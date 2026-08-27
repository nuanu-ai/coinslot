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

  it("treats running out of patience with the price check as the same silence", () => {
    // The wait for an answer and the life of an answer are two different
    // waitings. Running out of the first one is the merchant being silent, and
    // ADR-0002 §3 answers silence by mode: it must not close a synchronous
    // purchase that is supposed to go on to a sale at the card's own price.
    const sync = must(newOrder("sync", { priceCheck: "merchant" }), {
      kind: "deadline_expired",
      at: T0 + TEST_POLICY.deadlines.quoteResponseMs,
      deadline: "quote_response",
    });
    const async = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "deadline_expired",
      at: T0 + TEST_POLICY.deadlines.quoteResponseMs,
      deadline: "quote_response",
    });

    expect(sync.order.state).toBe("quoted");
    expect(sync.order.quoteSource).toBe("card_snapshot");
    expect(kinds(sync.effects)).toStrictEqual(["verify_payment"]);
    expect(async.order.state).toBe("rejected");
    expect(async.order.closure).toStrictEqual({ cause: "quote_silent" });
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
    expect(fulfilled.order.payment).toBe("settling");
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
    expect(verified.order.payment).toBe("settling");
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
    const { order, effects } = must(dispatched, { kind: "handler_accepted", at: T0 + 4 });

    expect(order.state).toBe("dispatched");
    expect(order.dispatch.accepted).toBe(true);
    // And he is told his answer landed, in the word for it. An acceptance is a
    // merchant's answer like the other two, and a machine that stayed silent
    // here would leave whoever answers him with nothing to say but no.
    expect(effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "accepted" } },
    ]);
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
    // The agent is invited to pay and the merchant is told his "I will"
    // landed. He answered a question, and an answer with no reply to it is
    // indistinguishable on his side from one that never arrived.
    expect(effects).toStrictEqual([
      { kind: "invite_payment" },
      { kind: "answer_merchant", answer: { ok: true, result: "accepted" } },
    ]);
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
      { kind: "emit_merchant_event", event: "order.unpaid_after_confirmation" },
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

    // Asking for the repeat's payment does not by itself reopen the purchase.
    expect(order.state).toBe("expired");
    expect(kinds(effects)).toStrictEqual(["verify_payment"]);

    const reopened = must(order, { kind: "payment_verified", at: T0 + 1_000_002 });

    expect(reopened.order.state).toBe("fulfilled");
    expect(kinds(reopened.effects)).toStrictEqual(["execute_payment"]);

    const paid = walk(reopened.order, [{ kind: "payment_settled", at: T0 + 1_000_003 }]);

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
      { kind: "emit_merchant_event", event: "order.payment_failed_after_delivery" },
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

  it("still answers the merchant's own calls where he is holding the order", () => {
    // The guard is about where the money is; it must not also decide who is
    // allowed to speak. In `fulfilled` and `delivered_unpaid` the merchant is
    // mid-conversation with us.
    const held = reach("fulfilled");
    const delivered = must(held, { kind: "deliver_called", at: T0 + 9 });
    const refused = must(held, {
      kind: "refuse_called",
      at: T0 + 9,
      code: "out_of_stock",
      message: "none",
    });

    expect(delivered.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
    expect(refused.effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "not_applicable_in_mode", retryable: false },
      },
    ]);
    expect(delivered.order).toStrictEqual(held);
    expect(refused.order).toStrictEqual(held);
  });

  it("keeps refusing them where he is holding nothing", () => {
    // In `quoted` and `confirmed` the merchant has not been given the order at
    // all, so his calling about it is not a retry of anything.
    const result = transition(settling(), { kind: "deliver_called", at: T0 + 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("settle_in_flight");
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
    expect(closed.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
  });

  it("does not write the same record for a guess as for a known failure", () => {
    // The fifth gate. Both close the purchase and neither charges the buyer,
    // but "the payment layer told us it failed" and "the payment layer never
    // answered" carry very different odds that the money actually moved, and
    // an error text, a dispute and the merchant's reconciliation all read this
    // field.
    const guessed = walk(settling(), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const known = walk(settling(), [{ kind: "payment_settle_failed", at: T0 + 2 }]);

    expect(guessed.state).toBe(known.state);
    expect(guessed.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
    expect(known.closure).toStrictEqual({ cause: "payment_not_settled" });
  });

  it("will not reopen a purchase the payment layer said it had failed", () => {
    // Only the guess can be overturned by a late charge. A payment layer that
    // reports a failure and then a success is contradicting itself, and this
    // machine is not the place that resolves it.
    const known = walk(settling(), [{ kind: "payment_settle_failed", at: T0 + 2 }]);
    const late = transition(known, { kind: "payment_settled", at: T0 + 999 });

    expect(late.ok).toBe(false);
  });

  it("turns the guess into a fact once, and no more than once", () => {
    // The counter behind the double-charge check moves on every accepted
    // settle outcome. An unbounded stream of them on a closed order would
    // drive it below zero and disarm the check that guards a second charge.
    const closed = walk(settling(), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const first = must(closed, { kind: "payment_settle_failed", at: T0 + 1_000_000 });

    expect(first.order.closure).toStrictEqual({ cause: "payment_not_settled" });
    expect(transition(first.order, { kind: "payment_settle_failed", at: T0 + 1_000_001 }).ok).toBe(
      false,
    );
  });

  it("answers the merchant's retry the same way wherever the settle happens to be", () => {
    // He produced the goods and his connection broke; his retry must not get a
    // raw rejection just because an internal charge is mid-flight at that
    // instant. The portal promises him the same typed success every time.
    const settlingNow = reach("fulfilled");
    const notSettling = reach("delivered_unpaid");

    expect(settlingNow.payment).toBe("settling");
    expect(notSettling.payment).not.toBe("settling");

    const whileSettling = must(settlingNow, { kind: "deliver_called", at: T0 + 9 });
    const otherwise = must(notSettling, { kind: "deliver_called", at: T0 + 9 });

    expect(whileSettling.effects).toStrictEqual(otherwise.effects);
    // And the answer reads the order's current fact without changing it.
    expect(whileSettling.order).toStrictEqual(settlingNow);
  });

  it("marks the refusal it gives during the charge as one to send again", () => {
    // The interpreter has no queue of its own for refused events; the flag is
    // how the machine asks for one.
    const result = transition(settling(), { kind: "merchant_departed", at: T0 + 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("settle_in_flight");
    expect(result.rejection.retryable).toBe(true);
  });

  it("does not ask for a second try where there is nothing to wait for", () => {
    // The flag is an instruction, and an interpreter that follows it on a
    // refusal meaning "this event does not belong here" spins forever.
    const nonsense = transition(reach("delivered"), { kind: "payment_settled", at: T0 + 1 });
    const early = transition(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 1_000,
      deadline: "sync_response",
    });

    expect(nonsense.ok).toBe(false);
    expect(early.ok).toBe(false);
    if (nonsense.ok || early.ok) return;
    expect(nonsense.rejection.retryable).toBe(false);
    expect(early.rejection.retryable).toBe(false);
  });

  it("frees a merchant whose confirmed order went quiet rather than failing", () => {
    // He answered "I will fulfill it" and nobody paid him. Whether the charge
    // failed or never answered makes no difference to him, and the portal
    // promises him the event either way.
    const midCharge = walk(reach("confirmed"), [{ kind: "payment_verified", at: T0 + 3 }]);
    const { order, effects } = must(midCharge, {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    expect(order.state).toBe("rejected");
    expect(effects).toStrictEqual([
      { kind: "emit_merchant_event", event: "order.unpaid_after_confirmation" },
    ]);
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

  it("never sends a second charge while the first one's outcome is unknown", () => {
    // The blocker this test exists for: a settle that reported nothing was
    // recorded as a settle that failed, so a repeat of the purchase sent the
    // money out again — unbounded, and with the first charge's fate still
    // unknown. Repeating four times produced five charges.
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(silent.state).toBe("delivered_unpaid");
    expect(silent.payment).toBe("outcome_unknown");

    const repeated = transition(silent, { kind: "purchase_repeated", at: T0 + 1_000_000 });

    expect(repeated.ok).toBe(false);
    if (repeated.ok) return;
    expect(repeated.rejection.retryable).toBe(true);
  });

  it("keeps a charge that reported nothing apart from one that reported failure", () => {
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const failed = walk(reach("fulfilled"), [{ kind: "payment_settle_failed", at: T0 + 5 }]);

    expect(silent.state).toBe(failed.state);
    expect(silent.payment).toBe("outcome_unknown");
    expect(failed.payment).toBe("settle_failed");
  });

  it("takes the answer when the payment layer finally speaks", () => {
    // The money did move after all, and the merchant's goods are already made.
    // Dropping this answer would leave the buyer charged for a purchase the
    // machine goes on calling "did not happen".
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const { order, effects } = must(silent, { kind: "payment_settled", at: T0 + 1_000_000 });

    expect(order.state).toBe("delivered");
    expect(order.payment).toBe("settled");
    expect(kinds(effects)).toStrictEqual(["release_goods_to_agent", "issue_receipt"]);
  });

  it("holds an order with the goods made and the money in flight against a departure", () => {
    // What keeps a merchant's departure from closing an order whose goods he
    // has already produced is not a branch inside that state — it is that the
    // state is always mid-charge, so the guard turns the departure back before
    // anything else looks at it. This is the test that makes that true, and
    // the reason the arm behind it can never be reached.
    const held = reach("fulfilled");

    expect(held.payment).toBe("settling");

    const result = transition(held, { kind: "merchant_departed", at: T0 + 9 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("settle_in_flight");
    expect(result.rejection.retryable).toBe(true);
  });

  it("does not let a failed verification wipe the charge it knows nothing about", () => {
    // The way round the guard that the widened walk found: a payment that did
    // not check out never became a charge, but clearing the record on it left
    // the order looking as though nothing were outstanding, and the next
    // repeat sent a second charge over the first.
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const after = must(silent, {
      kind: "payment_verification_failed",
      at: T0 + 1_000_000,
      reason: "signature",
    });

    expect(after.order.payment).toBe("outcome_unknown");
    expect(transition(after.order, { kind: "purchase_repeated", at: T0 + 1_000_001 }).ok).toBe(
      false,
    );
  });

  it("lets the repeat through once the answer is in", () => {
    const known = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
      { kind: "payment_settle_failed", at: T0 + 1_000_000 },
    ]);

    expect(known.payment).toBe("settle_failed");

    const { effects } = must(known, { kind: "purchase_repeated", at: T0 + 1_000_001 });

    expect(kinds(effects)).toStrictEqual(["verify_payment"]);
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
      { kind: "emit_merchant_event", event: "order.payment_failed_after_delivery" },
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

  it("writes no record of a hand-over on the strength of a call it refused", () => {
    // A synchronous order has no separate deliver call at all. Answering that
    // must not leave the order claiming it was handed to a merchant it was
    // never handed to: a support view, a latency metric and a dispute all read
    // those fields.
    const paid = walk(newOrder("sync"), [{ kind: "payment_verified", at: T0 + 1 }]);
    const { order, effects } = must(paid, { kind: "deliver_called", at: T0 + 2 });

    expect(order).toStrictEqual(paid);
    expect(effects).toStrictEqual([
      {
        kind: "answer_merchant",
        answer: { ok: false, error: "not_applicable_in_mode", retryable: false },
      },
    ]);
  });

  it("claims a hand-over only from an answer that proves the handler ran", () => {
    // A `refuse` call can be made from anywhere at any time; a handler answer
    // can only come from a handler that was invoked. Counting the first as a
    // delivery credits the order round with a delivery it never had, and in
    // the confirm mode the merchant learned of the order from the confirmation
    // round instead.
    const paid = walk(reach("confirmed"), [
      { kind: "payment_verified", at: T0 + 3 },
      { kind: "payment_settled", at: T0 + 4 },
    ]);

    expect(paid.state).toBe("paid");
    expect(paid.dispatch.attempts).toBe(0);

    const { order } = must(paid, {
      kind: "refuse_called",
      at: T0 + 5,
      code: "out_of_stock",
      message: "none",
    });

    expect(order.state).toBe("refund_due");
    expect(order.dispatch.attempts).toBe(0);
  });

  it("does not invent the instant of a hand-over it only heard about", () => {
    // That it happened is known, because the merchant is answering. When it
    // happened is not, and a made-up number in that field is worse than an
    // empty one.
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);
    const { order } = must(paid, { kind: "handler_accepted", at: T0 + 3 });

    expect(order.state).toBe("dispatched");
    expect(order.timestamps.dispatchedAt).toBeNull();
    expect(order.dispatch.attempts).toBe(1);
  });

  it("counts one hand-over once, however we learn of it", () => {
    // Both the backoff exponent and the attempt cap read this counter, so
    // counting the same hand-over twice costs the order a retry against a
    // merchant who is already struggling.
    const paid = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "payment_settled", at: T0 + 2 },
    ]);
    const heardOfIt = must(paid, { kind: "handler_accepted", at: T0 + 3 }).order;
    const recorded = must(heardOfIt, { kind: "order_dispatched", at: T0 + 4 }).order;

    expect(recorded.dispatch.attempts).toBe(1);
    expect(recorded.timestamps.dispatchedAt).toBe(T0 + 4);

    // A genuinely second hand-over still counts.
    const again = must(recorded, { kind: "order_dispatched", at: T0 + 5 }).order;

    expect(again.dispatch.attempts).toBe(2);
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

    expect(first.effects).toStrictEqual([{ kind: "redeliver_order", attempt: 2, delayMs: 1_000 }]);

    const redelivered = must(first.order, { kind: "confirmation_dispatched", at: T0 + 3 });

    expect(redelivered.order.dispatch.attempts).toBe(2);

    const second = must(redelivered.order, { kind: "handler_undelivered", at: T0 + 4 });

    expect(second.effects).toStrictEqual([{ kind: "redeliver_order", attempt: 3, delayMs: 2_000 }]);
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

  it("does not carry the reason a purchase ran out of time onto its second life", () => {
    // Two orders in the same state must not differ in the field a dispute and
    // the merchant's dashboard render from, for no reason but which path they
    // took to get there.
    const revived = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
      { kind: "purchase_repeated", at: T0 + 1_000_001 },
      { kind: "payment_verified", at: T0 + 1_000_002 },
      { kind: "payment_settle_failed", at: T0 + 1_000_003 },
    ]);

    expect(revived.state).toBe("delivered_unpaid");
    expect(revived.closure).toBeNull();
  });

  it("does not carry a dead verification into a repeated purchase", () => {
    // The repeat brings its own payment. Claiming the old one is verified
    // while asking for the new one to be verified is two answers at once.
    const held = walk(reach("dispatched"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "sync_response" },
      { kind: "handler_delivered", at: T0 + 1_000_000 },
    ]);
    const { order } = must(held, { kind: "purchase_repeated", at: T0 + 1_000_001 });

    expect(order.state).toBe("expired");
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
    [
      "paid",
      { kind: "confirmation_dispatched", at: T0 + 1 },
      "a confirmation on an order already paid for",
    ],
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
