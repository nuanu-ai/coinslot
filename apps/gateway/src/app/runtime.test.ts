/**
 * The fold from four facts to the one word the order machine is given.
 *
 * A merchant can stop selling altogether, can take one card off sale, can have
 * nowhere for the money to go, and can be listed under no name for the sale to
 * be made under — and the machine has exactly one guard for all four.
 * `sellingFor` is where they become the one; the last two reach it through
 * `sellableBy`, because from the order's side they are one fact: this merchant
 * cannot make a sale.
 *
 * What is here is only what a purchase cannot reach. Every combination a
 * merchant can actually get into is bought against over HTTP — the two switches
 * in `http/server.test.ts` and the missing address in `http/payout-wallet.test.ts`
 * — where the answer is a price or a refusal rather than a word, and a fold that
 * got any of them wrong dies there. Two cases are left, and neither can be
 * reached over HTTP: nothing in the pilot sets a merchant to `departed`, so a
 * defect in that branch would sit in the code with every route green and
 * surface the day departure is wired up as a merchant who had left going on
 * selling; and no route can ask for a combination the type admits and the
 * product does not yet produce, which is what the totality loop is for.
 */

import type { Card } from "@coinslot/contracts";
import { MERCHANT_SELLING } from "@coinslot/core";
import { describe, expect, it } from "vitest";
import { SANDBOX_FACILITATOR } from "../config.js";
import type { StoredCard } from "../ports/store.js";
import { testConfig } from "../testing/harness.js";
import { sellableBy, sellingFor } from "./runtime.js";

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
    expect(sellingFor("departed", stored(false), true)).toBe("departed");
    expect(sellingFor("departed", stored(true), true)).toBe("departed");
    // And a merchant who left with no address to be paid at has still left:
    // read as paused, their open orders would look like something a resume
    // could bring back.
    expect(sellingFor("departed", stored(false), false)).toBe("departed");
  });

  it("answers with a word the machine knows, for every case there is", () => {
    // The fold must never invent a fourth word, and it must be total: a case
    // falling through would reach `createOrder` as undefined and be refused by
    // its own exhaustiveness check at the birth of somebody's order.
    for (const merchant of MERCHANT_SELLING) {
      for (const paused of [true, false]) {
        for (const sellable of [true, false]) {
          expect(MERCHANT_SELLING, `${merchant} + ${paused} + ${sellable}`).toContain(
            sellingFor(merchant, stored(paused), sellable),
          );
        }
      }
    }
  });
});

describe("whether a merchant could make a sale at all", () => {
  const real = testConfig();
  const sandbox = testConfig({ FACILITATOR_URL: SANDBOX_FACILITATOR });
  const wallet = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

  it("says no to a merchant with nobody for the payment request to name", () => {
    // The state a merchant is put in by `merchant listed-as <id> --none`, with
    // cards already published and selling. A payment request carries the name
    // of the seller, and a card of theirs would go out inside one that names
    // nobody: the agent is invited to pay a stranger it cannot identify, and
    // the gateway has shipped exactly that once. Off sale is the honest answer
    // and the merchant already knows how to put it right.
    expect(sellableBy({ payoutWallet: wallet, serviceName: null }, real)).toBe(false);
    // And the other half, or the line above would pass against a gateway that
    // had stopped selling for everybody.
    expect(sellableBy({ payoutWallet: wallet, serviceName: "Someone's shop" }, real)).toBe(true);
  });

  it("says no to a merchant with nowhere for the money to go", () => {
    expect(sellableBy({ payoutWallet: null, serviceName: "Someone's shop" }, real)).toBe(false);
  });

  it("excuses the wallet in the sandbox and never the name", () => {
    // The two rules are not one rule. The sandbox settles against nothing, so
    // there is no money to send and no address to be missing (ADR-0008) — but
    // the name is not about money at all: it is what the request calls the
    // seller, and a challenge in a sandbox names one exactly as a real one
    // does. A local stack sells with no wallet configured anywhere; nothing
    // sells under nobody's name.
    expect(sellableBy({ payoutWallet: null, serviceName: "Someone's shop" }, sandbox)).toBe(true);
    expect(sellableBy({ payoutWallet: null, serviceName: null }, sandbox)).toBe(false);
    expect(sellableBy({ payoutWallet: wallet, serviceName: null }, sandbox)).toBe(false);
  });
});
