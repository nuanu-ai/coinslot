/**
 * What our calls hand back when they do not succeed.
 *
 * None of these travel as exceptions. A merchant's integration code has to
 * read them, branch on them and write some of them down, and an exception is
 * the wrong shape for something you are expected to handle rather than to be
 * surprised by. That is a rule about the whole surface, which is why publishing
 * a card and failing to deliver an order share a file even though they belong
 * to different calls.
 *
 * One member of that family is missing on purpose. When a synchronous handler
 * returns after its deadline the tools hand the merchant a typed result saying
 * the purchase is already closed — again a value, not an exception. It is not
 * here because it never crosses the wire: it is produced by the SDK, on the
 * merchant's own machine, about a call that never left it. If it turns out
 * that the gateway has to say it too, it moves here.
 */

import { z } from "zod";
import { IdentifierSchema } from "./primitives.js";

/** One thing wrong with a card, in a place, in a code and in words. */
export const PublishErrorSchema = z.strictObject({
  /**
   * Which field the finding is about, as the path to it — `["params",
   * "email", "type"]`. An empty path is a statement rather than a missing
   * value: the finding is about the card as a whole. Leaving the field out
   * entirely would make those two indistinguishable.
   */
  path: z.array(z.string()),

  /** What kind of finding it is, for the code that reads it. */
  code: z.string().regex(/\S/, "a finding carries a code"),

  /** The same finding in words, for the person who has to fix the card. */
  message: z.string().regex(/\S/, "a finding carries an explanation a person can read"),
});

/**
 * The answer to publishing a card: the catalog id, or what is wrong with it.
 *
 * The list of findings is never empty. "Refused, and here is nothing" is the
 * one answer a merchant cannot act on, and acceptance already has a shape of
 * its own — it does not need to be spelled as an absence of errors.
 */
export const PublishResultSchema = z.union(
  [
    z.strictObject({
      ok: z.strictObject({
        /** Our catalog identifier, from now on in catalogs, orders and receipts. */
        id: IdentifierSchema,
      }),
    }),
    z.strictObject({ errors: z.array(PublishErrorSchema).min(1) }),
  ],
  { error: "publishing a card answers with either { ok } or { errors }, and never with both" },
);

/**
 * What comes back when delivering or refusing an order does not go through.
 *
 * The flag is the reason this shape exists. "The connection dropped, call
 * again — the call is idempotent" and "nothing you do will change this, write
 * the case down" need different code on the merchant's side, and a merchant
 * left to guess turns one of them into a retry loop and the other into an
 * order nobody comes back to. The refund that has already been paid out is the
 * example of the second kind.
 *
 * It is required rather than defaulted for the same reason: both readings of a
 * missing flag are expensive.
 */
export const OrderCallErrorSchema = z.strictObject({
  code: z.string().regex(/\S/, "an error carries a code"),
  message: z.string().regex(/\S/, "an error carries an explanation a person can read"),
  retryable: z.boolean(),
});

export type PublishError = z.infer<typeof PublishErrorSchema>;
export type PublishResult = z.infer<typeof PublishResultSchema>;
export type OrderCallError = z.infer<typeof OrderCallErrorSchema>;
