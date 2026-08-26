/**
 * The order, as it reaches the merchant's handler.
 *
 * By the time an order exists the purchase has already been checked on our
 * side: the card was found, the parameters passed the card's own declaration,
 * the price was settled and the payment was verified. Invalid purchases, stale
 * prices and payments that did not verify never reach a handler, which is why
 * this schema is short.
 *
 * Everything here answers a question the handler would otherwise have to ask
 * us: what to deliver, to whom, under which of its own keys, at what price,
 * and whether the money behind it is real.
 *
 * What state an order is in is not a field here. Reading state back — one
 * order, or every order still open — is a separate call, and the words it
 * answers with are `OrderStatusSchema` in `order-status.ts`.
 *
 * One shape the documentation promises is still missing, and it is named here
 * rather than left to be found as an absence. In the mode where the merchant
 * is asked before the money moves, a confirmation request reaches the same
 * subscription as the orders and is marked as a request rather than an order —
 * no payment has happened, and delivering against one is not allowed. Nothing
 * in this package carries that mark, so the two would be indistinguishable on
 * the wire. Rather than leave that as a trap, the card refuses to publish in
 * that mode at all until the request has a shape; see `card.ts`.
 */

import { z } from "zod";
import { ParamNameSchema } from "./param-spec.js";
import { IdentifierSchema, SalePriceSchema } from "./primitives.js";

export const OrderSchema = z.strictObject({
  /**
   * The order's identifier, which is also its idempotency key: the same string
   * on every redelivery. Delivery is at-least-once, so a handler that answers
   * from this key instead of delivering twice is not being careful, it is
   * being correct.
   */
  id: IdentifierSchema,

  /** The merchant's own key for the product, the one their database uses. */
  merchant_item_id: IdentifierSchema,

  /**
   * The purchase parameters, already checked against the card's declaration.
   * Always present, empty for a card that takes no input — a handler should
   * never have to tell "no parameters" from "the field did not arrive".
   */
  // One key is dropped here rather than carried or refused; the reason is at
  // `PROTOTYPE_KEY_IS_DROPPED` in `param-spec.ts`.
  params: z.record(ParamNameSchema, z.unknown()),

  /**
   * What the product was actually sold for, which is not always what the card
   * says: a card with a price check sells at the price the check answered.
   * Both moments travel with it, so the sale can be written down as it stands.
   */
  price: SalePriceSchema,

  /**
   * The identifier of the price question this sale came out of, absent when
   * there was none — a card without a price check sells from its own price and
   * no question was ever asked. A merchant who set stock aside under this
   * identifier can release it here.
   */
  price_id: IdentifierSchema.optional(),

  /**
   * Whether this is a test order.
   *
   * Required rather than defaulted. The safe reading of a missing flag is not
   * obvious in either direction, and a test order taken for a live one is a
   * real delivery made against money that does not exist.
   */
  test: z.boolean(),
});

export type Order = z.infer<typeof OrderSchema>;
