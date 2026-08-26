/**
 * The order state machine: one machine for all three fulfillment modes, with
 * the modes as guards.
 *
 * The rules that shaped the code below, each of them from
 * `docs/research/16-order-state-machine.md` and the two portal pages that say
 * the same things to the merchant:
 *
 * Money decides the shape of every failure. Where the merchant's live answer
 * still stands between the price and the charge, a failure costs the buyer
 * nothing; where the money moved first, the same failure leaves a debt that
 * has to be recorded rather than swept into a terminal claiming nobody owes
 * anything.
 *
 * An answer is a fulfillment, a refusal or an acceptance, and nothing else. An
 * exception, a dead process and a broken connection are not answers: the order
 * is delivered again until the mode's deadline, because a refusal is
 * understood as a final "this cannot be fulfilled".
 *
 * Work that was done is not thrown away. A merchant who started before the
 * deadline and finished after it gets a typed "the purchase is already closed"
 * rather than an exception, and the goods he produced wait for a repeat of the
 * purchase — which brings the payment with it and asks for no second
 * fulfillment.
 *
 * Two shapes of "no" come out of this file and they mean different things. A
 * typed answer to the merchant (`answer_merchant`) is the machine talking to
 * somebody who legitimately holds this order: the call was understood and
 * could not be honoured. A rejection of the transition is the machine saying
 * that this event has no meaning in this state at all — a stale message off
 * the queue, or a bug. Neither is ever thrown.
 */

import { assertNever } from "../index.js";
import { deadlines, fulfillmentDeadline } from "./deadlines.js";
import type {
  Closure,
  Effect,
  MerchantAnswer,
  Order,
  OrderEvent,
  OrderMode,
  OrderState,
  Price,
  QuoteSource,
  StateEvent,
  TransitionRejection,
  TransitionResult,
} from "./model.js";
import { effectsOnQuoted } from "./model.js";
import { nextRedelivery } from "./redelivery.js";

export function transition(order: Order, event: OrderEvent): TransitionResult {
  if (event.kind === "deadline_expired") {
    return onDeadline(order, event);
  }

  switch (order.state) {
    case "created":
      return fromCreated(order, event);
    case "quoted":
      return fromQuoted(order, event);
    case "awaiting_confirmation":
      return fromAwaitingConfirmation(order, event);
    case "confirmed":
      return fromConfirmed(order, event);
    case "paid":
      return fromPaid(order, event);
    case "dispatched":
      return fromDispatched(order, event);
    case "fulfilled":
      return fromFulfilled(order, event);
    case "delivered":
      return fromDelivered(order, event);
    case "delivered_unpaid":
      return fromDeliveredUnpaid(order, event);
    case "refund_due":
      return fromRefundDue(order, event);
    case "refunded":
      return fromRefunded(order, event);
    case "failed":
      return fromFailed(order, event);
    case "expired":
      return fromExpired(order, event);
    case "rejected":
    case "declined":
    case "cancelled":
      return fromClosedWithoutMoney(order, event);
    default:
      return assertNever(order.state, "order state");
  }
}

// --- the answers this file gives -------------------------------------------

function ok(order: Order, effects: readonly Effect[] = []): TransitionResult {
  return { ok: true, order, effects };
}

function reject(
  order: Order,
  event: OrderEvent,
  code: TransitionRejection,
  message: string,
): TransitionResult {
  return { ok: false, rejection: { code, state: order.state, event: event.kind, message } };
}

function notApplicable(order: Order, event: OrderEvent): TransitionResult {
  return reject(
    order,
    event,
    "event_not_applicable",
    `${event.kind} has no meaning for an order in ${order.state}`,
  );
}

function answer(order: Order, merchantAnswer: MerchantAnswer): TransitionResult {
  return ok(order, [{ kind: "answer_merchant", answer: merchantAnswer }]);
}

function closedToMerchant(order: Order): TransitionResult {
  return answer(order, { ok: false, error: "order_already_closed", retryable: false });
}

// --- the moves several states share ----------------------------------------

/**
 * A silent price check is an open failure only where the merchant's own answer
 * still stands between the price and the charge. Where the money moves at the
 * purchase, selling at an unknown stock level would manufacture debts to
 * buyers, and a lost sale is cheaper than a debt (ADR-0002 §3).
 */
function sellsOnSilentQuote(mode: OrderMode): boolean {
  return mode.needsConfirmation || mode.settle === "after_fulfillment";
}

function enterQuoted(
  order: Order,
  at: number,
  price: Price,
  source: QuoteSource,
): TransitionResult {
  return ok(
    {
      ...order,
      state: "quoted",
      price,
      quoteSource: source,
      timestamps: { ...order.timestamps, quotedAt: at },
    },
    effectsOnQuoted(order.mode),
  );
}

function closeWithoutMoney(order: Order, state: OrderState, closure: Closure): Order {
  return { ...order, state, closure };
}

/**
 * The order is ready to go to the merchant. The delivery counters start fresh
 * here: a confirmation round and an order round are two different deliveries.
 */
function enterPaid(order: Order, at: number, payment: "verified" | "settled"): TransitionResult {
  return ok(
    {
      ...order,
      state: "paid",
      payment,
      dispatch: { attempts: 0, accepted: false },
      timestamps: { ...order.timestamps, paidAt: at },
    },
    [{ kind: "dispatch_order" }],
  );
}

/**
 * A fulfillment that will not happen, resolved by where the money is. After
 * the charge it is a debt; before it, the purchase simply did not happen, and
 * whether the agent is told "refused" or "closed on time" depends on which of
 * the two ended it.
 */
function resolveFulfillmentFailure(order: Order, closure: Closure): TransitionResult {
  if (order.payment === "settled") {
    return ok({ ...order, state: "refund_due", closure }, [
      { kind: "mark_refund_due", closure },
      { kind: "emit_merchant_event", event: "order_refund_due" },
    ]);
  }

  const state: OrderState = closure.cause === "merchant_refused" ? "failed" : "expired";
  return ok(closeWithoutMoney(order, state, closure));
}

function deliverGoods(order: Order, extra: readonly Effect[] = []): TransitionResult {
  if (order.mode.settle === "after_fulfillment") {
    // The goods exist and the money has not moved yet: executing the payment
    // is the last step, and it is ours.
    return ok({ ...order, state: "fulfilled" }, [{ kind: "execute_payment" }, ...extra]);
  }

  return ok({ ...order, state: "delivered" }, [
    { kind: "release_goods_to_agent" },
    { kind: "issue_receipt" },
    ...extra,
  ]);
}

/** The merchant left. A charged order that never got its goods stays a debt. */
function onDeparture(order: Order): TransitionResult {
  const closure: Closure = { cause: "merchant_departed" };

  if (order.payment === "settled") {
    return ok({ ...order, state: "refund_due", closure }, [
      { kind: "mark_refund_due", closure },
      { kind: "emit_merchant_event", event: "order_refund_due" },
    ]);
  }

  return ok(closeWithoutMoney(order, "cancelled", closure));
}

function redeliver(order: Order, at: number, deadlineAt: number | null): TransitionResult {
  const decision = nextRedelivery({
    attempts: order.dispatch.attempts,
    now: at,
    deadlineAt,
    policy: order.policy.redelivery,
  });

  if (decision.retry) {
    return ok(order, [
      { kind: "redeliver_order", attempt: decision.attempt, delayMs: decision.delayMs },
    ]);
  }

  const kind = order.mode.settle === "after_fulfillment" ? "sync_response" : "async_fulfillment";
  return resolveFulfillmentFailure(order, { cause: "deadline_expired", deadline: kind });
}

// --- deadlines --------------------------------------------------------------

function onDeadline(
  order: Order,
  event: Extract<OrderEvent, { kind: "deadline_expired" }>,
): TransitionResult {
  const armed = deadlines(order).find((deadline) => deadline.kind === event.deadline);

  if (armed === undefined) {
    // Closes a money hole that is easy to miss: a quote timing out while the
    // settle of that very order is already on its way.
    return reject(
      order,
      event,
      "deadline_not_armed",
      `the ${event.deadline} deadline is not running on an order in ${order.state}`,
    );
  }

  if (event.at < armed.at) {
    // A timer that fired early, or fired twice, must not close an order the
    // merchant is still honestly inside the deadline of — in the asynchronous
    // mode that would mark a refund due against somebody who is not late.
    return reject(
      order,
      event,
      "deadline_not_yet_due",
      `the ${event.deadline} deadline runs until ${armed.at} and the expiry claims ${event.at}`,
    );
  }

  const closure: Closure = { cause: "deadline_expired", deadline: event.deadline };

  switch (event.deadline) {
    case "quote_expiry":
    case "confirmation_response":
      return ok(closeWithoutMoney(order, "expired", closure));
    case "payment_after_confirmation":
      // The merchant said he would fulfill and nobody paid him for it. He owes
      // nothing, and he is told so rather than left waiting.
      return ok(closeWithoutMoney(order, "expired", closure), [
        { kind: "emit_merchant_event", event: "confirmed_order_unpaid" },
      ]);
    case "sync_response":
    case "async_fulfillment":
      return resolveFulfillmentFailure(order, closure);
    default:
      return assertNever(event.deadline, "deadline kind");
  }
}

// --- the states -------------------------------------------------------------

function fromCreated(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "quote_answered":
      return event.available
        ? enterQuoted(order, event.at, event.price, "merchant_answer")
        : ok(closeWithoutMoney(order, "rejected", { cause: "unavailable" }));
    case "quote_silent":
      return sellsOnSilentQuote(order.mode)
        ? enterQuoted(order, event.at, order.cardPrice, "card_snapshot")
        : ok(closeWithoutMoney(order, "rejected", { cause: "quote_silent" }));
    case "merchant_departed":
      return onDeparture(order);
    case "purchase_repeated":
      return ok(order);
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_delivered":
    case "handler_refused":
    case "handler_undelivered":
    case "deliver_called":
    case "refuse_called":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromQuoted(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "payment_verified":
      if (order.mode.needsConfirmation) {
        // The merchant has not said he will fulfill it yet, and until he does
        // nothing may touch the buyer's money.
        return notApplicable(order, event);
      }
      return order.mode.settle === "after_fulfillment"
        ? enterPaid(order, event.at, "verified")
        : ok({ ...order, payment: "verified" }, [{ kind: "execute_payment" }]);
    case "payment_verification_failed":
      return ok(
        closeWithoutMoney(order, "rejected", {
          cause: "payment_not_verified",
          reason: event.reason,
        }),
      );
    case "payment_settled":
      return order.payment === "verified" && order.mode.settle === "on_purchase"
        ? enterPaid(order, event.at, "settled")
        : notApplicable(order, event);
    case "payment_settle_failed":
      return order.payment === "verified"
        ? ok({
            ...closeWithoutMoney(order, "rejected", { cause: "payment_not_settled" }),
            payment: "settle_failed",
          })
        : notApplicable(order, event);
    case "confirmation_dispatched":
      return order.mode.needsConfirmation
        ? ok({
            ...order,
            state: "awaiting_confirmation",
            dispatch: { attempts: 1, accepted: false },
            timestamps: { ...order.timestamps, confirmationRequestedAt: event.at },
          })
        : notApplicable(order, event);
    case "merchant_departed":
      return onDeparture(order);
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_delivered":
    case "handler_refused":
    case "handler_undelivered":
    case "deliver_called":
    case "refuse_called":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromAwaitingConfirmation(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "handler_accepted":
      return ok(
        {
          ...order,
          state: "confirmed",
          timestamps: { ...order.timestamps, confirmedAt: event.at },
        },
        [{ kind: "invite_payment" }],
      );
    case "handler_refused":
      return ok(
        closeWithoutMoney(order, "declined", {
          cause: "merchant_refused",
          code: event.code,
          message: event.message,
        }),
      );
    case "refuse_called":
      return ok(
        closeWithoutMoney(order, "declined", {
          cause: "merchant_refused",
          code: event.code,
          message: event.message,
        }),
        [{ kind: "answer_merchant", answer: { ok: true, result: "refused" } }],
      );
    case "handler_delivered":
    case "deliver_called":
      // Nothing has been charged for this order yet, so there is nothing to
      // hand goods over against.
      return reject(
        order,
        event,
        "delivery_before_payment",
        "goods cannot be handed over against a confirmation request: nothing has been charged",
      );
    case "handler_undelivered": {
      const deadline = order.timestamps.confirmationRequestedAt;
      return redeliver(
        order,
        event.at,
        deadline === null ? null : deadline + order.policy.deadlines.confirmationResponseMs,
      );
    }
    case "merchant_departed":
      return onDeparture(order);
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromConfirmed(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "payment_verified":
      return order.mode.settle === "after_fulfillment"
        ? enterPaid(order, event.at, "verified")
        : ok({ ...order, payment: "verified" }, [{ kind: "execute_payment" }]);
    case "payment_settled":
      return order.payment === "verified"
        ? enterPaid(order, event.at, "settled")
        : notApplicable(order, event);
    case "payment_verification_failed":
      return ok(
        closeWithoutMoney(order, "rejected", {
          cause: "payment_not_verified",
          reason: event.reason,
        }),
        [{ kind: "emit_merchant_event", event: "confirmed_order_unpaid" }],
      );
    case "payment_settle_failed":
      return order.payment === "verified"
        ? ok(
            {
              ...closeWithoutMoney(order, "rejected", { cause: "payment_not_settled" }),
              payment: "settle_failed",
            },
            [{ kind: "emit_merchant_event", event: "confirmed_order_unpaid" }],
          )
        : notApplicable(order, event);
    case "refuse_called":
      // Taking an order on does not bind the merchant while it is still open,
      // and here nothing has been charged for it yet.
      return ok(
        closeWithoutMoney(order, "declined", {
          cause: "merchant_refused",
          code: event.code,
          message: event.message,
        }),
        [{ kind: "answer_merchant", answer: { ok: true, result: "refused" } }],
      );
    case "handler_refused":
      return ok(
        closeWithoutMoney(order, "declined", {
          cause: "merchant_refused",
          code: event.code,
          message: event.message,
        }),
      );
    case "merchant_departed":
      return onDeparture(order);
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_delivered":
    case "handler_undelivered":
    case "deliver_called":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromPaid(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "order_dispatched":
      return ok({
        ...order,
        state: "dispatched",
        dispatch: { attempts: order.dispatch.attempts + 1, accepted: false },
        timestamps: { ...order.timestamps, dispatchedAt: event.at },
      });
    case "merchant_departed":
      return onDeparture(order);
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "handler_accepted":
    case "handler_delivered":
    case "handler_refused":
    case "handler_undelivered":
    case "deliver_called":
    case "refuse_called":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromDispatched(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "handler_accepted":
      return ok({ ...order, dispatch: { ...order.dispatch, accepted: true } });
    case "handler_delivered":
      return deliverGoods(order);
    case "handler_refused":
      return resolveFulfillmentFailure(order, {
        cause: "merchant_refused",
        code: event.code,
        message: event.message,
      });
    case "handler_undelivered":
      return redeliver(order, event.at, fulfillmentDeadline(order)[0]?.at ?? null);
    case "deliver_called":
      // In the synchronous mode the handler answers with the goods themselves
      // and there is no separate call at all.
      return order.mode.settle === "after_fulfillment"
        ? answer(order, { ok: false, error: "not_applicable_in_mode", retryable: false })
        : deliverGoods(order, [
            { kind: "answer_merchant", answer: { ok: true, result: "delivered" } },
          ]);
    case "refuse_called": {
      if (order.mode.settle === "after_fulfillment") {
        return answer(order, { ok: false, error: "not_applicable_in_mode", retryable: false });
      }
      const refused = resolveFulfillmentFailure(order, {
        cause: "merchant_refused",
        code: event.code,
        message: event.message,
      });
      if (!refused.ok) return refused;
      return ok(refused.order, [
        ...refused.effects,
        { kind: "answer_merchant", answer: { ok: true, result: "refused" } },
      ]);
    }
    case "order_dispatched":
      // At-least-once delivery: the same order landing again is ordinary, and
      // the counter is what the backoff counts from.
      return ok({
        ...order,
        dispatch: { ...order.dispatch, attempts: order.dispatch.attempts + 1 },
      });
    case "merchant_departed":
      return onDeparture(order);
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromFulfilled(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "payment_verified":
      return ok({ ...order, payment: "verified" }, [{ kind: "execute_payment" }]);
    case "payment_settled":
      return ok({ ...order, state: "delivered", payment: "settled" }, [
        { kind: "release_goods_to_agent" },
        { kind: "issue_receipt" },
      ]);
    case "payment_settle_failed":
      // Rare, and possible only where the money is executed last: between the
      // verification and the execution the funds went somewhere else.
      return ok({ ...order, state: "delivered_unpaid", payment: "settle_failed" }, [
        { kind: "emit_merchant_event", event: "payment_not_settled_after_sync_delivery" },
      ]);
    case "payment_verification_failed":
      // Only reachable on goods produced too late and picked up by a repeat:
      // the repeat's payment did not check out, so the goods go on waiting.
      return order.heldFulfillment
        ? ok({ ...order, state: "expired", payment: "none" })
        : notApplicable(order, event);
    case "deliver_called":
    case "handler_delivered":
      return answer(order, { ok: true, result: "already_delivered" });
    case "merchant_departed":
      return onDeparture(order);
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_refused":
    case "handler_undelivered":
    case "refuse_called":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromDelivered(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "deliver_called":
    case "handler_delivered":
      // Idempotent by the order's own identifier: the same success, no second
      // fulfillment and no second charge.
      return answer(order, { ok: true, result: "already_delivered" });
    case "handler_accepted":
    case "order_dispatched":
      // The order came round again off the queue. The merchant answers with
      // the state he is in, and what must not appear is a second fulfillment.
      return ok(order);
    case "refuse_called":
      return closedToMerchant(order);
    case "merchant_departed":
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "handler_refused":
    case "handler_undelivered":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromDeliveredUnpaid(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "purchase_repeated":
      // The repeat carries a fresh payment; the goods the merchant already
      // produced close the order, and he is asked for nothing more.
      return ok({ ...order, payment: "none" }, [{ kind: "verify_payment" }]);
    case "payment_verified":
      return ok({ ...order, payment: "verified" }, [{ kind: "execute_payment" }]);
    case "payment_settled":
      return ok({ ...order, state: "delivered", payment: "settled" }, [
        { kind: "release_goods_to_agent" },
        { kind: "issue_receipt" },
      ]);
    case "payment_settle_failed":
      return ok({ ...order, payment: "settle_failed" });
    case "payment_verification_failed":
      return ok({ ...order, payment: "none" });
    case "deliver_called":
    case "handler_delivered":
      return answer(order, { ok: true, result: "already_delivered" });
    case "merchant_departed":
      return onDeparture(order);
    case "quote_answered":
    case "quote_silent":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_refused":
    case "handler_undelivered":
    case "refuse_called":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromRefundDue(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "deliver_called":
      // The money for the goods has been paid, and to the buyer late goods are
      // better than a refund — as long as the refund has not gone through yet.
      return ok({ ...order, state: "delivered" }, [
        { kind: "release_goods_to_agent" },
        { kind: "issue_receipt" },
        { kind: "answer_merchant", answer: { ok: true, result: "debt_closed_by_delivery" } },
      ]);
    case "handler_delivered":
      return ok({ ...order, state: "delivered" }, [
        { kind: "release_goods_to_agent" },
        { kind: "issue_receipt" },
      ]);
    case "refund_settled":
      return ok({ ...order, state: "refunded" });
    case "refuse_called":
      return answer(order, { ok: true, result: "refused" });
    case "handler_refused":
    case "handler_accepted":
    case "handler_undelivered":
    case "order_dispatched":
    case "purchase_repeated":
      return ok(order);
    case "merchant_departed":
      // A debt survives the departure of the merchant who owes it.
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromRefunded(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "deliver_called":
    case "handler_delivered":
      // The buyer has his money back, so there is nothing left to deliver
      // against. Repeating the call would change nothing.
      return answer(order, { ok: false, error: "refund_already_settled", retryable: false });
    case "refuse_called":
      return closedToMerchant(order);
    case "merchant_departed":
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_refused":
    case "handler_undelivered":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromFailed(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "deliver_called":
    case "refuse_called":
      return closedToMerchant(order);
    case "handler_delivered":
      // He refused this order himself; goods arriving afterwards are not a
      // late fulfillment of it, they are a contradiction.
      return notApplicable(order, event);
    case "merchant_departed":
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_refused":
    case "handler_undelivered":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

/**
 * Whether goods arriving now are the late end of a fulfillment this order was
 * actually waiting for. Only a purchase closed by the synchronous budget
 * qualifies: an order that ran out of time waiting for a confirmation or for a
 * payment never reached the handler at all.
 */
function awaitedLateGoods(order: Order): boolean {
  return (
    order.mode.settle === "after_fulfillment" &&
    order.closure?.cause === "deadline_expired" &&
    order.closure.deadline === "sync_response"
  );
}

function fromExpired(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "handler_delivered":
      if (!awaitedLateGoods(order)) {
        return notApplicable(order, event);
      }
      // He started before the deadline and finished after it. The purchase is
      // closed and nothing was charged, but the work is not thrown away.
      return ok(
        order.heldFulfillment ? order : { ...order, heldFulfillment: true },
        order.heldFulfillment
          ? [{ kind: "answer_merchant", answer: { ok: true, result: "purchase_already_closed" } }]
          : [
              { kind: "hold_fulfillment" },
              {
                kind: "answer_merchant",
                answer: { ok: true, result: "purchase_already_closed" },
              },
            ],
      );
    case "purchase_repeated":
      // A repeat with the same key picks up goods that are already made, this
      // time with the payment.
      return order.heldFulfillment
        ? ok({ ...order, state: "fulfilled" }, [{ kind: "verify_payment" }])
        : ok(order);
    case "deliver_called":
    case "refuse_called":
      return closedToMerchant(order);
    case "merchant_departed":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_refused":
    case "handler_undelivered":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

/** `rejected`, `declined` and `cancelled`: closed, and nobody was charged. */
function fromClosedWithoutMoney(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "deliver_called":
    case "refuse_called":
      return closedToMerchant(order);
    case "merchant_departed":
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
    case "payment_settled":
    case "payment_settle_failed":
    case "confirmation_dispatched":
    case "order_dispatched":
    case "handler_accepted":
    case "handler_delivered":
    case "handler_refused":
    case "handler_undelivered":
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}
