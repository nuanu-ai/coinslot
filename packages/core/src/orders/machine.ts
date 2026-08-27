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
  DeadlineKind,
  Effect,
  MerchantAnswer,
  Order,
  OrderEvent,
  OrderMode,
  OrderState,
  Price,
  QuoteSource,
  StateEvent,
  TransitionRejectionCode,
  TransitionResult,
} from "./model.js";
import { effectsOnQuoted } from "./model.js";
import { nextRedelivery } from "./redelivery.js";

/**
 * What the machine still answers while the payment is being executed.
 *
 * The settle's own outcome, always: that is what the whole window is waiting
 * for. And the merchant's two calls in the two states where he is genuinely
 * mid-conversation with us — he has produced the goods and is retrying after a
 * broken connection, and the portal promises him the same typed success back
 * every time. Where his retry lands must not depend on where an internal
 * settle happens to be at that instant, and those two answers read the order's
 * current fact and change nothing.
 *
 * Everything else is refused until the settle reports: for those few seconds
 * the machine does not know where the buyer's money is, and neither closing
 * the order as free nor spending the money again is an answer it can stand
 * behind. That refusal is marked retryable and the interpreter is expected to
 * send the event again once the settle has reported.
 */
function allowedWhileSettling(order: Order, event: OrderEvent): boolean {
  if (event.kind === "payment_settled" || event.kind === "payment_settle_failed") {
    return true;
  }

  const merchantIsHoldingIt = order.state === "fulfilled" || order.state === "delivered_unpaid";
  return merchantIsHoldingIt && (event.kind === "deliver_called" || event.kind === "refuse_called");
}

export function transition(order: Order, event: OrderEvent): TransitionResult {
  if (event.kind === "deadline_expired") {
    return onDeadline(order, event);
  }

  if (order.payment === "settling" && !allowedWhileSettling(order, event)) {
    return reject(
      order,
      event,
      "settle_in_flight",
      `the payment is being executed, so ${event.kind} is not answered until it reports`,
    );
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

/**
 * Only one refusal means "come back later". Every other one is a statement
 * that the event does not belong here, and sending it again would produce the
 * same answer; a timer that fired at the wrong moment is fixed by rescheduling
 * off `deadlines(order)`, not by repeating the expiry.
 */
function isRetryable(code: TransitionRejectionCode): boolean {
  return code === "settle_in_flight";
}

function reject(
  order: Order,
  event: OrderEvent,
  code: TransitionRejectionCode,
  message: string,
): TransitionResult {
  return {
    ok: false,
    rejection: {
      code,
      retryable: isRetryable(code),
      state: order.state,
      event: event.kind,
      message,
    },
  };
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

/**
 * The merchant is told his acceptance landed.
 *
 * Written once and used from two arms — dispatched, and the confirmation the
 * same event answers — because those are the same fact about him and a
 * merchant reading two different answers to his one answer would be reading a
 * difference that is not there. Arms, not states: an acceptance arriving while
 * our record still says `paid` is routed into the dispatched arm, so three
 * states reach this effect and five in all can handle the event.
 * It rides alongside the other effects rather than through `answer`, which
 * replaces them.
 *
 * The two states where an acceptance arrives for an order that has moved on
 * are answered elsewhere and not with this. A delivered order says so in its
 * own arm below, because the goods are not owed and telling him otherwise
 * would send him looking for them. An order owed a refund says this word, but
 * through the gateway rather than from here — there the machine has nothing to
 * do about the event, and the answer is what his own call amounted to.
 */
const ACCEPTANCE_LANDED: Effect = {
  kind: "answer_merchant",
  answer: { ok: true, result: "accepted" },
};

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

/**
 * The merchant did not say what the goods cost. It reaches the machine either
 * as the gateway's own `quote_silent` — a timeout, a server error, an answer
 * that did not parse, a stamp older than the freshness threshold — or as the
 * `quote_response` deadline running out on our side. Both are the same fact
 * and get the same answer, which is the per-mode policy and never a closure of
 * its own.
 */
function onQuoteSilence(order: Order, at: number): TransitionResult {
  return sellsOnSilentQuote(order.mode)
    ? enterQuoted(order, at, order.cardPrice, "card_snapshot")
    : ok(closeWithoutMoney(order, "rejected", { cause: "quote_silent" }));
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

/** Hands the payment over for execution and starts the clock on the answer. */
function startSettle(order: Order, at: number, state?: OrderState): TransitionResult {
  return ok(
    {
      ...order,
      state: state ?? order.state,
      payment: "settling",
      timestamps: { ...order.timestamps, settleStartedAt: at },
    },
    [{ kind: "execute_payment" }],
  );
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
      { kind: "emit_merchant_event", event: "order.refund_due" },
    ]);
  }

  const state: OrderState = closure.cause === "merchant_refused" ? "failed" : "expired";
  return ok(closeWithoutMoney(order, state, closure));
}

function deliverGoods(order: Order, at: number, extra: readonly Effect[] = []): TransitionResult {
  if (order.mode.settle === "after_fulfillment") {
    // The goods exist and the money has not moved yet: executing the payment
    // is the last step, and it is ours.
    const settling = startSettle(order, at, "fulfilled");
    if (!settling.ok) return settling;
    return ok(settling.order, [...settling.effects, ...extra]);
  }

  return ok({ ...order, state: "delivered", closure: null }, [
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
      { kind: "emit_merchant_event", event: "order.refund_due" },
    ]);
  }

  return ok(closeWithoutMoney(order, "cancelled", closure));
}

/**
 * An order that never reached the handler goes back into the queue, unless
 * another attempt would be pointless. `giveUp` is the deadline this leg of the
 * order is running against, and it is the deadline the closure will cite:
 * naming a fulfillment deadline on an order that never reached fulfillment
 * would be a claim the machine cannot back.
 */
function redeliver(
  order: Order,
  at: number,
  deadlineAt: number | null,
  giveUp: DeadlineKind,
): TransitionResult {
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

  return resolveFulfillmentFailure(order, { cause: "deadline_expired", deadline: giveUp });
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
    case "quote_response":
      // Not a closure of its own. Running out of patience with the merchant's
      // price check is his silence, and silence is answered by mode.
      return onQuoteSilence(order, event.at);
    case "quote_expiry":
    case "confirmation_response":
      return ok(closeWithoutMoney(order, "expired", closure));
    case "settle_response":
      return onSilentSettle(order);
    case "payment_after_confirmation":
      // The merchant said he would fulfill and nobody paid him for it. He owes
      // nothing, and he is told so rather than left waiting.
      return ok(closeWithoutMoney(order, "expired", closure), [
        { kind: "emit_merchant_event", event: "order.unpaid_after_confirmation" },
      ]);
    case "sync_response":
    case "async_fulfillment":
      return resolveFulfillmentFailure(order, closure);
    default:
      return assertNever(event.deadline, "deadline kind");
  }
}

/**
 * The execution of the payment never reported back. ADR-0002 §3 settles what
 * to do about it: a silent decision about the charge is always a closed
 * failure, the purchase is refused rather than carried on with.
 *
 * That is a guess that the money did not move, and the machine says so rather
 * than pretending to know: a charge that reports in afterwards is turned into
 * a debt by `fromClosedWithoutMoney`, not thrown away.
 */
function onSilentSettle(order: Order): TransitionResult {
  // Not "the charge failed". The charge said nothing, and writing down the
  // stronger of the two is what let a repeat of the purchase send a second
  // charge on top of a first one nobody had heard from.
  const silent: Order = { ...order, payment: "outcome_unknown" };

  if (order.state === "fulfilled") {
    // The merchant produced the goods and we cannot say the money arrived. He
    // is told, so that he does not have to find it by reconciling by hand.
    return ok({ ...silent, state: "delivered_unpaid", closure: null }, [
      { kind: "emit_merchant_event", event: "order.payment_failed_after_delivery" },
    ]);
  }

  if (order.state === "delivered_unpaid") {
    return ok(silent);
  }

  const closed = closeWithoutMoney(silent, "rejected", { cause: "payment_outcome_unknown" });

  // A merchant who answered "I will fulfill it" is owed the news that nobody
  // paid him, and it makes no difference to him whether the charge failed or
  // went quiet.
  return order.state === "confirmed"
    ? ok(closed, [{ kind: "emit_merchant_event", event: "order.unpaid_after_confirmation" }])
    : ok(closed);
}

// --- the states -------------------------------------------------------------

function fromCreated(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "quote_answered":
      return event.available
        ? enterQuoted(order, event.at, event.price, "merchant_answer")
        : ok(closeWithoutMoney(order, "rejected", { cause: "unavailable" }));
    case "quote_silent":
      return onQuoteSilence(order, event.at);
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
        // The merchant of a card that needs confirming has not said he will
        // fulfill it yet, and until he does nothing may touch the buyer's
        // money. (A verification arriving twice off the queue is stopped
        // earlier, by the settle-in-flight guard: the first one is still being
        // executed when the second lands.)
        return notApplicable(order, event);
      }
      return order.mode.settle === "after_fulfillment"
        ? enterPaid(order, event.at, "verified")
        : startSettle(order, event.at);
    case "payment_verification_failed":
      return ok(
        closeWithoutMoney(order, "rejected", {
          cause: "payment_not_verified",
          reason: event.reason,
        }),
      );
    case "payment_settled":
      // Only a payment that was actually sent for execution can come back
      // done: without this, a stray settle would hand the merchant an order
      // nobody paid for.
      return order.payment === "settling"
        ? enterPaid(order, event.at, "settled")
        : notApplicable(order, event);
    case "payment_settle_failed":
      return order.payment === "settling"
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
        // The agent is invited to pay, and the answer says his "I will"
        // landed — the same word the asynchronous mode uses, because what an
        // answer names is which of the three things he said, not what the
        // machine did about it. Nobody reads it yet: the confirmation mode has
        // no shape on the wire, and the gateway throws on `invite_payment`
        // rather than invent one. The machine still says it, because the day
        // that mode is wired up the merchant's answer is already answered.
        [{ kind: "invite_payment" }, ACCEPTANCE_LANDED],
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
        "confirmation_response",
      );
    }
    case "confirmation_dispatched":
      // The confirmation request has its own deliveries and its own worker
      // that can die. Counting them is what makes the backoff back off and the
      // attempt cap mean anything on this leg of the order. The merchant's own
      // deadline is not moved by our redeliveries: it runs from the first time
      // we asked him, not from the last time we managed to reach him.
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
        : startSettle(order, event.at);
    case "payment_settled":
      return order.payment === "settling"
        ? enterPaid(order, event.at, "settled")
        : notApplicable(order, event);
    case "payment_verification_failed":
      return ok(
        closeWithoutMoney(order, "rejected", {
          cause: "payment_not_verified",
          reason: event.reason,
        }),
        [{ kind: "emit_merchant_event", event: "order.unpaid_after_confirmation" }],
      );
    case "payment_settle_failed":
      return order.payment === "settling"
        ? ok(
            {
              ...closeWithoutMoney(order, "rejected", { cause: "payment_not_settled" }),
              payment: "settle_failed",
            },
            [{ kind: "emit_merchant_event", event: "order.unpaid_after_confirmation" }],
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
      return ok(dispatchedOrder(order, event.at));
    case "deliver_called":
    case "refuse_called":
      if (order.mode.settle === "after_fulfillment") {
        // In the synchronous mode these calls do not exist, so this one is
        // answered and nothing else happens. In particular the order does not
        // acquire a record of having been handed to a merchant on the strength
        // of a call the machine just refused.
        return answer(order, { ok: false, error: "not_applicable_in_mode", retryable: false });
      }
      // A call can be made from anywhere at any time and proves nothing about
      // whether the order round ever reached his handler — in the confirm mode
      // he knows about the order from the confirmation round. So it is
      // answered where it lands, and the delivery counter is left alone.
      return fromDispatched({ ...order, state: "dispatched" }, event);
    case "handler_accepted":
    case "handler_delivered":
    case "handler_refused":
    case "handler_undelivered":
      // The order is queued and our own record of the hand-over has not landed
      // yet — but the merchant is plainly holding it, because he is answering.
      // Dropping his answer here would run the order to its deadline and
      // refund a buyer who was already holding the goods.
      return fromDispatched(handedOver(order), event);
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

/** The hand-over we recorded ourselves, with the instant it happened at. */
function dispatchedOrder(order: Order, at: number): Order {
  return {
    ...order,
    state: "dispatched",
    dispatch: { attempts: order.dispatch.attempts + 1, accepted: false },
    timestamps: { ...order.timestamps, dispatchedAt: at },
  };
}

/**
 * The hand-over we learned about from his handler answering, which is a
 * different thing: we know it happened, and we do not know when. The instant
 * stays empty rather than being filled in with the moment his answer reached
 * us — a support view, a latency metric and a dispute all read that field, and
 * a made-up number there is worse than an absent one.
 *
 * Only a handler answer gets here. A `deliver` or `refuse` call can be made
 * from anywhere and says nothing about whether this order round reached him.
 *
 * The counter this keeps can be one low: nothing on the wire ties a hand-over
 * to the record of it, so when a record is lost the next one to arrive is
 * taken for the one we inferred. That is the direction to be wrong in — it
 * costs a merchant who is already failing one extra delivery rather than one
 * fewer, and the alternative would cut his retries short.
 */
function handedOver(order: Order): Order {
  return {
    ...order,
    state: "dispatched",
    dispatch: { ...order.dispatch, attempts: Math.max(order.dispatch.attempts, 1) },
  };
}

function fromDispatched(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "handler_accepted":
      // The order is his, and he is told so. Delivery is at least once, so the
      // same acceptance arrives again on every redelivery and is answered the
      // same way each time — there is nothing here for a repeat to get wrong.
      //
      // The flag is a record and not a control, and a reader who came here
      // asking what acknowledges an acceptance would otherwise leave with the
      // right answer for the wrong reason. Nothing branches on it, here or in
      // the gateway. What stops the order being sent out again is the gateway
      // clearing the hand-over it was waiting on when it applies this event, so
      // that the reminder left against that hand-over finds it is no longer the
      // open one (`openDeliveryId`, apps/gateway/src/app/gateway.ts:186).
      return ok({ ...order, dispatch: { ...order.dispatch, accepted: true } }, [ACCEPTANCE_LANDED]);
    case "handler_delivered":
      return deliverGoods(order, event.at);
    case "handler_refused":
      return resolveFulfillmentFailure(order, {
        cause: "merchant_refused",
        code: event.code,
        message: event.message,
      });
    case "handler_undelivered": {
      const deadline = fulfillmentDeadline(order)[0];
      return redeliver(
        order,
        event.at,
        deadline?.at ?? null,
        deadline?.kind ??
          (order.mode.settle === "after_fulfillment" ? "sync_response" : "async_fulfillment"),
      );
    }
    case "deliver_called":
      // In the synchronous mode the handler answers with the goods themselves
      // and there is no separate call at all.
      return order.mode.settle === "after_fulfillment"
        ? answer(order, { ok: false, error: "not_applicable_in_mode", retryable: false })
        : deliverGoods(order, event.at, [
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
    case "order_dispatched": {
      // At-least-once delivery: the same order landing again is ordinary, and
      // the counter is what the backoff counts from. But this event is also
      // how the record of a hand-over we already learned about from the
      // merchant finally reaches us, and that one hand-over is counted once —
      // the counter is what the backoff and the attempt cap read, so counting
      // it twice costs the order a retry.
      const alreadyRecorded = order.timestamps.dispatchedAt !== null;
      return ok({
        ...order,
        dispatch: {
          ...order.dispatch,
          attempts: alreadyRecorded ? order.dispatch.attempts + 1 : order.dispatch.attempts,
        },
        timestamps: { ...order.timestamps, dispatchedAt: event.at },
      });
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
    case "refund_settled":
      return notApplicable(order, event);
    default:
      return assertNever(event, "order event");
  }
}

function fromFulfilled(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "payment_settled":
      return order.payment === "settling"
        ? ok({ ...order, state: "delivered", payment: "settled", closure: null }, [
            { kind: "release_goods_to_agent" },
            { kind: "issue_receipt" },
          ])
        : notApplicable(order, event);
    case "payment_settle_failed":
      // Rare, and possible only where the money is executed last: between the
      // verification and the execution the funds went somewhere else.
      return order.payment === "settling"
        ? ok({ ...order, state: "delivered_unpaid", payment: "settle_failed", closure: null }, [
            { kind: "emit_merchant_event", event: "order.payment_failed_after_delivery" },
          ])
        : notApplicable(order, event);
    case "deliver_called":
    case "handler_delivered":
      return answer(order, { ok: true, result: "already_delivered" });
    case "refuse_called":
      // This state belongs to the synchronous mode, where the handler refuses
      // by answering and there is no separate call at all.
      return answer(order, { ok: false, error: "not_applicable_in_mode", retryable: false });
    case "purchase_repeated":
      return ok(order);
    // Both entrances to this state go through `startSettle`, so an order here
    // is always mid-charge and the settling guard has already turned back
    // everything below. These arms exist for the compiler; refusing is the
    // safe thing for them to say if that ever stops being true.
    case "merchant_departed":
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
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

function fromDelivered(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "deliver_called":
    case "handler_delivered":
      // Idempotent by the order's own identifier: the same success, no second
      // fulfillment and no second charge.
      return answer(order, { ok: true, result: "already_delivered" });
    case "handler_accepted":
      // A worker taking on an order that is already delivered. Deliveries are
      // at least once, so this is ordinary rather than a fault, and the answer
      // is the state he is in: told his acceptance landed he would write the
      // order down as under way — which is what that word means here — and go
      // looking for goods he has already handed over.
      //
      // Where the line falls, since the same at-least-once argument reaches
      // further than this arm: a redelivered acceptance is answered as
      // ordinary only where the order still stands and nothing failed. On an
      // order that ran out its deadline or closed with a departed merchant the
      // refusal stays, and the entry it writes in his log is one he wants —
      // there the order genuinely did fail, and `order_already_closed` is
      // exactly true of it rather than merely safe to say.
      return answer(order, { ok: true, result: "already_delivered" });
    case "order_dispatched":
      // The order came round again off the queue. Nothing is owed on it and
      // what must not appear is a second fulfillment.
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
      //
      // Unless a charge is already out there unaccounted for. Then the repeat
      // waits: sending a second one would be spending the buyer's money on a
      // guess about the first, and only the payment layer can end that guess.
      if (order.payment === "outcome_unknown") {
        return reject(
          order,
          event,
          "settle_in_flight",
          "a charge on this order has not reported back, so no second one is sent",
        );
      }
      return ok({ ...order, payment: "none" }, [{ kind: "verify_payment" }]);
    case "payment_verified":
      return order.payment === "none" ? startSettle(order, event.at) : notApplicable(order, event);
    case "payment_settled":
      // The second of these is the payment layer finally answering about a
      // charge we had given up on. The goods are made and the money did move
      // after all, so the purchase is a success rather than a debt.
      return order.payment === "settling" || order.payment === "outcome_unknown"
        ? ok({ ...order, state: "delivered", payment: "settled" }, [
            { kind: "release_goods_to_agent" },
            { kind: "issue_receipt" },
          ])
        : notApplicable(order, event);
    case "payment_settle_failed":
      return order.payment === "settling" || order.payment === "outcome_unknown"
        ? ok({ ...order, payment: "settle_failed" })
        : notApplicable(order, event);
    case "payment_verification_failed":
      // A payment that did not check out never became a charge, so there is
      // nothing here to write down. In particular it does not clear the record
      // of a charge that IS out there unaccounted for: doing that let a repeat
      // walk straight past the guard above and send a second one.
      return ok(order);
    case "deliver_called":
    case "handler_delivered":
      return answer(order, { ok: true, result: "already_delivered" });
    case "refuse_called":
      // This state belongs to the synchronous mode, where the handler refuses
      // by answering and there is no separate call at all.
      return answer(order, { ok: false, error: "not_applicable_in_mode", retryable: false });
    case "merchant_departed":
      // He owes nothing on this order: the goods are made and it is the money
      // that never came. The portal promises the buyer can still close it with
      // a repeat, and his leaving takes nothing away from that.
      return ok(order);
    case "quote_answered":
    case "quote_silent":
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

function fromRefundDue(order: Order, event: StateEvent): TransitionResult {
  switch (event.kind) {
    case "deliver_called":
      // The money for the goods has been paid, and to the buyer late goods are
      // better than a refund — as long as the refund has not gone through yet.
      // The reason the order was marked for a refund goes with it: an order
      // that ended in success may not carry "the merchant refused" as the
      // record of how it ended.
      //
      // Known and open: a refund that is already on its way but has not
      // reported back is invisible here, and this delivery races it. Closing
      // that race needs the refund mechanism itself, which is an open question
      // of `docs/research/16-order-state-machine.md`.
      return ok({ ...order, state: "delivered", closure: null }, [
        { kind: "release_goods_to_agent" },
        { kind: "issue_receipt" },
        { kind: "answer_merchant", answer: { ok: true, result: "debt_closed_by_delivery" } },
      ]);
    case "handler_delivered":
      return ok({ ...order, state: "delivered", closure: null }, [
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
      // time with the payment. Asking for that payment does not by itself
      // reopen the order: the verification of the payment that ran out of time
      // went with the purchase it belonged to, the repeat brings its own, and
      // until that one checks out there is nothing here but a closed purchase
      // and some goods in a drawer.
      return order.heldFulfillment
        ? ok({ ...order, payment: "none" }, [{ kind: "verify_payment" }])
        : ok(order);
    case "payment_verified":
      // Now there is something to reopen it with.
      return order.heldFulfillment && order.payment === "none"
        ? startSettle(order, event.at, "fulfilled")
        : notApplicable(order, event);
    case "payment_verification_failed":
      // The repeat's payment did not check out. The purchase stays closed and
      // the goods stay where they are; the agent may try again.
      return order.heldFulfillment ? ok(order) : notApplicable(order, event);
    case "deliver_called":
    case "refuse_called":
      return closedToMerchant(order);
    case "merchant_departed":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
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
    case "payment_settled":
      // The purchase was refused because the execution of the payment never
      // reported back, and now it has. Closing on that silence was a guess
      // that the money had not moved; the guess was wrong, and the buyer is
      // owed it back rather than left with a refusal and an empty wallet.
      //
      // Only the guess can be overturned this way. An order closed because the
      // payment layer said the charge failed is not reopened by a later claim
      // that it succeeded: that is the payment layer contradicting itself, and
      // the machine is not the place to resolve it.
      if (order.closure?.cause !== "payment_outcome_unknown") {
        return notApplicable(order, event);
      }
      return ok({ ...order, state: "refund_due", payment: "settled" }, [
        { kind: "mark_refund_due", closure: order.closure },
        { kind: "emit_merchant_event", event: "order.refund_due" },
      ]);
    case "payment_settle_failed":
      // The same late answer, saying the money did not move after all. It
      // turns the guess into a fact, once: a second one finds the fact already
      // written and has nothing to add.
      return order.closure?.cause === "payment_outcome_unknown"
        ? ok({ ...order, payment: "settle_failed", closure: { cause: "payment_not_settled" } })
        : notApplicable(order, event);
    case "merchant_departed":
    case "purchase_repeated":
      return ok(order);
    case "quote_answered":
    case "quote_silent":
    case "payment_verified":
    case "payment_verification_failed":
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
