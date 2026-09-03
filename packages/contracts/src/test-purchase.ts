/**
 * What a merchant learns from walking a test purchase of their own card.
 *
 * A merchant who has published a card and started a worker has proved nothing
 * yet: everything on their side can be right while the card is off sale, the
 * price question goes to nobody, or the goods do not match what the card
 * declared. The only proof is a purchase made the way a stranger's agent makes
 * one — through the public storefront, with a payment on it — and this document
 * is what such a walk leaves behind.
 *
 * It is a transcript and not a receipt. The receipt is the merchant's record of
 * a sale and is read at its own address; this says which doors were knocked on,
 * in which order, and what each one answered, so that a walk that did not
 * finish is a page the merchant can act on rather than a failure with no
 * inside. That is why an unfinished walk is one of these documents too, with
 * fewer steps in it, and never an error: "it stopped at the price, and the
 * storefront said the product is not on sale" is the answer, and a 500 would
 * throw it away.
 *
 * The addresses are in it on purpose. They are the storefront's own — the
 * catalog an agent reads, the address it buys at, the door it comes back to —
 * and a merchant reading them is reading the three addresses their buyers will
 * use. It is also the one thing in here that cannot be faked by an
 * implementation that took a short cut inside the process: a walk that never
 * left the building has no address to write down.
 */

import { z } from "zod";
import { DeliverySchema } from "./handler.js";
import { IdentifierSchema } from "./primitives.js";

/**
 * The four doors a buying agent goes through, in the order it goes through
 * them.
 *
 * `catalog` is the public list an agent chooses from, and it is the one step
 * that does not stop the walk: a card missing from it is worth knowing about,
 * and what the storefront says about that card is what the next step gets.
 * `price` is the unpaid call that opens an order and answers with what it
 * costs. `payment` is the signed retry. `delivery` is the buyer coming back to
 * its own order's door for the goods.
 */
export const TEST_PURCHASE_STEPS = Object.freeze([
  "catalog",
  "price",
  "payment",
  "delivery",
] as const);

export const TestPurchaseStepNameSchema = z.enum(TEST_PURCHASE_STEPS);

/**
 * One door, and what came back from it.
 *
 * `said` is required and never blank, for the reason the refusal envelope gives
 * about its own message: a step that failed and says nothing is a step only its
 * author can read. Where the storefront refused, this is the storefront's own
 * sentence, exactly as a stranger's agent would have read it. Where the
 * storefront answered without words — a catalog that does not carry the card, a
 * status door with no goods on it yet, an answer that never arrived at all —
 * this is the walk's own account of what it found, because the alternative is
 * an empty space where the reason belongs.
 */
export const TestPurchaseStepSchema = z
  .strictObject({
    step: TestPurchaseStepNameSchema,

    /** Whether this door gave the buyer what it went there for. */
    ok: z.boolean(),

    /**
     * The address the buyer called, whole, as it would be written by somebody
     * who has our documentation and no package of ours.
     */
    address: z
      .string()
      .regex(/^https?:\/\/\S+$/, "a step names the whole address the buyer called"),

    /** What came of this step, in words. */
    said: z.string().regex(/\S/, "a step says in words what came of it"),
  })
  .meta({
    description:
      "One door of the walk and what came back from it: which step it was, whether it gave the buyer what it went there for, the whole address the buyer called, and what came of it in words. Where the storefront refused, those words are the storefront's own sentence, exactly as a stranger's agent would have read it; where the storefront answered without words — a catalog that does not carry the card, a status door with no goods on it yet, an answer that never arrived — they are this walk's own account of what it found, because a step that failed and said nothing would leave the merchant a flag and no reason.",
  });

/**
 * What the whole walk came to, which is the first thing a merchant reads.
 *
 * Three words because there are three different next moves. `delivered` — the
 * buyer came away holding the goods, and there is nothing to do. `accepted` —
 * the money moved and the merchant's worker took the order on, so the goods are
 * owed and the buyer collects them at the order's own door; that is the honest
 * end of a walk of a card whose goods come later, and it is a success rather
 * than a half-failure. `stopped` — the walk did not get through, and the last
 * step in the list is where, with its own sentence saying why.
 */
export const TEST_PURCHASE_OUTCOMES = Object.freeze(["delivered", "accepted", "stopped"] as const);

export const TestPurchaseOutcomeSchema = z.enum(TEST_PURCHASE_OUTCOMES);

export const TestPurchaseSchema = z
  .strictObject({
    outcome: TestPurchaseOutcomeSchema,

    /**
     * The steps that were actually taken, in order. A walk that stopped has
     * fewer of them, and the last one is where it stopped — which is why there
     * is no separate field naming that step: two ways of saying one thing is
     * one way for them to disagree.
     */
    steps: z
      .array(TestPurchaseStepSchema)
      .min(1, "a walk that happened took at least one step, and says which"),

    /**
     * The order this walk opened, so the merchant can find it among their own
     * orders, and null where the walk stopped before there was one.
     */
    order_id: IdentifierSchema.nullable(),

    /**
     * The goods exactly as the buyer received them, and null where the buyer is
     * holding none — a walk that stopped, and a card whose goods come later.
     *
     * Null rather than absent, for the reason the agent's own status document
     * gives: a field left out is a silence a reader cannot tell from an
     * oversight, and this is the field a merchant checks their card's declared
     * result against.
     */
    delivered: DeliverySchema.nullable(),
  })
  .meta({
    description:
      "What became of one test purchase of the merchant's own card, walked through the public storefront by this gateway's own test buyer. The steps are the doors that were actually knocked on, in order; a walk that did not finish carries fewer of them and the last one says where it stopped and why, because an unfinished walk is this document with less in it and never an error. The order identifier is there so the merchant can find the order among their own, and is null where the walk stopped before an order existed. The goods are the delivery exactly as the buyer received it, and null where the buyer is holding none — which covers both a walk that stopped and a card whose goods come later, and the outcome is what tells those apart. This walk only ever spends test money: a gateway that settles on a chain where the money is real refuses the call outright, so there is no reading of this document in which somebody was charged.",
  });

export type TestPurchaseStepName = z.infer<typeof TestPurchaseStepNameSchema>;
export type TestPurchaseStep = z.infer<typeof TestPurchaseStepSchema>;
export type TestPurchaseOutcome = z.infer<typeof TestPurchaseOutcomeSchema>;
export type TestPurchase = z.infer<typeof TestPurchaseSchema>;
