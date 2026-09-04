/**
 * Which clocks are running on an order right now.
 *
 * The gateway schedules its timers off this list and the machine checks
 * against it: a deadline that is not in the list cannot expire an order, and
 * one that is in it cannot expire it before its time. Those two rules together
 * close a money hole that is easy to miss — a quote timing out while the settle
 * of that very order is already on its way, or a timer that fired twice
 * closing an order whose merchant is still honestly inside his deadline.
 *
 * Every open state in which the machine is waiting for somebody has exactly
 * one clock on it, and the reason is `docs/research/16-order-state-machine.md`:
 * an overdue order does not hang, it goes to an honest ending and the agent is
 * told which.
 *
 * Three open states carry no clock, and each is a deliberate exception rather
 * than a gap. `refund_due` and `delivered_unpaid` are the two the portal calls
 * unclosed: the purchase is over and what is left is a debt in one direction
 * or the other, which a deadline cannot settle. And an order whose charge
 * never reported back waits for the payment layer to speak, because that is a
 * fact only the payment layer has and another clock would only re-guess it.
 *
 * Three of the clocks start at instants worth naming out loud. Both of the
 * clocks on the goods run from the moment the order became paid, which in the
 * two modes is a different fact about the money: synchronously it is the
 * payment checking out, because nothing has moved yet and the goods are what
 * moves it; asynchronously it is the settle, because the buyer's money is at
 * risk from then on and it is that risk the deadline bounds. And the settle's
 * own deadline runs from the moment the payment was handed over for execution.
 *
 * Neither of the first two runs from the opening of the order, and that is a
 * lesson rather than a preference. The synchronous one used to, and an agent
 * that read the price, decided, and paid twenty seconds later — legitimately,
 * inside the life of its quote — arrived at an order whose whole answer had
 * already run out before there was anything to hand the merchant. He delivered,
 * the money moved, and the agent was told its purchase was still in progress
 * and given nothing. Before the payment an order is held by the life of its
 * price and by nothing else; the merchant cannot be on a clock for goods
 * nobody has paid for yet.
 */

import { assertNever } from "../index.js";
import type { Deadline, DeadlineKind, Order } from "./model.js";

export function deadlines(order: Order): readonly Deadline[] {
  // While the payment is being executed, that is the only thing the order is
  // waiting on, whichever state it is sitting in.
  if (order.payment === "settling") {
    // A settling order with no start time cannot have come out of this
    // package, but it can come out of a store, and it is the one order that
    // must never lose its clock: nothing but the settle's own outcome can move
    // it, and without a clock nothing will ever produce that outcome. So it is
    // already overdue — we cannot say it is not — and `moneyInvariantViolations`
    // says the same thing in words.
    const startedAt = order.timestamps.settleStartedAt;
    return [
      {
        kind: "settle_response",
        at:
          startedAt === null
            ? order.timestamps.createdAt
            : startedAt + order.policy.deadlines.settleResponseMs,
      },
    ];
  }

  switch (order.state) {
    case "created":
      // The price has not come back yet. Running out of this one is the
      // merchant's silence, and silence is answered by mode rather than by
      // closing the order — which is why it is not the life of a price that
      // was never quoted.
      return [
        {
          kind: "quote_response",
          at: order.timestamps.createdAt + order.policy.deadlines.quoteResponseMs,
        },
      ];

    case "quoted":
      return order.payment === "none" && order.timestamps.quotedAt !== null
        ? [
            {
              kind: "quote_expiry",
              at: order.timestamps.quotedAt + order.policy.deadlines.quoteTtlMs,
            },
          ]
        : [];

    case "awaiting_confirmation":
      return order.timestamps.confirmationRequestedAt === null
        ? []
        : [
            {
              kind: "confirmation_response",
              at:
                order.timestamps.confirmationRequestedAt +
                order.policy.deadlines.confirmationResponseMs,
            },
          ];

    case "confirmed":
      return order.payment === "none" && order.timestamps.confirmedAt !== null
        ? [
            {
              kind: "payment_after_confirmation",
              at: order.timestamps.confirmedAt + order.policy.deadlines.paymentAfterConfirmationMs,
            },
          ]
        : [];

    case "paid":
    case "dispatched":
      return fulfillmentDeadline(order);

    case "fulfilled":
    case "delivered_unpaid":
      // The merchant has produced the goods and the money is ours to move. He
      // is held to none of his deadlines here; the clock that runs, when one
      // runs, is the settle's, handled above.
      return [];

    case "delivered":
    case "refund_due":
    case "refunded":
    case "failed":
    case "rejected":
    case "declined":
    case "expired":
    case "cancelled":
      return [];

    default:
      return assertNever(order.state, "order state");
  }
}

/**
 * The deadline on the goods themselves, whichever of the two modes the order
 * is in. It is exported because the machine asks for it when it decides
 * whether another delivery attempt could still arrive in time.
 */
export function fulfillmentDeadline(order: Order): readonly Deadline[] {
  const paidAt = order.timestamps.paidAt;
  if (paidAt === null) {
    return [];
  }

  const { syncResponseMs, asyncFulfillmentMs } = order.policy.deadlines;

  return order.mode.settle === "after_fulfillment"
    ? [{ kind: "sync_response", at: paidAt + syncResponseMs }]
    : [{ kind: "async_fulfillment", at: paidAt + asyncFulfillmentMs }];
}

export function isArmed(order: Order, kind: DeadlineKind): boolean {
  return deadlines(order).some((deadline) => deadline.kind === kind);
}
