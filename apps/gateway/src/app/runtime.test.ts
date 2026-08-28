/**
 * The fold from two switches to the one word the order machine is given.
 *
 * A merchant can stop selling altogether and can take one card off sale, and
 * the machine has exactly one guard for both. `sellingFor` is where the two
 * become the one.
 *
 * What is here is only what a purchase cannot reach. Every combination of the
 * two switches that a merchant can actually get into is bought against in
 * `http/server.test.ts`, where the answer is a price or a refusal rather than a
 * word — and a fold that got any of them wrong dies there. Two cases are left,
 * and neither of them can be reached over HTTP: nothing in the pilot sets a
 * merchant to `departed`, so a defect in that branch would sit in the code with
 * every route green and surface the day departure is wired up as a merchant who
 * had left going on selling; and no route can ask for a combination the type
 * admits and the product does not yet produce, which is what the totality loop
 * is for.
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

const stored = (paused: boolean): StoredCard => ({
  id: "itm_1",
  merchantId: "mch_1",
  card,
  asOf: 0,
  paused,
});

describe("what the order machine is told about one card", () => {
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
