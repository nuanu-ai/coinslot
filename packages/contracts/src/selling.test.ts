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

  it("says in the exported document that leaving is not a heavier pause", () => {
    // The distinction is the reason there are three words rather than a
    // boolean, and it is invisible from the shape: a reader with the document
    // and no TypeScript sees three strings. Pausing takes the cards off sale
    // and lets the open orders play out; leaving closes them and leaves the
    // merchant owing refunds on whatever was paid for and never delivered. A
    // reader who took a departure for a deeper pause would expect it to be
    // undone the way a pause is.
    const description = toJsonSchemas().selling_state.description ?? "";

    expect(description).toContain("already accepted play out");
    expect(description).toContain("closed with them");
    expect(description).toContain("not reachable by pausing");
  });

  it("reaches the reader who has the exported document and nothing else", () => {
    const document = toJsonSchemas().selling_state;

    expect(document.enum).toStrictEqual([...SELLING_STATES]);
    expect(document.description ?? "").toContain("paused");
  });
});
