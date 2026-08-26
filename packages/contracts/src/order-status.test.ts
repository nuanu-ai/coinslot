import { describe, expect, it } from "vitest";
import { FulfillmentSchema } from "./card.js";
import { RECOMMENDED_REFUSAL_CODES } from "./handler.js";
import { ORDER_STATUSES, OrderStatusSchema } from "./order-status.js";

describe("the status an order can be in", () => {
  // The promise: an agent asking what became of its purchase, and a merchant
  // restarting a worker and asking what is still open, get an answer from one
  // vocabulary. Two lists would mean two answers to one question, and the one
  // the state machine keeps would win silently.

  it("names every state the machine can end an order in", () => {
    expect([...ORDER_STATUSES]).toStrictEqual([
      "in_progress",
      "delivered",
      "rejected",
      "declined",
      "expired",
      "cancelled",
      "refund_due",
      "refunded",
      "delivered_unpaid",
    ]);
  });

  it("accepts each of them and nothing else", () => {
    for (const status of ORDER_STATUSES) {
      expect(OrderStatusSchema.safeParse(status).success, status).toBe(true);
    }
    for (const status of ["pending", "open", "paid", "failed", "IN_PROGRESS", ""]) {
      expect(OrderStatusSchema.safeParse(status).success, JSON.stringify(status)).toBe(false);
    }
  });

  it("gives a purchase that is still running a name of its own", () => {
    // The fifth gate in one value: a purchase still running has a name, and it
    // is not the name of any ending. An agent that had to read silence as an
    // answer would take an unfinished order for a refused one.
    expect(OrderStatusSchema.safeParse("in_progress").success).toBe(true);
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

  it("keeps the three recommended refusal codes verbatim", () => {
    expect(Object.values(RECOMMENDED_REFUSAL_CODES)).toStrictEqual([
      "out_of_stock",
      "invalid_params",
      "cannot_fulfill",
    ]);
  });
});
