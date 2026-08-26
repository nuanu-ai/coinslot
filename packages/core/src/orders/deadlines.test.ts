import { describe, expect, it } from "vitest";
import { deadlines, isArmed } from "./deadlines.js";
import { newOrder, T0, TEST_POLICY, TEST_PRICE } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Order } from "./model.js";
import { moneyInvariantViolations } from "./money.js";

/**
 * Deadlines are what keeps an order from hanging in the unknown. Every test
 * here answers the same question: if it failed, an order could wait forever,
 * or a timer could fire on an order that is no longer waiting for that thing.
 */

function at(order: Order, kind: string): number | undefined {
  return deadlines(order).find((deadline) => deadline.kind === kind)?.at;
}

describe("the deadlines of an order", () => {
  it("bounds the wait for the merchant to name a price, on its own budget", () => {
    // Two different waitings and two different numbers. This one is how long
    // we wait for him to answer at all, and running out of it is his silence;
    // the life of a price he did name is `quote_expiry` and is longer. Using
    // one number for both would let the price's life end a wait that ADR-0002
    // §3 says must go on to a sale.
    const order = newOrder("sync", { priceCheck: "merchant" });

    expect(deadlines(order)).toStrictEqual([
      { kind: "quote_response", at: T0 + TEST_POLICY.deadlines.quoteResponseMs },
    ]);
    expect(TEST_POLICY.deadlines.quoteResponseMs).not.toBe(TEST_POLICY.deadlines.quoteTtlMs);
  });

  it("keeps a settling order on a clock even when it has lost its start time", () => {
    // Such an order cannot come out of this package, but it can come out of a
    // store — and it is the one order that must never lose its clock, because
    // nothing but the settle's own outcome can move it and no clock means no
    // outcome. Frozen and invisible is the combination to avoid; this makes it
    // overdue and says so out loud.
    const base = newOrder("async");
    const stranded: Order = {
      ...base,
      payment: "settling",
      timestamps: { ...base.timestamps, settleStartedAt: null },
    };

    expect(deadlines(stranded)).toStrictEqual([{ kind: "settle_response", at: T0 }]);
    expect(moneyInvariantViolations(stranded).length).toBeGreaterThan(0);

    const closed = transition(stranded, {
      kind: "deadline_expired",
      at: T0 + 1,
      deadline: "settle_response",
    });

    expect(closed.ok).toBe(true);
  });

  it("gives a quoted price a life of its own", () => {
    // Portal, "Время вышло": the agent got a price and is thinking; when the
    // time runs out the price no longer holds.
    const order = newOrder("sync");

    expect(at(order, "quote_expiry")).toBe(T0 + TEST_POLICY.deadlines.quoteTtlMs);
  });

  it("hands the clock from the price to the charge once the settle is away", () => {
    // Two things at once. A quote expiring while the settle is on its way
    // would close an order that is about to be paid for; and a settle with no
    // clock on it at all would leave the order waiting for an answer that
    // never comes, with the agent told "not yet" forever.
    const base = newOrder("async");
    const order: Order = {
      ...base,
      payment: "settling",
      timestamps: { ...base.timestamps, settleStartedAt: T0 + 40 },
    };

    expect(deadlines(order)).toStrictEqual([
      { kind: "settle_response", at: T0 + 40 + TEST_POLICY.deadlines.settleResponseMs },
    ]);
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

  it("holds our own step to a deadline once the merchant has done his", () => {
    // In `fulfilled` the merchant has produced the goods and executing the
    // payment is ours. None of his deadlines may punish him for our step, and
    // ours may not run forever either: when it runs out he is told that the
    // goods went out and the money did not arrive.
    const base = newOrder("sync");
    const order: Order = {
      ...base,
      state: "fulfilled",
      payment: "settling",
      timestamps: { ...base.timestamps, settleStartedAt: T0 + 4_000 },
    };

    expect(deadlines(order)).toStrictEqual([
      { kind: "settle_response", at: T0 + 4_000 + TEST_POLICY.deadlines.settleResponseMs },
    ]);
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
