import { describe, expect, it } from "vitest";
import { bearerIn, keyMatches } from "./auth.js";
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
  it("matches only the key itself", () => {
    expect(keyMatches("a-merchant-key-long-enough", "a-merchant-key-long-enough")).toBe(true);
    expect(keyMatches("a-merchant-key-long-enougH", "a-merchant-key-long-enough")).toBe(false);
    // Keys of different lengths are compared without complaint, because the
    // comparison is over digests. Refusing to compare them would have said
    // something about the length of the real one.
    expect(keyMatches("short", "a-merchant-key-long-enough")).toBe(false);
    expect(keyMatches("", "a-merchant-key-long-enough")).toBe(false);
  });

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
    const shouted = paymentFingerprint(signed(authorised()));
    const whispered = paymentFingerprint(
      signed(
        authorised({
          from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          nonce: "0xabcdef0123456789",
        }),
      ),
    );

    expect(whispered).toBe(shouted);
  });

  it("is one fingerprint however the amounts are written", () => {
    // 1000000, "1000000" and "0xF4240" are one number to the chain.
    const asText = paymentFingerprint(signed({ proof: { value: "1000000" } }));
    expect(paymentFingerprint(signed({ proof: { value: 1_000_000 } }))).toBe(asText);
    expect(paymentFingerprint(signed({ proof: { value: "0xF4240" } }))).toBe(asText);
  });

  it("keys on the payer as well as the nonce, the way the token does", () => {
    // A token records authorizationState[authorizer][nonce]. Keyed on the nonce
    // alone, the first payer to use one would block every other payer who ever
    // picked the same — and a client that counts from one picks exactly those.
    const mine = paymentFingerprint(signed(authorised()));
    const yours = paymentFingerprint(
      signed(authorised({ from: "0xcccccccccccccccccccccccccccccccccccccccc" })),
    );

    expect(yours).not.toBe(mine);
  });

  it("changes when the nonce does", () => {
    expect(paymentFingerprint(signed(authorised({ nonce: "0x02" })))).not.toBe(
      paymentFingerprint(signed(authorised({ nonce: "0x01" }))),
    );
  });

  it("does not change when the agent rewrites everything it is allowed to rewrite", () => {
    // The requirements beside the payload are the agent's own unsigned copy of
    // what we asked for. If the fingerprint moved with them, one signature
    // would buy as many orders as the agent cared to relabel it for.
    const first = paymentFingerprint(signed(authorised()));
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

    expect(paymentFingerprint(relabelled)).toBe(first);
  });

  it("does not change when a field is added beside the signed authorisation", () => {
    const first = paymentFingerprint(signed(authorised()));
    const padded = signed({ ...authorised(), padding: "anything at all" });

    expect(paymentFingerprint(padded)).toBe(first);
  });

  it("falls back to the signature, canonicalised, and then to the whole payload", () => {
    // Not every scheme carries an authorisation under that name; whatever it
    // does carry, two spellings of one payment have to agree.
    const shouted = paymentFingerprint(signed({ signature: "0xDEADbeef" }));
    expect(paymentFingerprint(signed({ signature: "0xdeadBEEF" }))).toBe(shouted);
    expect(paymentFingerprint(signed({ signature: "0xdeadbeee" }))).not.toBe(shouted);

    const byPayload = paymentFingerprint(signed({ proof: { b: "0xFF", a: 1 } }));
    // The same payload written in another order, and in another case, is the
    // same payment.
    expect(paymentFingerprint(signed({ proof: { a: 1, b: "0xff" } }))).toBe(byPayload);
    expect(paymentFingerprint(signed({ proof: { a: 2, b: "0xff" } }))).not.toBe(byPayload);
  });
});
