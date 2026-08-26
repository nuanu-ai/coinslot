/**
 * The client a merchant's engineer holds: a catalog, an order desk and a price
 * desk, built once from a key and an address.
 *
 * The shape of it is the portal's, not this file's. Every method here exists
 * because a page of the documentation tells a merchant to call it, with the
 * arguments that page passes and answering with what that page reads — and the
 * examples on those pages are compiled against these types by a test, so the
 * code a merchant copies out of the documentation is code that builds.
 *
 * One rule runs through the whole surface and it is worth stating once. What
 * the contract gives a call a failure branch for is returned, never thrown: a
 * card that was not accepted comes back as its findings, and an order call
 * that did not go through comes back as an error with a flag saying whether
 * repeating it could help. A merchant's integration code is expected to read
 * those and branch on them. What is thrown is what has no branch to be read
 * on: a client built wrong, and a call that produced no answer of the kind the
 * route promises where the route has nowhere to put one.
 *
 * The one place that rule needed a decision rather than a reading is a
 * `deliver` or a `refuse` that never reached the gateway at all. The contract
 * has a branch for it — an error with a retryable flag is exactly the shape of
 * "the connection dropped, call again, the call is idempotent" — so it comes
 * back through that branch, under a code this package produces and the gateway
 * never sends. It is written down beside the code below.
 */

import type {
  Acceptance,
  Card,
  Delivery,
  OrderAcceptResponse,
  OrderCallError,
  OrderCallResponse,
  OrderList,
  OrderWithStatus,
  PublishResult,
  Refusal,
} from "@coinslot/contracts";
import { callRoute, type Gateway, type TransportFailure } from "./transport.js";
import {
  type EventHandler,
  type HandlerRegistry,
  type OrderHandler,
  type ProblemReporter,
  type QuoteHandler,
  type Subscription,
  startWorker,
  type WorkerClock,
  type WorkerProblem,
} from "./worker.js";

export interface ClientOptions {
  /**
   * The merchant's API key.
   *
   * It admits `undefined` because the thing a merchant actually writes is
   * `process.env.COINSLOT_API_KEY`, which is `string | undefined` in every
   * strict TypeScript project there is. Refusing that at the type level would
   * teach every merchant to silence it with a non-null assertion, which turns
   * an unset variable into an authorisation failure much later. It is refused
   * here instead, at the line that is wrong, with a sentence that names what
   * is missing.
   */
  readonly apiKey: string | undefined;

  /**
   * Where the gateway is.
   *
   * Optional in the type and required in fact. Nothing in the contract or in
   * any decision says where the gateway lives — the portal lists it among the
   * things not yet settled — so this package has no default to fall back on,
   * and a client built without an address says that rather than pretending to
   * a hostname nobody chose.
   */
  readonly baseUrl?: string | undefined;
}

export interface SubscribeOptions {
  /**
   * Things that happened to an order without the merchant doing anything.
   * They arrive on the same subscription and want no answer.
   */
  readonly onEvent?: EventHandler;

  /**
   * Everything the worker could not get through: a gateway that did not
   * answer, a handler that threw, an answer the gateway would not take.
   *
   * Left out, the problems are written to the error console, because a worker
   * that stopped in silence is the failure a merchant finds out about from
   * their buyers.
   */
  readonly onProblem?: ProblemReporter;
}

export interface CatalogNamespace {
  /**
   * Publishes one product, or says what is wrong with the card.
   *
   * Publishing again under the same `merchant_item_id` changes that card
   * rather than adding a second one, so a publish script can be run as often
   * as a merchant likes.
   */
  publish(card: Card): Promise<PublishResult>;
}

export interface OrdersNamespace {
  /**
   * Receives paid orders and answers each one with what the handler returns:
   * the goods, a refusal, or an acceptance to deliver later.
   *
   * The subscription is outgoing — the merchant opens it, and nothing of
   * theirs has to be reachable from outside. It carries the price questions
   * and the order events too, so a process needs one of these and not three.
   */
  subscribe(handler: OrderHandler, options?: SubscribeOptions): Subscription;

  /** The goods for an order taken on earlier. Idempotent by the order's identifier. */
  deliver(orderId: string, delivery: Delivery): Promise<OrderCallResponse>;

  /** A final "this cannot be delivered" for an order already taken on. */
  refuse(orderId: string, refusal: Refusal): Promise<OrderCallResponse>;

  /**
   * Takes an order on without delivering yet, from outside a handler.
   *
   * Inside a handler the same thing is said by returning `{ accepted }`, which
   * is what the portal's examples do; this is here for the merchant who
   * decides later, in another part of their code.
   */
  accept(orderId: string, acceptance?: Acceptance): Promise<OrderAcceptResponse>;

  /** One order and the state it is in. */
  get(orderId: string): Promise<OrderWithStatus>;

  /** Orders and the states they are in; with `open`, only those still owed something. */
  list(query?: { readonly open?: boolean }): Promise<OrderList>;
}

export interface PricingNamespace {
  /**
   * Answers "how much is this and is it there" for the cards whose price is
   * computed at the moment of purchase.
   *
   * It runs on the same subscription as the orders, so a merchant answering
   * price questions this way hosts nothing.
   */
  onQuote(handler: QuoteHandler): Subscription;
}

export interface CoinslotClient {
  readonly catalog: CatalogNamespace;
  readonly orders: OrdersNamespace;
  readonly pricing: PricingNamespace;
}

/**
 * The code an order call comes back under when it never reached the gateway.
 *
 * The contract's list of error codes is open exactly so that a case nobody
 * anticipated reaches the merchant in its own words instead of being flattened
 * into the nearest of three. This is one of those, and it is produced here
 * rather than on the wire — the gateway does not send it, because a gateway
 * that could send it would have answered.
 */
export const CALL_DID_NOT_REACH_US = "call_did_not_reach_us";

const failedCall = (failure: TransportFailure): OrderCallError => ({
  code: CALL_DID_NOT_REACH_US,
  message: `${failure.reason} — the call is idempotent, so repeating it is safe`,
  retryable: true,
});

/**
 * The reporter a subscription gets when the merchant passed none.
 *
 * A library writing to the console is a small rudeness. A worker that stopped
 * on a contract mismatch and said nothing to anybody is a merchant learning
 * about it from a buyer, and between the two this is the cheaper one.
 */
const reportToConsole: ProblemReporter = (problem: WorkerProblem): void => {
  console.error(`[coinslot] ${problem.kind}: ${problem.message}`);
};

const keyOf = (apiKey: string | undefined): string => {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TypeError(
      "createClient needs the merchant's API key, and was given none — check that the environment variable holding it is set where this process can read it",
    );
  }

  return apiKey;
};

const addressOf = (baseUrl: string | undefined): string => {
  if (baseUrl === undefined) {
    throw new TypeError(
      "createClient needs baseUrl, the address of the gateway — this package has no default to fall back on, because where the gateway lives is not settled yet",
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl is not an address: ${JSON.stringify(baseUrl)}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(
      `baseUrl is not an http address: ${JSON.stringify(baseUrl)} — the gateway is reached over https, and over http only where the two run on one machine`,
    );
  }

  return baseUrl;
};

/**
 * `clock` is not part of what a merchant passes. It is here so the tests can
 * assert which delays the worker asks for without waiting through them, and it
 * is left off `ClientOptions` so that it is not part of anything published.
 */
export const createClient = (options: ClientOptions, clock?: WorkerClock): CoinslotClient => {
  const gateway: Gateway = {
    apiKey: keyOf(options.apiKey),
    baseUrl: addressOf(options.baseUrl),
  };

  const registry: HandlerRegistry = { problem: reportToConsole };
  let worker: Subscription | undefined;

  const workerStarted = (): Subscription => {
    worker ??= startWorker(gateway, registry, clock);
    return worker;
  };

  const orderCall = async (
    route: "deliver_order" | "refuse_order",
    orderId: string,
    body: unknown,
  ): Promise<OrderCallResponse> => {
    const answer = await callRoute(gateway, route, { path: { order_id: orderId }, body });

    return answer.ok ? answer.document : { ok: false, error: failedCall(answer.failure) };
  };

  const document = async <Name extends "publish_card" | "get_order" | "list_orders">(
    route: Name,
    options_: Parameters<typeof callRoute<Name>>[2],
  ) => {
    const answer = await callRoute(gateway, route, options_);

    if (!answer.ok) throw new Error(answer.failure.reason);

    return answer.document;
  };

  return {
    catalog: {
      publish: (card) => document("publish_card", { body: card }),
    },

    orders: {
      subscribe: (handler, subscribeOptions) => {
        if (registry.order !== undefined) {
          throw new TypeError(
            "orders.subscribe was called twice on one client: the second handler would silently replace the first, and one order goes to one handler",
          );
        }

        registry.order = handler;
        if (subscribeOptions?.onEvent !== undefined) registry.event = subscribeOptions.onEvent;
        if (subscribeOptions?.onProblem !== undefined)
          registry.problem = subscribeOptions.onProblem;

        return workerStarted();
      },

      deliver: (orderId, delivery) => orderCall("deliver_order", orderId, delivery),

      refuse: (orderId, refusal) => orderCall("refuse_order", orderId, refusal),

      accept: async (orderId, acceptance) => {
        const answer = await callRoute(gateway, "accept_order", {
          path: { order_id: orderId },
          body: acceptance ?? {},
        });

        return answer.ok ? answer.document : { ok: false, error: failedCall(answer.failure) };
      },

      get: (orderId) => document("get_order", { path: { order_id: orderId } }),

      list: (query) =>
        document("list_orders", {
          // The wire carries the two words rather than a boolean, because a
          // query string carries text. The merchant writes the boolean their
          // language has and this is where the two meet.
          query: query?.open === undefined ? {} : { open: query.open ? "true" : "false" },
        }),
    },

    pricing: {
      onQuote: (handler) => {
        if (registry.quote !== undefined) {
          throw new TypeError(
            "pricing.onQuote was called twice on one client: the second handler would silently replace the first",
          );
        }

        registry.quote = handler;

        return workerStarted();
      },
    },
  };
};
