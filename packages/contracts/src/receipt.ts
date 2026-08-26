/**
 * The receipt: the record left by a purchase that was paid for.
 *
 * It exists from the moment the money moves, which in two of the three modes
 * is before the product is delivered — so a receipt has to be able to say
 * "paid, delivery still running" without that being mistaken for either "you
 * have it" or "you paid and never got it". A purchase that ends before any
 * payment leaves no receipt at all: nothing moved, and there is nothing for it
 * to be proof of.
 *
 * The price on a receipt is the price the sale went through at, and it stays
 * what it was even after the merchant's price changes.
 */

import { z } from "zod";
import { IdentifierSchema, SalePriceSchema, TimestampSchema } from "./primitives.js";

/**
 * What became of the purchase behind this receipt.
 *
 * `pending` — paid, the delivery is still open. `delivered` — the product
 * reached the agent. `refund_due` — the money moved and the delivery did not
 * happen. The states a purchase can end in without paying are not here,
 * because none of them produces a receipt.
 */
export const ReceiptOutcomeSchema = z.enum(["pending", "delivered", "refund_due"]);

export const ReceiptSchema = z.strictObject({
  /**
   * The receipt's own identifier. In the modes where the payment goes first,
   * this is what an agent repeats a purchase by.
   */
  id: IdentifierSchema,

  /** The order this purchase produced. */
  order_id: IdentifierSchema,

  /** Our catalog identifier for the card that was bought. */
  item_id: IdentifierSchema,

  /** The price the sale went through at, with the moment behind it. */
  price: SalePriceSchema,

  /** The price question the sale came out of, absent when there was none. */
  price_id: IdentifierSchema.optional(),

  /**
   * When the payment executed — which is not when the purchase happened. In
   * the synchronous mode the payment is the last step, after the delivery, so
   * folding the two moments together would misdate one of them.
   */
  paid_at: TimestampSchema,

  outcome: ReceiptOutcomeSchema,

  /**
   * Whether the money behind this receipt was real. A receipt is proof of
   * payment, and an unmarked receipt for a test purchase is proof of a payment
   * that never happened.
   */
  test: z.boolean(),
});

export type ReceiptOutcome = z.infer<typeof ReceiptOutcomeSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
