import { describe, expect, it } from "vitest";
import { must, newOrder, reach, sampleEvent, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Effect, Order } from "./model.js";
import { ORDER_EVENT_KINDS, ORDER_STATES } from "./model.js";
import { moneyInvariantViolations } from "./money.js";

/**
 * The invariants that make this package worth writing. Every test below is a
 * promise about somebody else's money, and every one of them names what breaks
 * for a real person if it fails.
 */

const MONEY_EFFECTS: readonly Effect["kind"][] = ["execute_payment", "release_goods_to_agent"];

function moved(effects: readonly Effect[]): readonly string[] {
  return effects.map((effect) => effect.kind).filter((kind) => MONEY_EFFECTS.includes(kind));
}

describe("the invariants of the order's money", () => {
  it("holds in every state the machine can reach", () => {
    for (const state of ORDER_STATES) {
      expect(moneyInvariantViolations(reach(state)), `an order in ${state}`).toStrictEqual([]);
    }
  });

  it("holds after every event the machine accepts, from every state", () => {
    // The gateway will feed this machine pairings nobody planned. If a single
    // one of them produced an order where the money and the state disagree, a
    // buyer would be out of pocket with no record saying so.
    let accepted = 0;

    for (const state of ORDER_STATES) {
      for (const kind of ORDER_EVENT_KINDS) {
        const result = transition(reach(state), sampleEvent(kind));
        if (!result.ok) continue;
        accepted += 1;
        expect(
          moneyInvariantViolations(result.order),
          `${state} on ${kind} produced ${result.order.state}/${result.order.payment}`,
        ).toStrictEqual([]);
      }
    }

    expect(accepted).toBeGreaterThan(60);
  });

  // The negative controls. Without them the invariants would be decoration and
  // the two sweeps above would prove nothing.
  //
  // Each one names the rule it is about by the sentence that rule writes, and
  // reads the whole list rather than its length. The sentence is not an
  // implementation detail: `refuseToWriteAnImpossibleOrder` in the gateway
  // joins these into the error a person reads when an order will not persist,
  // and it is all that person is given to work out which of eight things went
  // wrong.
  //
  // Asserting only that some rule fired cost more than it looks. Four of the
  // eight rules could be deleted one at a time with the whole suite green,
  // because a control that reads a length is satisfied by any other rule that
  // fires on the same order; and seven of the eight sentences could be replaced
  // with "xxx", the exception being the one the gateway's own test reads out of
  // the error text.
  //
  // Two of the rules are narrower restatements of the first, which catches any
  // settled order in a state that records neither goods nor a debt. They earn
  // their place by saying something sharper about the two cases that matter
  // most, and reading the full list is what holds them to it.

  it("catches an order that claims a debt without a charge behind it", () => {
    const impossible: Order = { ...reach("dispatched"), state: "refund_due", payment: "none" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the order is in refund_due with no charge behind the debt",
    ]);
  });

  it("catches a success that nobody paid for", () => {
    const impossible: Order = { ...reach("dispatched"), state: "delivered", payment: "verified" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the order is a success and the money never moved",
    ]);
  });

  it("catches money taken on an order closed as free", () => {
    const impossible: Order = { ...reach("dispatched"), state: "expired", payment: "settled" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the buyer paid and the order sits in expired, which records neither goods nor a debt",
      "the buyer paid and the order is closed as expired, owing nothing",
    ]);
  });

  it("catches an order marked unpaid while the buyer's money did move", () => {
    const impossible: Order = { ...reach("delivered_unpaid"), payment: "settled" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the buyer paid and the order sits in delivered_unpaid, which records neither goods nor a debt",
      "the order is marked unpaid and the money did move",
    ]);
  });

  it("catches an order carrying on with an unaccounted charge behind it", () => {
    // There are two places to wait for a payment layer that went quiet, and
    // both are orders the machine has stopped moving. Anywhere else is an
    // order going about its business with an open question about the buyer's
    // money behind it.
    const impossible: Order = { ...reach("dispatched"), payment: "outcome_unknown" };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "a charge on this order never reported back and the order is in dispatched, " +
        "which is not a place to wait in",
    ]);
  });

  it("catches an order that moved on while its charge was still being executed", () => {
    // The machine will not produce this, and that is exactly why the rule is
    // here: it is the shape the gateway's own records have to be checked
    // against. Whatever the charge does now, it happens to a decided order.
    const dispatched = reach("dispatched");
    const impossible: Order = {
      ...dispatched,
      state: "cancelled",
      payment: "settling",
      // The charge has a start time, so the only thing wrong with this order is
      // the state it moved on to.
      timestamps: { ...dispatched.timestamps, settleStartedAt: T0 + 3 },
    };

    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the payment is being executed and the order has moved on to cancelled, " +
        "so whatever happens to the money now happens to a decided order",
    ]);
  });

  it("catches a charge in flight with no record of when it started", () => {
    // Nothing but the settle's own outcome moves an order in this stage, and
    // the outcome is asked for on a clock that runs from this instant. Without
    // it the order is frozen and invisible, which is the one way an order can
    // wait forever with the buyer's money in the air.
    //
    // `deadlines.test.ts` already reaches for this rule while proving that such
    // an order keeps its clock. This is its own control, in the file the rule
    // lives beside, and it is what pins the sentence.
    const fulfilled = reach("fulfilled");
    const impossible: Order = {
      ...fulfilled,
      timestamps: { ...fulfilled.timestamps, settleStartedAt: null },
    };

    expect(fulfilled.payment).toBe("settling");
    expect(moneyInvariantViolations(impossible)).toStrictEqual([
      "the payment is being executed and the order has no record of when that began",
    ]);
  });
});

describe("a refusal before the charge never creates a debt", () => {
  const refusalsBeforeMoney: readonly [string, Order][] = [
    ["a handler refusing a synchronous order", reach("failed")],
    ["a merchant declining a confirmation", reach("declined")],
    ["a price check saying the goods are gone", reach("rejected")],
  ];

  for (const [what, order] of refusalsBeforeMoney) {
    it(`leaves nothing owed after ${what}`, () => {
      expect(order.payment).not.toBe("settled");
      expect(order.state).not.toBe("refund_due");
      expect(moneyInvariantViolations(order)).toStrictEqual([]);
    });
  }
});

describe("money taken is always accounted for", () => {
  // The sweep that used to open this block walked the same sixteen states and
  // eighteen events as the one above and looked for one shape by hand: the
  // buyer's money gone and the order closed as though nothing were owed. Every
  // order it could have flagged breaks a rule the sweep above already reads —
  // money settled outside the states that may hold it, and a charge in flight
  // outside the states that may be charging — so it could only ever fail in
  // company. Measured, on a refunded order closed as cancelled by a departure:
  // both went red together, and deleting the hand-written one left the failure
  // exactly where it was.

  it("turns the departure of a merchant who was already paid into a debt", () => {
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);
    const { order } = must(paid, { kind: "merchant_departed", at: T0 + 3 });

    expect(order.state).toBe("refund_due");
  });
});

describe("an asynchronous purchase is never made at an unknown stock level", () => {
  it("never reaches a charge after a silent price check", () => {
    // ADR-0002 §3: an open failure here would produce orders where the money
    // is taken and the goods do not exist, while the refund mechanism is not
    // even chosen yet.
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    });

    expect(order.state).toBe("rejected");

    for (const kind of ORDER_EVENT_KINDS) {
      const result = transition(order, sampleEvent(kind));
      if (!result.ok) continue;
      expect(result.order.payment, `${kind} after a silent check`).not.toBe("settled");
    }
  });
});

describe("a repeat never charges twice and never fulfills twice", () => {
  it("moves no money when the purchase is repeated on an order already delivered", () => {
    const delivered = reach("delivered");
    const { order, effects } = must(delivered, { kind: "purchase_repeated", at: T0 + 99 });

    expect(order).toStrictEqual(delivered);
    expect(moved(effects)).toStrictEqual([]);
  });

  it("asks for no second fulfillment when a repeat closes an unpaid delivery", () => {
    const closing = walk(reach("delivered_unpaid"), [
      { kind: "purchase_repeated", at: T0 + 6 },
      { kind: "payment_verified", at: T0 + 7 },
    ]);
    const { order, effects } = must(closing, { kind: "payment_settled", at: T0 + 8 });

    expect(order.state).toBe("delivered");
    expect(moved(effects)).toStrictEqual(["release_goods_to_agent"]);
    expect(effects.map((effect) => effect.kind)).not.toContain("dispatch_order");
  });
});
