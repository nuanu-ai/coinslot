import { describe, expect, it } from "vitest";
import {
  FieldSpecSchema,
  ParamSpecSchema,
  type ParamType,
  PROTOTYPE_KEY_IS_DROPPED,
  paramSpecToValidator,
} from "./param-spec.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

/** `Object.entries` keeps the key type, which the tables below rely on. */
const typesOf = (table: Record<ParamType, unknown[]>): [ParamType, unknown[]][] =>
  Object.entries(table) as [ParamType, unknown[]][];

describe("field spec", () => {
  // The promise: a card declares each purchase parameter with a type, whether
  // it is required, and words a program-buyer can read. A field spec that gets
  // through without a type is a card that cannot be checked against anything.
  it("accepts the spec the portal writes", () => {
    const field = { type: "string", required: true, title: "Куда прислать доступ" };
    expect(FieldSpecSchema.parse(field)).toStrictEqual(field);
  });

  it("accepts a spec that only names a type", () => {
    expect(FieldSpecSchema.parse({ type: "string" })).toStrictEqual({ type: "string" });
  });

  it("refuses a field spec without a type and names the field", () => {
    expectMissingFieldRejected(FieldSpecSchema, { type: "string", required: true }, "type");
  });

  it("refuses a type the compiler cannot turn into a check", () => {
    // Every accepted type has a validator behind it. A card that declares
    // `type: 'date'` would promise the agent a check nobody performs.
    const message = errorOf(FieldSpecSchema, { type: "date" });
    expect(message).toContain("string");
    expect(message).toContain("integer");
  });

  it("refuses a key it does not know", () => {
    expect(errorOf(FieldSpecSchema, { type: "string", pattern: "^a" })).toContain("pattern");
  });
});

describe("param spec", () => {
  it("accepts the params and the result of a real card", () => {
    const params = { email: { type: "string", required: true, title: "Куда прислать доступ" } };
    const result = {
      access_url: { type: "string", title: "Ссылка для входа" },
      expires_at: { type: "string", title: "До какого момента действует" },
    };
    expect(ParamSpecSchema.parse(params)).toStrictEqual(params);
    expect(ParamSpecSchema.parse(result)).toStrictEqual(result);
  });

  it("accepts a spec with no fields at all", () => {
    expect(ParamSpecSchema.parse({})).toStrictEqual({});
  });

  it("names the offending field when one entry of many is wrong", () => {
    const message = errorOf(ParamSpecSchema, {
      email: { type: "string" },
      country: { type: "date" },
    });
    expect(message).toContain("country");
    expect(message).not.toContain("email");
  });

  it("refuses a name that cannot safely become a property", () => {
    // A spec name becomes a key in JSON on both sides and a segment of the
    // error path a merchant reads. Dots collide with that path notation and
    // spaces make the name unquotable in an error.
    for (const name of ["", " ", "Not Ok", "a.b", "1st", "-x", "_hidden"]) {
      expect(
        ParamSpecSchema.safeParse({ [name]: { type: "string" } }).success,
        JSON.stringify(name),
      ).toBe(false);
    }
  });

  it("cannot carry the one name that is dropped rather than refused", () => {
    // The promise: nothing named `__proto__` reaches the compiler, where
    // assigning it would set a prototype instead of declaring a field. The
    // mechanism is zod's, not ours — it removes the key before the name check
    // ever runs, so the spec comes back without it rather than refused, and
    // the whole reason is written down at PROTOTYPE_KEY_IS_DROPPED. This test
    // exists to notice if that ever stops being true.
    const spec = ParamSpecSchema.parse(
      JSON.parse(
        `{"email": {"type": "string"}, "${PROTOTYPE_KEY_IS_DROPPED}": {"type": "string"}}`,
      ),
    );
    expect(Object.keys(spec)).toStrictEqual(["email"]);
  });

  it("accepts names written the way either side of the contract writes them", () => {
    for (const name of ["email", "access_url", "expiresAt", "line2"]) {
      expect(ParamSpecSchema.safeParse({ [name]: { type: "string" } }).success, name).toBe(true);
    }
  });
});

describe("the compiler from a spec to a validator", () => {
  // The promise: a card's declaration of its purchase parameters is the same
  // check the gateway runs on the agent's purchase and the same check the
  // delivery is held to. One spec, one meaning, in the gateway and in the SDK.

  const accepted: Record<ParamType, unknown[]> = {
    string: ["", "buyer@example.com"],
    number: [0, 1.5, -3],
    integer: [0, 42, -7],
    boolean: [true, false],
  };

  const refused: Record<ParamType, unknown[]> = {
    string: [1, true, null, {}, []],
    number: ["1", true, null, Number.NaN, Number.POSITIVE_INFINITY],
    integer: [1.5, "1", true, null, Number.NaN],
    boolean: ["true", 1, 0, null],
  };

  for (const [type, values] of typesOf(accepted)) {
    it(`accepts a ${type} where the spec declares a ${type}`, () => {
      const validator = paramSpecToValidator({ field: { type, required: true } }, "purchase");
      for (const value of values) {
        expect(validator.safeParse({ field: value }).success, JSON.stringify(value)).toBe(true);
      }
    });
  }

  for (const [type, values] of typesOf(refused)) {
    it(`refuses what is not a ${type} and names the field`, () => {
      const validator = paramSpecToValidator({ email: { type, required: true } }, "purchase");
      for (const value of values) {
        expect(errorOf(validator, { email: value }), JSON.stringify(value)).toContain("email");
      }
    });
  }

  it("requires a field the spec marked required, whichever way it is compiled", () => {
    for (const direction of ["purchase", "delivery"] as const) {
      const validator = paramSpecToValidator(
        { email: { type: "string", required: true } },
        direction,
      );
      expect(errorOf(validator, {}), direction).toContain("email");
    }
  });

  it("lets a purchase leave out a field with no required flag", () => {
    // The portal writes `required: true` where it means it, so silence means
    // the other thing. A default of "required" would break every card whose
    // author left the flag off.
    const validator = paramSpecToValidator({ note: { type: "string" } }, "purchase");
    expect(validator.safeParse({}).success).toBe(true);
    expect(validator.safeParse({ note: "for a friend" }).success).toBe(true);
  });

  it("holds a delivery to every field the card declared", () => {
    // The other direction of the same flag. A card's result is what the agent
    // reads before paying to decide what it is buying, so a declared field is
    // one that arrives. Reading silence as "optional" here would let a
    // merchant deliver an empty object against a card advertising three
    // fields, and the promise the agent paid on would be unenforceable.
    const validator = paramSpecToValidator(
      { access_url: { type: "string" }, expires_at: { type: "string" } },
      "delivery",
    );

    expect(validator.safeParse({}).success).toBe(false);
    expect(errorOf(validator, { access_url: "https://example.com/a" })).toContain("expires_at");
    expect(
      validator.safeParse({
        access_url: "https://example.com/a",
        expires_at: "2026-09-25T10:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("lets a delivery field that may genuinely be absent say so", () => {
    const validator = paramSpecToValidator(
      { iccid: { type: "string" }, ios_tap_link: { type: "string", required: false } },
      "delivery",
    );

    expect(validator.safeParse({ iccid: "89000000000000000000" }).success).toBe(true);
    expect(validator.safeParse({ ios_tap_link: "https://example.com/e" }).success).toBe(false);
  });

  it("refuses a value the card never declared", () => {
    // The decision behind this test: undeclared keys are refused, not
    // stripped and not passed through. Stripping would be truncation the
    // agent is never told about; passing through would hand the merchant's
    // handler fields the card never promised, which is both a lie about the
    // card and a way to smuggle input into someone else's code. The same rule
    // holds for a delivery, where an undeclared field means the agent paid
    // for a result different from the one it read before paying.
    for (const direction of ["purchase", "delivery"] as const) {
      const validator = paramSpecToValidator(
        { email: { type: "string", required: true } },
        direction,
      );
      const message = errorOf(validator, { email: "buyer@example.com", coupon: "FREE" });
      expect(message, direction).toContain("coupon");
    }
  });

  it("drops a delivered field named __proto__ instead of reporting it", () => {
    // The portal promises that a delivery reaches the agent as the merchant
    // wrote it. This is the one exception, and it is zod's: the key is removed
    // before any check of ours runs, so it is neither delivered nor refused.
    // Nothing in a card can declare such a field, so a merchant only reaches
    // this by sending one nobody asked for — but the loss is silent, and this
    // test is here so it stays known rather than surprising.
    const validator = paramSpecToValidator({ access_url: { type: "string" } }, "delivery");
    const delivered = validator.parse(
      JSON.parse('{"access_url": "https://example.com/a", "__proto__": {"x": 1}}'),
    );

    expect(Object.keys(delivered as object)).toStrictEqual(["access_url"]);
  });

  it("refuses a delivered string with nothing in it, and says which field", () => {
    // The promise this holds: a card declaring an access code and a delivery
    // carrying `""` are the same outcome for the buyer as a delivery carrying
    // nothing at all. Caught in one case and not the other, the check would
    // read as enforcing a promise it does not enforce.
    const validator = paramSpecToValidator({ access_code: { type: "string" } }, "delivery");

    for (const nothing of ["", " ", "\t\n "]) {
      const refused = validator.safeParse({ access_code: nothing });
      expect(refused.success, JSON.stringify(nothing)).toBe(false);
      if (refused.success) throw new Error("a blank delivery was accepted");
      expect(refused.error.issues[0]?.path).toStrictEqual(["access_code"]);
      expect(refused.error.issues[0]?.message).toContain("blank");
    }

    expect(validator.safeParse({ access_code: "4417" }).success).toBe(true);
  });

  it("holds a delivered field that may be absent to the same rule when it is there", () => {
    // `required: false` says the field may not arrive, not that it may arrive
    // empty. Left out is a complete delivery; present and blank is a field
    // that claims to be there and is not.
    const validator = paramSpecToValidator(
      { note: { type: "string", required: false } },
      "delivery",
    );

    expect(validator.safeParse({}).success).toBe(true);
    expect(validator.safeParse({ note: "" }).success).toBe(false);
  });

  it("lets a purchase parameter be an empty string, because that is the agent's to choose", () => {
    // The other half of the asymmetry, and the reason it is not a bug. Input
    // the agent left blank is input; refusing it would be this package
    // inventing a requirement no card asked for.
    const validator = paramSpecToValidator({ note: { type: "string" } }, "purchase");
    expect(validator.safeParse({ note: "" }).success).toBe(true);
  });

  it("compiles an empty spec into a check that accepts only an empty object", () => {
    const validator = paramSpecToValidator({}, "purchase");
    expect(validator.safeParse({}).success).toBe(true);
    expect(validator.safeParse({ anything: 1 }).success).toBe(false);
  });

  it("gives back the values it was handed", () => {
    const validator = paramSpecToValidator(
      {
        email: { type: "string", required: true },
        seats: { type: "integer" },
      },
      "purchase",
    );
    const instance = { email: "buyer@example.com", seats: 3 };
    expect(validator.parse(instance)).toStrictEqual(instance);
  });

  it("refuses an instance that is not an object at all", () => {
    const validator = paramSpecToValidator(
      { email: { type: "string", required: true } },
      "purchase",
    );
    for (const instance of [null, "email=buyer@example.com", 1, []]) {
      expect(validator.safeParse(instance).success, JSON.stringify(instance)).toBe(false);
    }
  });
});
