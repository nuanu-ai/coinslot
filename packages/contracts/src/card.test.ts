import { describe, expect, it } from "vitest";
import {
  CardSchema,
  deliveryCheckFor,
  FulfillmentSchema,
  PriceCheckSchema,
  purchaseCheckFor,
} from "./card.js";
import { toJsonSchemas } from "./index.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const syncCard = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Доступ на 30 дней с момента выдачи, продление не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
  result: { access_url: { type: "string", title: "Ссылка для входа" } },
  fulfillment: "sync",
};

describe("fulfillment mode", () => {
  it("is one of the three modes the agent is told about before paying", () => {
    for (const mode of ["sync", "async", "confirm"]) {
      expect(FulfillmentSchema.safeParse(mode).success, mode).toBe(true);
    }
    for (const mode of ["synchronous", "SYNC", "manual", ""]) {
      expect(FulfillmentSchema.safeParse(mode).success, JSON.stringify(mode)).toBe(false);
    }
  });
});

describe("price check", () => {
  // The promise: a card says how its price is asked for, and the two
  // transports are the two the model has — the handler on the order channel,
  // or an address of the merchant's own.
  it("accepts the handler on the order channel", () => {
    expect(PriceCheckSchema.parse("handler")).toBe("handler");
  });

  it("accepts an address for the merchants who run a pricing service", () => {
    expect(PriceCheckSchema.parse({ url: "https://api.example.com/quote" })).toStrictEqual({
      url: "https://api.example.com/quote",
    });
  });

  it("reads the scheme the way a URL scheme is read, without regard to case", () => {
    // A scheme is case-insensitive, and for a while the two checks behind this
    // field disagreed about that: one accepted `HTTPS://` and the other
    // refused it, complaining that an address was not https about an address
    // that was.
    expect(PriceCheckSchema.safeParse({ url: "HTTPS://api.example.com/quote" }).success).toBe(true);
    expect(PriceCheckSchema.safeParse({ url: "HtTpS://api.example.com/quote" }).success).toBe(true);
    expect(PriceCheckSchema.safeParse({ url: "HTTP://api.example.com/quote" }).success).toBe(false);
  });

  it("refuses a price hook that is not over https", () => {
    // The question and the answer carry a merchant's prices. Over plain http
    // they are readable and rewritable by anyone on the path, and the merchant
    // would have no way to tell that the price we sold at was not theirs.
    expect(PriceCheckSchema.safeParse({ url: "http://api.example.com/quote" }).success).toBe(false);
    expect(PriceCheckSchema.safeParse({ url: "/quote" }).success).toBe(false);
    expect(PriceCheckSchema.safeParse({ url: "api.example.com/quote" }).success).toBe(false);
  });

  it("refuses something that begins like an address and is not one", () => {
    // The scheme rule and the address rule are two checks, and this is the
    // case that tells them apart: right scheme, no address behind it. A card
    // carrying one of these would publish, and the price question would fail
    // at the first purchase instead of at the publish call.
    for (const url of ["https://", "https://a b", "https://["]) {
      expect(PriceCheckSchema.safeParse({ url }).success, url).toBe(false);
    }
  });

  it("refuses an address that names nowhere", () => {
    // A card that declares the second transport and gives no address is a card
    // whose price we would never manage to ask about, and the merchant would
    // find out from the sales that quietly stopped rather than from publishing.
    expect(errorOf(PriceCheckSchema, {})).toContain("url");
    expect(errorOf(PriceCheckSchema, { address: "https://api.example.com/quote" })).toContain(
      "url",
    );
  });

  it("refuses a transport it does not have", () => {
    const message = errorOf(PriceCheckSchema, "webhook");
    expect(message).toContain("handler");
    expect(message).toContain("url");
  });
});

describe("card", () => {
  it("accepts a synchronous card with everything a purchase needs", () => {
    expect(CardSchema.parse(syncCard)).toStrictEqual(syncCard);
  });

  it("accepts an asynchronous card that checks its price and names its deadline", () => {
    const card = {
      ...syncCard,
      fulfillment: "async",
      price_check: "handler",
      fulfill_deadline_seconds: 86_400,
    };
    expect(CardSchema.parse(card)).toStrictEqual(card);
  });

  it("refuses to publish in the mode whose request the wire cannot carry", () => {
    // The promise this keeps: a merchant never publishes a card that cannot be
    // sold. In the confirmation mode a request arrives before any money moves
    // and must be answered without delivering — but nothing on the wire marks
    // it, so a handler could not tell it from a paid order. Naming that in a
    // comment somewhere is not enough: the merchant, and the engineer
    // generating a client from the exported document, learn about it here or
    // they learn about it from a request they mishandle.
    const message = errorOf(CardSchema, { ...syncCard, fulfillment: "confirm" });

    expect(message).toContain("confirm");
    expect(message).toContain("pilot");
  });

  it("complains about the mode and not about the deadlines that go with it", () => {
    // The rules about which card carries which deadline are unchanged and
    // still correct for the confirmation mode; they are simply unreachable
    // while the gate is down. If this card drew a deadline complaint too, the
    // gate would be hiding a second problem behind it — and lifting the gate
    // later would uncover it.
    const message = errorOf(CardSchema, {
      ...syncCard,
      fulfillment: "confirm",
      confirm_deadline_seconds: 3_600,
      fulfill_deadline_seconds: 86_400,
    });

    expect(message).not.toContain("confirm_deadline_seconds");
    expect(message).not.toContain("fulfill_deadline_seconds");
  });

  it("accepts a card that takes no purchase parameters", () => {
    const { params, ...withoutParams } = syncCard;
    expect(params).toBeDefined();
    expect(CardSchema.safeParse(withoutParams).success).toBe(true);
    expect(CardSchema.safeParse({ ...withoutParams, params: {} }).success).toBe(true);
  });

  for (const field of [
    "merchant_item_id",
    "title",
    "description",
    "price",
    "result",
    "fulfillment",
  ]) {
    it(`refuses a card without ${field} and names it`, () => {
      expectMissingFieldRejected(CardSchema, syncCard, field);
    });
  }

  it("refuses a card that fills in the catalog id", () => {
    // The catalog id is ours and we hand it back from the publish call. A
    // merchant who sends one is either guessing at our numbering or replaying
    // a card we returned, and both are worth saying out loud.
    expect(errorOf(CardSchema, { ...syncCard, id: "itm_9f2c4a" })).toContain("id");
  });

  it("refuses a card whose title or description is blank", () => {
    // The agent picks a card out of a catalog by these two fields. A blank
    // title is a card nobody can tell from its neighbours.
    expect(CardSchema.safeParse({ ...syncCard, title: "   " }).success).toBe(false);
    expect(CardSchema.safeParse({ ...syncCard, description: "" }).success).toBe(false);
  });

  it("refuses a card that promises nothing on delivery", () => {
    // `result` is what the agent reads before paying to decide what it is
    // buying. An empty declaration passes the letter of "result is required"
    // and tells the agent nothing at all.
    expect(errorOf(CardSchema, { ...syncCard, result: {} })).toContain("result");
  });

  it("refuses a card whose whole result might be absent", () => {
    // The same nothing, spelled differently: a declaration of one field that
    // the merchant has marked as possibly missing promises exactly as much as
    // an empty one, and satisfies "at least one field" while doing it. At
    // least one field of a result has to be a field that arrives.
    expect(
      errorOf(CardSchema, { ...syncCard, result: { maybe: { type: "string", required: false } } }),
    ).toContain("result");

    // One that arrives alongside one that might not is a real promise.
    expect(
      CardSchema.safeParse({
        ...syncCard,
        result: {
          access_url: { type: "string" },
          ios_tap_link: { type: "string", required: false },
        },
      }).success,
    ).toBe(true);
  });
});

describe("the merchant's two deadlines", () => {
  // The promise: both deadlines are shown to the agent before it pays, so a
  // card may only carry the ones its mode actually uses. A synchronous card
  // showing a delivery deadline would be advertising a wait that never
  // happens; the wait for a synchronous answer is our own system-wide budget
  // and is not a card field at all.

  it("refuses a confirmation deadline on a card that has no confirmation step", () => {
    for (const fulfillment of ["sync", "async"]) {
      const message = errorOf(CardSchema, {
        ...syncCard,
        fulfillment,
        confirm_deadline_seconds: 3_600,
      });
      expect(message, fulfillment).toContain("confirm_deadline_seconds");
    }
  });

  it("refuses a delivery deadline on a synchronous card", () => {
    const message = errorOf(CardSchema, { ...syncCard, fulfill_deadline_seconds: 86_400 });
    expect(message).toContain("fulfill_deadline_seconds");
  });

  it("has no field for the synchronous response budget", () => {
    expect(errorOf(CardSchema, { ...syncCard, sync_deadline_seconds: 10 })).toContain(
      "sync_deadline_seconds",
    );
  });

  it("refuses a deadline that is not a whole number of seconds in the future", () => {
    for (const seconds of [0, -1, 1.5, "3600", null]) {
      const card = { ...syncCard, fulfillment: "async", fulfill_deadline_seconds: seconds };
      expect(CardSchema.safeParse(card).success, JSON.stringify(seconds)).toBe(false);
    }
  });

  it("accepts a card that names neither deadline", () => {
    // The default values are among the numbers named before the pilot, so a
    // card is allowed to leave both out and take ours.
    expect(CardSchema.safeParse({ ...syncCard, fulfillment: "async" }).success).toBe(true);
  });
});

describe("the checks a card compiles to", () => {
  // The promise: the card is the only place that knows which of its two
  // declarations is which, so asking it for a check cannot get the direction
  // backwards. A caller who compiled the result as a purchase would silently
  // reopen the hole where a delivery promises nothing.
  //
  // The card below is the one that tells the two apart: a field with no
  // `required` flag, which a purchase may omit and a delivery may not.
  const card = CardSchema.parse({
    ...syncCard,
    params: { email: { type: "string", required: true }, note: { type: "string" } },
    result: { access_url: { type: "string" }, expires_at: { type: "string" } },
  });

  it("lets a purchase leave out a parameter that was never marked required", () => {
    const check = purchaseCheckFor(card);

    expect(check.safeParse({ email: "buyer@example.com" }).success).toBe(true);
    expect(check.safeParse({ email: "buyer@example.com", note: "for a friend" }).success).toBe(
      true,
    );
    expect(check.safeParse({ note: "for a friend" }).success).toBe(false);
  });

  it("holds a delivery to every field the same card declared", () => {
    const check = deliveryCheckFor(card);

    expect(
      check.safeParse({ access_url: "https://example.com/a", expires_at: "2026-09-25T10:00:00Z" })
        .success,
    ).toBe(true);
    expect(check.safeParse({ access_url: "https://example.com/a" }).success).toBe(false);
  });

  it("compiles nothing for a card that asks for no parameters", () => {
    const withoutParams = CardSchema.parse({ ...syncCard, params: undefined });
    const check = purchaseCheckFor(withoutParams);

    expect(check.safeParse({}).success).toBe(true);
    expect(check.safeParse({ email: "buyer@example.com" }).success).toBe(false);
  });
});

describe("what the exported document says about the mode", () => {
  // An engineer generating a client from the JSON Schema never reads the
  // TypeScript. If the gate lived only in a refinement, their generated card
  // would offer a mode that fails on the first publish, and the reason would
  // be nowhere in the document they were working from.

  it("keeps all three modes in the enumeration", () => {
    // The value is not removed: the mode exists in the model, the machine
    // knows it, and taking it out of the vocabulary would be a different and
    // larger claim than "not yet".
    expect(toJsonSchemas().fulfillment.enum).toStrictEqual(["sync", "async", "confirm"]);
  });

  it("says in the fulfillment document that one of them cannot be published", () => {
    const description = toJsonSchemas().fulfillment.description ?? "";

    expect(description).toContain("confirm");
    expect(description).toContain("pilot");
  });

  it("says the same in the card document", () => {
    const description = toJsonSchemas().card.description ?? "";

    expect(description).toContain("confirm");
    expect(description).toContain("pilot");
  });
});
