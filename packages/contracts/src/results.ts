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
 * Every one of those answers arrives in one envelope. `ok` is `true` or it is
 * `false` and nothing else says which; a success carries its own fields beside
 * it, and a failure carries `error`. That `ok` is a value and not a key that
 * may or may not be present is the part worth arguing, because the two look
 * alike from inside TypeScript and do not behave alike anywhere else. A key
 * with an object under it reads as false in Python and in PHP — `{"ok": {}}`
 * is falsy in both — so the one idiom an engineer would write says yes to one
 * answer and no to another, and the JSON Schema export exists for exactly that
 * engineer. As a literal it is also a discriminator: it crosses into the export
 * as a `const` on each branch, which a generator can switch on, where
 * "whichever key happens to be present" is something a reader has to work out.
 *
 * Two words carry what went wrong, and they are not two names for one thing.
 * `error` is why a call did not go through: one object, always, with a code to
 * branch on, a sentence to print, and a flag saying whether repeating the call
 * could change the outcome. `problems` is the list of findings about what was
 * sent — the fields at fault — and it rides inside `error` wherever there are
 * any. A call fails for one reason; a document can be wrong in several places
 * at once, and that is the whole of the difference between the singular and the
 * plural here.
 */

import { z } from "zod";
import { IdentifierSchema } from "./primitives.js";

/**
 * How answering for an order can succeed.
 *
 * "Answering" rather than "delivering or refusing", because two of these reach
 * us from a third surface — a handler's own return — rather than from either
 * call. `accepted` is how an asynchronous handler answers while the delivery
 * is still ahead of it, and `purchase_already_closed` belongs to the
 * synchronous mode, where neither `deliver` nor `refuse` exists at all, as the
 * error code `not_applicable_in_mode` says from the other direction.
 *
 * Each one is a different thing for the merchant to do next, which is why none
 * of them collapses into another. `accepted` is a handler taking the order on: the
 * goods are owed and will follow through the separate `deliver` call, and the
 * merchant's own record of the order should say it is under way. It is a
 * success and belongs among these rather than among the error codes, and that
 * placement is the whole of what it does for a merchant: every handler answer
 * is posted to the answer route by the SDK without being asked to, and an
 * integration that reads anything but a success as trouble would otherwise
 * open a case on every asynchronous order it sells.
 *
 * `delivered` is the sale closing. `already_delivered` is their own retry
 * landing twice — safe, and no second delivery is wanted.
 *
 * That one is worth a warning, because the merchant-facing pages say a
 * repeated call returns "the same success" and this returns a different word
 * for it. Both are true of the effect — nothing is delivered twice and nothing
 * is charged twice — but a merchant who reads that sentence and writes
 * `if (result === "delivered")` turns their own safe retry into a failure
 * branch. The answer these words travel in is built so that nobody has to: a
 * consumer branches on `ok` and records the word, which stays right when this
 * list grows another entry.
 *
 * One kind of consumer it does not stay right for, said here because the list
 * has grown once already and will again. A client that checks the answer
 * against its own copy of this schema — our own SDK does, and so does anything
 * generated from the JSON Schema export — reads an unknown word as a document
 * it cannot parse rather than as a success it cannot name, and reports the
 * call as having gone wrong. So a word added here has to reach those clients
 * before the gateway starts sending it. The version handshake would be the
 * place to catch that. The published SDK keeps this schema strict, and every
 * new word moves `CONTRACT_VERSION` before the gateway sends it. An old worker
 * then stops at its version handshake rather than calling a successful answer
 * unreadable after the merchant has already acted on it (ADR-0006).
 *
 * `debt_closed_by_delivery` says the delivery deadline had already passed and
 * the goods went out anyway, closing a debt instead of completing a sale; the
 * merchant may want to know that happened. `refused` is the refusal taking
 * effect. `purchase_already_closed` is the synchronous handler that came back
 * after its deadline: not an error, because nothing went wrong on their side —
 * the work exists and a repeat purchase will collect it, and the only thing to
 * do is write the case down.
 */
export const ORDER_CALL_RESULTS = Object.freeze([
  "accepted",
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
 * `delivery_does_not_match_card` — the goods are not the ones the card for
 * this order declares it delivers, so nothing was written down; the message
 * says whether the order still stands or has already ended, and the fields
 * that did not fit are named one by one in the error's `problems`.
 *
 * The fourth is the only one of them a merchant fixes rather than records, and
 * it is the reason it is promised rather than left to the open set. It is
 * marked retryable where the order is still open, and that retry is not the
 * same retry the other three mean: those say "the call may not have reached
 * us, send it again", while this says the call arrived and was understood and
 * the goods in it were wrong. Sending the same delivery again produces the
 * same refusal until the goods change, and a merchant told only "retryable"
 * would loop on it — which is why the code is named and the message says which
 * field is wrong.
 *
 * On an order that has already ended it is not retryable, and the message says
 * the ending. The goods being wrong and the sale being over are both true
 * there, and only the second decides what he can do next: told the order still
 * stood, a merchant would make the goods a second time for a purchase nobody
 * can complete.
 *
 * Adding to this list is safe in a way that adding a success word is not: the
 * code is an open string on the wire, so an older client parses an unfamiliar
 * one and reads it as the failure it is. What it loses is the meaning, which is
 * what this list and the dictionary below carry.
 */
export const ORDER_CALL_ERROR_CODES = Object.freeze([
  "refund_already_settled",
  "order_already_closed",
  "not_applicable_in_mode",
  "delivery_does_not_match_card",
] as const);

/**
 * One thing wrong with what was sent, in a place, in a code and in words.
 *
 * This is one finding and never a whole answer. Wherever a call refuses what it
 * was handed, the findings travel as a list of these under `problems` inside
 * the error: a card that could not be published names every field standing
 * between it and the catalog, a delivery that is not what its card declares
 * names the fields that did not fit, and the local check a merchant runs before
 * publishing — `checkCard` in the SDK — answers in this same shape, so a
 * finding read on their own machine and a finding read off the wire need no
 * two readers.
 *
 * The empty path is the part two readers were left to infer differently, so it
 * is said in the exported description as well as here.
 */
export const ProblemSchema = z
  .strictObject({
    /**
     * Which field the finding is about, as the path to it — `["params",
     * "email", "type"]`. An empty path is a statement rather than a missing
     * value, and it covers two kinds of finding that a merchant tells apart by
     * the words rather than by the shape: one about the whole of what was
     * sent, and one about the merchant sending it — their having set no name
     * for buyers to read, or no wallet for their sales to be paid into.
     * Leaving the field out entirely would make an empty path
     * indistinguishable from a path nobody filled in.
     */
    path: z.array(z.string()),

    /** What kind of finding it is, for the code that reads it. */
    code: z.string().regex(/\S/, "a finding carries a code"),

    /** The same finding in words, for the person who has to fix the card. */
    message: z.string().regex(/\S/, "a finding carries an explanation a person can read"),
  })
  .meta({
    description:
      'One thing wrong with what was sent: where it is, a code for the program that reads it, and the same finding in words for the person who has to fix it. The path names the field, innermost last — ["params", "email", "type"] — and an empty path is a statement rather than a missing value: the finding is about the whole of what was sent, or about the sender — a merchant with no name set for buyers, or no wallet set for their sales to be paid into, is refused with an empty path too — and not about any one field, which is also what a document that could not be read at all produces. The field is always present for that reason, because an absent path and an empty one would be indistinguishable. Findings never travel alone: they arrive as the problems list inside the error of a call that refused what it was handed — a card that was not published, a delivery that is not what its card declares, a body or a set of purchase parameters that did not fit.',
  });

/**
 * Why a call did not go through: a code to branch on, a sentence to print, and
 * whether repeating it could change the outcome.
 *
 * One shape for every call on the merchant's surface. Publishing a card and
 * delivering an order fail for entirely different reasons, and a merchant who
 * had to learn two shapes for "this did not happen" would be learning the same
 * lesson twice.
 *
 * The flag is the reason this shape exists at all. "The connection dropped,
 * call again — the call is idempotent" and "nothing you do will change this,
 * write the case down" need different code on the merchant's side, and a
 * merchant left to guess turns one of them into a retry loop and the other into
 * an order nobody comes back to. The refund that has already been paid out is
 * the example of the second kind. It is required rather than defaulted for the
 * same reason: both readings of a missing flag are expensive.
 *
 * `problems` is present where the call is refusing what it was handed rather
 * than reporting a state of the world, and it is the field that turns "no" into
 * an edit. It is optional because most failures have nothing to point at: a
 * refund already settled is about the order and not about a field of the
 * request. Where it is there it is never empty, and a call whose whole answer
 * is "refused, and here is nothing" — a publish — requires it.
 */
export const CallErrorSchema = z.strictObject({
  code: z.string().regex(/\S/, "an error carries a code").meta({
    // Same reason as the refusal code: the dictionary travels with the field
    // or it does not reach the reader the export exists for.
    description:
      'Why the call did not go through. The set is open, and five are promised to mean one thing. "card_rejected" (the card was not published, and every finding standing between it and the catalog is named in the error\'s problems — the fields at fault, and the merchant\'s own missing name or payout wallet where those are what is missing; it is never retryable, because the same card gets the same answer and what changes the outcome is fixing what the problems name). "refund_already_settled" (the debt was paid back, so there is nothing left to deliver against). "order_already_closed" (the order reached an ending that no call reopens). "not_applicable_in_mode" (the call does not exist for this card\'s mode — refusing separately does not, in the synchronous one, where the handler\'s own answer is the refusal). "delivery_does_not_match_card" (the goods are not the ones the card for this order declares it delivers — nothing was written down, the problems name the fields that did not fit, and the message says whether the order still stands or has already ended). The last of those is retryable in a different sense from a lost connection: the call arrived and was understood, so sending the same goods again gives the same refusal, and what clears it is delivering what the card declares. It is not retryable at all where the order has already ended, because there is nothing left to deliver against.',
  }),
  message: z.string().regex(/\S/, "an error carries an explanation a person can read"),
  retryable: z.boolean(),

  /**
   * The findings, where the call is refusing what it was handed.
   *
   * Never empty when it is there: a list with nothing in it says "these are the
   * things at fault" and names none of them, which is the one answer a merchant
   * cannot act on.
   */
  problems: z.array(ProblemSchema).min(1).optional(),
});

/**
 * The code a refused publish comes back under.
 *
 * Promised rather than left to the open set, because it is the one refusal of
 * this surface a merchant meets on their first afternoon, and every one of them
 * writes the branch that reads it.
 */
export const CARD_REJECTED = "card_rejected";

/**
 * The error a refused publish carries: the shared shape, with the findings made
 * required.
 *
 * "Refused, and here is nothing" is the one answer a merchant cannot act on,
 * and publishing is the call where that would be easiest to send — a card is
 * refused precisely because something about it is wrong, so there is always
 * something to name. Not every finding is about the card. A merchant who has
 * set no name for buyers to read is refused here too, and so is one who has set
 * no wallet for their sales to be paid into; both ride in the same list, so one
 * answer carries everything standing between this card and the catalog rather
 * than handing it over one round trip at a time.
 */
const PublishRefusalSchema = CallErrorSchema.extend({
  problems: z.array(ProblemSchema).min(1),
});

/**
 * The answer to publishing a card: the catalog id, or what stands in its way.
 *
 * `ok` says which, as it does on every other call of this surface, and the
 * catalog identifier sits at the top level of the success beside it rather than
 * nested under a word. There is one fact in a successful publish and this is
 * it.
 *
 * The refusal is `CARD_REJECTED` and it is not retryable: publishing the same
 * card again gets the same answer, and what changes the outcome is fixing what
 * the findings name. That is a different thing from the retry a dropped
 * connection asks for, which is why the flag says no here rather than being
 * left for the merchant to infer from the code.
 */
export const PublishResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),

    /** Our catalog identifier, from now on in catalogs, orders and receipts. */
    id: IdentifierSchema,
  }),
  z.strictObject({ ok: z.literal(false), error: PublishRefusalSchema }),
]);

export type Problem = z.infer<typeof ProblemSchema>;
export type PublishResult = z.infer<typeof PublishResultSchema>;
export type OrderCallResult = z.infer<typeof OrderCallResultSchema>;
export type CallError = z.infer<typeof CallErrorSchema>;
