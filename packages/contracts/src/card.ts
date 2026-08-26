/**
 * The card: one product in the catalog, as the merchant publishes it.
 *
 * Everything the agent sees before buying is here, and the requirement that
 * runs through every field follows from that: an agent holding only this card
 * has to be able to assemble a correct purchase and know what it will get
 * back. A field that fails that test is not a detail, it is a sale that ends
 * in a refusal.
 *
 * The catalog id is not part of this schema. We issue it when the card is
 * published and hand it back in the result, so a card arriving with one is a
 * card whose author is guessing at our numbering.
 */

import { z } from "zod";
import { ParamSpecSchema } from "./param-spec.js";
import { IdentifierSchema, MoneySchema } from "./primitives.js";

/**
 * When the product reaches the agent, and therefore when the money moves.
 *
 * `sync` — in the answer to the purchase, and the payment executes last, after
 * the merchant has delivered. `async` — later, by a separate call, and the
 * payment executes at the moment of purchase. `confirm` — the merchant is
 * asked first, and the payment executes right after they say yes.
 */
export const FulfillmentSchema = z.enum(["sync", "async", "confirm"]);

/**
 * How the price and availability of this card are asked for, if they are.
 *
 * `"handler"` is the default path: the question travels the same outgoing
 * channel as the orders, and the merchant hosts nothing. The other form names
 * an address, for merchants whose price is computed by a separate service that
 * the order handler cannot reach.
 *
 * The address has to be https. The question and the answer carry a merchant's
 * prices; over plain http they are readable and rewritable by anyone on the
 * path, and a sale that went through at someone else's price would be
 * indistinguishable from an honest one.
 */
export const PriceCheckSchema = z.union(
  [
    z.literal("handler"),
    z.strictObject({
      url: z.url({ protocol: /^https$/ }),
    }),
  ],
  { error: 'a price check is either "handler" or { url } naming an https address' },
);

const CardFieldsSchema = z.strictObject({
  /** The merchant's own key for this product, the one their database uses. */
  merchant_item_id: IdentifierSchema,

  /** The short line a catalog shows; how the card differs from its neighbours. */
  title: z.string().regex(/\S/, "a title must not be empty or blank"),

  /**
   * What the buyer gets, what it is good for and what it does not include.
   * Read by a program, so distinguishing facts do the work here.
   */
  description: z.string().regex(/\S/, "a description must not be empty or blank"),

  /**
   * The price in the catalog. Always required, even for a card with a price
   * check: this is what the agent compares when it is choosing.
   */
  price: MoneySchema,

  /** What the agent has to supply to buy. Absent when the purchase needs no input. */
  params: ParamSpecSchema.optional(),

  /**
   * What the agent receives when the delivery goes through. Never empty: a
   * declaration with no fields satisfies the letter of "the card declares its
   * result" while telling the agent nothing about what it is paying for.
   */
  result: ParamSpecSchema.refine(
    (spec) => Object.keys(spec).length > 0,
    "a card declares at least one field of what the agent receives",
  ),

  fulfillment: FulfillmentSchema,

  price_check: PriceCheckSchema.optional(),

  /**
   * How long the merchant may take to answer a confirmation request.
   *
   * The seconds themselves — the default, the ceiling — are among the numbers
   * named before the pilot and belong to the gateway. This schema takes any
   * whole positive number of seconds rather than inventing a limit that would
   * read as a decision nobody took.
   */
  confirm_deadline_seconds: z.int().positive().optional(),

  /** How long the merchant may take to deliver an order it has accepted. */
  fulfill_deadline_seconds: z.int().positive().optional(),
});

/**
 * Both deadlines are shown to the agent before it pays, which is why a card
 * may only carry the ones its own mode uses. A synchronous card advertising a
 * delivery deadline would be advertising a wait that never happens — and the
 * wait for a synchronous answer is our system-wide budget, the same for every
 * product, so it has no field here at all.
 */
export const CardSchema = CardFieldsSchema.superRefine((card, ctx) => {
  if (card.fulfillment !== "confirm" && card.confirm_deadline_seconds !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["confirm_deadline_seconds"],
      message: `only a card with fulfillment "confirm" is asked to confirm; this one is "${card.fulfillment}"`,
    });
  }

  if (card.fulfillment === "sync" && card.fulfill_deadline_seconds !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["fulfill_deadline_seconds"],
      message:
        'a synchronous card delivers inside the system-wide response budget and sets no delivery deadline; "async" and "confirm" do',
    });
  }
});

export type Fulfillment = z.infer<typeof FulfillmentSchema>;
export type PriceCheck = z.infer<typeof PriceCheckSchema>;
export type Card = z.infer<typeof CardSchema>;
