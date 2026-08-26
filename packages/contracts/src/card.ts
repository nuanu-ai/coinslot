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
export const FulfillmentSchema = z.enum(["sync", "async", "confirm"]).meta({
  description:
    'When the product reaches the agent, and so when the money moves. "sync" — in the answer to the purchase, payment last. "async" — later, by a separate call, payment at the moment of purchase. "confirm" — the merchant is asked first and the payment follows their yes. A card cannot be published as "confirm" during the pilot: the confirmation request has no shape on the wire yet, so a handler could not tell one from a paid order.',
});

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
      // The https rule is written twice on purpose. `protocol` is what zod
      // checks; the pattern is what survives into the JSON Schema export,
      // where zod renders a url as `format: "uri"` and drops everything else.
      // An engineer generating code from the exported document would otherwise
      // build a client that happily posts a merchant's prices over http.
      url: z.url({ protocol: /^https$/ }).regex(/^https:\/\//, "a price hook is https"),
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
   *
   * The rule is written twice again. zod drops refinements when it renders
   * JSON Schema, so the same constraint goes into the metadata as
   * `minProperties`, where a generator can still see it.
   */
  result: ParamSpecSchema.refine(
    (spec) => Object.keys(spec).length > 0,
    "a card declares at least one field of what the agent receives",
  ).meta({
    description: "What the agent receives on delivery. At least one field.",
    minProperties: 1,
  }),

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
  if (card.fulfillment === "confirm") {
    // The gate, and the reason it is a refusal rather than a note somewhere.
    // A confirmation request reaches the merchant before any money moves and
    // must be answered without delivering — but nothing on the wire marks it
    // as one, so a handler could not tell it from a paid order. Publishing
    // such a card would sell the merchant a mode that cannot be served, and
    // the first they heard of it would be a request they mishandled.
    //
    // The value stays in the enumeration: the mode exists in the model and the
    // state machine knows it. What is missing is its shape on the wire, and
    // that is a "not yet", not a "no".
    ctx.addIssue({
      code: "custom",
      path: ["fulfillment"],
      message:
        'a card cannot be published as "confirm" during the pilot: the confirmation request has no shape on the wire yet, so a handler could not tell one from a paid order',
    });

    // The deadline rules below are unchanged and still right for this mode.
    // Reporting them alongside the gate would stack a second complaint on a
    // card that has one problem, and lifting the gate later would uncover it.
    return;
  }

  // Past the gate only "sync" and "async" remain, and neither is ever asked to
  // confirm — which is why this needs no test on the mode of its own.
  if (card.confirm_deadline_seconds !== undefined) {
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
}).meta({
  // JSON Schema has no way to say "this field only when that one has this
  // value", and zod drops the rules above when it renders a document. Left at
  // that, an engineer generating a client from the export would build one that
  // sends deadlines a card cannot carry and only find out on the first publish.
  // Saying it in words is weaker than checking it, and better than silence.
  description:
    'A product in the catalog, as the merchant publishes it. Three rules are enforced beyond the shape below. A card cannot be published as fulfillment "confirm" during the pilot: the confirmation request has no shape on the wire yet, so a handler could not tell one from a paid order. confirm_deadline_seconds is only allowed when fulfillment is "confirm", and fulfill_deadline_seconds only when fulfillment is "async" or "confirm" — a synchronous card delivers inside the system-wide response budget and names no deadline of its own.',
});

export type Fulfillment = z.infer<typeof FulfillmentSchema>;
export type PriceCheck = z.infer<typeof PriceCheckSchema>;
export type Card = z.infer<typeof CardSchema>;
