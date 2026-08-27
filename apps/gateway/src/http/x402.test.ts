import { CardSchema } from "@coinslot/contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { DiscoveryExtension } from "@x402/extensions/bazaar";
import {
  sanitizeResourceServiceMetadata,
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { bearerIn } from "./auth.js";
import { atomicUnits, PaymentEdge, paymentFingerprint } from "./x402.js";

describe("a price in the token's own units", () => {
  it("writes an exact amount, whatever the price looked like", async () => {
    // Money never becomes a float on the way through. Every one of these is a
    // charge somebody would notice being wrong by a factor of ten.
    expect(atomicUnits("80.00", 6)).toBe("80000000");
    expect(atomicUnits("0.001", 6)).toBe("1000");
    expect(atomicUnits("12", 6)).toBe("12000000");
    expect(atomicUnits("0", 6)).toBe("0");
    expect(atomicUnits("0.000001", 6)).toBe("1");
    expect(atomicUnits("1234567890.123456", 6)).toBe("1234567890123456");
  });

  it("refuses a price the token cannot hold, rather than rounding it", async () => {
    // Which way it was rounded is the difference between shorting the buyer and
    // shorting the merchant, and neither is a decision this code gets to take.
    expect(() => atomicUnits("0.0000001", 6)).toThrowError(
      /written to 7 places and this token carries 6/,
    );
  });
});

describe("what an agent is asked to pay", () => {
  const edge = (payTo: string | null) =>
    new PaymentEdge(
      {
        facilitatorUrl: "https://x402.org/facilitator",
        network: "eip155:84532",
        timeoutSeconds: 300,
        payTo,
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      },
      "https://coinslot.example",
      300,
    );

  it("names the network's own asset and the order the price is for", () => {
    const asked = edge("0xabc").requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1");

    expect(asked).toStrictEqual({
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "80000000",
      payTo: "0xabc",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2", order_id: "ord_1" },
    });
  });

  it("says nothing about an order when there is no order behind the price", () => {
    // A crawler asking what a resource costs is not a purchase, so there is no
    // order to name and none is invented.
    const asked = edge("0xabc").requirementsFor({ amount: "80.00", currency: "USD" }, null);
    expect(asked.extra).toStrictEqual({ name: "USDC", version: "2" });
  });

  it("will not ask for money with nowhere to send it", () => {
    expect(() =>
      edge(null).requirementsFor({ amount: "1.00", currency: "USD" }, null),
    ).toThrowError(/nowhere to send the money/);
  });

  it("will not invent an exchange rate for a currency it cannot charge in", () => {
    // Nobody has decided where a rate would come from, and a charge based on one
    // we made up would be the clearest possible claim beyond the evidence.
    expect(() =>
      edge("0xabc").requirementsFor({ amount: "80.00", currency: "EUR" }, "ord_1"),
    ).toThrowError(/will not invent a rate/);
  });
});

describe("the merchant's key", () => {
  // What used to be here was a test that one key matched another in constant
  // time. It retired with the variable it certified: the door is a lookup by
  // digest now (ADR-0010), so nothing compares a secret against a secret. What
  // replaced it is in `tenancy.test.ts` — a key nobody was issued is refused, a
  // key somebody disabled is refused in the same words, and two merchants' keys
  // never resolve to each other.
  it("reads a bearer token however the scheme is spelled, and nothing else", () => {
    expect(bearerIn("Bearer abc")).toBe("abc");
    expect(bearerIn("bearer abc")).toBe("abc");
    expect(bearerIn("  Bearer\tabc  ")).toBe("abc");
    expect(bearerIn("abc")).toBeNull();
    expect(bearerIn("Basic abc")).toBeNull();
    expect(bearerIn("Bearer")).toBeNull();
    expect(bearerIn(undefined)).toBeNull();
  });
});

describe("one payment, one fingerprint", () => {
  const token = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };

  const signed = (payload: Record<string, unknown>) => ({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:84532" as const,
      asset: "0x0",
      amount: "1",
      payTo: "0x0",
      maxTimeoutSeconds: 300,
      extra: {},
    },
    payload,
  });

  const fingerprintOf = (payload: Parameters<typeof paymentFingerprint>[0]) =>
    paymentFingerprint(payload, token);

  const authorised = (fields: { from?: string; nonce?: string; value?: string | number } = {}) => ({
    signature: "0xdeadBEEF",
    authorization: {
      from: fields.from ?? "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
      to: "0xbbbb",
      value: fields.value ?? "1000000",
      validAfter: "0",
      validBefore: "999",
      nonce: fields.nonce ?? "0xABCDEF0123456789",
    },
  });

  it("is one fingerprint however the hex is spelled", () => {
    // The signature is over decoded bytes, so 0xABCD and 0xabcd are one nonce
    // to the token contract, to the facilitator and to the signature. Two
    // fingerprints here would be a replay guard an attacker defeats by holding
    // down the shift key: present the same authorisation twice, flip a case
    // bit, and both orders verify.
    const shouted = fingerprintOf(signed(authorised()));
    const whispered = fingerprintOf(
      signed(
        authorised({
          from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          nonce: "0xabcdef0123456789",
        }),
      ),
    );

    expect(whispered).toBe(shouted);
  });

  it("is one fingerprint however the amounts are written, and whatever they are called", () => {
    // 1000000, "1000000" and "0xF4240" are one number to the chain, and a
    // scheme may write that number under any of these names. This is the
    // branch for a payload that carries neither an authorisation pair nor a
    // signature, where the whole payload is the key: an authorisation whose
    // validBefore arrives as a number in one presentation and as a string in
    // another is one authorisation, and two fingerprints for it is one
    // authorisation buying two orders.
    //
    // The names are written out rather than read from the set the code uses. A
    // test that read that set would go on passing if a name were dropped from
    // it, which is the direction that costs money — the names it stopped
    // normalising would each split one authorisation into two fingerprints.
    // The other direction is left unguarded on purpose: a name added to the set
    // only merges more spellings, and merging never lets one payment buy twice.
    const names = ["value", "amount", "validAfter", "validBefore", "maxAmount"];

    // The plain decimal is written with leading zeros so that it is not already
    // in its own normalised form. Against "1000000" the decimal arm of asAmount
    // is exercised and cannot fail: deleting it changes nothing, because the
    // text and the number it stands for are the same string.
    for (const name of names) {
      const asText = fingerprintOf(signed({ proof: { [name]: "0001000000" } }));

      expect(fingerprintOf(signed({ proof: { [name]: "1000000" } })), name).toBe(asText);
      expect(fingerprintOf(signed({ proof: { [name]: 1_000_000 } })), name).toBe(asText);
      expect(fingerprintOf(signed({ proof: { [name]: "0xF4240" } })), name).toBe(asText);
    }
  });

  it("merges a number and its text only as far as a JSON number is exact", () => {
    // The merge holds to the last integer a JSON number carries exactly and
    // stops there. Past 2^53 the number that arrives is no longer the integer
    // it was written as, and putting it through BigInt would assert an equality
    // nobody can check.
    //
    // The cost of stopping is real and is pinned here rather than left to be
    // discovered: an amount that large and its own text are two fingerprints.
    // One token of an eighteen-decimal asset is such an amount. No scheme this
    // gateway speaks reaches this branch — an EIP-3009 payload is keyed on its
    // payer and nonce long before the payload itself is read — so this is the
    // bound as it stands, not a bound anybody has had to choose.
    const exact = String(Number.MAX_SAFE_INTEGER);
    const beyond = "1000000000000000000";

    expect(fingerprintOf(signed({ proof: { value: Number.MAX_SAFE_INTEGER } }))).toBe(
      fingerprintOf(signed({ proof: { value: exact } })),
    );
    expect(fingerprintOf(signed({ proof: { value: 1e18 } }))).not.toBe(
      fingerprintOf(signed({ proof: { value: beyond } })),
    );
  });

  it("merges two spellings of one number and not two different values", () => {
    // The normalisation exists to make one payment one key. It may not go
    // further and make two payments one: no token records a negative amount, so
    // -5 and "-5" are two pieces of junk rather than one number, and merging
    // them would have the second payment refused as a replay of the first.
    expect(fingerprintOf(signed({ proof: { value: -5 } }))).not.toBe(
      fingerprintOf(signed({ proof: { value: "-5" } })),
    );
  });

  it("survives an amount that is not a whole number", () => {
    // The decoder guarantees nothing about the payload, so a fraction under one
    // of these names arrives from an agent like anything else. BigInt refuses
    // it by throwing, and a throw here is a crash where a refusal belongs.
    expect(() => fingerprintOf(signed({ proof: { value: 1.5 } }))).not.toThrow();
  });

  it("keys on the payer as well as the nonce, the way the token does", () => {
    // A token records authorizationState[authorizer][nonce]. Keyed on the nonce
    // alone, the first payer to use one would block every other payer who ever
    // picked the same — and a client that counts from one picks exactly those.
    const mine = fingerprintOf(signed(authorised()));
    const yours = fingerprintOf(
      signed(authorised({ from: "0xcccccccccccccccccccccccccccccccccccccccc" })),
    );

    expect(yours).not.toBe(mine);
  });

  it("changes when the nonce does", () => {
    expect(fingerprintOf(signed(authorised({ nonce: "0x02" })))).not.toBe(
      fingerprintOf(signed(authorised({ nonce: "0x01" }))),
    );
  });

  it("does not key on a nonce that has no payer beside it", () => {
    // The chain keys on the pair — authorizationState[authorizer][nonce] — so a
    // nonce alone is not a key. Keyed on the nonce without the payer, the first
    // agent to use a nonce would block every other payer who picked the same,
    // and a client that counts from one picks exactly those. The proof is that
    // a nonce with no `from` beside it falls through to the signature the
    // authorisation carries, and the nonce then changes nothing: two such
    // payments differing only in nonce are one payment, and both are the same
    // payment as the bare signature.
    const withNonce = (nonce: string) =>
      signed({ signature: "0xdeadbeef", authorization: { to: "0xbbbb", value: "1", nonce } });
    const bareSignature = signed({ signature: "0xdeadbeef" });

    expect(fingerprintOf(withNonce("0x01"))).toBe(fingerprintOf(withNonce("0x02")));
    expect(fingerprintOf(withNonce("0x01"))).toBe(fingerprintOf(bareSignature));
  });

  it("does not key on a payer that has no nonce beside it", () => {
    // The symmetric edge. A payer without a nonce is not half of a key either:
    // it falls through to the signature, and two different payers with no nonce
    // are one payment, the same as the bare signature. Keyed on the payer
    // alone, one payer could spend once and never again.
    const withPayer = (from: string) =>
      signed({ signature: "0xdeadbeef", authorization: { from, to: "0xbbbb", value: "1" } });
    const bareSignature = signed({ signature: "0xdeadbeef" });

    expect(fingerprintOf(withPayer("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe(
      fingerprintOf(withPayer("0xcccccccccccccccccccccccccccccccccccccccc")),
    );
    expect(fingerprintOf(withPayer("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe(
      fingerprintOf(bareSignature),
    );
  });

  it("does not change when the agent rewrites everything it is allowed to rewrite", () => {
    // The requirements beside the payload are the agent's own unsigned copy of
    // what we asked for. If the fingerprint moved with them, one signature
    // would buy as many orders as the agent cared to relabel it for.
    const first = fingerprintOf(signed(authorised()));
    const relabelled = {
      ...signed(authorised()),
      accepted: {
        scheme: "exact",
        network: "eip155:84532" as const,
        asset: "0xdifferent",
        amount: "999",
        payTo: "0xsomebody-else",
        maxTimeoutSeconds: 1,
        extra: { order_id: "another_order" },
      },
    };

    expect(fingerprintOf(relabelled)).toBe(first);
  });

  it("does not change when a field is added beside the signed authorisation", () => {
    const first = fingerprintOf(signed(authorised()));
    const padded = signed({ ...authorised(), padding: "anything at all" });

    expect(fingerprintOf(padded)).toBe(first);
  });

  it("does not move with the protocol version the agent types", () => {
    // Nothing checks that field: the decoder is a base64 JSON parse with no
    // schema behind it. Digested, it would let an agent make as many
    // fingerprints out of one authorisation as it liked by counting upwards,
    // which is the two-orders-one-signature hole reopened by one integer.
    const two = fingerprintOf(signed(authorised()));
    for (const version of [1, 3, 0, 99]) {
      expect(fingerprintOf({ ...signed(authorised()), x402Version: version })).toBe(two);
    }
  });

  it("is a different payment on a different token", () => {
    // A token records authorizationState[authorizer][nonce] in its own
    // contract, so one payer and one nonce on two assets are two payments. The
    // token comes from our configuration and never from the payment, or the
    // agent would have its variation back.
    const here = fingerprintOf(signed(authorised()));
    const elsewhere = paymentFingerprint(signed(authorised()), {
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });

    expect(elsewhere).not.toBe(here);
  });

  it("reads a payment that is not one without falling over", () => {
    // The decoder guarantees nothing about the payload, so a header naming a
    // known order and carrying nothing else reaches this function.
    expect(() =>
      paymentFingerprint(
        { x402Version: 2 } as unknown as Parameters<typeof paymentFingerprint>[0],
        token,
      ),
    ).not.toThrow();
  });

  it("does not mistake something that is not hex for a canonical key", () => {
    // The pair is a key only when it is written the way the chain writes one.
    // Taken loosely, a scheme whose authorisation fields are words rather than
    // hex would have those words used as the key — and two genuinely different
    // payments, with different signatures, would come out as one.
    const worded = (signature: string) => ({
      ...signed({
        signature,
        authorization: { from: "alice", to: "bob", value: "1", nonce: "the-first-one" },
      }),
    });

    expect(fingerprintOf(worded("0xaaaa"))).not.toBe(fingerprintOf(worded("0xbbbb")));
  });

  it("falls back to the signature, canonicalised, and then to the whole payload", () => {
    // Not every scheme carries an authorisation under that name; whatever it
    // does carry, two spellings of one payment have to agree.
    const shouted = fingerprintOf(signed({ signature: "0xDEADbeef" }));
    expect(fingerprintOf(signed({ signature: "0xdeadBEEF" }))).toBe(shouted);
    expect(fingerprintOf(signed({ signature: "0xdeadbeee" }))).not.toBe(shouted);

    const byPayload = fingerprintOf(signed({ proof: { b: "0xFF", a: 1 } }));
    // The same payload written in another order, and in another case, is the
    // same payment.
    expect(fingerprintOf(signed({ proof: { a: 1, b: "0xff" } }))).toBe(byPayload);
    expect(fingerprintOf(signed({ proof: { a: 2, b: "0xff" } }))).not.toBe(byPayload);
  });
});

describe("the discovery declaration a challenge carries", () => {
  // The promise: an agent that has never heard of us can find this product in
  // a catalog it already walks, and what it reads there is the product it can
  // then buy. Nothing offline can say the catalog will accept it — that is a
  // live call and it lives in `pnpm smoke:listing` — but two things can be
  // checked here, and both are checked with the catalog's own code: that the
  // declaration is consistent with the schema it ships alongside itself, and
  // that nothing we send about the seller gets dropped on the way in.
  const card = CardSchema.parse({
    merchant_item_id: "access-monthly",
    title: "Доступ к сервису на один месяц",
    description: "Доступ на 30 дней с момента выдачи, продление не входит.",
    price: { amount: "5.00", currency: "USD" },
    params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
    result: { access_url: { type: "string", title: "Ссылка для входа" } },
    fulfillment: "sync",
    tags: ["access", "subscription"],
  });

  const edge = () =>
    new PaymentEdge(
      {
        facilitatorUrl: "https://x402.org/facilitator",
        network: "eip155:84532",
        timeoutSeconds: 300,
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      },
      "https://coinslot.example",
      300,
    );

  const challenge = (method: "GET" | "POST", listed: { serviceName: string | null }) =>
    decodePaymentRequiredHeader(
      edge().challengeFor(
        { amount: "5.00", currency: "USD" },
        null,
        { itemId: "itm_4d21bb", card, serviceName: listed.serviceName },
        method,
      ),
    );

  const declaration = (method: "GET" | "POST") =>
    challenge(method, { serviceName: "The pilot merchant" }).extensions
      ?.bazaar as DiscoveryExtension;

  it("names the resource at the address this gateway was configured with", () => {
    // Not the address the request arrived at. Behind a terminator that is
    // http:// and carries whatever query string the caller wrote, and the
    // resource identity is what a listing is keyed on: two spellings would be
    // two listings, or one that flickers between them.
    expect(challenge("GET", { serviceName: null }).resource.url).toBe(
      "https://coinslot.example/v0/items/itm_4d21bb/purchase",
    );
  });

  it("says who is selling and what the product is filed under", () => {
    const { resource } = challenge("POST", { serviceName: "The pilot merchant" });

    expect(resource.serviceName).toBe("The pilot merchant");
    expect(resource.tags).toStrictEqual(["access", "subscription"]);
    expect(resource.description).toBe(card.description);
  });

  it("loses nothing about the seller to the catalog's own sanitiser", () => {
    // This is the catalog's code, not a copy of its rules: what it drops here
    // is what would silently vanish from a listing. A name or a tag it did not
    // hand back would be a merchant trading under a word they did not choose.
    const { resource } = challenge("POST", { serviceName: "The pilot merchant" });

    expect(sanitizeResourceServiceMetadata(resource)).toStrictEqual({
      serviceName: "The pilot merchant",
      tags: ["access", "subscription"],
    });
  });

  it("says nothing about a seller nobody has named", () => {
    const { resource } = challenge("POST", { serviceName: null });

    expect("serviceName" in resource).toBe(false);
  });

  it("describes the purchase an agent would actually make", () => {
    const info = declaration("POST").info as unknown as {
      input: Record<string, unknown>;
      output?: { example?: unknown };
    };

    expect(info.input.method).toBe("POST");
    expect(info.input.bodyType).toBe("json");
    expect(info.input.body).toStrictEqual({ params: { email: "string" } });
    expect(info.output?.example).toStrictEqual({ access_url: "string" });
  });

  it("describes the probe a crawler makes as the probe it is", () => {
    // A crawler and the catalog's own validator ask with GET, and a body
    // declaration is only valid on a method that carries a body. Answering a
    // GET with one would make the resource invisible to the very thing that
    // lists it.
    const info = declaration("GET").info as unknown as { input: Record<string, unknown> };

    expect(info.input.method).toBe("GET");
    expect("bodyType" in info.input).toBe(false);
    expect("body" in info.input).toBe(false);
  });

  for (const method of ["GET", "POST"] as const) {
    it(`holds together against its own schema on ${method}`, () => {
      // The catalog validates the declaration against the schema shipped
      // beside it, with this very function. A declaration that failed here is
      // one the catalog would refuse.
      expect(validateDiscoveryExtension(declaration(method))).toStrictEqual({ valid: true });
      expect(
        validateDiscoveryExtensionSpec(declaration(method) as unknown as Record<string, unknown>),
      ).toStrictEqual({ valid: true });
    });
  }

  it("gives two requests for one product the same declaration", () => {
    // Byte for byte. A listing is keyed on the resource, and a declaration
    // that varied between two challenges for the same card would be two
    // listings for one product.
    expect(JSON.stringify(challenge("POST", { serviceName: "A seller" }))).toBe(
      JSON.stringify(challenge("POST", { serviceName: "A seller" })),
    );
  });

  it("still says which order it is for", () => {
    // The declaration is added beside what was already there, not instead of
    // it: the order identifier travels in `extra` and is what a payment names.
    const forOrder = decodePaymentRequiredHeader(
      edge().challengeFor(
        { amount: "5.00", currency: "USD" },
        "ord_1",
        { itemId: "itm_4d21bb", card, serviceName: null },
        "POST",
      ),
    );

    expect(forOrder.accepts[0]?.extra?.order_id).toBe("ord_1");
  });
});

describe("the shape a live validation once accepted", () => {
  /**
   * What this test is, said plainly, because it would be easy to read it as
   * more than it is.
   *
   * The spike that preceded this work put a public resource in front of the
   * CDP validation endpoint and was answered `valid: true`. That resource is a
   * POST resource whose paid address also answers GET — the same arrangement
   * ours has — and the endpoint echoed back the declaration it accepted, on
   * each method. The two objects below are that echo, copied from the answer.
   *
   * This compares the shape of what we emit against the shape of what was
   * accepted: which fields are present at which paths, not what is in them,
   * since the two describe different products. It is a comparison against
   * something that passed once. It is not a validation, it says nothing about
   * what the endpoint would do today, and it cannot: that is `pnpm
   * smoke:listing`, which makes the call.
   */
  const acceptedOnGet = {
    input: { method: "GET", queryParams: {}, type: "http" },
    output: {
      example: {
        expiresAt: "2026-08-26T00:00:00Z",
        messagesUrl: "/freeland/numbers/msg-mock-id/messages",
        number: "+1 202 555 0139",
      },
      type: "json",
    },
  };

  const acceptedOnPost = {
    input: { body: { country: "US" }, bodyType: "json", method: "POST", type: "http" },
    output: {
      example: {
        expiresAt: "2026-08-26T00:00:00Z",
        messagesUrl: "/freeland/numbers/msg-mock-id/messages",
        number: "+1 202 555 0139",
      },
      type: "json",
    },
  };

  /**
   * The schema half of the same accepted answer, recorded the same way.
   *
   * It is here for one fact that is invisible without it: the dialect is named
   * once, at the root. The rest differs from ours legitimately — the spike wrote
   * its body schema by hand and ours is rendered from the card's own check, so
   * ours says `type` and closes the object where the spike's said neither.
   */
  const acceptedSchemaOnPost = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: {
      input: {
        additionalProperties: false,
        properties: {
          body: {
            properties: {
              country: { description: "ISO 3166-1 alpha-2 country code", type: "string" },
            },
            required: ["country"],
          },
          bodyType: { enum: ["json", "form-data", "text"], type: "string" },
          method: { enum: ["POST"], type: "string" },
          type: { const: "http", type: "string" },
        },
        required: ["type", "method", "bodyType", "body"],
        type: "object",
      },
      output: {
        properties: { example: { type: "object" }, type: { type: "string" } },
        required: ["type"],
        type: "object",
      },
    },
    required: ["input"],
    type: "object",
  };

  /** Every path through an object, with the leaves replaced by their types. */
  const skeleton = (value: unknown, at = ""): string[] => {
    if (Array.isArray(value)) {
      return value.length === 0
        ? [`${at}: []`]
        : value.flatMap((held, index) => skeleton(held, `${at}[${index}]`));
    }
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
      // An empty object is a fact about the shape and has no paths under it, so
      // it is written out rather than vanishing.
      return entries.length === 0
        ? [`${at}: {}`]
        : entries.flatMap(([name, held]) => skeleton(held, at === "" ? name : `${at}.${name}`));
    }
    return [`${at}: ${typeof value}`];
  };

  const ourDeclaration = (method: "GET" | "POST") => {
    const card = CardSchema.parse({
      merchant_item_id: "numbers-rent",
      title: "A virtual number",
      description: "Rent a virtual phone number for inbound SMS in the given country.",
      price: { amount: "2.00", currency: "USD" },
      params: { country: { type: "string", required: true } },
      result: {
        number: { type: "string" },
        messages_url: { type: "string" },
        expires_at: { type: "string" },
      },
      fulfillment: "sync",
    });
    const edge = new PaymentEdge(
      {
        facilitatorUrl: "https://x402.org/facilitator",
        network: "eip155:84532",
        timeoutSeconds: 300,
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      },
      "https://coinslot.example",
      300,
    );
    const decoded = decodePaymentRequiredHeader(
      edge.challengeFor(
        { amount: "2.00", currency: "USD" },
        null,
        { itemId: "itm_1", card, serviceName: "Freeland" },
        method,
      ),
    );
    const declared = decoded.extensions?.bazaar as DiscoveryExtension | undefined;
    if (declared === undefined) throw new Error("the challenge carried no declaration");
    return declared;
  };

  it("puts the same fields in the same places as the GET probe that was accepted", () => {
    expect(skeleton(ourDeclaration("GET").info)).toStrictEqual([
      "input.method: string",
      "input.queryParams: {}",
      "input.type: string",
      "output.example.expires_at: string",
      "output.example.messages_url: string",
      "output.example.number: string",
      "output.type: string",
    ]);
    // And the accepted one, read the same way. The literal above is what makes
    // this test fail on a change of ours; this is what makes it fail on a
    // change that walks away from the shape that passed.
    expect(unique(skeleton(acceptedOnGet).map(named))).toStrictEqual(
      unique(skeleton(ourDeclaration("GET").info).map(named)),
    );
  });

  it("names the schema dialect where the accepted shape names it, and nowhere else", () => {
    // Ours is built partly from a document rendered on its own — the purchase
    // body — and a document rendered on its own names its dialect at the top.
    // Nested inside another schema that is a second declaration, in a place the
    // accepted shape has none. It is dropped on the way in, and the accepted
    // schema recorded above is what says where it belongs.
    const dialectsIn = (schema: unknown) =>
      skeleton(schema).filter((path) => path.includes("$schema"));

    expect(dialectsIn(ourDeclaration("POST").schema)).toStrictEqual(["$schema: string"]);
    expect(dialectsIn(acceptedSchemaOnPost)).toStrictEqual(
      dialectsIn(ourDeclaration("POST").schema),
    );
  });

  it("puts the same fields in the same places as the POST probe that was accepted", () => {
    expect(unique(skeleton(acceptedOnPost).map(named))).toStrictEqual(
      unique(skeleton(ourDeclaration("POST").info).map(named)),
    );
  });
});

/**
 * One path with the product's own field names taken out of it.
 *
 * The declarations being compared describe different products, so the names
 * under `body` and under `output.example` differ and are not the subject. What
 * is the subject is that both have a body and an example at all, and that the
 * protocol's own fields sit at the same places in both.
 */
const named = (path: string): string =>
  path
    .replace(/^(input\.body)\..*/, "$1.<field>")
    .replace(/^(input\.queryParams)\..*/, "$1.<field>")
    .replace(/^(output\.example)\..*/, "$1.<field>");

/** The same path once, however many of a product's own fields folded into it. */
const unique = (paths: readonly string[]): string[] => [...new Set(paths)].sort();
