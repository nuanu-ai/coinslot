/**
 * Which clocks are running on an order right now.
 *
 * The gateway schedules its timers off this list and the machine checks
 * against it: a deadline that is not in the list cannot expire an order. That
 * one rule closes a money hole that is easy to miss — a quote timing out while
 * the settle of that very order is already on its way would close a purchase
 * that is about to be paid for.
 *
 * Two clocks start at instants worth naming out loud. The synchronous budget
 * is ours and it is the ceiling on how long the agent waits, so it runs from
 * the purchase itself rather than from the moment the order reached the
 * merchant. The merchant's fulfillment deadline runs from the settle: the
 * buyer's money is at risk from then on, and it is that risk the deadline
 * bounds.
 */

import { assertNever } from "../index.js";
import type { Deadline, DeadlineKind, Order } from "./model.js";

export function deadlines(order: Order): readonly Deadline[] {
  switch (order.state) {
    case "created":
      // The price question is still out. Its own silence rules bound it, and
      // an order without a price has nothing else to wait for.
      return [];

    case "quoted":
      // Once the payment has been verified the settle is in flight, and the
      // life of the price is no longer what the order is waiting on.
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
      // The merchant has done his part; executing the payment is ours, and no
      // deadline of his may punish him for our step.
      return [];

    case "delivered":
    case "delivered_unpaid":
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
  if (order.mode.settle === "after_fulfillment") {
    return [
      {
        kind: "sync_response",
        at: order.timestamps.createdAt + order.policy.deadlines.syncResponseMs,
      },
    ];
  }

  return order.timestamps.paidAt === null
    ? []
    : [
        {
          kind: "async_fulfillment",
          at: order.timestamps.paidAt + order.policy.deadlines.asyncFulfillmentMs,
        },
      ];
}

export function isArmed(order: Order, kind: DeadlineKind): boolean {
  return deadlines(order).some((deadline) => deadline.kind === kind);
}
