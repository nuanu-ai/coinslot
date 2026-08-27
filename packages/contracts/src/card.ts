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
import type { ParamSpec, ParamType } from "./param-spec.js";
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
 * The longest a word may be before the discovery channel stops carrying it, and
 * the most words it carries.
 *
 * Both numbers belong to the channel rather than to us, and both are read off
 * its own implementation rather than guessed: a name is at most thirty-two
 * characters of printable ASCII, and at most five tags survive. What the
 * channel does past those limits is drop the value without telling anybody,
 * which is why they are enforced here instead — a merchant whose tag or whose
 * name silently disappeared would have nothing to look at and no reason to
 * suspect anything went wrong.
 */
const LISTED_TEXT_MAX = 32;
const LISTED_TAGS_MAX = 5;

/**
 * A word the discovery channel can render, held to the channel's own rule.
 *
 * Printable ASCII and nothing else, because the channel measures length in
 * bytes and drops anything outside that range. The restriction is real and it
 * costs something worth saying out loud: a seller whose name is written in
 * Cyrillic, Greek or Arabic cannot be listed under it, and this refuses the
 * name rather than listing them under a mangled one.
 */
const listedText = (what: string) =>
  z
    .string()
    .min(1, `a ${what} must not be empty`)
    .max(LISTED_TEXT_MAX, `a ${what} is at most ${LISTED_TEXT_MAX} characters`)
    .regex(/^[\x20-\x7e]*$/, `a ${what} is printable ASCII, which is all the listing carries`)
    // Blank and padded in one rule. A space at either end survives the listing
    // untouched, which is worse than being dropped: it makes two spellings of
    // one word, and a merchant comparing what they typed with what they see
    // finds them identical.
    .regex(/^\S(?:[\s\S]*\S)?$/, `a ${what} must not be blank or padded with spaces`);

/**
 * The name the seller of a card is listed under, wherever a catalog names a
 * seller rather than a product.
 *
 * It belongs to the merchant and not to any one card: a merchant sells under
 * one name, and a per-card name would be one seller appearing as several. What
 * holds it is the merchants table, so this schema is the rule alone, applied
 * wherever a merchant's listing name is written down.
 */
export const ServiceNameSchema = listedText("service name").meta({
  description:
    "The name a seller is listed under in a discovery catalog. At most 32 characters of printable ASCII, because that is what the catalog carries; a name outside that is refused here rather than truncated there, where nobody would be told.",
});

/**
 * The words a merchant puts on one product so an agent searching a catalog can
 * find it.
 *
 * They describe this product and not the seller, which is why they sit on the
 * card. At most five, because the catalog keeps the first five and drops the
 * rest without a word.
 */
export const TagsSchema = z
  .array(listedText("tag"))
  // Not an empty list. A card that names no tags leaves the field out; an
  // empty list is a value a catalog renders, and the two would be one thing
  // written two ways with nothing to tell them apart.
  .min(1, "a card that names no tags leaves the field out rather than sending an empty list")
  .max(LISTED_TAGS_MAX, `a card carries at most ${LISTED_TAGS_MAX} tags`)
  .refine(
    // The catalog folds tags together without regard to case and keeps the
    // first of each, so "Access" and "access" published together become one
    // tag and the merchant is never told which of the two survived. Refusing
    // the pair is the version of that a merchant can act on.
    (tags) => new Set(tags.map((tag) => tag.toLowerCase())).size === tags.length,
    "two tags that differ only in case are one tag to the listing, so both cannot be published",
  )
  .meta({
    description:
      "Words describing this product for an agent searching a discovery catalog. Between 1 and 5 of them, each 1 to 32 characters of printable ASCII with no space at either end, and no two the same without regard to case — because that is what the catalog keeps, and it drops the rest in silence. A card with no tags leaves the field out.",
    // The case rule is a refinement and zod drops those when it renders a
    // document. This much of it does cross, so a generated client refuses at
    // least the identical pair.
    uniqueItems: true,
  });

/**
 * The longest a description may be before a discovery catalog stops carrying
 * all of it.
 *
 * This number is weaker evidence than the other two on this page and the
 * difference matters. The length and the alphabet a listing name and a tag are
 * held to were read out of the catalog's own code, which we run here; this one
 * is read out of the catalog's written documentation, recorded in
 * `docs/research/04-spike-bazaar-listing.md`, and no code of theirs that we can
 * run enforces it — their sanitiser touches the listing name, the tags and the
 * icon, and never the description. A hundred entries walked out of the live
 * catalog are consistent with it and prove nothing: the longest was 468
 * characters and none sat at the boundary, which is what a hard cut would have
 * left behind. So the ceiling is honoured rather than verified.
 */
const LISTED_DESCRIPTION_MAX = 500;

/**
 * What the buyer gets, what it is good for and what it does not include. Read
 * by a program, so distinguishing facts do the work here.
 *
 * It is also the one field of prose that goes out to a discovery catalog, and
 * the only one of the three merchant-written fields that reaches a listing with
 * nothing of the catalog's own checking it on arrival. Whatever a catalog does
 * with a description past its limit — cut it, refuse the record, keep it whole
 * — a merchant would learn of it from a listing rather than from us. So the
 * limit is here, at the publish, where somebody is reading the answer.
 */
const DescriptionSchema = z
  .string()
  .regex(/\S/, "a description must not be empty or blank")
  .max(
    LISTED_DESCRIPTION_MAX,
    `a description is at most ${LISTED_DESCRIPTION_MAX} characters, which is what a listing carries`,
  );

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

  /**
   * Words for an agent searching a discovery catalog. Absent on a card whose
   * merchant named none, and never invented for them.
   */
  tags: TagsSchema.optional(),

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
 * `tags` are gone as well, and that one is a decision rather than an omission.
 * They are words a merchant chose so that a search in a discovery catalog finds
 * this product, held to that catalog's own rule about length and alphabet. Our
 * own catalog is not searched that way — an agent reading it has the whole
 * page — so carrying them here would put a foreign catalog's constraint in
 * front of a reader who has no use for it.
 *
 * One thing an agent might reasonably want is not here, and saying so is
 * better than leaving it to be discovered: nothing in this document names who
 * is selling. There is a shape in this contract for one name a seller carries —
 * `ServiceNameSchema`, the name a discovery catalog lists them under — and it
 * is deliberately not this. That name exists to satisfy one channel's rules,
 * a merchant may have none, and standing it in for a public identity would
 * answer a question — who "we" are to the buyer, and who the merchant is —
 * that is still open.
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
 * One card as a discovery catalog reads it: what an agent that has never seen
 * our own catalog finds when it searches somewhere else.
 *
 * This is the second projection of a card and it sits beside the first because
 * the two have to be read together. Both are claims we make to somebody about
 * to spend money, both are built by naming what is copied rather than by
 * copying the card and removing what is internal, and a field added to a card
 * has to be considered against both or it reaches one audience by accident.
 *
 * What comes out is not a wire document of ours. It is the material an x402
 * payment challenge is assembled from — the resource block, an example of the
 * purchase body, the JSON Schema that body is held to, and an example of what a
 * delivery carries — and the assembling is done at the edge, by the protocol's
 * own library, from exactly these pieces. Keeping the projection here and the
 * assembly there is what stops this package growing a payment library's
 * dependency tree, which is the merchant SDK's dependency tree (ADR-0003 §8).
 *
 * Two decisions inside are worth reading before the code.
 *
 * The card's title is not sent. The resource block has one field of prose and
 * the card has two, and joining a merchant's headline to a merchant's
 * description with punctuation of our own would be us writing their listing for
 * them. The description is the field a card writes for a program to read, so it
 * is the one that goes.
 *
 * The examples are shapes rather than facts. A card declares the types of what
 * it takes and what it returns and carries no example values, so what goes out
 * is every declared field holding a value that stands for its type and nothing
 * more. That is a claim we can keep — a test holds the input example to this
 * card's own purchase check and the output example to its own delivery check,
 * so what we publish is something our own door would accept — and it is not a
 * claim about anybody's real data, which we do not have and will not invent.
 */
export interface BazaarDeclaration {
  /** The resource block: what is being paid for, and who is selling it. */
  readonly resource: {
    /** The canonical address of this resource, exactly as it was given. */
    readonly url: string;
    readonly description: string;
    readonly mimeType: string;
    readonly serviceName?: string;
    readonly tags?: readonly string[];
  };
  /** An example purchase body, in the shape this gateway takes one. */
  readonly input: Record<string, unknown>;
  /** The JSON Schema that body is held to, derived from the card's `params`. */
  readonly inputSchema: Record<string, unknown>;
  /** An example of what arrives on delivery, derived from the card's `result`. */
  readonly output: { readonly example: Record<string, unknown> };
}

/**
 * One declared field as a value standing for its own type.
 *
 * A string is the word `string` rather than an empty one, and that is not a
 * flourish: a delivered string has to carry something, so an example built out
 * of empty strings would be an example this system's own delivery check
 * refuses — published to strangers as what they will receive. The word says
 * what goes there, which is more than an empty string said anyway.
 */
const standInFor = (type: ParamType): unknown => {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
  }
};

/** A whole declaration as an example: every field, each one standing for a type. */
const exampleOf = (spec: ParamSpec): Record<string, unknown> =>
  Object.fromEntries(Object.entries(spec).map(([name, field]) => [name, standInFor(field.type)]));

/**
 * The JSON Schema a purchase body is held to.
 *
 * It is rendered from the very check the gateway runs against an agent's
 * parameters, so the document a stranger reads and the door they meet cannot
 * disagree. The rendered document names its own dialect at the top, which is
 * right for a document standing alone and wrong for one about to be nested
 * inside another schema, so that one line is dropped here.
 */
const purchaseBodySchemaOf = (card: Card): Record<string, unknown> => {
  const { $schema, ...body } = z.toJSONSchema(z.strictObject({ params: purchaseCheckFor(card) }));
  return body as Record<string, unknown>;
};

/**
 * The card as a discovery catalog reads it.
 *
 * The two things a card cannot know are passed in: the address this resource
 * answers at, which is pinned by whoever runs the gateway rather than worked
 * out from a request, and the name its seller is listed under, which belongs to
 * the merchant. A seller with no listing name and a card with no tags leave
 * those fields out altogether — an empty string and an empty list are values a
 * catalog would render, and the absence is the only way to say that nobody
 * named one.
 */
export const bazaarDeclarationOf = (
  card: Card,
  listed: { readonly url: string; readonly serviceName: string | null },
): BazaarDeclaration => ({
  resource: {
    url: listed.url,
    description: card.description,
    mimeType: "application/json",
    ...(listed.serviceName === null ? {} : { serviceName: listed.serviceName }),
    ...(card.tags === undefined ? {} : { tags: card.tags }),
  },
  input: { params: exampleOf(card.params ?? {}) },
  inputSchema: purchaseBodySchemaOf(card),
  output: { example: exampleOf(card.result) },
});

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
