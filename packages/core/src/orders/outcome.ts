/**
 * What the agent is told an order came to.
 *
 * The vocabulary here is the portal's table of how an order can end, read from
 * the buyer's side: seven endings, plus the word for an order that has not
 * ended yet, plus the one for a debt that has been paid back. The projection is
 * separate from the state on purpose — the machine keeps distinctions the
 * merchant's own accounting needs, and the agent is told only what is true of
 * his purchase.
 *
 * The fifth gate is the whole point of `in_progress`. An order whose answer has
 * not arrived says so, and the agent does not read silence as a refusal.
 */

import { assertNever } from "../index.js";
import type { Order } from "./model.js";

export const ORDER_OUTCOMES = [
  /** The answer is not in yet. Not a refusal, and not a promise either. */
  "in_progress",
  /** The goods are the agent's and the receipt is written. */
  "delivered",
  /**
   * The purchase did not happen and nothing was charged: the goods were gone,
   * the parameters did not fit, the payment did not pass verification, or the
   * merchant refused a synchronous order.
   */
  "rejected",
  /** The merchant answered a confirmation request with "I will not". */
  "declined",
  /** A deadline ran out. Nothing was charged. */
  "expired",
  /** The merchant left and the order closed with him. */
  "cancelled",
  /** The money was taken and the goods never came: a refund is owed. */
  "refund_due",
  /** That refund has been paid back. */
  "refunded",
  /**
   * The merchant produced the goods for a synchronous purchase and the charge
   * did not go through. The purchase did not happen; repeating it drives the
   * payment home against the fulfillment that already exists.
   */
  "delivered_unpaid",
] as const;

export type OrderOutcome = (typeof ORDER_OUTCOMES)[number];

export function outcomeFor(order: Order): OrderOutcome {
  switch (order.state) {
    case "created":
    case "quoted":
    case "awaiting_confirmation":
    case "confirmed":
    case "paid":
    case "dispatched":
    case "fulfilled":
      return "in_progress";
    case "delivered":
      return "delivered";
    case "delivered_unpaid":
      return "delivered_unpaid";
    case "refund_due":
      return "refund_due";
    case "refunded":
      return "refunded";
    case "failed":
      // The merchant's handler refused before any money moved. The merchant's
      // own metrics can tell this apart from a purchase that never reached
      // him; to the agent both are one sentence — a refusal with a reason.
      return "rejected";
    case "rejected":
      return "rejected";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    default:
      return assertNever(order.state, "order state");
  }
}
