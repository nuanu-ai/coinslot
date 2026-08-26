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
 * `deliver` or a `refuse` whose answer never arrived, or arrived in words this
 * package cannot read. The contract has a branch for it — an error with a flag
 * saying whether calling again could change the outcome is exactly the shape
 * of "the connection dropped, call again" — so it comes back through that
 * branch, under a code this package produces and the gateway never sends. The
 * two codes and what separates them are written down beside them below.
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
import {
  callRoute,
  type Gateway,
  REACH,
  type Reach,
  type TransportFailure,
  whatIsKnown,
} from "./transport.js";
import {
  type EventHandler,
  type HandlerRegistry,
  type OrderHandler,
  type ProblemReporter,
  type QuoteHandler,
  type RunningWorker,
  type Subscription,
  startWorker,
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
   * Optional, and there is no default behind it. Nothing in the contract or in
   * any decision says where the gateway lives — the documentation lists it
   * among the things not yet settled — so this package has no address to fall
   * back on and will not invent one.
   *
   * Leaving it out builds a client, exactly as the quickstart's first step
   * says it does, and every call that would have to reach the gateway fails
   * with a sentence naming what is missing. That is where the failure belongs:
   * the documentation tells the merchant that the first call is what checks
   * whether they can reach us, and an address nobody has chosen yet is one of
   * the things such a call finds out. Giving a wrong address, on the other
   * hand, is refused here and now — a value that is not an address at all
   * cannot become one later.
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

/**
 * What a process that answers only price questions can still ask for.
 *
 * The order subscription is where the events live, so there is nothing here
 * about them; what is here is the one thing such a process would otherwise
 * have no way to set, and would then be given the error console whether it
 * wanted it or not.
 */
export type QuoteOptions = Pick<SubscribeOptions, "onProblem">;

export interface PricingNamespace {
  /**
   * Answers "how much is this and is it there" for the cards whose price is
   * computed at the moment of purchase.
   *
   * It runs on the same subscription as the orders, so a merchant answering
   * price questions this way hosts nothing.
   */
  onQuote(handler: QuoteHandler, options?: QuoteOptions): Subscription;
}

export interface CoinslotClient {
  readonly catalog: CatalogNamespace;
  readonly orders: OrdersNamespace;
  readonly pricing: PricingNamespace;
}

/**
 * The three codes an order call comes back under when the gateway produced no
 * answer this package can read.
 *
 * The contract's list of error codes is open exactly so that a case nobody
 * anticipated reaches the merchant in its own words instead of being flattened
 * into the nearest of three. These are three of those, and they are produced
 * here rather than on the wire.
 *
 * Three and not one because the difference is the whole of what a merchant
 * needs at that moment, and they are about their own books. A call that never
 * arrived certainly changed nothing. A call answered in words we could not
 * read reached us and may well have done its work; what is missing is what it
 * said. And a call that was sent into silence — the connection broke, the
 * worker was shut down mid-flight — is neither of those, and saying it did not
 * arrive would be inventing the one fact the merchant came here for.
 */
export const CALL_DID_NOT_REACH_US = "call_did_not_reach_us";
export const ANSWER_NOT_UNDERSTOOD = "answer_not_understood";
export const OUTCOME_UNKNOWN = "outcome_unknown";

const CODE_FOR: Readonly<Record<Reach, string>> = {
  [REACH.NOT_RECEIVED]: CALL_DID_NOT_REACH_US,
  [REACH.ANSWERED]: ANSWER_NOT_UNDERSTOOD,
  [REACH.UNKNOWN]: OUTCOME_UNKNOWN,
};

/**
 * Whether calling again could change the outcome, which is what the contract's
 * flag actually asks. It could, in all three cases: none of them is a state of
 * the order, and none will still be true in a minute if a network settled or a
 * proxy went away.
 *
 * The sentence about repeating safely is only added where the contract says
 * the call may be repeated: delivering is idempotent by the order's
 * identifier, and taking an order on happens again on every redelivery.
 * Refusing is documented as neither, so nothing is claimed about it.
 */
const failedCall = (repeatIsSafe: boolean, failure: TransportFailure): OrderCallError => ({
  code: CODE_FOR[failure.reach],
  message: repeatIsSafe
    ? `${whatIsKnown(failure)}: ${failure.reason} — this call may be made again without doing its work twice`
    : `${whatIsKnown(failure)}: ${failure.reason}`,
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
  // The exception goes out beside the sentence rather than inside it. The
  // message already carries what the exception says; what it cannot carry is
  // the stack, and the stack is the whole of what a merchant debugging their
  // own handler is looking for.
  if (problem.cause === undefined) {
    console.error(`[coinslot] ${problem.kind}: ${problem.message}`);
    return;
  }

  console.error(`[coinslot] ${problem.kind}: ${problem.message}`, problem.cause);
};

const keyOf = (apiKey: string | undefined): string => {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TypeError(
      "createClient needs the merchant's API key, and was given none — check that the environment variable holding it is set where this process can read it",
    );
  }

  return apiKey;
};

/**
 * The address as given, checked as far as it can be checked without using it.
 *
 * A value that is not an address is refused at once: it will not become one
 * later, and the line that produced it is the line to fix. An address that was
 * not given at all is a different matter, and it is kept as the sentence that
 * will be raised by the first call that needs it — see `baseUrl` above.
 */
const addressOf = (baseUrl: string | undefined): string => {
  if (baseUrl === undefined) return "";

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

export const createClient = (options: ClientOptions): CoinslotClient => {
  const gateway: Gateway = {
    apiKey: keyOf(options.apiKey),
    baseUrl: addressOf(options.baseUrl),
  };

  const reachable = (): void => {
    if (gateway.baseUrl === "") {
      throw new TypeError(
        "this client has no gateway address: pass baseUrl to createClient. There is no default — where the gateway lives is not settled yet, and this package will not invent a hostname",
      );
    }
  };

  /**
   * One subscription, with the loop behind it and the handlers it dispatches
   * to.
   *
   * Each subscription owns its own registry rather than sharing one with the
   * client, and that is the point rather than tidiness. A shared registry
   * means the reporter a merchant passed is one field that every loop reads at
   * the moment it reports — so the problems of a subscription that is winding
   * down arrive at the reporter of the one that replaced it, describing orders
   * that subscription never saw, while the merchant who asked to hear about
   * them hears nothing.
   */
  interface Live {
    readonly registry: HandlerRegistry;
    /**
     * The loop, which is the one part of a subscription that can be replaced
     * under it. A loop ends on its own when the gateway turns out to speak
     * another dialect; if a later registration built a whole new subscription
     * around a new loop, the handle the merchant is already holding would stop
     * naming anything — their stop() would return having stopped a loop that
     * was already over while the replacement polled on, and the handlers and
     * the reporter they registered would have been left behind with it.
     */
    worker: RunningWorker;
    readonly subscription: Subscription;
    /** Set once stopping begins, and shared by every caller of stop(). */
    stopping?: Promise<void>;
  }

  let live: Live | undefined;

  const beginStopping = (owned: Live): Promise<void> => {
    // One promise for every caller, so a shutdown routine and a signal handler
    // that both call stop() both wait for the same ending rather than the
    // second one returning at once and letting the process exit with a
    // delivery still in flight.
    owned.stopping ??= owned.worker.stop().then(() => {
      // Only now, and this order is the whole of the fix: the loop reports its
      // last problems — an answer that did not get through, a batch it left
      // unread — while it is stopping, and those go to the reporter this
      // subscription was given. Torn down first, they would go to the console
      // and the merchant would never learn that a delivery went unanswered.
      if (live === owned) live = undefined;
    });

    return owned.stopping;
  };

  const startedSubscription = (): Live => {
    reachable();

    if (live?.stopping !== undefined) {
      throw new TypeError(
        "this client's subscription is being stopped: await that stop() before registering a handler again, or the handler would be registered on a loop that is going away",
      );
    }

    if (live !== undefined) {
      // The subscription is still the merchant's; only its loop ended, and it
      // ended for a reason that has not gone away — a gateway of another
      // dialect is still of another dialect. Starting a loop over the same
      // handlers reports that again, where handing back the dead one would
      // register a handler on something that will never poll and say nothing.
      if (!live.worker.running()) live.worker = startWorker(gateway, live.registry);

      return live;
    }

    const registry: HandlerRegistry = { problem: reportToConsole };
    const started: Live = {
      registry,
      worker: startWorker(gateway, registry),
      subscription: { stop: () => beginStopping(started) },
    };

    live = started;

    return started;
  };

  const orderCall = async (
    route: "deliver_order" | "refuse_order",
    orderId: string,
    body: unknown,
  ): Promise<OrderCallResponse> => {
    reachable();

    const answer = await callRoute(gateway, route, { path: { order_id: orderId }, body });

    return answer.ok
      ? answer.document
      : { ok: false, error: failedCall(route === "deliver_order", answer.failure) };
  };

  const document = async <Name extends "publish_card" | "get_order" | "list_orders">(
    route: Name,
    options_: Parameters<typeof callRoute<Name>>[2],
  ) => {
    reachable();

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
        // Everything that can refuse this call happens before anything is
        // written down, so a call that threw leaves no trace and the same call
        // made again once the address is there succeeds. Registering first and
        // refusing afterwards would tell the second attempt that it had
        // already registered.
        const owned = startedSubscription();

        if (owned.registry.order !== undefined) {
          throw new TypeError(
            "orders.subscribe was called twice on one client: the second handler would silently replace the first, and one order goes to one handler",
          );
        }

        owned.registry.order = handler;
        if (subscribeOptions?.onEvent !== undefined)
          owned.registry.event = subscribeOptions.onEvent;
        if (subscribeOptions?.onProblem !== undefined)
          owned.registry.problem = subscribeOptions.onProblem;

        return owned.subscription;
      },

      deliver: (orderId, delivery) => orderCall("deliver_order", orderId, delivery),

      refuse: (orderId, refusal) => orderCall("refuse_order", orderId, refusal),

      accept: async (orderId, acceptance) => {
        reachable();

        const answer = await callRoute(gateway, "accept_order", {
          path: { order_id: orderId },
          body: acceptance ?? {},
        });

        // Accepting the same order again is ordinary: an order is taken on
        // afresh on every redelivery, so a repeat does no work twice.
        return answer.ok ? answer.document : { ok: false, error: failedCall(true, answer.failure) };
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
      onQuote: (handler, quoteOptions) => {
        const owned = startedSubscription();

        if (owned.registry.quote !== undefined) {
          throw new TypeError(
            "pricing.onQuote was called twice on one client: the second handler would silently replace the first",
          );
        }

        owned.registry.quote = handler;
        if (quoteOptions?.onProblem !== undefined) owned.registry.problem = quoteOptions.onProblem;

        return owned.subscription;
      },
    },
  };
};
