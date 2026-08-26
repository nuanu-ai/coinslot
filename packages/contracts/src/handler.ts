/**
 * What a merchant's handler answers when an order reaches it.
 *
 * There are three answers and no more, and the closed set is the point. A
 * refusal is understood as a final "this cannot be delivered" and closes the
 * order; a temporary failure is expressed by an exception, a dead process or a
 * dropped connection, all of which read as an order that was not delivered and
 * comes back after a delay. A fourth answer meaning "not right now" would blur
 * that line, and a supplier who timed out once would look like a product that
 * cannot be sold at all.
 *
 * Silence is not an answer either. Every wait has a deadline, and an order
 * that runs out of time is closed without the handler.
 */

import { z } from "zod";
import { ParamNameSchema } from "./param-spec.js";

/**
 * The three codes we and the merchant read the same way.
 *
 * Preferring them costs nothing and buys one thing in particular:
 * `out_of_stock` is what feeds the share of purchases that ran into a missing
 * product, which is a number we hold under a limit. The same refusal sent
 * under a merchant's own code is invisible to it, and the picture of their
 * catalog comes out wrong.
 */
export const RECOMMENDED_REFUSAL_CODES = Object.freeze({
  OUT_OF_STOCK: "out_of_stock",
  INVALID_PARAMS: "invalid_params",
  CANNOT_FULFILL: "cannot_fulfill",
} as const);

/**
 * A refusal code.
 *
 * The set is open: a merchant whose reason fits none of ours says it in their
 * own word rather than flattening it into the nearest approximation. What the
 * schema does insist on is that there is a code at all — a refusal nobody can
 * count is a refusal that never shows up in any picture of what is going
 * wrong.
 */
export const RefusalCodeSchema = z
  .string()
  .regex(/\S/, "a refusal carries a short code, even one of the merchant's own");

export const RefusalSchema = z.strictObject({
  code: RefusalCodeSchema,

  /**
   * The reason, in words. We and the agent read the code; this is for the
   * person who picks the case up afterwards, and leaving it empty leaves them
   * with nothing.
   */
  message: z.string().regex(/\S/, "a refusal carries a reason a person can read"),
});

/**
 * The delivery itself: the JSON the card's `result` declared.
 *
 * Here it is only held to being an object with names a card could have
 * declared. Whether it matches this particular card is the job of the checker
 * compiled from that card's `result` — one problem, one error message.
 *
 * The portal promises that a delivery reaches the agent as the merchant wrote
 * it. There is one exception and it is zod's: a key named `__proto__` is
 * removed while the record is parsed, before any check of ours runs, so it is
 * neither delivered nor refused. No card can declare such a field, so a
 * merchant only meets this by sending one nobody asked for — and the note is
 * here because the loss is silent. `param-spec.ts` carries the same note and a
 * test that holds the behaviour in place.
 */
const DeliveredSchema = z.record(ParamNameSchema, z.unknown());

export const HandlerAnswerSchema = z.union(
  [
    z.strictObject({ delivered: DeliveredSchema }),
    z.strictObject({ refused: RefusalSchema }),
    z.strictObject({
      accepted: z.strictObject({
        /**
         * How long the merchant expects the delivery to take, when they know.
         * An empty `accepted` is a complete answer.
         */
        eta_seconds: z.int().positive().optional(),
      }),
    }),
  ],
  {
    error:
      "a handler answers with exactly one of { delivered }, { refused } or { accepted }; a temporary failure is an exception, not a refusal",
  },
);

export type RefusalCode = z.infer<typeof RefusalCodeSchema>;
export type Refusal = z.infer<typeof RefusalSchema>;
export type HandlerAnswer = z.infer<typeof HandlerAnswerSchema>;
