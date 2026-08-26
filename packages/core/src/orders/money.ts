/**
 * The rules about money that no order may ever break, written down so a
 * machine can check them.
 *
 * These are not a substitute for the ledger; they are the shape the ledger has
 * to be able to trust. Every one of them says something a person would notice:
 * a buyer whose money is gone with nothing recording it, a merchant credited
 * for goods nobody paid for, a debt that appeared without a charge behind it.
 *
 * The gateway is meant to run this on the order it is about to write down. A
 * violation is a defect in this package, not a case to be handled.
 */

import type { Order, OrderState } from "./model.js";

/** The order is closed and, by that closure, nobody owes anybody anything. */
const CLOSED_OWING_NOTHING: readonly OrderState[] = [
  "rejected",
  "declined",
  "expired",
  "cancelled",
  "failed",
];

/** The states in which the buyer's money has legitimately been taken. */
const MAY_HOLD_THE_BUYERS_MONEY: readonly OrderState[] = [
  "paid",
  "dispatched",
  "delivered",
  "refund_due",
  "refunded",
];

/**
 * The states in which a payment may legitimately be mid-execution. Everywhere
 * else, a settle in flight means the machine let something else happen to the
 * order while it did not know where the money was.
 */
const MAY_BE_CHARGING: readonly OrderState[] = [
  "quoted",
  "confirmed",
  "fulfilled",
  "delivered_unpaid",
];

/** The states that record a debt, and therefore require a charge behind them. */
const RECORDS_A_DEBT: readonly OrderState[] = ["refund_due", "refunded"];

export function moneyInvariantViolations(order: Order): readonly string[] {
  const violations: string[] = [];

  if (order.payment === "settled" && !MAY_HOLD_THE_BUYERS_MONEY.includes(order.state)) {
    violations.push(
      `the buyer paid and the order sits in ${order.state}, which records neither goods nor a debt`,
    );
  }

  if (order.payment === "settled" && CLOSED_OWING_NOTHING.includes(order.state)) {
    violations.push(`the buyer paid and the order is closed as ${order.state}, owing nothing`);
  }

  if (order.payment !== "settled" && RECORDS_A_DEBT.includes(order.state)) {
    violations.push(`the order is in ${order.state} with no charge behind the debt`);
  }

  if (order.state === "delivered" && order.payment !== "settled") {
    violations.push("the order is a success and the money never moved");
  }

  if (order.state === "delivered_unpaid" && order.payment === "settled") {
    violations.push("the order is marked unpaid and the money did move");
  }

  if (order.payment === "settling" && !MAY_BE_CHARGING.includes(order.state)) {
    violations.push(
      `the payment is being executed and the order has moved on to ${order.state}, ` +
        "so whatever happens to the money now happens to a decided order",
    );
  }

  return violations;
}
