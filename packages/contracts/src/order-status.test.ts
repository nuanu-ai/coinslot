import { describe, expect, it } from "vitest";
import { FulfillmentSchema } from "./card.js";
import { ORDER_STATUSES, OrderStatusSchema } from "./order-status.js";

describe("the status an order can be in", () => {
  // The promise: an agent asking what became of its purchase, and a merchant
  // restarting a worker and asking what is still open, get an answer from one
  // vocabulary. Two lists would mean two answers to one question, and the one
  // the state machine keeps would win silently.

  it("names every ending an agent can be told about", () => {
    // Compared as a set, not a sequence. The same list lives in the state
    // machine, and holding two files to one order would be a test failing over
    // something neither side means.
    expect([...ORDER_STATUSES].sort()).toStrictEqual(
      [
        "in_progress",
        "delivered",
        "rejected",
        "payment_unresolved",
        "declined",
        "expired",
        "cancelled",
        "refund_due",
        "refunded",
        "delivered_unpaid",
      ].sort(),
    );
  });

  it("keeps an unanswered charge apart from a purchase that did not happen", () => {
    // The distinction the fifth gate exists for. `rejected` says the buyer's
    // money did not move; `payment_unresolved` says nobody can say whether it
    // did. An agent told the first goes and buys the same thing elsewhere
    // without checking its wallet — which is a claim we would be making on no
    // evidence.
    expect(OrderStatusSchema.options).toContain("payment_unresolved");
    expect(OrderStatusSchema.options).toContain("rejected");
  });

  it("accepts each of them and nothing else", () => {
    for (const status of ORDER_STATUSES) {
      expect(OrderStatusSchema.safeParse(status).success, status).toBe(true);
    }
    for (const status of ["pending", "open", "paid", "IN_PROGRESS", ""]) {
      expect(OrderStatusSchema.safeParse(status).success, JSON.stringify(status)).toBe(false);
    }
  });

  it("refuses the machine's own words where they are finer than the buyer's", () => {
    // `failed` and `accepted` are states in the machine and not endings an
    // agent is told about: the first is folded into `rejected`, the second
    // into `in_progress`. Refusing them here is what keeps the two vocabularies
    // from being used as one — a gateway reaching for the machine's word finds
    // out at the boundary rather than shipping it to a buyer.
    for (const status of ["failed", "accepted", "dispatched", "quoted"]) {
      expect(OrderStatusSchema.safeParse(status).success, status).toBe(false);
    }
  });
});

describe("the vocabulary the machine and the contract share", () => {
  // These two lists exist in the state machine as well. They are wire names,
  // so this package is where they are decided — and if the machine ever drifts
  // from them, the agent's status and the merchant's card stop agreeing about
  // the same product.

  it("keeps the three fulfillment modes verbatim", () => {
    expect(FulfillmentSchema.options).toStrictEqual(["sync", "async", "confirm"]);
  });

  // The three recommended refusal codes are held to the same words in
  // `handler.test.ts`, beside the assertion that `RefusalSchema` accepts each
  // of them — which is the half this file never had. One list, one place.
});
