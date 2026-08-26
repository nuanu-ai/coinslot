import { describe, expect, it } from "vitest";
import { deadlines } from "./deadlines.js";
import { must, newOrder, reach, T0, TEST_POLICY, TEST_PRICE, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Effect, Order, OrderEvent, OrderEventKind, OrderState, Price } from "./model.js";
import { ORDER_EVENT_KINDS, ORDER_STATES, PAYMENT_STAGES } from "./model.js";
import { moneyInvariantViolations } from "./money.js";
import { ORDER_OUTCOMES, outcomeFor } from "./outcome.js";

const MERCHANT_PRICE: Price = { amount: "6.50", currency: "USD", asOf: T0 + 1 };

function kinds(effects: readonly Effect[]): readonly string[] {
  return effects.map((effect) => effect.kind);
}

function sampleEvent(kind: OrderEventKind): OrderEvent {
  switch (kind) {
    case "quote_answered":
      return { kind, at: T0 + 1, available: true, price: MERCHANT_PRICE };
    case "handler_refused":
      return { kind, at: T0 + 1, code: "out_of_stock", message: "none left" };
    case "refuse_called":
      return { kind, at: T0 + 1, code: "cannot_fulfill", message: "supplier is silent" };
    case "payment_verification_failed":
      return { kind, at: T0 + 1, reason: "insufficient_funds" };
    case "deadline_expired":
      return { kind, at: T0 + 1_000_000, deadline: "sync_response" };
    default:
      return { kind, at: T0 + 1 };
  }
}

describe("the shape of the machine", () => {
  it("reaches every state in the vocabulary through legal events alone", () => {
    // A state nothing can walk to is a claim the machine cannot back up. This
    // test is what keeps the vocabulary honest.
    for (const state of ORDER_STATES) {
      expect(reach(state).state, `walking to ${state}`).toBe(state);
    }
  });

  it("answers every pairing of a state and an event without throwing", () => {
    // The gateway feeds this machine events that came off a queue with
    // at-least-once delivery, so it will see pairings nobody planned. Each one
    // gets either a transition or a named refusal — never an exception, and
    // never a silent nothing.
    let accepted = 0;

    for (const state of ORDER_STATES) {
      for (const kind of ORDER_EVENT_KINDS) {
        const before = reach(state);
        const result = transition(before, sampleEvent(kind));
        const where = `${state} on ${kind}`;

        if (!result.ok) {
          expect(result.rejection.state, where).toBe(state);
          expect(result.rejection.event, where).toBe(kind);
          expect(result.rejection.message.length, where).toBeGreaterThan(0);
          continue;
        }

        accepted += 1;
        // Whatever it did, what came back has to be an order: a real state, a
        // real payment stage, an outcome the agent can be told, the money and
        // the state in agreement, and the same order it was handed.
        expect(ORDER_STATES, where).toContain(result.order.state);
        expect(PAYMENT_STAGES, where).toContain(result.order.payment);
        expect(ORDER_OUTCOMES, where).toContain(outcomeFor(result.order));
        expect(moneyInvariantViolations(result.order), where).toStrictEqual([]);
        expect(result.order.id, where).toBe(before.id);
        expect(result.order.mode, where).toStrictEqual(before.mode);
      }
    }

    // A floor under the loop: if a change made every pairing illegal, the
    // checks above would pass while exercising nothing at all.
    expect(accepted).toBeGreaterThan(60);
  });

  it("never changes the order it was given", () => {
    // The gateway keeps the previous order around to write an audit row. A
    // machine that mutated its input would rewrite history under it.
    const order = reach("dispatched");
    const before = structuredClone(order);

    must(order, { kind: "handler_delivered", at: T0 + 9 });

    expect(order).toStrictEqual(before);
  });
});

describe("pricing the purchase", () => {
  it("takes the merchant's price over the card's snapshot", () => {
    // ADR-0002 §2: the live answer outranks the snapshot and carries its own
    // `as_of`, which is what the receipt later points at.
    const { order, effects } = must(newOrder("sync", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: true,
      price: MERCHANT_PRICE,
    });

    expect(order.state).toBe("quoted");
    expect(order.price).toStrictEqual(MERCHANT_PRICE);
    expect(order.quoteSource).toBe("merchant_answer");
    expect(kinds(effects)).toStrictEqual(["verify_payment"]);
  });

  it("closes the purchase before any money when the goods are not there", () => {
    // Portal, "Товар кончился": said in time, the buyer's money does not move.
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: false,
    });

    expect(order.state).toBe("rejected");
    expect(order.payment).toBe("none");
    expect(order.closure).toStrictEqual({ cause: "unavailable" });
  });

  it("sells a synchronous card at its snapshot price when the check goes silent", () => {
    // ADR-0002 §3, open failure: the merchant's live answer still stands
    // between the price and the money, so a second of silence must not cancel
    // a sale that can be carried out honestly at a known price.
    const { order, effects } = must(newOrder("sync", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    });

    expect(order.state).toBe("quoted");
    expect(order.price).toStrictEqual(TEST_PRICE);
    expect(order.quoteSource).toBe("card_snapshot");
    expect(kinds(effects)).toStrictEqual(["verify_payment"]);
  });

  it("sells a card with confirmation at its snapshot price when the check goes silent", () => {
    const { order, effects } = must(newOrder("confirm", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    });

    expect(order.state).toBe("quoted");
    expect(kinds(effects)).toStrictEqual(["dispatch_confirmation_request"]);
  });

  it("refuses to start an asynchronous purchase when the check goes silent", () => {
    // ADR-0002 §3, closed failure: here the money moves before the merchant is
    // asked anything, so an open failure would manufacture debts to buyers
    // while the refund mechanism is still unchosen.
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    });

    expect(order.state).toBe("rejected");
    expect(order.payment).toBe("none");
    expect(order.closure).toStrictEqual({ cause: "quote_silent" });
  });
});

describe("the synchronous mode: refusal before the charge", () => {
  it("verifies the payment before the order goes anywhere near the merchant", () => {
    const { order, effects } = must(newOrder("sync"), { kind: "payment_verified", at: T0 + 1 });

    expect(order.state).toBe("paid");
    expect(order.payment).toBe("verified");
    expect(kinds(effects)).toStrictEqual(["dispatch_order"]);
  });

  it("executes the payment only after the goods have come back", () => {
    const dispatched = reach("dispatched");
    const fulfilled = must(dispatched, { kind: "handler_delivered", at: T0 + 4 });

    expect(fulfilled.order.state).toBe("fulfilled");
    expect(fulfilled.order.payment).toBe("verified");
    expect(kinds(fulfilled.effects)).toStrictEqual(["execute_payment"]);

    const delivered = must(fulfilled.order, { kind: "payment_settled", at: T0 + 5 });

    expect(delivered.order.state).toBe("delivered");
    expect(delivered.order.payment).toBe("settled");
    expect(kinds(delivered.effects)).toStrictEqual(["release_goods_to_agent", "issue_receipt"]);
  });

  it("leaves the buyer untouched when the handler refuses", () => {
    // Portal, "Чем заказ может закончиться": you refused in the synchronous
    // mode, the money did not move, the agent sees a refusal with a reason.
    const { order } = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "out_of_stock",
      message: "no SIM left",
    });

    expect(order.state).toBe("failed");
    expect(order.payment).toBe("verified");
    expect(order.closure).toStrictEqual({
      cause: "merchant_refused",
      code: "out_of_stock",
      message: "no SIM left",
    });
  });

  it("has no separate deliver call at all", () => {
    // Portal: in the synchronous mode the handler answers with the goods
    // themselves. A `deliver` call there is a typed answer, not an exception.
    const { effects } = must(reach("dispatched"), { kind: "deliver_called", at: T0 + 4 });

    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "not_applicable_in_mode", retryable: false },
      },
    ]);
  });
});

describe("the asynchronous mode: the money moves first", () => {
  it("executes the payment at the purchase, before the merchant is asked", () => {
    const verified = must(newOrder("async"), { kind: "payment_verified", at: T0 + 1 });

    expect(verified.order.state).toBe("quoted");
    expect(verified.order.payment).toBe("verified");
    expect(kinds(verified.effects)).toStrictEqual(["execute_payment"]);

    const paid = must(verified.order, { kind: "payment_settled", at: T0 + 2 });

    expect(paid.order.state).toBe("paid");
    expect(paid.order.payment).toBe("settled");
    expect(kinds(paid.effects)).toStrictEqual(["dispatch_order"]);
  });

  it("makes no order out of a purchase whose charge did not go through", () => {
    const verified = walk(newOrder("async"), [{ kind: "payment_verified", at: T0 + 1 }]);
    const { order } = must(verified, { kind: "payment_settle_failed", at: T0 + 2 });

    expect(order.state).toBe("rejected");
    expect(order.payment).toBe("settle_failed");
    expect(order.closure).toStrictEqual({ cause: "payment_not_settled" });
  });

  it("remembers that the handler took the order on", () => {
    const dispatched = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
    ]);
    const { order } = must(dispatched, { kind: "handler_accepted", at: T0 + 4 });

    expect(order.state).toBe("dispatched");
    expect(order.dispatch.accepted).toBe(true);
  });

  it("closes the order with the separate deliver call", () => {
    const accepted = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
      { kind: "handler_accepted", at: T0 + 4 },
    ]);
    const { order, effects } = must(accepted, { kind: "deliver_called", at: T0 + 60 });

    expect(order.state).toBe("delivered");
    expect(kinds(effects)).toStrictEqual([
      "release_goods_to_agent",
      "issue_receipt",
      "answer_merchant",
    ]);
  });

  it("marks the debt the moment the merchant refuses after the charge", () => {
    // Portal, "Отказаться после того, как приняли заказ": waiting for the
    // deadline to reach the same result by silence helps nobody — the buyer
    // learns of the debt the minute the merchant does.
    const sync = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "out_of_stock",
      message: "none left",
    });
    expect(sync.order.state).toBe("failed");
    expect(sync.effects).toStrictEqual([]);

    const async = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
      { kind: "handler_accepted", at: T0 + 4 },
    ]);
    const refused = must(async, {
      kind: "refuse_called",
      at: T0 + 5,
      code: "out_of_stock",
      message: "the supplier did not confirm the number",
    });

    expect(refused.order.state).toBe("refund_due");
    expect(refused.order.payment).toBe("settled");
    expect(kinds(refused.effects)).toStrictEqual([
      "mark_refund_due",
      "emit_merchant_event",
      "answer_merchant",
    ]);
  });
});

describe("the mode with confirmation: the question comes before the money", () => {
  it("asks the merchant while the buyer's money sits still", () => {
    const { order } = must(newOrder("confirm"), { kind: "confirmation_dispatched", at: T0 + 1 });

    expect(order.state).toBe("awaiting_confirmation");
    expect(order.payment).toBe("none");
  });

  it("gives the agent a deadline to pay once the merchant says he will", () => {
    const { order, effects } = must(reach("awaiting_confirmation"), {
      kind: "handler_accepted",
      at: T0 + 2,
    });

    expect(order.state).toBe("confirmed");
    expect(order.payment).toBe("none");
    expect(kinds(effects)).toStrictEqual(["invite_payment"]);
  });

  it("closes the purchase for nothing when the merchant says he will not", () => {
    // Portal, "Чем заказ может закончиться": a refusal, nothing charged.
    const { order } = must(reach("awaiting_confirmation"), {
      kind: "handler_refused",
      at: T0 + 2,
      code: "cannot_fulfill",
      message: "not this week",
    });

    expect(order.state).toBe("declined");
    expect(order.payment).toBe("none");
  });

  it("refuses goods handed over before the money moved", () => {
    // Portal: the merchant cannot fulfill straight into a confirmation
    // request, because nothing has been charged for it yet.
    const result = transition(reach("awaiting_confirmation"), {
      kind: "handler_delivered",
      at: T0 + 2,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("delivery_before_payment");
  });

  it("charges after the confirmation and then behaves like the asynchronous mode", () => {
    const verified = must(reach("confirmed"), { kind: "payment_verified", at: T0 + 3 });

    expect(verified.order.state).toBe("confirmed");
    expect(kinds(verified.effects)).toStrictEqual(["execute_payment"]);

    const paid = must(verified.order, { kind: "payment_settled", at: T0 + 4 });

    expect(paid.order.state).toBe("paid");
    expect(paid.order.payment).toBe("settled");
  });

  it("lets a merchant who confirmed still refuse while nothing is charged", () => {
    // Portal, "Отказаться после того, как приняли заказ": taking an order on
    // does not bind the merchant while the order is still open.
    const { order } = must(reach("confirmed"), {
      kind: "refuse_called",
      at: T0 + 3,
      code: "out_of_stock",
      message: "sold out overnight",
    });

    expect(order.state).toBe("declined");
    expect(order.payment).toBe("none");
  });
});

describe("when the time runs out", () => {
  it("lets a price die of its own age", () => {
    const { order } = must(newOrder("sync"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    });

    expect(order.state).toBe("expired");
    expect(order.payment).toBe("none");
  });

  it("closes an unanswered confirmation without charging anybody", () => {
    const { order } = must(reach("awaiting_confirmation"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "confirmation_response",
    });

    expect(order.state).toBe("expired");
    expect(order.payment).toBe("none");
  });

  it("frees the merchant when a confirmed order goes unpaid", () => {
    const { order, effects } = must(reach("confirmed"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "payment_after_confirmation",
    });

    expect(order.state).toBe("expired");
    expect(effects).toStrictEqual([
      { kind: "emit_merchant_event", event: "confirmed_order_unpaid" },
    ]);
  });

  it("closes a synchronous purchase without a charge", () => {
    const { order } = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    });

    expect(order.state).toBe("expired");
    expect(order.payment).toBe("verified");
    expect(order.closure).toStrictEqual({ cause: "deadline_expired", deadline: "sync_response" });
  });

  it("marks a debt when an asynchronous order misses its fulfillment deadline", () => {
    const dispatched = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
      { kind: "handler_accepted", at: T0 + 4 },
    ]);
    const { order, effects } = must(dispatched, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(order.state).toBe("refund_due");
    expect(kinds(effects)).toStrictEqual(["mark_refund_due", "emit_merchant_event"]);
  });

  it("refuses a deadline that is not running", () => {
    // The money hole: a quote expiring while the settle of that very order is
    // in flight would close a purchase that is about to be paid for.
    const settling = walk(newOrder("async"), [{ kind: "payment_verified", at: T0 + 1 }]);
    const result = transition(settling, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("deadline_not_armed");
  });

  it("refuses a deadline that has not come due yet", () => {
    // A timer that fired early, or fired twice, must not close an order the
    // merchant is still honestly inside his deadline of: in the asynchronous
    // mode that would mark a refund due against somebody who is not late.
    const dispatched = reach("dispatched");
    const early = transition(dispatched, {
      kind: "deadline_expired",
      at: T0 + 1_000,
      deadline: "sync_response",
    });
    const onTime = transition(dispatched, {
      kind: "deadline_expired",
      at: T0 + 10_000,
      deadline: "sync_response",
    });

    expect(early.ok).toBe(false);
    if (early.ok) return;
    expect(early.rejection.code).toBe("deadline_not_yet_due");
    expect(onTime.ok).toBe(true);
  });
});

describe("an order that never reached the handler", () => {
  it("is delivered again rather than closed", () => {
    // Portal, "Обработчик упал, не ответив": an exception is not an answer.
    const { order, effects } = must(reach("dispatched"), {
      kind: "handler_undelivered",
      at: T0 + 4,
    });

    expect(order.state).toBe("dispatched");
    expect(order.dispatch.attempts).toBe(1);
    expect(effects).toStrictEqual([{ kind: "redeliver_order", attempt: 2, delayMs: 1_000 }]);
  });

  it("stops repeating once the mode's deadline is too close", () => {
    // The synchronous budget is ten seconds in the fixtures, so by the ninth
    // second another attempt could only arrive late.
    const { order } = must(reach("dispatched"), {
      kind: "handler_undelivered",
      at: T0 + 9_500,
    });

    expect(order.state).toBe("expired");
    expect(order.payment).toBe("verified");
  });

  it("leaves an asynchronous order owing a refund when the repeats run out", () => {
    const dispatched = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
    ]);
    const exhausted = { ...dispatched, dispatch: { attempts: 5, accepted: false } };
    const { order } = must(exhausted, { kind: "handler_undelivered", at: T0 + 4 });

    expect(order.state).toBe("refund_due");
  });
});

describe("delivering twice, and delivering late", () => {
  it("answers a second deliver with the same success and no second fulfillment", () => {
    // Portal: repeating the call after a broken connection is safe, and the
    // merchant does not have to keep a note that he already sent it.
    const delivered = reach("delivered");
    const { order, effects } = must(delivered, { kind: "deliver_called", at: T0 + 99 });

    expect(order).toStrictEqual(delivered);
    expect(effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
  });

  it("closes an outstanding debt with a late delivery", () => {
    // Portal: the money for the goods has been paid, and to the buyer late
    // goods are better than a refund.
    const { order, effects } = must(reach("refund_due"), { kind: "deliver_called", at: T0 + 999 });

    expect(order.state).toBe("delivered");
    expect(order.payment).toBe("settled");
    expect(effects).toContainEqual({
      kind: "answer_merchant",
      answer: { ok: true, result: "debt_closed_by_delivery" },
    });
  });

  it("has nothing left to deliver once the refund has gone through", () => {
    const { order, effects } = must(reach("refunded"), { kind: "deliver_called", at: T0 + 999 });

    expect(order.state).toBe("refunded");
    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "refund_already_settled", retryable: false },
      },
    ]);
  });

  it("keeps the goods a merchant produced after the purchase was already closed", () => {
    // Canon, "Поздняя синхронная выдача не пропадает": he started before the
    // deadline and finished after it, and the work is not thrown away.
    const closed = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
    ]);
    const { order, effects } = must(closed, { kind: "handler_delivered", at: T0 + 1_000_000 });

    expect(order.state).toBe("expired");
    expect(order.heldFulfillment).toBe(true);
    expect(effects).toStrictEqual([
      { kind: "hold_fulfillment" },
      { kind: "answer_merchant", answer: { ok: true, result: "purchase_already_closed" } },
    ]);
  });

  it("lets a repeat of the purchase pick up goods that were produced too late", () => {
    const held = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
    ]);
    const { order, effects } = must(held, { kind: "purchase_repeated", at: T0 + 1_000_001 });

    expect(order.state).toBe("fulfilled");
    expect(kinds(effects)).toStrictEqual(["verify_payment"]);

    const paid = walk(order, [
      { kind: "payment_verified", at: T0 + 1_000_002 },
      { kind: "payment_settled", at: T0 + 1_000_003 },
    ]);

    expect(paid.state).toBe("delivered");
    expect(paid.payment).toBe("settled");
  });

  it("has nothing to hand over when a repeat finds no goods waiting", () => {
    const closed = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
    ]);
    const { order, effects } = must(closed, { kind: "purchase_repeated", at: T0 + 1_000_000 });

    expect(order.state).toBe("expired");
    expect(effects).toStrictEqual([]);
  });
});

describe("the same order delivered to the handler twice", () => {
  it("takes a repeat of an order already delivered as a no-op", () => {
    // Canon: the answer to a repeat is the current state, and what is compared
    // is the effect — no second fulfillment — rather than the bytes of the
    // two answers.
    const delivered = reach("delivered");
    const redispatched = must(delivered, { kind: "order_dispatched", at: T0 + 50 });
    const accepted = must(redispatched.order, { kind: "handler_accepted", at: T0 + 51 });

    expect(accepted.order.state).toBe("delivered");
    expect(kinds(redispatched.effects)).toStrictEqual([]);
    expect(kinds(accepted.effects)).toStrictEqual([]);
  });

  it("counts the deliveries so the backoff has something to count from", () => {
    const dispatched = reach("dispatched");
    const again = must(dispatched, { kind: "order_dispatched", at: T0 + 4 });

    expect(again.order.dispatch.attempts).toBe(dispatched.dispatch.attempts + 1);
  });
});

describe("goods handed over that were never paid for", () => {
  it("records the case and tells the merchant", () => {
    // Portal, "Выдали, а платёж не исполнился": rare, and possible only in the
    // synchronous mode, where the money is executed last.
    const { order, effects } = must(reach("fulfilled"), {
      kind: "payment_settle_failed",
      at: T0 + 5,
    });

    expect(order.state).toBe("delivered_unpaid");
    expect(effects).toStrictEqual([
      { kind: "emit_merchant_event", event: "payment_not_settled_after_sync_delivery" },
    ]);
  });

  it("is closed by the agent repeating the purchase, with no second fulfillment", () => {
    const unpaid = reach("delivered_unpaid");
    const repeated = must(unpaid, { kind: "purchase_repeated", at: T0 + 6 });

    expect(repeated.order.state).toBe("delivered_unpaid");
    expect(kinds(repeated.effects)).toStrictEqual(["verify_payment"]);

    const verified = must(repeated.order, { kind: "payment_verified", at: T0 + 7 });

    expect(kinds(verified.effects)).toStrictEqual(["execute_payment"]);

    const settled = must(verified.order, { kind: "payment_settled", at: T0 + 8 });

    expect(settled.order.state).toBe("delivered");
    expect(kinds(settled.effects)).toStrictEqual(["release_goods_to_agent", "issue_receipt"]);
  });
});

describe("the merchant leaves", () => {
  it("closes an open order on which nothing was charged", () => {
    const { order } = must(reach("dispatched"), { kind: "merchant_departed", at: T0 + 5 });

    expect(order.state).toBe("cancelled");
    expect(order.payment).toBe("verified");
  });

  it("turns an open order that was charged into a debt", () => {
    // Portal, "Чем заказ может закончиться": for what was not delivered, the
    // merchant refunds — so the debt has to be recorded, not swept into a
    // terminal that claims nobody owes anything.
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
      { kind: "order_dispatched", at: T0 + 3 },
    ]);
    const { order, effects } = must(paid, { kind: "merchant_departed", at: T0 + 5 });

    expect(order.state).toBe("refund_due");
    expect(order.closure).toStrictEqual({ cause: "merchant_departed" });
    expect(kinds(effects)).toStrictEqual(["mark_refund_due", "emit_merchant_event"]);
  });

  it("leaves an existing debt exactly where it was", () => {
    const debt = reach("refund_due");
    const { order } = must(debt, { kind: "merchant_departed", at: T0 + 999 });

    expect(order).toStrictEqual(debt);
  });

  it("touches nothing that is already closed", () => {
    const delivered = reach("delivered");
    const { order } = must(delivered, { kind: "merchant_departed", at: T0 + 999 });

    expect(order).toStrictEqual(delivered);
  });
});

describe("while the settle is in flight", () => {
  /**
   * The window between the payment being sent for execution and the answer
   * coming back. It is seconds long and it is the one moment when the machine
   * genuinely does not know where the buyer's money is. Everything here is
   * about not pretending otherwise.
   */
  function settling(): Order {
    return walk(newOrder("async"), [{ kind: "payment_verified", at: T0 + 1 }]);
  }

  it("says so instead of calling the money untouched", () => {
    expect(settling().payment).toBe("settling");
  });

  it("refuses to close the order as free while it does not know", () => {
    // Every one of these would otherwise tell the buyer his purchase never
    // happened while his money was already on its way to the merchant.
    const closing: readonly OrderEvent[] = [
      { kind: "merchant_departed", at: T0 + 2 },
      { kind: "payment_verification_failed", at: T0 + 2, reason: "signature" },
      { kind: "handler_refused", at: T0 + 2, code: "out_of_stock", message: "none" },
      { kind: "refuse_called", at: T0 + 2, code: "out_of_stock", message: "none" },
    ];

    for (const event of closing) {
      const result = transition(settling(), event);
      expect(result.ok, event.kind).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code, event.kind).toBe("settle_in_flight");
    }
  });

  it("refuses a merchant who confirmed and then changes his mind mid-charge", () => {
    const midCharge = walk(reach("confirmed"), [{ kind: "payment_verified", at: T0 + 3 }]);
    const result = transition(midCharge, {
      kind: "refuse_called",
      at: T0 + 4,
      code: "out_of_stock",
      message: "sold out",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("settle_in_flight");
  });

  it("sends the payment for execution once and not twice", () => {
    // A duplicate off a queue that delivers at least once must not spend the
    // buyer's money a second time.
    const result = transition(settling(), { kind: "payment_verified", at: T0 + 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("settle_in_flight");
  });

  it("gives the settle a deadline of its own, and closes the purchase if it is silent", () => {
    // ADR-0002 §3: a silent decision about the charge is always a closed
    // failure. Without a deadline here the order would wait for an answer that
    // never comes, and the agent would be told "not yet" forever.
    const order = settling();

    expect(deadlines(order)).toStrictEqual([
      { kind: "settle_response", at: T0 + 1 + TEST_POLICY.deadlines.settleResponseMs },
    ]);

    const { order: closed } = must(order, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    expect(closed.state).toBe("rejected");
    expect(closed.closure).toStrictEqual({ cause: "payment_not_settled" });
  });

  it("turns a charge that lands after that into a debt rather than losing it", () => {
    // The closed failure is a guess that the money did not move. If the guess
    // turns out wrong, the buyer is owed his money back — and the machine has
    // to record that rather than carry on insisting the purchase never was.
    const closed = walk(settling(), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const { order, effects } = must(closed, { kind: "payment_settled", at: T0 + 1_000_000 });

    expect(order.state).toBe("refund_due");
    expect(order.payment).toBe("settled");
    expect(kinds(effects)).toStrictEqual(["mark_refund_due", "emit_merchant_event"]);
  });

  it("closes a synchronous order whose settle went silent as goods without payment", () => {
    // The merchant produced the goods and we cannot say whether the money
    // arrived. He is told, exactly as the portal promises him.
    const fulfilled = reach("fulfilled");

    expect(fulfilled.payment).toBe("settling");

    const { order, effects } = must(fulfilled, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    expect(order.state).toBe("delivered_unpaid");
    expect(effects).toStrictEqual([
      { kind: "emit_merchant_event", event: "payment_not_settled_after_sync_delivery" },
    ]);
  });
});

describe("an answer that arrives before we recorded handing the order over", () => {
  it("is taken, not thrown away", () => {
    // One order goes to one instance of the handler, and that instance can
    // answer before our own record of the dispatch has landed. Dropping the
    // answer would run the order to its deadline and refund a buyer who was
    // holding the goods.
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);

    expect(paid.state).toBe("paid");

    const { order, effects } = must(paid, { kind: "deliver_called", at: T0 + 3 });

    expect(order.state).toBe("delivered");
    expect(kinds(effects)).toContain("release_goods_to_agent");
  });

  it("takes a refusal in that same gap", () => {
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);
    const { order } = must(paid, {
      kind: "refuse_called",
      at: T0 + 3,
      code: "out_of_stock",
      message: "none",
    });

    expect(order.state).toBe("refund_due");
  });
});

describe("delivering the confirmation request again", () => {
  it("counts its attempts and backs off like any other delivery", () => {
    // The confirmation leg has its own deliveries and its own worker that can
    // die. Without a counter the backoff is a constant and the attempt cap is
    // dead, which is a retry storm against a side that is already down.
    const first = must(reach("awaiting_confirmation"), {
      kind: "handler_undelivered",
      at: T0 + 2,
    });

    expect(first.effects).toStrictEqual([
      { kind: "redeliver_order", attempt: 2, delayMs: 1_000 },
    ]);

    const redelivered = must(first.order, { kind: "confirmation_dispatched", at: T0 + 3 });

    expect(redelivered.order.dispatch.attempts).toBe(2);

    const second = must(redelivered.order, { kind: "handler_undelivered", at: T0 + 4 });

    expect(second.effects).toStrictEqual([
      { kind: "redeliver_order", attempt: 3, delayMs: 2_000 },
    ]);
  });

  it("closes the order citing the deadline it actually ran out of", () => {
    // The reason is what the merchant and the agent read. Citing a
    // fulfillment deadline on an order that never reached fulfillment is a
    // claim the machine cannot back.
    const exhausted: Order = {
      ...reach("awaiting_confirmation"),
      dispatch: { attempts: 5, accepted: false },
    };
    const { order } = must(exhausted, { kind: "handler_undelivered", at: T0 + 9 });

    expect(order.state).toBe("expired");
    expect(order.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "confirmation_response",
    });
  });
});

describe("records that would say something untrue", () => {
  it("does not leave a refusal written on an order that ended in success", () => {
    // The closure is what a receipt, a dispute and the merchant's dashboard
    // render from. "The merchant refused" on a delivered order is a lie.
    const { order } = must(reach("refund_due"), { kind: "deliver_called", at: T0 + 999 });

    expect(order.state).toBe("delivered");
    expect(order.closure).toBeNull();
  });

  it("does not carry a dead verification into a repeated purchase", () => {
    // The repeat brings its own payment. Claiming the old one is verified
    // while asking for the new one to be verified is two answers at once.
    const held = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
    ]);
    const { order } = must(held, { kind: "purchase_repeated", at: T0 + 1_000_001 });

    expect(order.state).toBe("fulfilled");
    expect(order.payment).toBe("none");
  });

  it("will not settle a repeated purchase whose payment nobody verified", () => {
    const reopened = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
      { kind: "purchase_repeated", at: T0 + 1_000_001 },
    ]);
    const result = transition(reopened, { kind: "payment_settled", at: T0 + 1_000_002 });

    expect(result.ok).toBe(false);
  });
});

describe("an order whose goods are out and whose money is not", () => {
  it("stays open when the merchant leaves, because he owes nothing on it", () => {
    // Portal: this order stays unclosed and a repeat of the purchase closes
    // it. The merchant already produced the goods; his departure takes away
    // nothing the buyer is still waiting for.
    const unpaid = reach("delivered_unpaid");
    const { order } = must(unpaid, { kind: "merchant_departed", at: T0 + 9 });

    expect(order.state).toBe("delivered_unpaid");
  });
});

describe("events that do not belong where they arrived", () => {
  const illegal: readonly [OrderState, OrderEvent, string][] = [
    ["created", { kind: "payment_verified", at: T0 + 1 }, "a payment before there is a price"],
    ["quoted", { kind: "order_dispatched", at: T0 + 1 }, "a dispatch before the payment"],
    ["quoted", { kind: "payment_settled", at: T0 + 1 }, "a settle nobody verified first"],
    [
      "awaiting_confirmation",
      { kind: "payment_verified", at: T0 + 1 },
      "a payment before the merchant answered",
    ],
    ["paid", { kind: "handler_delivered", at: T0 + 1 }, "an answer from a handler never asked"],
    [
      "fulfilled",
      { kind: "handler_refused", at: T0 + 1, code: "x", message: "y" },
      "a refusal after the goods",
    ],
    ["delivered", { kind: "payment_settled", at: T0 + 1 }, "a second charge on a closed order"],
    [
      "rejected",
      { kind: "handler_accepted", at: T0 + 1 },
      "an acceptance of a purchase that never happened",
    ],
    [
      "declined",
      { kind: "payment_settled", at: T0 + 1 },
      "a charge for a confirmation the merchant refused",
    ],
    ["refunded", { kind: "payment_settled", at: T0 + 1 }, "a charge after the refund"],
    [
      "cancelled",
      { kind: "payment_verified", at: T0 + 1 },
      "a payment on an order the merchant left behind",
    ],
    [
      "failed",
      { kind: "handler_delivered", at: T0 + 1 },
      "goods from a handler that refused this very order",
    ],
  ];

  for (const [state, event, why] of illegal) {
    it(`refuses ${why}`, () => {
      const result = transition(reach(state), event);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.rejection.state).toBe(state);
      expect(result.rejection.event).toBe(event.kind);
    });
  }

  it("names the refusal instead of throwing it", () => {
    // The gateway turns this into an answer for whoever sent the event. An
    // exception here would become a five hundred on somebody's purchase.
    const result = transition(reach("delivered"), { kind: "payment_settled", at: T0 + 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("event_not_applicable");
    expect(result.rejection.message).toContain("delivered");
  });
});
