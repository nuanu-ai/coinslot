import { describe, expect, it } from "vitest";
import { toJsonSchemas } from "./index.js";
import { SELLING_STATES, SellingStateSchema } from "./selling.js";

describe("whether a merchant is taking new orders", () => {
  // The promise: the merchant's cabinet, the merchant's own tooling and the
  // order machine use one word for the same situation. A cabinet that showed
  // "off" where the machine said "paused" would be a second vocabulary for one
  // switch, and the merchant would have to learn both.
  it("carries the three words the order machine is given, and no others", () => {
    for (const state of ["open", "paused", "departed"]) {
      expect(SellingStateSchema.safeParse(state).success, state).toBe(true);
    }
    for (const state of ["stopped", "off", "OPEN", "closed", ""]) {
      expect(SellingStateSchema.safeParse(state).success, JSON.stringify(state)).toBe(false);
    }
  });

  it("keeps leaving apart from pausing, because they are not the same thing", () => {
    // Pausing takes the cards off sale and lets the open orders play out.
    // Leaving closes them and leaves the merchant owing refunds on whatever
    // was paid for and never delivered. One word for both would let a merchant
    // reading a screen think a pause could be undone the same way a departure
    // can, which it cannot.
    expect(SELLING_STATES).toContain("paused");
    expect(SELLING_STATES).toContain("departed");
    expect(SellingStateSchema.parse("paused")).not.toBe(SellingStateSchema.parse("departed"));
  });

  it("reaches the reader who has the exported document and nothing else", () => {
    const document = toJsonSchemas().selling_state;

    expect(document.enum).toStrictEqual([...SELLING_STATES]);
    expect(document.description ?? "").toContain("paused");
  });
});
