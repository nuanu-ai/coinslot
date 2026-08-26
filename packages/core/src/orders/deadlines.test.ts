import { describe, expect, it } from "vitest";
import { deadlines, isArmed } from "./deadlines.js";
import { newOrder, T0, TEST_POLICY, TEST_PRICE } from "./fixtures.js";
import type { Order } from "./model.js";

/**
 * Deadlines are what keeps an order from hanging in the unknown. Every test
 * here answers the same question: if it failed, an order could wait forever,
 * or a timer could fire on an order that is no longer waiting for that thing.
 */

function at(order: Order, kind: string): number | undefined {
  return deadlines(order).find((deadline) => deadline.kind === kind)?.at;
}

describe("the deadlines of an order", () => {
  it("runs nothing while the price question is still out", () => {
    // An order that has not been quoted yet is waiting on the price check, and
    // that waiting is bounded by the price check's own silence rules, not by a
    // deadline of the order.
    const order = newOrder("sync", { priceCheck: "merchant" });

    expect(deadlines(order)).toStrictEqual([]);
  });

  it("gives a quoted price a life of its own", () => {
    // Portal, "Время вышло": the agent got a price and is thinking; when the
    // time runs out the price no longer holds.
    const order = newOrder("sync");

    expect(at(order, "quote_expiry")).toBe(T0 + TEST_POLICY.deadlines.quoteTtlMs);
  });

  it("stops the quote's clock once the payment is in flight", () => {
    // The money hole this closes: a quote expiring while the settle is on its
    // way would close an order that is about to be paid for.
    const order: Order = { ...newOrder("async"), payment: "verified" };

    expect(deadlines(order)).toStrictEqual([]);
  });

  it("holds the merchant to his own confirmation deadline", () => {
    const order: Order = {
      ...newOrder("confirm"),
      state: "awaiting_confirmation",
      timestamps: { ...newOrder("confirm").timestamps, confirmationRequestedAt: T0 + 5 },
    };

    expect(at(order, "confirmation_response")).toBe(
      T0 + 5 + TEST_POLICY.deadlines.confirmationResponseMs,
    );
  });

  it("holds the agent to his deadline to pay a confirmed order", () => {
    const order: Order = {
      ...newOrder("confirm"),
      state: "confirmed",
      timestamps: { ...newOrder("confirm").timestamps, confirmedAt: T0 + 7 },
    };

    expect(at(order, "payment_after_confirmation")).toBe(
      T0 + 7 + TEST_POLICY.deadlines.paymentAfterConfirmationMs,
    );
  });

  it("measures the synchronous budget from the agent's own purchase", () => {
    // The synchronous budget is ours and it is the ceiling on how long the
    // agent waits, so it starts when he asked and not when we got round to
    // him. An order that spent three seconds in the queue has three seconds
    // less of it, and the two timestamps below are deliberately different so
    // that measuring from the wrong one is visible here.
    const base = newOrder("sync");
    const order: Order = {
      ...base,
      state: "dispatched",
      payment: "verified",
      timestamps: { ...base.timestamps, paidAt: T0 + 1_000, dispatchedAt: T0 + 3_000 },
    };

    expect(at(order, "sync_response")).toBe(T0 + TEST_POLICY.deadlines.syncResponseMs);
    expect(at(order, "async_fulfillment")).toBeUndefined();
  });

  it("measures the merchant's fulfillment deadline from the moment money moved", () => {
    // The buyer's money is at risk from the settle onward, so that is when the
    // clock on the goods starts.
    const base = newOrder("async");
    const order: Order = {
      ...base,
      state: "dispatched",
      payment: "settled",
      timestamps: { ...base.timestamps, paidAt: T0 + 30 },
    };

    expect(at(order, "async_fulfillment")).toBe(T0 + 30 + TEST_POLICY.deadlines.asyncFulfillmentMs);
    expect(at(order, "sync_response")).toBeUndefined();
  });

  it("stops every clock once the merchant has produced the goods", () => {
    // In `fulfilled` the merchant has done his part and the settle is ours; a
    // deadline firing here would punish him for our step.
    const order: Order = { ...newOrder("sync"), state: "fulfilled", payment: "verified" };

    expect(deadlines(order)).toStrictEqual([]);
  });

  it("runs no deadline on a closed order or on an unpaid debt", () => {
    const closed: Order = { ...newOrder("async"), state: "delivered", payment: "settled" };
    const debt: Order = { ...newOrder("async"), state: "refund_due", payment: "settled" };

    expect(deadlines(closed)).toStrictEqual([]);
    expect(deadlines(debt)).toStrictEqual([]);
  });

  it("answers whether a given deadline is running at all", () => {
    const order = newOrder("sync");

    expect(isArmed(order, "quote_expiry")).toBe(true);
    expect(isArmed(order, "sync_response")).toBe(false);
  });

  it("uses the order's own policy and invents no numbers of its own", () => {
    // The pilot's numbers are not chosen yet. If the core ever grew a default,
    // an order would quietly acquire a deadline nobody agreed to.
    const base = newOrder("sync");
    const order: Order = {
      ...base,
      policy: {
        ...TEST_POLICY,
        deadlines: { ...TEST_POLICY.deadlines, quoteTtlMs: 42 },
      },
      price: TEST_PRICE,
    };

    expect(at(order, "quote_expiry")).toBe(T0 + 42);
  });
});
