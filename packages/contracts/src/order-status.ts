/**
 * What state an order is in, in the words an agent and a merchant both read.
 *
 * These are the state machine's own endings, and they live here because they
 * are wire names: an agent asks what became of its purchase, a merchant
 * restarting a worker asks what is still open, and both have to get the same
 * answer. A second list kept anywhere else would be a second answer to one
 * question, and the one the machine keeps would win without anybody noticing.
 *
 * Every value below says exactly what the machine knows and nothing more. The
 * one for a purchase still running has a name of its own on purpose: an agent
 * that had to read silence as an answer would take an unfinished order for a
 * refused one, and hold a budget against a sale that is still going to happen.
 */

import { z } from "zod";

export const ORDER_STATUSES = Object.freeze([
  /** Running: no terminal answer yet, and no reason to read one into it. */
  "in_progress",
  /** Success: the product is with the agent and the money with the merchant. */
  "delivered",
  /**
   * Closed before any money moved — the product was gone, the parameters did
   * not fit, the payment failed its check, or a synchronous handler refused.
   */
  "rejected",
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
