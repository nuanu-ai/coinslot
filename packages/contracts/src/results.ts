/**
 * What our calls hand back — the successes as well as the failures.
 *
 * None of it travels as an exception. A merchant's integration code has to
 * read these, branch on them and write some of them down, and an exception is
 * the wrong shape for something you are expected to handle rather than to be
 * surprised by. That is a rule about the whole surface, which is why publishing
 * a card and answering for an order share a file even though they are
 * different calls.
 *
 * The words below are wire names, not prose: a merchant's code branches on
 * them, so rewording one is changing the contract.
 *
 * The two calls are shaped differently and it is worth saying why rather than
 * leaving it to be noticed. Publishing answers with one value, `{ok} | {errors}`,
 * because a card is accepted or it is not. Answering for an order is a
 * vocabulary of successes and a vocabulary of failures held apart, and what
 * ties them into one answer lives with the call that returns it — a merchant
 * reads `OrderCallResponseSchema` in `api.ts`, which puts the success word
 * inside `ok` so that the marker of success is the same one whether a delivery
 * was the first or a repeat.
 *
 * The plural in `errors` and the singular in the order call's `error` are not
 * an inconsistency: a card can be wrong in several places at once, while a
 * call either went through or did not go through for one reason.
 */

import { z } from "zod";
import { IdentifierSchema } from "./primitives.js";

/**
 * How answering for an order can succeed.
 *
 * "Answering" rather than "delivering or refusing", because the last of the
 * five belongs to a third surface: a synchronous handler's own return, where
 * neither `deliver` nor `refuse` exists at all — as the error code
 * `not_applicable_in_mode` says from the other direction.
 *
 * Five and not fewer, because each one is a different thing for the merchant
 * to do next. `delivered` is the sale closing. `already_delivered` is their
 * own retry landing twice — safe, and no second delivery is wanted.
 *
 * That second one is worth a warning, because the merchant-facing pages say a
 * repeated call returns "the same success" and this returns a different word
 * for it. Both are true of the effect — nothing is delivered twice and nothing
 * is charged twice — but a merchant who reads that sentence and writes
 * `if (result === "delivered")` turns their own safe retry into a failure
 * branch. Until the pages and this list agree, a consumer branching on success
 * should test for membership in this enumeration rather than for one value.
 * `debt_closed_by_delivery` says the delivery deadline had already passed and
 * the goods went out anyway, closing a debt instead of completing a sale; the
 * merchant may want to know that happened. `refused` is the refusal taking
 * effect. `purchase_already_closed` is the synchronous handler that came back
 * after its deadline: not an error, because nothing went wrong on their side —
 * the work exists and a repeat purchase will collect it, and the only thing to
 * do is write the case down.
 */
export const ORDER_CALL_RESULTS = Object.freeze([
  "delivered",
  "already_delivered",
  "debt_closed_by_delivery",
  "refused",
  "purchase_already_closed",
] as const);

export const OrderCallResultSchema = z.enum(ORDER_CALL_RESULTS);

/**
 * The error codes those calls answer with.
 *
 * A list of what we promise to mean the same way, not a gate: the code below
 * stays an open string, because an error nobody anticipated has to reach the
 * merchant in its own words rather than be flattened into the nearest of
 * three. `refund_already_settled` — the debt was paid back, so there is
 * nothing left to deliver against. `order_already_closed` — the order reached
 * an ending that no call reopens. `not_applicable_in_mode` — the call does not
 * exist for this card's mode, as refusing separately does not in the
 * synchronous one, where the handler's own answer is the refusal.
 */
export const ORDER_CALL_ERROR_CODES = Object.freeze([
  "refund_already_settled",
  "order_already_closed",
  "not_applicable_in_mode",
] as const);

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
  code: z.string().regex(/\S/, "an error carries a code").meta({
    // Same reason as the refusal code: the dictionary travels with the field
    // or it does not reach the reader the export exists for.
    description:
      'Why the call did not go through. The set is open, and three are promised to mean one thing: "refund_already_settled" (the debt was paid back, so there is nothing left to deliver against), "order_already_closed" (the order reached an ending that no call reopens), "not_applicable_in_mode" (the call does not exist for this card\'s mode — refusing separately does not, in the synchronous one, where the handler\'s own answer is the refusal).',
  }),
  message: z.string().regex(/\S/, "an error carries an explanation a person can read"),
  retryable: z.boolean(),
});

export type PublishError = z.infer<typeof PublishErrorSchema>;
export type PublishResult = z.infer<typeof PublishResultSchema>;
export type OrderCallResult = z.infer<typeof OrderCallResultSchema>;
export type OrderCallError = z.infer<typeof OrderCallErrorSchema>;
