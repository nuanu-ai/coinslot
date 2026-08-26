/**
 * What state an order is in, in the words an agent and a merchant both read.
 *
 * These are the state machine's own endings, and they live here because they
 * are wire names: an agent asks what became of its purchase, a merchant
 * restarting a worker asks what is still open, and both have to get the same
 * answer. A second list kept anywhere else would be a second answer to one
 * question, and the one the machine keeps would win without anybody noticing.
 *
 * Every value below says what the agent can be told truthfully, which is not
 * always everything the machine knows. Where the two differ the value says so
 * in its own words: `rejected` is coarser than the machine's states behind it,
 * and `in_progress` covers every step of a purchase that has not finished —
 * an order just sent to the merchant and one the merchant has taken on and
 * owes a delivery for are one word here, because to the buyer they are one
 * situation. A merchant who needs those apart is not reading this vocabulary;
 * they are reading their own order, which carries the answer they gave.
 *
 * The word for a purchase still running exists on purpose: an agent that had
 * to read silence as an answer would take an unfinished order for a refused
 * one, and hold a budget against a sale that is still going to happen.
 */

import { z } from "zod";

export const ORDER_STATUSES = Object.freeze([
  /** Running: no terminal answer yet, and no reason to read one into it. */
  "in_progress",
  /** Success: the product is with the agent and the money with the merchant. */
  "delivered",
  /**
   * Closed and the buyer's money is known not to have moved — the product was
   * gone, the parameters did not fit, the payment failed its check, the charge
   * came back failed, or a synchronous handler refused.
   *
   * The machine keeps a finer distinction behind this word: a purchase that
   * never reached the merchant and one the merchant refused are separate
   * states there, because the merchant's own accounting needs them apart. To
   * the agent both are one sentence — a refusal with a reason — and the reason
   * travels in the refusal code, so nothing is lost by the agent-facing word
   * being the coarser one.
   */
  "rejected",
  /**
   * Closed, and nobody can say whether the buyer was charged: the payment
   * network was asked and never answered.
   *
   * Deliberately not `rejected`, and this is the fifth gate in one value. An
   * agent told its purchase did not happen goes and buys the same thing
   * elsewhere without looking at its wallet — a claim we would be making with
   * no evidence behind it. What we know is that we asked and heard nothing;
   * saying so is the honest answer, and it is what a dispute, an error text
   * and the merchant's reconciliation all read.
   */
  "payment_unresolved",
  /** The merchant answered a confirmation request with "I will not deliver". */
  "declined",
  /**
   * A deadline passed with nobody at fault: the confirmation, the payment that
   * was to follow it, or the synchronous delivery.
   */
  "expired",
  /** The merchant left, and orders still open closed with them. */
  "cancelled",
  /** The money moved and the delivery did not happen. */
  "refund_due",
  /** That debt has since been paid back to the buyer. */
  "refunded",
  /**
   * The merchant delivered synchronously and the payment did not execute. The
   * goods exist, nothing was paid, and the order stays open until a repeat
   * purchase carries the payment through.
   */
  "delivered_unpaid",
] as const);

export const OrderStatusSchema = z.enum(ORDER_STATUSES);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;
