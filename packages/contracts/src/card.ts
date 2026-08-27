/**
 * One product, in the shapes it has: the card the merchant publishes, the card
 * an agent reads in a catalog, and the card its own merchant reads back.
 *
 * The published card comes first and everything the agent sees is drawn from
 * it. The requirement that runs through every field follows from that: an
 * agent holding only this card has to be able to assemble a correct purchase
 * and know what it will get back. A field that fails that test is not a
 * detail, it is a sale that ends in a refusal.
 *
 * The catalog id is not part of the published schema. We issue it when the
 * card is published and hand it back in the result, so a card arriving with
 * one is a card whose author is guessing at our numbering.
 *
 * The first two shapes share this file rather than being separated by
 * audience, because what they have to be is in step with each other. Anything a
 * merchant may publish has to project into something an agent can read, and
 * anything the projection copies is a claim we make to whoever spends money on
 * it. Kept apart, the rule that ties them would live in neither file.
 *
 * The third is not a projection at all and is here for the opposite reason: a
 * merchant reading their own catalog is reading what they wrote, so the card
 * travels whole, wrapped in the two facts they cannot have — the identifier we
 * issued and the word it is selling under. A second projection would be one
 * more shape to keep in step for no gain to anybody.
 */

import { z } from "zod";
import { ParamSpecSchema, paramSpecToValidator } from "./param-spec.js";
import { IdentifierSchema, MoneySchema, TimestampSchema } from "./primitives.js";
import { SellingStateSchema } from "./selling.js";

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
      // Two checks, and each earns its place. `z.url()` says this is a URL at
      // all; the pattern says the scheme is https. The scheme is a pattern
      // rather than zod's own `protocol` option because a pattern is what
      // survives into the JSON Schema export — zod renders a url as
      // `format: "uri"` and drops the rest, so a generated client would
      // otherwise happily post a merchant's prices over http. Written both
      // ways, the protocol option was doing nothing the pattern did not, and
      // no test could tell the difference.
      //
      // Case-insensitive because a URL scheme is (RFC 3986 §3.1). Written
      // case-sensitively alongside zod's own check, the two disagreed:
      // `HTTPS://` passed one and failed the other, with a message saying an
      // address was not https about an address that was.
      url: z.url().regex(/^https:\/\//i, "a price hook is https"),
    }),
  ],
  { error: 'a price check is either "handler" or { url } naming an https address' },
);

/** The short line a catalog shows; how the card differs from its neighbours. */
const TitleSchema = z.string().regex(/\S/, "a title must not be empty or blank");

/**
 * What the buyer gets, what it is good for and what it does not include. Read
 * by a program, so distinguishing facts do the work here.
 */
const DescriptionSchema = z.string().regex(/\S/, "a description must not be empty or blank");

/**
 * What the agent receives when the delivery goes through. Never empty: a
 * declaration with no fields satisfies the letter of "the card declares its
 * result" while telling the agent nothing about what it is paying for.
 *
 * The rule is written twice again. zod drops refinements when it renders
 * JSON Schema, so the same constraint goes into the metadata as
 * `minProperties`, where a generator can still see it.
 *
 * One schema, used by the published card and by the projection below, because
 * the promise is the same one: what the agent reads before paying is what the
 * merchant is held to afterwards. Two copies of a refinement would be two
 * promises, and the export would carry whichever was edited last.
 */
const DeclaredResultSchema = ParamSpecSchema.refine(
  // Not merely non-empty: at least one field that actually arrives. A
  // declaration of one field marked `required: false` satisfies "at least
  // one" and promises the agent exactly as much as an empty one does.
  (spec) => Object.values(spec).some((field) => field.required !== false),
  "a card declares at least one field of what the agent receives, and at least one of them arrives every time",
).meta({
  description:
    "What the agent receives on delivery. At least one field, and at least one of the fields is not marked required: false — a result that might be entirely absent promises nothing.",
  minProperties: 1,
});

const CardFieldsSchema = z.strictObject({
  /** The merchant's own key for this product, the one their database uses. */
  merchant_item_id: IdentifierSchema,

  title: TitleSchema,

  description: DescriptionSchema,

  /**
   * The price in the catalog. Always required, even for a card with a price
   * check: this is what the agent compares when it is choosing.
   */
  price: MoneySchema,

  /** What the agent has to supply to buy. Absent when the purchase needs no input. */
  params: ParamSpecSchema.optional(),

  result: DeclaredResultSchema,

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

/**
 * The check an agent's purchase parameters are held to, for this card.
 *
 * The compiler underneath takes a direction, and a direction is a string a
 * caller can get backwards: compiling a card's result as a purchase silently
 * restores the hole where a delivery promises nothing. These two take the card
 * instead, so the only place that knows which declaration is which is the
 * place that picks.
 */
export const purchaseCheckFor = (card: Card): z.ZodType =>
  paramSpecToValidator(card.params ?? {}, "purchase");

/** The check this card's delivery is held to. */
export const deliveryCheckFor = (card: Card): z.ZodType =>
  paramSpecToValidator(card.result, "delivery");

/**
 * The fields of a card as an agent reads it in a catalog.
 *
 * The published card is what a merchant writes; this is what we say about it
 * to somebody who is about to spend money. Every difference between the two is
 * a decision, so each one is written down.
 *
 * Our catalog identifier replaces the merchant's own key. `id` is what a
 * purchase, a receipt and a status all use, while `merchant_item_id` is unique
 * only inside one merchant's catalog and means nothing outside it. An agent
 * handed both would use the wrong one some of the time, for no gain.
 *
 * `price_check` is gone and one fact out of it stays. The address of a
 * merchant's pricing service is infrastructure of theirs, no agent ever calls
 * it, and publishing it would put it in front of everyone. What an agent does
 * act on is that the price will be asked again: the number in the catalog is
 * what it compares when choosing, and the sale can go through at another. So
 * the projection carries `price_checked_at_purchase` and nothing else about
 * how the asking is done. The flag says we ask, not that we get an answer —
 * what happens when a merchant is silent depends on the mode and is the
 * gateway's, and this document does not claim to know it.
 *
 * Both deadlines stay, because they are the merchant's promise to the agent
 * about how long it may wait, and the agent is told them before it pays. They
 * sit on the modes that have them, as branches of a union rather than as a
 * rule attached to one object: JSON Schema cannot say "this field only when
 * that one has this value", and zod drops such a rule without a word, so as
 * branches the constraint crosses whole into the export.
 *
 * `as_of` is added: the moment the price shown here was published. A price
 * with no moment behind it cannot be judged stale, and this is the only
 * freshness claim a catalog makes.
 *
 * One thing an agent might reasonably want is not here, and saying so is
 * better than leaving it to be discovered: nothing in this document names who
 * is selling. There is no shape in this contract for a merchant's public
 * identity, and inventing one here would answer a question — who "we" are to
 * the buyer, and who the merchant is — that is still open.
 */
const PublicCardFieldsSchema = z.strictObject({
  /** Our catalog identifier, the one a purchase, a receipt and a status use. */
  id: IdentifierSchema,

  title: TitleSchema,

  description: DescriptionSchema,

  /** The price in the catalog: what an agent compares when it is choosing. */
  price: MoneySchema,

  /** When the price above was published. */
  as_of: TimestampSchema,

  /** What the agent has to supply to buy. Absent when the purchase needs no input. */
  params: ParamSpecSchema.optional(),

  result: DeclaredResultSchema,

  /**
   * Whether the merchant is asked for this product's price and availability at
   * the moment of purchase, so the sale may go through at a price other than
   * the one above.
   *
   * Required rather than defaulted, because both readings of a missing flag
   * cost the agent something: read as false it budgets against a price that is
   * about to move, read as true it distrusts a price that never moves.
   */
  price_checked_at_purchase: z.boolean(),
});

export const PublicCardSchema = z
  .discriminatedUnion("fulfillment", [
    // Synchronous: the product arrives in the answer to the purchase, inside our
    // own response budget — one number for every product on the platform, which
    // is why no card names it and no card may name a delivery deadline instead.
    PublicCardFieldsSchema.extend({ fulfillment: z.literal("sync") }),

    // Asynchronous: the money moves at the purchase and the product comes later,
    // within the merchant's own delivery deadline where they set one.
    PublicCardFieldsSchema.extend({
      fulfillment: z.literal("async"),
      fulfill_deadline_seconds: z.int().positive().optional(),
    }),

    // With confirmation: the merchant is asked first and the payment follows
    // their yes, so both waits exist. No card can be published in this mode
    // during the pilot; the branch is here because the mode is in the
    // vocabulary, and a branch missing from a projection would be a second gate
    // in a second place for whoever lifts the first one.
    PublicCardFieldsSchema.extend({
      fulfillment: z.literal("confirm"),
      confirm_deadline_seconds: z.int().positive().optional(),
      fulfill_deadline_seconds: z.int().positive().optional(),
    }),
  ])
  .meta({
    // Everything below is written in prose above as well, and it has to be
    // written twice: the reader this matters most to is the one holding the
    // exported document and no TypeScript, and that reader is about to spend
    // money on what this card claims. `as_of` in particular means something
    // narrower here than the same name means elsewhere in this contract, and a
    // reader who assumed otherwise would trust a stale number.
    description:
      "A product an agent can buy, projected from the card its merchant published. as_of is when the price shown here was published, and nothing more: on a card whose price is checked at purchase it says nothing about how fresh that check will be — elsewhere in this contract the same name means the moment a live answer was true. price_checked_at_purchase says the merchant is asked for a price at the moment of purchase, not that they answer; what happens when they are silent depends on the mode and belongs to the gateway. The number above is what an agent compares when choosing and may not be what the sale goes through at. Two rules hold beyond the shape: a synchronous product names no delivery deadline, because it is delivered inside a response budget that is the same for every product on the platform, and only a product whose merchant is asked to confirm names a confirmation deadline. No field here names who is selling: this contract has no shape for a merchant's public identity.",
  });

export type PublicCard = z.infer<typeof PublicCardSchema>;

/**
 * The card as an agent reads it, built from the card the merchant published.
 *
 * It exists so there is one projection rather than one per caller. The
 * decision about what an agent may see is made once, here, and it is made by
 * naming each field that is copied. Built the other way — copy the card, then
 * remove what is internal — a field added to the published card would reach
 * every agent by default, and the first anybody heard of it would be a
 * merchant's pricing address in a public catalog.
 *
 * The two things the card cannot know are passed in: the catalog identifier we
 * issued when it was published, and the moment its price was published.
 */
export const publicCardOf = (
  card: Card,
  issued: { readonly id: string; readonly as_of: string },
): PublicCard => {
  const common = {
    id: issued.id,
    title: card.title,
    description: card.description,
    price: card.price,
    as_of: issued.as_of,
    ...(card.params === undefined ? {} : { params: card.params }),
    result: card.result,
    price_checked_at_purchase: card.price_check !== undefined,
  };

  switch (card.fulfillment) {
    case "sync":
      return { ...common, fulfillment: "sync" };
    case "async":
      return {
        ...common,
        fulfillment: "async",
        ...(card.fulfill_deadline_seconds === undefined
          ? {}
          : { fulfill_deadline_seconds: card.fulfill_deadline_seconds }),
      };
    case "confirm":
      return {
        ...common,
        fulfillment: "confirm",
        ...(card.confirm_deadline_seconds === undefined
          ? {}
          : { confirm_deadline_seconds: card.confirm_deadline_seconds }),
        ...(card.fulfill_deadline_seconds === undefined
          ? {}
          : { fulfill_deadline_seconds: card.fulfill_deadline_seconds }),
      };
  }
};

/**
 * One card as the merchant who published it reads it back.
 *
 * The public catalog answers none of what a merchant needs from their own
 * catalog. It is unscoped, so nothing in it says which entries are theirs; it
 * carries our identifier in place of their key; and a card that is off sale is
 * not in it at all, which is precisely the card a merchant is looking for when
 * they go to put it back on sale.
 *
 * So the card travels whole rather than as a third projection. Everything the
 * merchant wrote is theirs already, and copying a subset of it here would be
 * one more shape to hold in step with the published card — the drift the
 * projection above exists to prevent once, repeated for no gain.
 *
 * Two fields say where the card stands, and they are two rather than one for a
 * reason that is invisible from the shape. `selling` is what a purchase of this
 * card meets right now, and it is the same word the order machine is given at
 * the birth of an order, so a card reading "paused" here is a card that refuses
 * new orders there. `paused` says whether the pause is this card's own. They
 * differ exactly when the merchant has stopped all selling: every card then
 * reads `selling: "paused"`, and only the ones with `paused: true` are still
 * paused after the merchant starts selling again. A merchant given only the
 * first would press resume on a card and watch nothing change.
 */
export const MerchantCardSchema = z
  .strictObject({
    /** Our catalog identifier, the one a purchase, a receipt and a status use. */
    id: IdentifierSchema,

    /** When this version of the card was published. */
    as_of: TimestampSchema,

    /** The card exactly as its merchant published it. */
    card: CardSchema,

    /** What a purchase of this card meets right now. */
    selling: SellingStateSchema,

    /** Whether the pause is this card's own, rather than the whole catalog's. */
    paused: z.boolean(),
  })
  .meta({
    description:
      'One card as the merchant who published it reads it back: the card whole, the catalog identifier we issued for it, and where it stands. selling is what a purchase of this card meets right now and is the same word the order machine is given, so a card reading "paused" refuses new orders and lets the orders already accepted play out. paused says whether the pause is this card\'s own. The two differ when the merchant has stopped all selling: every card then reads selling "paused", and only the cards with paused true are still paused once the merchant starts selling again — so a resume on a card whose paused is already false changes nothing until all selling is resumed.',
  });

export type MerchantCard = z.infer<typeof MerchantCardSchema>;
