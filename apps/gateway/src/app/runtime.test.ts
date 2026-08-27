/**
 * The fold from two switches to the one word the order machine is given.
 *
 * A merchant can stop selling altogether and can take one card off sale, and
 * the machine has exactly one guard for both. `sellingFor` is where the two
 * become the one, and it is tested here directly rather than only through a
 * purchase because one of its cases cannot be reached over HTTP at all: nothing
 * in the pilot sets a merchant to `departed`, so a defect in that branch would
 * sit in the code with every route green — and the day departure is wired up,
 * it would be a merchant who had left going on selling.
 */

import type { Card } from "@coinslot/contracts";
import { MERCHANT_SELLING } from "@coinslot/core";
import { describe, expect, it } from "vitest";
import type { StoredCard } from "../ports/store.js";
import { sellingFor } from "./runtime.js";

const card: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const stored = (paused: boolean): StoredCard => ({ id: "itm_1", card, asOf: 0, paused });

describe("what the order machine is told about one card", () => {
  it("sells only when the merchant is selling and the card is not paused", () => {
    expect(sellingFor("open", stored(false))).toBe("open");
  });

  it("refuses a card its merchant took off sale", () => {
    expect(sellingFor("open", stored(true))).toBe("paused");
  });

  it("refuses every card while the merchant is paused, whatever the card says", () => {
    expect(sellingFor("paused", stored(false))).toBe("paused");
    expect(sellingFor("paused", stored(true))).toBe("paused");
  });

  it("keeps a merchant who left apart from one who is merely paused", () => {
    // Leaving is not a heavier pause. A pause takes the cards off sale and the
    // orders already accepted play out; leaving closes those orders and leaves
    // the merchant owing refunds on whatever was paid for and not delivered.
    // Read as paused, a departure would tell everything downstream — the
    // rejection an agent gets, the word on a screen — that it can be undone by
    // pressing resume, which it cannot.
    expect(sellingFor("departed", stored(false))).toBe("departed");
    expect(sellingFor("departed", stored(true))).toBe("departed");
  });

  it("answers with a word the machine knows, for every case there is", () => {
    // The fold must never invent a fourth word, and it must be total: a case
    // falling through would reach `createOrder` as undefined and be refused by
    // its own exhaustiveness check at the birth of somebody's order.
    for (const merchant of MERCHANT_SELLING) {
      for (const paused of [true, false]) {
        expect(MERCHANT_SELLING, `${merchant} + ${paused}`).toContain(
          sellingFor(merchant, stored(paused)),
        );
      }
    }
  });
});
