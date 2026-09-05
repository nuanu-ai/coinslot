/**
 * The seam between the wire's vocabularies and the words a merchant reads.
 *
 * A status with no word here reaches a merchant as `undefined` or as the raw
 * wire value, and the states most likely to be added later are the rare ones —
 * exactly the ones a merchant has never seen and cannot guess. So the maps are
 * walked from the contract's own lists rather than from their own keys: a value
 * added to a vocabulary fails here until somebody writes the sentence for it.
 */

import {
  FulfillmentSchema,
  ORDER_STATUSES,
  ReceiptOutcomeSchema,
  SELLING_STATES,
} from "@nuanu-ai/coinslot-contracts";
import { describe, expect, it } from "vitest";
import {
  FULFILLMENT_WORDS,
  moment,
  money,
  needsAttention,
  ORDER_WORDS,
  SELLING_WORDS,
} from "./words.js";

describe("the words a merchant reads", () => {
  it("has one for every state an order can be in", () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_WORDS[status]?.text, status).toBeTruthy();
      // And it is not the wire value dressed up: `refund_due` on a screen is
      // a field name, not a sentence.
      expect(ORDER_WORDS[status]?.text, status).not.toContain("_");
    }
  });

  it("covers every outcome a receipt can carry with the order's own words", () => {
    // A receipt's outcomes are a subset of the order's on purpose, so one map
    // serves both screens. A merchant reading "in progress" beside an order
    // and something else beside its receipt would go looking for two different
    // situations.
    for (const outcome of ReceiptOutcomeSchema.options) {
      expect(ORDER_WORDS[outcome]?.text, outcome).toBeTruthy();
    }
  });

  it("has one for every fulfillment mode and every selling state", () => {
    for (const mode of FulfillmentSchema.options) {
      expect(FULFILLMENT_WORDS[mode], mode).toBeTruthy();
    }
    for (const selling of SELLING_STATES) {
      expect(SELLING_WORDS[selling]?.text, selling).toBeTruthy();
    }
  });

  it("calls out the two endings that stay open owing something, and nothing else", () => {
    // An order merely under way is open and may well be the merchant's to
    // deliver — and this API cannot tell that from an order created a second
    // ago, so demanding attention for it would be a claim beyond the evidence.
    expect(needsAttention("refund_due")).toBe(true);
    expect(needsAttention("delivered_unpaid")).toBe(true);
    expect(needsAttention("in_progress")).toBe(false);
    expect(needsAttention("delivered")).toBe(false);
    expect(needsAttention("payment_unresolved")).toBe(false);
  });

  it("does not name a duty for an order that may be nobody's yet", () => {
    // `in_progress` folds an order the merchant has been handed with one that
    // an unpaid request opened a second ago and that closes unanswered half a
    // minute later, and nothing over this API tells the two apart. A word
    // about fulfilment or delivery reads as the first for both: on the orders
    // screen an order nobody had paid for stood as one the merchant owed goods
    // on, and then closed on its time limit without ever reaching them.
    expect(ORDER_WORDS.in_progress.text).not.toMatch(/fulfil|deliver|accept|owe/i);
    // And it still reads as something under way rather than as an ending.
    expect(ORDER_WORDS.in_progress.tone).toBe("busy");
  });

  it("does not turn a payment we never heard about into a refusal", () => {
    // The fifth gate in one word. An agent's purchase whose charge went
    // unanswered is not a purchase that did not happen, and a merchant told
    // otherwise would reconcile a payment that may well have been taken.
    expect(ORDER_WORDS.payment_unresolved.text).toContain("unknown");
    expect(ORDER_WORDS.payment_unresolved.text).not.toContain("refus");
    expect(ORDER_WORDS.payment_unresolved.tone).toBe("warn");
  });
});

describe("money and moments on a screen", () => {
  it("prints an amount exactly as it arrived", () => {
    // Money is a decimal string on the wire so that nothing turns it into a
    // float. A screen that rendered "5.00" as "5" would be the last place that
    // promise is kept, and the first place a merchant's books disagree.
    expect(money({ amount: "5.00", currency: "USD" })).toBe("5.00 USD");
    expect(money({ amount: "0.000001", currency: "USDC" })).toBe("0.000001 USDC");
    expect(money({ amount: "1234.50", currency: "USD" })).toBe("1234.50 USD");
  });

  it("says which zone a moment is in", () => {
    // The server has no idea what zone the reader is in, and a time rendered
    // in the server's zone with nothing to say so is off by hours on a receipt.
    expect(moment("2026-08-27T09:12:04Z")).toBe("2026-08-27 09:12:04 UTC");
    expect(moment("2026-08-27T11:12:04+02:00")).toBe("2026-08-27 09:12:04 UTC");
  });

  it("shows a moment it cannot read rather than inventing one", () => {
    expect(moment("not a moment")).toBe("not a moment");
  });

  it("keeps the seconds, because this is reconciled against a wallet", () => {
    // Cut to the minute, two payments a few seconds apart are one line twice
    // and the merchant matching transfers cannot tell which is which.
    expect(moment("2026-08-27T09:12:04Z")).not.toBe(moment("2026-08-27T09:12:39Z"));
  });
});
