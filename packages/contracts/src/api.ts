/**
 * The HTTP surface: which calls exist, at which addresses, with which document
 * going each way.
 *
 * It is written as data rather than as prose because two programs read it. The
 * gateway serves these calls and the SDK makes them, and each of them
 * previously would have learned the surface from a document a person had
 * transcribed — which is how one side ends up posting to `/v0/order/:id/deliver`
 * while the other serves `/v0/orders/:id/deliver`, and how a response shape
 * agreed in a meeting becomes two shapes in two repositories. Here the table is
 * the agreement, and both sides import it.
 *
 * What the table does not carry is deliberate. There is no header name for the
 * merchant key, no status codes, no base address, no timeouts and no retry
 * policy. `auth` says which door a call is behind, not how the door is built;
 * the key's header, the status code a refusal comes back under and where the
 * service lives are the gateway's, and a number invented here would read as a
 * decision nobody took. What belongs here is what both sides have to agree on
 * or fail: the address, the method, the door, and the documents.
 *
 * The paths are written the way an express-style router writes them — a colon
 * and a lowercase name, `/v0/orders/:order_id/deliver`. That form was chosen
 * over the braces of OpenAPI for one reason: the gateway can mount these
 * strings unchanged, so the side that must never be wrong about an address is
 * the side that does no translation at all. The SDK is the side that
 * substitutes, and it does not write its own substitution either: `pathParamsOf`
 * and `expandPath` below are here so that the encoding is done once. That is
 * not a nicety. An identifier in this contract may contain a slash and a space
 * — "SKU 100/1" is one we accept — and pasted into an address unencoded it
 * becomes two path segments and a different route.
 *
 * One route in the table answers with something that is not a document at all,
 * and it says so in a field rather than by leaving the response out. A missing
 * field is a silence, and a reader cannot tell a silence from an oversight.
 *
 * Two ways of answering for an order sit in the table and they are not the
 * same thing, which is worth reading before either is used. What a merchant's
 * handler returns — delivered, refused, taken on — goes to the answer route,
 * in every mode, and the SDK sends it without the merchant asking. `deliver`
 * and `refuse` are the asynchronous mode's explicit closure verbs, called
 * later by a merchant who took an order on and now has the goods or has run
 * out of them. The order machine keeps the same two apart, and in the
 * synchronous mode it is the returned answer that exists and the explicit
 * calls that do not. The addendum of 2026-08-26 to ADR-0004 settles this; §2
 * of that decision, read alone, leaves the synchronous handler with no address
 * at all.
 */

import { z } from "zod";
import { CardSchema, MerchantCardSchema, PublicCardSchema } from "./card.js";
import { WorkerEnvelopeSchema } from "./envelope.js";
import { AcceptanceSchema, DeliverySchema, HandlerAnswerSchema, RefusalSchema } from "./handler.js";
import { OrderSchema } from "./order.js";
import { OrderStatusSchema } from "./order-status.js";
import { ParamNameSchema } from "./param-spec.js";
import { IdentifierSchema } from "./primitives.js";
import { QuoteResponseSchema } from "./quote.js";
import { ReceiptSchema } from "./receipt.js";
import { OrderCallErrorSchema, OrderCallResultSchema, PublishResultSchema } from "./results.js";
import { SellingStateSchema } from "./selling.js";

/**
 * An order together with the word for where it stands.
 *
 * The order itself carries no state — reading state back is a separate call,
 * and this is that call's document. It is the order with one field added
 * rather than the order nested inside a wrapper, because to the merchant it is
 * one order that has a status, and a wrapper would exist only to keep a strict
 * parser happy. The consequence is worth naming: this is a different document
 * from an order off the worker stream, and `OrderSchema` refuses it. That is
 * the intended reading, not an accident of strictness.
 */
export const OrderWithStatusSchema = OrderSchema.extend({
  /** Where the order stands, in the words an agent and a merchant both read. */
  status: OrderStatusSchema,
});

/**
 * Every order the merchant asked for.
 *
 * An object rather than a bare array, because a bare array is the one shape
 * that cannot grow. The day this list needs a cursor or a count, an array
 * would have to become an object and every reader that already parses it would
 * break at once.
 */
export const OrderListSchema = z.strictObject({
  orders: z.array(OrderWithStatusSchema),
});

/**
 * A merchant's own catalog: their cards, and whether they are selling at all.
 *
 * The merchant's own word sits beside the cards rather than being left to be
 * inferred from them, because the two answer different questions and a screen
 * needs both. Every card of a merchant who has stopped all selling reads
 * paused, and nothing in the cards themselves says whether that is five
 * separate decisions or one — which is exactly the difference between resuming
 * a card and resuming the catalog.
 *
 * An object rather than a bare array for the reason the order list gives, and
 * one more: a bare array has nowhere to put the merchant's own word at all.
 */
export const MerchantCardListSchema = z
  .strictObject({
    /** Whether this merchant is taking new orders at all. */
    selling: SellingStateSchema,

    cards: z.array(MerchantCardSchema),
  })
  .meta({
    description:
      "A merchant's own catalog: every card they have published, and whether they are taking new orders at all. The merchant's own selling word is here as well as on each card because the two are different facts — when a merchant stops all selling every card reads paused, and only this field says why. This document does not say whether it is the whole catalog: paging is not designed, and when it is, this object grows the field that answers it.",
  });

/**
 * Every receipt this merchant has.
 *
 * A receipt exists from the moment the money moves, so this is the list a
 * merchant reconciles their wallet against. What it cannot show is worth
 * knowing before it is reconciled from: a purchase that ended before any
 * payment leaves no receipt at all, and no receipt is written while it is
 * unknown whether the buyer was charged — `ReceiptSchema` works both through.
 *
 * An object rather than a bare array, so the day it needs paging it grows the
 * field that says so instead of changing shape under every reader.
 */
export const ReceiptListSchema = z
  .strictObject({
    receipts: z.array(ReceiptSchema),
  })
  .meta({
    description:
      "The receipts of one merchant. A receipt is written when the money moves, so a purchase that ended before any payment is not here, and neither is one whose payment outcome is still unknown — that receipt is written if and when the answer arrives. This document does not say whether it is the whole list: paging is not designed, and the absence of a field about it is not a promise that there is no more.",
  });

/**
 * The question a merchant puts in the query string when listing orders.
 *
 * `open=true` narrows the list to the orders that are still owed something —
 * which includes the two that stay open after the purchase itself is over, an
 * order owing a refund and one delivered but never paid for. Leaving it out
 * asks for everything.
 *
 * The value is text and not a boolean, because that is what a query string
 * carries. Written as a boolean it would export as one, and an engineer
 * generating a client from that document would build a request nobody can
 * send. The two words are exact on purpose: a merchant who wrote `open=1`,
 * meant "only the open ones" and silently received all of them would reconcile
 * their books against the wrong list.
 */
export const OrderListQuerySchema = z
  .strictObject({
    open: z.enum(["true", "false"]).optional(),
  })
  .meta({
    description:
      'Which orders to list. Written as text because a query string carries text. "true" narrows the list to the orders that are still owed something, which includes the two that stay open after the purchase itself is over: an order owing a refund, and one delivered but never paid for. Leaving the field out asks for everything.',
  });

/**
 * What a worker asks of one poll.
 *
 * Neither field carries a ceiling, and the absence is deliberate. A first
 * draft put a maximum on each and called them bounds on the format; they were
 * not. The bounds this package does write down are anchored in something
 * outside itself — eighteen fractional digits because that is what an ERC-20
 * token carries — and no such anchor exists for a number of seconds or a
 * number of messages. A card is already held to that rule from the other side:
 * it takes any whole positive number of seconds for its deadlines rather than
 * inventing a limit that would read as a decision nobody took. How long the
 * gateway will actually hold a request and how many envelopes it will actually
 * return are the gateway's, and it is the one that has to answer for them.
 *
 * The two lower bounds stay, because each refuses something that is not a
 * request at all rather than something that is merely large.
 */
export const WorkerPollRequestSchema = z
  .strictObject({
    /**
     * How long the gateway may hold the request open waiting for something to
     * arrive. Zero is allowed and means a drain: answer with whatever is
     * queued right now and come straight back, which is what a worker shutting
     * down asks for. The gateway will hold it for its own window at most, and
     * that window is shorter than anything worth asking for.
     */
    wait_seconds: z.int().min(0).optional(),

    /**
     * At most this many envelopes in the answer. One is the smallest request
     * that means anything — at most zero envelopes is a call asking for
     * nothing, answered with an empty batch forever and indistinguishable from
     * a quiet queue.
     */
    max: z.int().min(1).optional(),
  })
  .meta({
    description:
      "What a worker asks of one poll. Both fields may be left out, and then the gateway's own defaults apply. Neither carries a ceiling here, because a ceiling on a wait or on a batch would be a policy number and the policy is the gateway's: it answers with its own window and its own batch size whatever is asked for.",
  });

/**
 * What a poll answers with.
 *
 * The list may be empty, and an empty batch is the ordinary answer to a quiet
 * window rather than a failure. A worker that read it as one would tear down
 * and rebuild its subscription every time nothing happened.
 *
 * The contract version rides here because this is the call every worker makes
 * first and then forever. The SDK checks it and refuses to start against a
 * gateway speaking another dialect, which is the difference between failing at
 * startup and failing on somebody's first order.
 */
export const WorkerPollResponseSchema = z.strictObject({
  /** The version of the contract this gateway speaks. */
  contract_version: z.string().regex(/\S/, "a gateway names the contract version it speaks"),

  envelopes: z.array(WorkerEnvelopeSchema),
});

/**
 * The failure branch every order call shares: it did not go through, here is
 * why, and here is whether calling again could change that.
 */
const OrderCallFailedSchema = z.strictObject({
  ok: z.literal(false),
  error: OrderCallErrorSchema,
});

/**
 * What delivering or refusing an order comes back as.
 *
 * `ok` is a value rather than a key, and that is the decision worth arguing.
 * What the portal promises the merchant is that the marker of success is one
 * and the same for a first delivery and for a repeated one — a merchant who
 * wrote `if (result === "delivered")` would have turned their own safe retry
 * into a failure branch. Any shape with a single marker keeps that promise.
 * Two things pick this one out of them.
 *
 * A marker that is a key rather than a value reads as false in some of the
 * languages a merchant writes in: `{"ok": {}}` is falsy in Python and in PHP,
 * so the same idiom would say yes for a delivery and no for an acceptance. The
 * JSON Schema export exists for exactly the engineer working outside
 * TypeScript, and handing them a marker that flips with the payload would be
 * handing them the trap the single marker was meant to remove.
 *
 * And `ok` as a literal is a discriminator: it crosses into the export as a
 * `const` on each branch, which a generator can use, where "whichever key is
 * present" is something a reader has to work out. It is also the shape the
 * order machine already answers in, so the two do not need translating.
 *
 * Singular `error` where publishing has plural `errors`. A card can be wrong
 * in several places at once and is checked here; a delivery is checked against
 * its own card on the merchant's side before the call is made, so what this
 * call can fail on is the state of the order — one order, one reason.
 *
 * Nothing here travels as an exception. A merchant's integration code is
 * expected to read this, branch on it and write some of it down.
 */
export const OrderCallResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: OrderCallResultSchema }),
  OrderCallFailedSchema,
]);

/**
 * What taking an order on comes back as.
 *
 * The success carries no word, and that is a choice rather than a gap. The
 * published results include `accepted`, so there is a word to carry; this
 * route declines to carry it. Underneath, taking on an order that is waiting
 * and taking on one already delivered are two different answers, and this
 * route reports both as the same bare success — a merchant who takes on an
 * order they have already finished learns nothing new here, which is what
 * makes a repeat harmless. The answer route is where the word earns its
 * place, because it carries whichever of the three things a handler returned
 * and its success has to name which. `ok: true` here is a whole sentence on
 * its own: true is true in every language, and the shape leaves room for a
 * word beside it the day this route needs to tell two successes apart.
 *
 * Repeats are ordinary here. Delivery is at least once, so an order already
 * taken on is taken on again every time it is redelivered, and an answer with
 * no word in it has nothing to get wrong on the second pass.
 *
 * The failures are the same ones the other order calls have — accepting an
 * order that has already closed, or accepting in a mode where acceptance does
 * not exist.
 */
export const OrderAcceptResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  OrderCallFailedSchema,
]);

/**
 * What answering a price question comes back as.
 *
 * One fact, because one fact is what the merchant acts on. A merchant who set
 * stock aside against the question needs to know whether the answer arrived in
 * time to price the purchase; if it did not, they can release what they held.
 *
 * `used: false` also covers a question we no longer hold at all — a worker
 * that restarted and replayed an envelope from an hour ago. The two are folded
 * into one word deliberately, because the merchant does the same thing in
 * either case, and the fold is written down here rather than left to be
 * discovered. The flag is required, not defaulted: read as used, a missing
 * flag leaves stock held forever; read as unused, it releases stock out from
 * under a sale that is going through.
 */
export const QuoteAnswerAckSchema = z
  .strictObject({
    used: z.boolean(),
  })
  .meta({
    description:
      "Whether the merchant's answer arrived in time to price the purchase it was asked for. False also covers a question we no longer hold — a worker replaying an old envelope after a restart — because in both cases the answer priced nothing and stock held against it can be released.",
  });

/**
 * What an agent sends to buy.
 *
 * The parameters are always there, empty for a product that needs no input,
 * for the same reason an order's are: nobody downstream should have to tell
 * "no parameters" from "the field did not arrive".
 *
 * This document holds the envelope and not the contents. Whether these
 * particular values fit this particular card is checked against that card's
 * own declaration at the moment of purchase — one card, one check, one error
 * message — and no schema written in advance of a catalog can do it.
 */
export const PurchaseRequestSchema = z
  .strictObject({
    // The same dropped key as everywhere this contract parses free-form names;
    // see `PROTOTYPE_KEY_IS_DROPPED` in `param-spec.ts`.
    params: z.record(ParamNameSchema, z.unknown()),
  })
  .meta({
    description:
      "What an agent supplies to buy: the purchase parameters, empty for a product that needs none. The names are held to the shape a card could have declared and no further — that these values fit this card is checked against that card at the moment of purchase.",
  });

/**
 * What became of a purchase, told to the agent that made it.
 *
 * Thin on purpose, and what it leaves out is the part worth saying plainly,
 * because one of the omissions costs the agent something it is entitled to.
 * The status vocabulary folds several of the machine's endings into `rejected`
 * on the argument that the reason travels separately, in the refusal code. No
 * shape in this contract carries that reason to an agent, and this document
 * does not either — so for now an agent told `rejected` cannot tell a product
 * that is gone from a payment that failed its check from parameters that did
 * not fit, and those want three different next moves. Adding a field for the
 * reason would be inventing a channel; leaving the gap unnamed would be worse.
 *
 * Where an agent collects the goods of an order delivered after the fact is
 * not designed anywhere either.
 */
export const AgentOrderStatusSchema = z
  .strictObject({
    order_id: IdentifierSchema,
    status: OrderStatusSchema,
  })
  .meta({
    description:
      'What became of one purchase, in the words an agent and a merchant both read. It carries the status and nothing more, and one omission is worth knowing about: "rejected" covers a product that was gone, a payment that failed its check and parameters that did not fit, and nothing in this contract yet carries that reason to an agent. Where the goods of an order delivered after the fact are collected is not designed either.',
  });

/**
 * The catalog as an agent reads it.
 *
 * An object rather than a bare array, so that the day it needs paging it can
 * grow the field that says so instead of changing shape under every reader.
 * Until then it makes no claim about completeness, and that is stated in the
 * document itself: an agent must not read the absence of a field about paging
 * as a promise that there is nothing more.
 */
export const CatalogPageSchema = z
  .strictObject({
    items: z.array(PublicCardSchema),
  })
  .meta({
    description:
      "Products offered for sale, as an agent reads them. This document does not say whether it is the whole catalog: paging is not designed, and when it is, this object grows the field that answers it. Until then the absence of such a field is not a promise that there is no more.",
  });

/** The methods this surface uses. */
export const HTTP_METHODS = Object.freeze(["GET", "POST"] as const);

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Which door a call is behind.
 *
 * `merchant_key` is the merchant's API key, the stage-one minimum. `none` is a
 * call anybody may make — the catalog an agent browses, and the purchase,
 * where the payment is what stands in for authorisation.
 *
 * `undecided` is not a third scheme. It is the honest word for a route whose
 * door nobody has chosen yet, and it exists because "I do not know" and "I
 * know there is no door" cannot be the same value. A gateway must refuse to
 * mount a route marked this way until somebody decides, which is exactly the
 * behaviour wanted: the alternative is a route quietly serving everybody
 * because `none` was the closest word to hand.
 */
export const AUTH_MODES = Object.freeze(["merchant_key", "none", "undecided"] as const);

export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * The header the merchant's key travels in, and the two helpers that put a key
 * into it and read one back out.
 *
 * `auth` above says which door a call is behind and not how the door is built,
 * and that omission is deliberate — but how the door is built is still a thing
 * the gateway and the SDK have to agree on exactly, because a mismatch is a call
 * that fails with an authorisation error while both repositories look correct.
 * They had agreed, by each writing the same two strings down apart from the
 * other: the gateway parsed an `Authorization: Bearer` header and the SDK sent
 * one. That is agreement by luck, and it is the very thing this table exists to
 * remove for the addresses and the documents. So the strings live here now, in
 * the one place both sides already import, and a change to either is a change in
 * one file rather than a silent drift between two.
 *
 * The name is `authorization` and the scheme is `Bearer`: the stage-one minimum
 * of the pilot plan, one merchant with one key sent as a bearer token. The name
 * is lower-case because that is how a client writes a header and how the wire
 * carries it; a reader on the gateway matches it without regard to case anyway.
 */
export const MERCHANT_KEY_HEADER = "authorization";

/** The scheme the merchant's key travels under. */
const MERCHANT_KEY_SCHEME = "Bearer";

/**
 * The value of the {@link MERCHANT_KEY_HEADER} header for a given key — what the
 * SDK sends, so that what the gateway parses is never guessed at.
 */
export const merchantKeyHeaderValue = (key: string): string => `${MERCHANT_KEY_SCHEME} ${key}`;

// Built once and matched case-insensitively: an auth scheme is case-insensitive
// (RFC 7235 §2.1), so a client that wrote "bearer" holds a key that is correct,
// and rejecting it would cost that merchant an afternoon on a key that works.
const MERCHANT_KEY_PATTERN = new RegExp(`^${MERCHANT_KEY_SCHEME}[ \\t]+(\\S+)$`, "i");

/**
 * The key inside a merchant-key header value, or null where there is not one.
 *
 * Null is every way the value is not a bearer token this contract issued: no
 * header at all, another scheme, or the scheme with nothing after it. The caller
 * is handed a key it can compare or nothing to compare, and never a half-parsed
 * string that a constant-time comparison would then match against a prefix of
 * the real key.
 */
export const merchantKeyFrom = (headerValue: string | undefined): string | null => {
  if (headerValue === undefined) {
    return null;
  }
  const match = MERCHANT_KEY_PATTERN.exec(headerValue.trim());
  return match?.[1] ?? null;
};

/**
 * What a call answers with: one document, or a contract this table cannot
 * hold.
 *
 * The second branch exists for the purchase, which is a payment exchange
 * before it is a document. It is a field carrying a sentence rather than an
 * absent `response`, because a reader can tell a sentence from an oversight
 * and cannot tell a silence from one.
 */
export type RouteResponse =
  | { readonly document: z.ZodType }
  | { readonly not_one_document: string };

export interface RouteDefinition {
  /** The method the call is made with, and the only one that carries the body. */
  readonly method: HttpMethod;
  /** The address, with path parameters written the way a router writes them. */
  readonly path: string;
  readonly auth: AuthMode;
  /** What the call is for, and anything about it the shapes cannot carry. */
  readonly description: string;
  /** What the query string may carry, where a call takes one. */
  readonly query?: z.ZodType;
  /** The body, where a call has one. */
  readonly request?: z.ZodType;
  readonly response: RouteResponse;
  /**
   * Other methods this address has to answer on, where something outside our
   * design requires it.
   *
   * One route has this and the reason has already been paid for once: the
   * validators and crawlers that list a paid resource ask for it with GET, and
   * a paywall bound to a single method makes the resource invisible to them.
   * It is a field rather than a sentence in the description because a gateway
   * mounts from data, and a sentence would be mounted by nobody.
   *
   * These methods carry no body. Whatever `request` names travels on `method`
   * and on nothing else.
   */
  readonly also_answers_on?: readonly HttpMethod[];
}

/**
 * Every call of the surface, under the name it is known by in both programs.
 *
 * The name is the key, so two routes cannot share one; a test holds the rest —
 * that no two sit at one address under one method, and that every schema named
 * here is one the contract registry publishes, since the registry and this
 * table are the whole of what a reader outside TypeScript has.
 */
export const API_ROUTES = Object.freeze({
  publish_card: {
    method: "POST",
    path: "/v0/catalog/publish",
    auth: "merchant_key",
    description:
      "Publishes one product, or says what is wrong with the card. Republishing under the same merchant_item_id is how a card is changed rather than how a second one appears. The catalog identifier comes back in the result, and from then on it is what an agent, a purchase and a receipt all use.",
    request: CardSchema,
    response: { document: PublishResultSchema },
  },

  list_merchant_cards: {
    method: "GET",
    path: "/v0/cards",
    auth: "merchant_key",
    description:
      "The cards published under the key this call was made with, each whole and with the word it is selling under, together with whether the merchant is taking new orders at all. It is not the public catalog: that one is unscoped, carries our identifier in place of the merchant's key, and leaves out a card that is off sale — which is the one card a merchant goes looking for when they want it back on sale. During the pilot there is one merchant and one key, so this is every card the gateway holds; when there is a second merchant, scoping it to the caller is a change to whoever serves this and not to the shape of the answer.",
    response: { document: MerchantCardListSchema },
  },

  pause_card: {
    method: "POST",
    path: "/v0/cards/:item_id/pause",
    auth: "merchant_key",
    description:
      "Takes one card off sale. No new order is taken for it, and the orders already accepted for it play out in the ordinary way — a pause closes nothing. Calling it on a card that is already paused changes nothing and answers the same way, so a retry after a dropped connection is safe. Republishing a paused card changes the card and leaves it paused: a merchant editing a price is not asking for it to go back on sale.",
    response: { document: MerchantCardSchema },
  },

  resume_card: {
    method: "POST",
    path: "/v0/cards/:item_id/resume",
    auth: "merchant_key",
    description:
      "Puts one card back on sale. Where the merchant has stopped all selling this lifts only this card's own pause, and the card goes on refusing new orders until selling is resumed — the answer says so in both of its words, and that is the case a merchant is most likely to misread.",
    response: { document: MerchantCardSchema },
  },

  pause_selling: {
    method: "POST",
    path: "/v0/selling/pause",
    auth: "merchant_key",
    description:
      "Stops all selling for this merchant. No new order is taken for any card, and the orders already accepted play out in the ordinary way — this is a pause and not a departure, so nothing open is closed and nothing is owed back. The answer is the whole catalog, because every card's word changed. A merchant who has already left is refused rather than paused: their orders are closed and their refunds owed, and a pause would describe none of that.",
    response: { document: MerchantCardListSchema },
  },

  resume_selling: {
    method: "POST",
    path: "/v0/selling/resume",
    auth: "merchant_key",
    description:
      "Starts selling again. Cards paused in their own right stay paused: stopping all selling did not forget which they were, and putting them all back on sale would sell products their merchant took off. The answer is the whole catalog, so which cards actually came back is a fact rather than an inference. A merchant who has left is refused: leaving closed the orders that were open and left refunds owed, and this switch unwinds none of it, so a departure is not undone here.",
    response: { document: MerchantCardListSchema },
  },

  get_order: {
    method: "GET",
    path: "/v0/orders/:order_id",
    auth: "merchant_key",
    description:
      "One order and the state it is in. Reading state back is not a convenience: a worker that restarted has to be able to find out what it still owes without resting on its own database alone.",
    response: { document: OrderWithStatusSchema },
  },

  list_orders: {
    method: "GET",
    path: "/v0/orders",
    auth: "merchant_key",
    description:
      "Orders and the states they are in. With open=true, only the ones still owed something — which includes the two that stay open after the purchase itself is over, an order owing a refund and one delivered but never paid for.",
    query: OrderListQuerySchema,
    response: { document: OrderListSchema },
  },

  list_receipts: {
    method: "GET",
    path: "/v0/receipts",
    auth: "merchant_key",
    description:
      "The receipts belonging to the key this call was made with: what was paid, when the payment executed, when the purchase happened, the moment the price behind it was true, and what became of the order. Every receipt says whether the money behind it was real, and during the pilot none of it is. Two silences are the receipt's own and are the same here — a purchase that ended before any payment leaves no receipt, and none is written while it is unknown whether the buyer was charged. A third is this call's: a refund owed leaves no receipt either, because receipts are written when goods are released and an order owing a refund released none. During the pilot there is one merchant and one key, so this is every receipt the gateway holds.",
    response: { document: ReceiptListSchema },
  },

  poll_worker: {
    method: "POST",
    path: "/v0/worker/poll",
    auth: "merchant_key",
    description:
      "Draws the next batch off this merchant's stream. The request is held open until something arrives or the wait window closes, and then answers with a batch of envelopes or an empty one; an empty batch is the ordinary answer to a quiet window and is not a failure. Delivery is at least once, so the same message can arrive again under the same envelope identifier.",
    request: WorkerPollRequestSchema,
    response: { document: WorkerPollResponseSchema },
  },

  answer_order: {
    method: "POST",
    path: "/v0/orders/:order_id/answer",
    auth: "merchant_key",
    description:
      "What the merchant's handler returned for an order it was given: the goods, a refusal, or an acceptance. The SDK sends this itself, in every mode, and it is the only way a synchronous answer reaches us at all — there the handler's return is the delivery and the refusal, and the explicit deliver and refuse calls do not apply. An acceptance is answered with the word accepted — the order is taken on, and the goods follow through the deliver call — or with already_delivered when the order closed before the acceptance reached us, which a redelivered order makes ordinary rather than a fault. A synchronous answer that arrives after its deadline is not an error: the work exists and a repeat purchase collects it, and the answer says so in the word purchase_already_closed.",
    request: HandlerAnswerSchema,
    response: { document: OrderCallResponseSchema },
  },

  deliver_order: {
    method: "POST",
    path: "/v0/orders/:order_id/deliver",
    auth: "merchant_key",
    description:
      "The goods for an order the merchant took on earlier — the asynchronous mode's closure verb, called by the merchant rather than by the SDK. Idempotent by the order's identifier: called again after a dropped connection it delivers nothing twice and charges nothing twice, so repeating it is safe and keeping a note of what was already sent is not needed. A late call is accepted too — where the delivery deadline has passed and the refund has not yet been paid out, delivering closes the debt.",
    request: DeliverySchema,
    response: { document: OrderCallResponseSchema },
  },

  refuse_order: {
    method: "POST",
    path: "/v0/orders/:order_id/refuse",
    auth: "merchant_key",
    description:
      "A final \"this cannot be delivered\" for an order already taken on — the asynchronous mode's other closure verb. It exists only where an acceptance came first; in the synchronous mode the handler's own answer is the refusal and travels on the answer route instead, which is what the error code not_applicable_in_mode says from the other side. A temporary failure is not a refusal — it is an exception, a dead process or a dropped connection, and it is answered with another delivery.",
    request: RefusalSchema,
    response: { document: OrderCallResponseSchema },
  },

  accept_order: {
    method: "POST",
    path: "/v0/orders/:order_id/accept",
    auth: "merchant_key",
    description:
      "Takes an order on: the merchant will deliver, and says how long they expect it to take when they know. An empty body is a complete answer. The same order is taken on again every time it is redelivered, and the success carries no word: taking on an order that is already delivered succeeds here too, and this route does not tell the two apart. The answer route does, because it carries whichever of the three things a handler returned.",
    request: AcceptanceSchema,
    response: { document: OrderAcceptResponseSchema },
  },

  answer_quote: {
    method: "POST",
    path: "/v0/quotes/:price_id/answer",
    auth: "merchant_key",
    description:
      "The price and availability for a question that came off the worker stream, against the price_id that question carried. The acknowledgement says whether the answer arrived in time to price the purchase; when it did not, stock held against the question can be released.",
    request: QuoteResponseSchema,
    response: { document: QuoteAnswerAckSchema },
  },

  list_catalog: {
    method: "GET",
    path: "/v0/catalog",
    auth: "none",
    description:
      "Products offered for sale, as an agent reads them. Each is the projection of a published card: our catalog identifier rather than the merchant's own key, and nothing about how the merchant's price is asked for beyond the fact that it will be asked again.",
    response: { document: CatalogPageSchema },
  },

  purchase_item: {
    method: "POST",
    path: "/v0/items/:item_id/purchase",
    auth: "none",
    description:
      "Buying one product. The payment is what stands in for authorisation, so there is no key on this call. Its answer is not one document: the first is a payment challenge, and what follows a paid purchase depends on the card's mode — the goods themselves where delivery is synchronous, an order and a receipt otherwise. The address also answers the challenge on GET, because the validators and crawlers that list a paid resource ask for it that way; a GET carries no body, so it can produce the challenge and never a completed purchase.",
    request: PurchaseRequestSchema,
    also_answers_on: ["GET"],
    response: {
      not_one_document:
        "the payment exchange of the x402 protocol, and then either the delivered goods or an order with its receipt, depending on the card's fulfillment mode",
    },
  },

  get_order_status: {
    method: "GET",
    path: "/v0/orders/:order_id/status",
    auth: "undecided",
    description:
      "What became of a purchase, for the agent that made it. Who may ask is an open question: nothing in this contract or in any decision says how an agent proves that an order is theirs. The door is therefore recorded as undecided rather than as none — left open, this route would let anyone read anyone's purchase, and a scheme invented here would be a decision nobody took. Two things follow for whoever mounts it. It is the only route under /v0/orders that is not the merchant's, so a check attached to that prefix would put the merchant's door on the agent's route without anybody noticing; and until the question is answered it is not in the list of routes a gateway may serve.",
    response: { document: AgentOrderStatusSchema },
  },
}) satisfies Readonly<Record<string, RouteDefinition>>;

/** The name of one call in the table. */
export type RouteName = keyof typeof API_ROUTES;

/**
 * The shape of a path parameter's name: lowercase, the way the fields on the
 * wire are written, so an address reads like the documents it carries.
 */
const PARAMETER_NAME = "[a-z][a-z0-9_]*";

// Built fresh on each call rather than kept in a module constant, because a
// global regular expression carries a cursor between calls and sharing one
// between a scan and a replace is a bug waiting for the second caller.
const pathParameterPattern = (): RegExp => new RegExp(`:(${PARAMETER_NAME})`, "g");

/** The parameters an address takes, in the order it writes them. */
export const pathParamsOf = (path: string): string[] =>
  [...path.matchAll(pathParameterPattern())].map((match) => match[1] ?? "");

/**
 * The address of one call, with its parameters filled in and encoded.
 *
 * Encoding is the reason this is not left to the caller. An identifier in this
 * contract may hold a slash and a space — "SKU 100/1" is one we accept — and
 * concatenated into a path unencoded it becomes two segments and a different
 * route.
 *
 * A missing value and a value for a parameter the address does not take are
 * both refused, and both are refused by throwing rather than by returning
 * something. Everything this package returns rather than throws is a condition
 * a consumer is expected to handle; this is not one of those. An address built
 * with a hole in it is a bug in the caller, and the request it would send
 * reads in a log as a route that exists and answers nothing to anybody.
 *
 * Three refusals are less obvious and each is a way an address stops being the
 * one that was meant. A value is looked up with `Object.hasOwn`, because a
 * parameter named `constructor` would otherwise find something on the
 * prototype and expand into the source of a function. A value of "." or ".."
 * is refused, because a relative-URL resolver walks it and the request lands
 * somewhere else entirely. And a value that is not a string is refused rather
 * than stringified: `null` would otherwise become the four letters that spell
 * it, and the SDK is not always the one holding the types.
 */
export const expandPath = (path: string, values: Readonly<Record<string, string>>): string => {
  const wanted = pathParamsOf(path);
  const unwanted = Object.keys(values).filter((name) => !wanted.includes(name));

  if (unwanted.length > 0) {
    throw new TypeError(
      `"${path}" takes ${wanted.length === 0 ? "no path parameters" : wanted.join(", ")}, so there is nowhere to put ${unwanted.join(", ")}`,
    );
  }

  return path.replace(pathParameterPattern(), (_match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;

    if (typeof value !== "string" || value === "") {
      throw new TypeError(`"${path}" needs a value for ":${name}" and was given none`);
    }

    if (value === "." || value === "..") {
      throw new TypeError(
        `"${path}" was given ${JSON.stringify(value)} for ":${name}", which is a step through the path rather than a value in it`,
      );
    }

    return encodeURIComponent(value);
  });
};

/**
 * The routes a gateway may serve.
 *
 * Every route whose door has been decided, which is every route except the one
 * marked `undecided`. It exists because the natural way to mount a table is to
 * ask whether a route needs the merchant key and to treat everything else as
 * open — and that reading serves the one route nobody has chosen a door for to
 * the whole world. Mounting from this list instead makes the safe reading the
 * easy one, and a route reappears here the day its door is decided.
 */
export const mountableRoutes = (): [RouteName, RouteDefinition][] =>
  (Object.entries(API_ROUTES) as [RouteName, RouteDefinition][]).filter(
    ([, route]) => route.auth !== "undecided",
  );

export type OrderWithStatus = z.infer<typeof OrderWithStatusSchema>;
export type OrderList = z.infer<typeof OrderListSchema>;
export type MerchantCardList = z.infer<typeof MerchantCardListSchema>;
export type ReceiptList = z.infer<typeof ReceiptListSchema>;
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>;
export type WorkerPollRequest = z.infer<typeof WorkerPollRequestSchema>;
export type WorkerPollResponse = z.infer<typeof WorkerPollResponseSchema>;
export type OrderCallResponse = z.infer<typeof OrderCallResponseSchema>;
export type OrderAcceptResponse = z.infer<typeof OrderAcceptResponseSchema>;
export type QuoteAnswerAck = z.infer<typeof QuoteAnswerAckSchema>;
export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>;
export type AgentOrderStatus = z.infer<typeof AgentOrderStatusSchema>;
export type CatalogPage = z.infer<typeof CatalogPageSchema>;
