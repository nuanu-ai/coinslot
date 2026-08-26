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
  .regex(/\S/, "a refusal carries a short code, even one of the merchant's own")
  .meta({
    // The dictionary has to travel with the field. An engineer generating a
    // client outside TypeScript is the only reader this export exists for, and
    // a bare `{type: "string"}` tells them nothing about the three codes we
    // promise to read the same way — least of all that `out_of_stock` is what
    // feeds the availability measure their catalog is held to.
    description:
      'A short code for why a delivery cannot happen. The set is open — a merchant whose reason fits none of ours sends their own word rather than the nearest approximation. Three are understood the same way on both sides and should be preferred: "out_of_stock" (the product is gone: sold out, no seats, the supplier did not deliver), "invalid_params" (the purchase parameters do not work for this delivery), "cannot_fulfill" (it cannot be delivered for some other reason). Only "out_of_stock" feeds the share of purchases that ran into a missing product, which is a number we hold under a limit — the same refusal sent under a merchant\'s own code is invisible to it.',
  });

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
 * it. There is one exception, and it is the one written down at
 * `PROTOTYPE_KEY_IS_DROPPED` in `param-spec.ts` — of the four places that
 * share it, this is where the loss would actually reach the agent.
 *
 * It is named and exported rather than left inside the answer below because
 * two surfaces carry it: what a synchronous handler returns, and the body of
 * the delivery call an asynchronous merchant makes (`api.ts`). Written out
 * twice, the two would be one shape only until somebody edited one of them.
 */
export const DeliverySchema = z.record(ParamNameSchema, z.unknown()).meta({
  description:
    "What the merchant delivers: the fields the card's result declared. This document holds the names to the shape a card could have declared and no further. That they are the names this particular card declared is checked against that card, and no document standing on its own can express it.",
});

/**
 * Taking an order on: the merchant will deliver, and here is how long they
 * expect that to take, when they know. An empty acceptance is a complete
 * answer.
 *
 * Named and exported for the same reason as the delivery above — it is both a
 * handler's answer and the body of a call.
 */
export const AcceptanceSchema = z
  .strictObject({
    eta_seconds: z.int().positive().optional(),
  })
  .meta({
    description:
      "Taking an order on: the merchant will deliver it. eta_seconds is how long they expect that to take, when they know; leaving it out is a complete answer and not a refusal to say. It is an expectation and not a commitment — what the merchant is actually held to is the delivery deadline on the card, and the two are different numbers.",
  });

export const HandlerAnswerSchema = z.union(
  [
    z.strictObject({ delivered: DeliverySchema }),
    z.strictObject({ refused: RefusalSchema }),
    z.strictObject({ accepted: AcceptanceSchema }),
  ],
  {
    error:
      "a handler answers with exactly one of { delivered }, { refused } or { accepted }; a temporary failure is an exception, not a refusal",
  },
);

export type RefusalCode = z.infer<typeof RefusalCodeSchema>;
export type Refusal = z.infer<typeof RefusalSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;
export type Acceptance = z.infer<typeof AcceptanceSchema>;
export type HandlerAnswer = z.infer<typeof HandlerAnswerSchema>;
