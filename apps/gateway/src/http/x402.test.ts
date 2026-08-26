import { describe, expect, it } from "vitest";
import { bearerIn, keyMatches } from "./auth.js";
import { atomicUnits, PaymentEdge } from "./x402.js";

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
