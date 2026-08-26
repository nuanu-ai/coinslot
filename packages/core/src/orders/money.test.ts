import { describe, expect, it } from "vitest";
import { must, newOrder, reach, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Effect, Order, OrderEvent, OrderState } from "./model.js";
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

function sampleEvent(kind: (typeof ORDER_EVENT_KINDS)[number]): OrderEvent {
  switch (kind) {
    case "quote_answered":
      return {
        kind,
        at: T0 + 1,
        available: true,
        price: { amount: "1.00", currency: "USD", asOf: T0 },
      };
    case "handler_refused":
      return { kind, at: T0 + 1, code: "out_of_stock", message: "none" };
    case "refuse_called":
      return { kind, at: T0 + 1, code: "out_of_stock", message: "none" };
    case "payment_verification_failed":
      return { kind, at: T0 + 1, reason: "signature" };
    case "deadline_expired":
      return { kind, at: T0 + 1_000_000, deadline: "sync_response" };
    default:
      return { kind, at: T0 + 1 };
  }
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

  it("catches an order that claims a debt without a charge behind it", () => {
    // The negative control. If this passed, the invariants would be decoration
    // and the test above would prove nothing.
    const impossible: Order = { ...reach("dispatched"), state: "refund_due", payment: "none" };

    expect(moneyInvariantViolations(impossible).length).toBeGreaterThan(0);
  });

  it("catches a success that nobody paid for", () => {
    const impossible: Order = { ...reach("dispatched"), state: "delivered", payment: "verified" };

    expect(moneyInvariantViolations(impossible).length).toBeGreaterThan(0);
  });

  it("catches money taken on an order closed as free", () => {
    const impossible: Order = { ...reach("dispatched"), state: "expired", payment: "settled" };

    expect(moneyInvariantViolations(impossible).length).toBeGreaterThan(0);
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
  it("leaves no closed state in which the buyer paid and nothing says so", () => {
    // Walk every state the machine can reach and every event it accepts, and
    // check the one thing that must never happen: the buyer's money gone and
    // the order closed as though nothing was owed.
    const settledAndClosed: string[] = [];
    let accepted = 0;

    for (const state of ORDER_STATES) {
      for (const kind of ORDER_EVENT_KINDS) {
        const result = transition(reach(state), sampleEvent(kind));
        if (!result.ok) continue;
        accepted += 1;

        const after = result.order;
        const owedNothing: readonly OrderState[] = [
          "rejected",
          "declined",
          "expired",
          "cancelled",
          "failed",
        ];
        // "settling" belongs here too: it is the window in which the machine
        // does not know whether the money moved, and closing an order as free
        // on a guess is exactly the mistake this list exists to catch.
        const moneyMayHaveMoved = after.payment === "settled" || after.payment === "settling";
        if (moneyMayHaveMoved && owedNothing.includes(after.state)) {
          settledAndClosed.push(`${state} on ${kind} -> ${after.state}/${after.payment}`);
        }
      }
    }

    expect(settledAndClosed).toStrictEqual([]);
    expect(accepted).toBeGreaterThan(60);
  });

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
