import { describe, expect, it } from "vitest";
import type { CreateOrderInput } from "./create.js";
import { createOrder } from "./create.js";
import { deadlines } from "./deadlines.js";
import { transition } from "./machine.js";
import type { Effect, Order, OrderEvent, OrderPolicy, Price } from "./model.js";
import { modeOf } from "./model.js";
import { moneyInvariantViolations } from "./money.js";
import { outcomeFor } from "./outcome.js";

/**
 * One order, from the intent to buy to the receipt, built here from scratch:
 * no fixtures, no shared builders, nothing this file did not put together
 * itself. The fixtures make the other tests short, and short tests can agree
 * with each other about a mistake; this one walks the machine the way the
 * gateway will and asks at every step whether what came back is what a person
 * would expect to see.
 *
 * The product is the one the canon uses for the asynchronous mode in its own
 * check against a real merchant: an eSIM that is paid for at once and
 * provisioned afterwards (`docs/research/16-order-state-machine.md`,
 * "Проекция на Freeland"). The hiccup in the middle — a provisioning API that
 * was down when the order first arrived — is not from any table in the portal.
 */

const NOON = 1_772_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const POLICY: OrderPolicy = {
  deadlines: {
    quoteResponseMs: 5 * SECOND,
    quoteTtlMs: 2 * MINUTE,
    settleResponseMs: 30 * SECOND,
    syncResponseMs: 10 * SECOND,
    paymentAfterConfirmationMs: 5 * MINUTE,
    confirmationResponseMs: 30 * MINUTE,
    asyncFulfillmentMs: 4 * HOUR,
  },
  redelivery: { baseDelayMs: 2 * SECOND, factor: 4, maxDelayMs: 5 * MINUTE, maxAttempts: 6 },
};

/** What the card says the eSIM costs. */
const CARD_PRICE: Price = { amount: "9.00", currency: "USD", asOf: NOON - HOUR };

/** What the merchant's own price check answers when asked at the purchase. */
const LIVE_PRICE: Price = { amount: "9.50", currency: "USD", asOf: NOON };

const PURCHASE: CreateOrderInput = {
  id: "ord_e51m01",
  at: NOON,
  mode: modeOf("async"),
  policy: POLICY,
  priceCheck: "merchant",
  cardPrice: CARD_PRICE,
  test: false,
  selling: "open",
};

function step(order: Order, event: OrderEvent): { order: Order; effects: readonly Effect[] } {
  const result = transition(order, event);
  if (!result.ok) {
    throw new Error(
      `${event.kind} was refused in ${order.state}: ${result.rejection.code} — ` +
        result.rejection.message,
    );
  }
  // Whatever else a step does, it may not leave the money and the state
  // disagreeing. Checking it here rather than at the end catches the step that
  // did it rather than the one that inherited it.
  expect(moneyInvariantViolations(result.order), `after ${event.kind}`).toStrictEqual([]);
  return { order: result.order, effects: result.effects };
}

describe("one eSIM, bought and provisioned, with the provisioner down at first", () => {
  it("walks from the intent to buy to the receipt", () => {
    // The agent found the card and its parameters passed the card's schema.
    // The card carries a price check, so nothing is quoted yet.
    const created = createOrder(PURCHASE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.order.state).toBe("created");
    expect(created.order.price).toBeNull();
    expect(created.effects).toStrictEqual([{ kind: "request_quote" }]);
    expect(outcomeFor(created.order)).toBe("in_progress");
    // Even here the order is on a clock, and it is the one that bounds how
    // long we wait for the merchant to name a price — not the life of a price
    // he has not named yet.
    expect(deadlines(created.order)).toStrictEqual([
      { kind: "quote_response", at: NOON + 5 * SECOND },
    ]);

    // The merchant answers. He has the eSIM and it costs fifty cents more than
    // the card's snapshot said, so the sale goes at his number.
    const quoted = step(created.order, {
      kind: "quote_answered",
      at: NOON + SECOND,
      available: true,
      price: LIVE_PRICE,
    });

    expect(quoted.order.state).toBe("quoted");
    expect(quoted.order.price).toStrictEqual(LIVE_PRICE);
    expect(quoted.order.quoteSource).toBe("merchant_answer");
    expect(quoted.effects).toStrictEqual([{ kind: "verify_payment" }]);
    expect(deadlines(quoted.order)).toStrictEqual([
      { kind: "quote_expiry", at: NOON + SECOND + 2 * MINUTE },
    ]);

    // The agent's payment checks out. This is an eSIM, so the money moves at
    // the purchase and not after the goods.
    const verified = step(quoted.order, { kind: "payment_verified", at: NOON + 2 * SECOND });

    expect(verified.order.state).toBe("quoted");
    expect(verified.order.payment).toBe("settling");
    expect(verified.effects).toStrictEqual([{ kind: "execute_payment" }]);
    // The price stops being what this order is waiting on the moment the
    // settle is in flight, so nothing can expire it out from under the money.
    // What the order waits on now is the answer about the charge, and that has
    // a clock of its own.
    expect(deadlines(verified.order)).toStrictEqual([
      { kind: "settle_response", at: NOON + 2 * SECOND + 30 * SECOND },
    ]);

    const paid = step(verified.order, { kind: "payment_settled", at: NOON + 3 * SECOND });

    expect(paid.order.state).toBe("paid");
    expect(paid.order.payment).toBe("settled");
    expect(paid.effects).toStrictEqual([{ kind: "dispatch_order" }]);
    // The merchant's four hours start here, where the buyer's money went.
    expect(deadlines(paid.order)).toStrictEqual([
      { kind: "async_fulfillment", at: NOON + 3 * SECOND + 4 * HOUR },
    ]);

    const dispatched = step(paid.order, { kind: "order_dispatched", at: NOON + 4 * SECOND });

    expect(dispatched.order.state).toBe("dispatched");
    expect(dispatched.order.dispatch).toStrictEqual({ attempts: 1, accepted: false });

    // The provisioning API is down and the handler throws. That is not an
    // answer, so the order comes back rather than closing.
    const threw = step(dispatched.order, { kind: "handler_undelivered", at: NOON + 5 * SECOND });

    expect(threw.order.state).toBe("dispatched");
    expect(threw.effects).toStrictEqual([
      { kind: "redeliver_order", attempt: 2, delayMs: 2 * SECOND },
    ]);

    const again = step(threw.order, { kind: "order_dispatched", at: NOON + 7 * SECOND });

    expect(again.order.dispatch.attempts).toBe(2);

    // This time the handler takes the order on: the profile will be issued,
    // but not in this answer.
    const accepted = step(again.order, { kind: "handler_accepted", at: NOON + 8 * SECOND });

    expect(accepted.order.dispatch.accepted).toBe(true);
    expect(accepted.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "accepted" } },
    ]);
    expect(outcomeFor(accepted.order)).toBe("in_progress");

    // Twenty minutes later the profile exists and the merchant says so. Well
    // inside his four hours.
    const delivered = step(accepted.order, { kind: "deliver_called", at: NOON + 20 * MINUTE });

    expect(delivered.order.state).toBe("delivered");
    expect(delivered.effects).toStrictEqual([
      { kind: "release_goods_to_agent" },
      { kind: "issue_receipt" },
      { kind: "answer_merchant", answer: { ok: true, result: "delivered" } },
    ]);
    expect(outcomeFor(delivered.order)).toBe("delivered");
    expect(deadlines(delivered.order)).toStrictEqual([]);

    // The queue delivers at least once, so the same order turns up again and
    // the handler takes it on a second time. Nothing else happens to the order,
    // and he is told the state it is in rather than that the work is his: there
    // is no second profile to issue.
    const duplicate = step(delivered.order, { kind: "order_dispatched", at: NOON + 21 * MINUTE });
    const answeredAgain = step(duplicate.order, {
      kind: "handler_accepted",
      at: NOON + 21 * MINUTE + SECOND,
    });

    expect(answeredAgain.order.state).toBe("delivered");
    expect(duplicate.effects).toStrictEqual([]);
    expect(answeredAgain.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);

    // And the merchant's own retry of the deliver call after a broken
    // connection gets the same success back, with no second profile issued.
    const deliveredTwice = step(answeredAgain.order, {
      kind: "deliver_called",
      at: NOON + 22 * MINUTE,
    });

    expect(deliveredTwice.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
    expect(deliveredTwice.order.price).toStrictEqual(LIVE_PRICE);
    expect(deliveredTwice.order.payment).toBe("settled");
    expect(outcomeFor(deliveredTwice.order)).toBe("delivered");
  });

  it("would have owed the buyer a refund had the four hours run out instead", () => {
    // The same order, taken to the same point and then left. This is the arm
    // of the story where the merchant's side never comes back, and it is the
    // one that has to leave a record rather than a closed order.
    const created = createOrder(PURCHASE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let order = created.order;
    for (const event of [
      { kind: "quote_answered", at: NOON + SECOND, available: true, price: LIVE_PRICE },
      { kind: "payment_verified", at: NOON + 2 * SECOND },
      { kind: "payment_settled", at: NOON + 3 * SECOND },
      { kind: "order_dispatched", at: NOON + 4 * SECOND },
      { kind: "handler_accepted", at: NOON + 5 * SECOND },
    ] satisfies OrderEvent[]) {
      order = step(order, event).order;
    }

    const late = step(order, {
      kind: "deadline_expired",
      at: NOON + 3 * SECOND + 4 * HOUR,
      deadline: "async_fulfillment",
    });

    expect(late.order.state).toBe("refund_due");
    expect(late.order.payment).toBe("settled");
    expect(late.effects).toStrictEqual([
      {
        kind: "mark_refund_due",
        closure: { cause: "deadline_expired", deadline: "async_fulfillment" },
      },
      { kind: "emit_merchant_event", event: "order.refund_due" },
    ]);
    expect(outcomeFor(late.order)).toBe("refund_due");

    // And a profile that shows up an hour late still closes the debt, because
    // the buyer paid for goods and late goods beat a refund.
    const rescued = step(late.order, { kind: "deliver_called", at: NOON + 5 * HOUR });

    expect(rescued.order.state).toBe("delivered");
    expect(outcomeFor(rescued.order)).toBe("delivered");
    expect(rescued.effects).toContainEqual({
      kind: "answer_merchant",
      answer: { ok: true, result: "debt_closed_by_delivery" },
    });
  });
});
