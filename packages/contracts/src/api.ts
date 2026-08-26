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
 */

import { z } from "zod";
import { CardSchema, PublicCardSchema } from "./card.js";
import { WorkerEnvelopeSchema } from "./envelope.js";
import { AcceptanceSchema, DeliverySchema, RefusalSchema } from "./handler.js";
import { OrderSchema } from "./order.js";
import { OrderStatusSchema } from "./order-status.js";
import { ParamNameSchema } from "./param-spec.js";
import { IdentifierSchema } from "./primitives.js";
import { QuoteResponseSchema } from "./quote.js";
import { OrderCallErrorSchema, OrderCallResultSchema, PublishResultSchema } from "./results.js";

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
export const OrderListQuerySchema = z.strictObject({
  open: z.enum(["true", "false"]).optional(),
});

/**
 * The longest wait one poll may ask to be held for.
 *
 * A bound on the format, not a policy. The gateway's own window is shorter and
 * is the gateway's to set; what this refuses is a number that is not a wait
 * window at all. A long poll rides a single HTTP request, and a request held
 * open longer than a few minutes is one that something on the path — a proxy,
 * a load balancer, the caller's own timeout — closes before we can answer it.
 */
export const MAX_POLL_WAIT_SECONDS = 300;

/**
 * The most envelopes one answer may be asked for. A format bound in the same
 * sense: past this a batch is not a batch, it is a queue emptied down a single
 * response body. The gateway's ceiling is lower and is the gateway's.
 */
export const MAX_POLL_ENVELOPES = 1000;

export const WorkerPollRequestSchema = z
  .strictObject({
    /**
     * How long the gateway may hold the request open waiting for something to
     * arrive. Zero is allowed and means a drain: answer with whatever is
     * queued right now and come straight back, which is what a worker shutting
     * down asks for.
     */
    wait_seconds: z.int().min(0).max(MAX_POLL_WAIT_SECONDS).optional(),

    /**
     * At most this many envelopes in the answer. One is the smallest request
     * that means anything — at most zero envelopes is a call asking for
     * nothing, answered with an empty batch forever and indistinguishable from
     * a quiet queue.
     */
    max: z.int().min(1).max(MAX_POLL_ENVELOPES).optional(),
  })
  .meta({
    description:
      "What a worker asks of one poll. Both fields may be left out, and then the gateway's own defaults apply. The bounds on them are the format's and not the policy's: they refuse a number that is not a wait window or not a batch, while the ceiling a merchant may actually ask for is lower and is the gateway's.",
  });

/**
 * What a poll answers with.
 *
 * The list may be empty, and an empty batch is the ordinary answer to a quiet
 * window rather than a failure. A worker that read it as one would tear down
 * and rebuild its subscription every time nothing happened.
 */
export const WorkerPollResponseSchema = z.strictObject({
  envelopes: z.array(WorkerEnvelopeSchema),
});

/**
 * What delivering or refusing an order comes back as.
 *
 * The success and the failure are separate branches with the marker being
 * which key is present, following the same shape publishing a card already
 * uses. That is the whole point of nesting the word inside `ok` instead of
 * making it the value of `ok`: the portal promises the merchant that the
 * marker of success is one and the same for a first delivery and for a
 * repeated one, and a merchant who wrote `if (result === "delivered")` would
 * have turned their own safe retry into a failure branch. Testing for `ok` is
 * the branch; the word inside it is something to write down.
 *
 * Singular `error` where publishing has plural `errors`, and the difference is
 * real: a card can be wrong in several places at once, while a call either
 * went through or did not go through for one reason.
 *
 * Nothing here travels as an exception. A merchant's integration code is
 * expected to read this, branch on it and write some of it down.
 */
export const OrderCallResponseSchema = z.union(
  [
    z.strictObject({ ok: z.strictObject({ result: OrderCallResultSchema }) }),
    z.strictObject({ error: OrderCallErrorSchema }),
  ],
  {
    error:
      "answering for an order comes back as either { ok } or { error }, never both and never neither; the presence of ok is the marker of success, and the word inside it is which success it was",
  },
);

/**
 * What taking an order on comes back as.
 *
 * The success carries no word, and that is an admission rather than an
 * omission. The five results this contract publishes are about delivering and
 * refusing; none of them names a successful acceptance, and inventing one here
 * would put a value on the wire that no decision stands behind. An empty
 * success is also the only answer that cannot be got wrong on a repeat, and
 * repeats are ordinary here: delivery is at least once, so an order already
 * taken on is taken on again every time it is redelivered.
 *
 * The failures are the same ones the other order calls have — accepting an
 * order that has already closed, or accepting in a mode where acceptance does
 * not exist.
 */
export const OrderAcceptResponseSchema = z.union(
  [z.strictObject({ ok: z.strictObject({}) }), z.strictObject({ error: OrderCallErrorSchema })],
  {
    error:
      "taking an order on comes back as either { ok } or { error }; the success carries no word, because none of the published results names a successful acceptance",
  },
);

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
 * Thin on purpose, and what it leaves out is worth saying. It carries the
 * status word and the order it is about, and nothing else. Where an agent
 * collects the goods of an order delivered after the fact, and whether it is
 * told the reason behind a refusal, are not designed anywhere in this
 * contract; a field for either would be a promise about a mechanism that does
 * not exist.
 */
export const AgentOrderStatusSchema = z
  .strictObject({
    order_id: IdentifierSchema,
    status: OrderStatusSchema,
  })
  .meta({
    description:
      "What became of one purchase, in the words an agent and a merchant both read. It carries the status and nothing more: where the goods of an order delivered after the fact are collected, and whether the reason behind a refusal is told, are not designed.",
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

  poll_worker: {
    method: "POST",
    path: "/v0/worker/poll",
    auth: "merchant_key",
    description:
      "Draws the next batch off this merchant's stream. The request is held open until something arrives or the wait window closes, and then answers with a batch of envelopes or an empty one; an empty batch is the ordinary answer to a quiet window and is not a failure. Delivery is at least once, so the same message can arrive again under the same envelope identifier.",
    request: WorkerPollRequestSchema,
    response: { document: WorkerPollResponseSchema },
  },

  deliver_order: {
    method: "POST",
    path: "/v0/orders/:order_id/deliver",
    auth: "merchant_key",
    description:
      "The goods for an order. Idempotent by the order's identifier: called again after a dropped connection it delivers nothing twice and charges nothing twice, so repeating it is safe and keeping a note of what was already sent is not needed. A late call is accepted too — where the delivery deadline has passed and the refund has not yet been paid out, delivering closes the debt.",
    request: DeliverySchema,
    response: { document: OrderCallResponseSchema },
  },

  refuse_order: {
    method: "POST",
    path: "/v0/orders/:order_id/refuse",
    auth: "merchant_key",
    description:
      'A final "this cannot be delivered" for an order already taken on. It exists only where an acceptance came first; in the synchronous mode the handler\'s own answer is the refusal and there is no separate call, which is what the error code not_applicable_in_mode says from the other side. A temporary failure is not a refusal — it is an exception, a dead process or a dropped connection, and it is answered with another delivery.',
    request: RefusalSchema,
    response: { document: OrderCallResponseSchema },
  },

  accept_order: {
    method: "POST",
    path: "/v0/orders/:order_id/accept",
    auth: "merchant_key",
    description:
      "Takes an order on: the merchant will deliver, and says how long they expect it to take when they know. An empty body is a complete answer. The same order is taken on again every time it is redelivered, which is why the success carries no word — none of the published results names a successful acceptance, and inventing one would be a wire value no decision stands behind.",
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
      "Buying one product. The payment is what stands in for authorisation, so there is no key on this call. Its answer is not one document: the first is a payment challenge, and what follows a paid purchase depends on the card's mode — the goods themselves where delivery is synchronous, an order and a receipt otherwise. One consequence of that exchange has already been paid for once and belongs here rather than in a gateway's memory: the challenge has to be answered on any method of this address and not only on the method named above, because the validators and crawlers that list a paid resource ask for it with GET, and a paywall bound to a single method makes the resource invisible to them.",
    request: PurchaseRequestSchema,
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
      "What became of a purchase, for the agent that made it. Who may ask is an open question: nothing in this contract or in any decision says how an agent proves that an order is theirs. The door is therefore recorded as undecided rather than as none — left open, this route would let anyone read anyone's purchase, and a scheme invented here would be a decision nobody took.",
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
    const value = values[name];

    if (value === undefined || value === "") {
      throw new TypeError(`"${path}" needs a value for ":${name}" and was given none`);
    }

    return encodeURIComponent(value);
  });
};

export type OrderWithStatus = z.infer<typeof OrderWithStatusSchema>;
export type OrderList = z.infer<typeof OrderListSchema>;
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>;
export type WorkerPollRequest = z.infer<typeof WorkerPollRequestSchema>;
export type WorkerPollResponse = z.infer<typeof WorkerPollResponseSchema>;
export type OrderCallResponse = z.infer<typeof OrderCallResponseSchema>;
export type OrderAcceptResponse = z.infer<typeof OrderAcceptResponseSchema>;
export type QuoteAnswerAck = z.infer<typeof QuoteAnswerAckSchema>;
export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>;
export type AgentOrderStatus = z.infer<typeof AgentOrderStatusSchema>;
export type CatalogPage = z.infer<typeof CatalogPageSchema>;
