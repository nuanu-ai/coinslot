/**
 * The question "how much is this and is it there", and the merchant's answer.
 *
 * One shape, two transports. By default the question rides the same outgoing
 * channel as the orders and is answered by a handler in the merchant's own
 * process; a merchant whose prices come from a separate service answers the
 * same question over https at an address their card names. The fields do not
 * differ between the two, which is what lets a merchant switch transports
 * without touching the code that answers.
 *
 * What the schema deliberately does not describe is silence. A missing answer,
 * a timeout, a broken connection and an answer too old to trust are all the
 * same thing to the gateway, and what it does about them depends on the card's
 * mode rather than on the shape of anything on this page.
 */

import { z } from "zod";
import { ParamNameSchema } from "./param-spec.js";
import { IdentifierSchema, MoneySchema, TimestampSchema } from "./primitives.js";

/**
 * Why we are asking.
 *
 * `purchase` means an agent is standing at the till right now; `poll` means we
 * are refreshing what we know between purchases and nobody is buying. The
 * distinction is there so an expensive stock lookup can be spent on the first
 * and skipped on the second.
 */
export const QuotePurposeSchema = z.enum(["purchase", "poll"]);

export const QuoteRequestSchema = z.strictObject({
  /** The merchant's own key for the product being asked about. */
  merchant_item_id: IdentifierSchema,

  /**
   * The purchase parameters, where the price depends on them. Absent for a
   * card that takes no input, and for a scheduled poll of such a card.
   */
  // Same dropped key as everywhere this contract parses free-form names; see
  // `PROTOTYPE_KEY_IS_DROPPED` in `param-spec.ts`.
  params: z.record(ParamNameSchema, z.unknown()).optional(),

  /**
   * The identifier of this question, which comes back attached to the order.
   *
   * It is good for one order: a merchant who set stock aside under it can
   * release it when the order arrives or when the price expires. That "one
   * order" is a rule the gateway keeps — no schema can see a second use of an
   * identifier it is shown once.
   */
  price_id: IdentifierSchema,

  purpose: QuotePurposeSchema,

  /**
   * Until when the price the merchant names will be honoured, so a merchant
   * holding stock against it knows when to stop. There is no separate message
   * when it passes; this moment is the whole notice.
   */
  expires_at: TimestampSchema,
});

/**
 * The answer, in the only two shapes it has.
 *
 * A price and an availability of `false` cannot travel together, and neither
 * can availability of `true` and no price. Both would be two answers at once:
 * whichever the gateway then acted on, the merchant would have grounds to say
 * it acted on the wrong one — and in the first case the sale would quietly
 * fall back to the price in the card, at a price the merchant never quoted.
 *
 * `as_of` is on both branches because it is what separates "I went and looked"
 * from "here is what was in the cache". The gateway decides how far it trusts
 * an answer by comparing that moment against a freshness threshold, and the
 * same moment ends up in the record of the sale.
 */
export const QuoteResponseSchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    price: MoneySchema,
    as_of: TimestampSchema,
  }),
  z.strictObject({
    available: z.literal(false),
    as_of: TimestampSchema,
  }),
]);

export type QuotePurpose = z.infer<typeof QuotePurposeSchema>;
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
