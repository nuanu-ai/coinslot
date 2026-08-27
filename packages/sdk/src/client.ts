/**
 * The client a merchant's engineer holds: a catalog, an order desk, and one
 * place to say what this process answers.
 *
 * The shape of it is the portal's, not this file's. Every method here exists
 * because a page of the documentation tells a merchant to call it, with the
 * arguments that page passes and answering with what that page reads — and the
 * examples on those pages are compiled against these types by a test, so the
 * code a merchant copies out of the documentation is code that builds.
 *
 * Three kinds travel one stream, so there is one way to register a handler for
 * one of them — `on(kind, handler)` — and one lifecycle, `start` and `stop`,
 * for the loop that carries all three. What a handler receives carries the
 * calls that answer it, and that is the part worth reading before changing
 * anything here, because two things that look alike are deliberately not.
 *
 * `order.delivered(...)`, `order.refused(...)` and `order.accepted(...)`
 * build the answer and send nothing; the handler still returns it. A bot
 * library lets a handler reply and forget, and forgetting there costs a
 * message; forgetting here is an order nobody answered — redelivered, a
 * delivery attempt spent, and in the asynchronous mode a debt to a buyer at
 * the end of it. Returning the answer is what makes forgetting impossible and
 * answering twice impossible.
 *
 * `order.deliver(...)`, `order.refuse(...)` and `order.accept(...)` are the
 * other thing: they send. They are the asynchronous merchant's closure verbs,
 * made hours later and from anywhere in their code, and they exist on the
 * order rather than beside it so that a merchant never holds an identifier of
 * ours. The same calls are on every order this client hands back — off the
 * stream, off `orders.get`, off `orders.list` — because a process that
 * restarted has no object left to hold, and that is exactly the moment
 * juggling identifiers would come back.
 *
 * One rule runs through the whole surface and it is worth stating once. What
 * the contract gives a call a failure branch for is returned, never thrown: a
 * card that was not accepted comes back as its findings, and an order call
 * that did not go through comes back as an error with a flag saying whether
 * repeating it could help. A merchant's integration code is expected to read
 * those and branch on them. What is thrown is what has no branch to be read
 * on: a client built wrong, a handler registered twice, and a call that
 * produced no answer of the kind the route promises where the route has
 * nowhere to put one.
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
  HandlerAnswer,
  Money,
  Order,
  OrderAcceptResponse,
  OrderCallError,
  OrderCallResponse,
  OrderWithStatus,
  PublishResult,
  QuoteRequest,
  QuoteResponse,
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
  type ProblemReporter,
  type RunningWorker,
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

/**
 * The calls every order carries, wherever the merchant got it from.
 *
 * The first three build an answer and send nothing: they are what a handler
 * returns, and the return is what this SDK posts. The last three send, and
 * they are the calls an asynchronous merchant makes later — after the supplier
 * answered, from another part of their code, from another process life.
 *
 * There are three of each because the two halves are not the same set of
 * choices seen twice. A synchronous handler chooses between delivering and
 * refusing on the spot; an asynchronous one accepts and then, eventually,
 * delivers or refuses. Accepting from outside a handler exists for the
 * merchant who decides later, in another part of their code.
 */
export interface OrderCalls {
  /** The goods, as the handler's answer. Building one sends nothing. */
  delivered(delivery: Delivery): HandlerAnswer;

  /** A final "this cannot be delivered", as the handler's answer. */
  refused(refusal: Refusal): HandlerAnswer;

  /**
   * Taking the order on without delivering yet, as the handler's answer. An
   * empty acceptance is a complete answer; the expected time is said where it
   * is known.
   */
  accepted(acceptance?: Acceptance): HandlerAnswer;

  /**
   * The goods for an order taken on earlier. Idempotent by the order's own
   * identifier, so repeating it after a dropped connection does no work twice.
   */
  deliver(delivery: Delivery): Promise<OrderCallResponse>;

  /** A final "this cannot be delivered" for an order already taken on. */
  refuse(refusal: Refusal): Promise<OrderCallResponse>;

  /** Takes the order on from outside a handler. Repeats are ordinary. */
  accept(acceptance?: Acceptance): Promise<OrderAcceptResponse>;
}

/**
 * The least an order can be and still be answerable: its identifier, and the
 * calls that close it.
 *
 * It is what `orders.forId` hands back, and it is the shape a merchant's own
 * function should take when all it does is close an order — every richer order
 * below satisfies it.
 */
export type OrderHandle = { readonly id: string } & OrderCalls;

/**
 * An order off the stream, with the calls that close it.
 *
 * "Live" is the whole of the difference from the plain document: this object
 * holds the client that produced it, so it can call home on its own and the
 * merchant never writes an identifier of ours as an argument.
 */
export type LiveOrder = Order & OrderCalls;

/** The same, read back from our record, so it also says where the order stands. */
export type LiveOrderWithStatus = OrderWithStatus & OrderCalls;

/**
 * The two answers a price question has, built from the question itself.
 *
 * `as_of` is what separates "I went and looked" from "here is what was in the
 * cache", and the gateway reads it to decide how far it trusts the answer. Left
 * out, it is the moment the answer is built — which is the truth for a price
 * computed on the spot, and is why a merchant answering from a cache passes the
 * moment that cache was filled instead.
 */
export interface QuoteCalls {
  available(price: Money, asOf?: string): QuoteResponse;
  unavailable(asOf?: string): QuoteResponse;
}

/** A price question, with the two answers it can be given. */
export type LiveQuoteRequest = QuoteRequest & QuoteCalls;

/** What the merchant's code does with one paid order. */
export type OrderHandler = (order: LiveOrder) => HandlerAnswer | Promise<HandlerAnswer>;

/** What the merchant's code answers to "how much is this and is it there". */
export type QuoteHandler = (question: LiveQuoteRequest) => QuoteResponse | Promise<QuoteResponse>;

/**
 * Everything a merchant's process can be asked to answer, by the word they
 * register it under.
 *
 * A map rather than four methods, because the stream is one stream and this is
 * the list of what travels on it. The day the contract carries a fourth kind —
 * the confirmation request, whose shape it does not carry yet — that kind is
 * an entry here and an arm in the worker's dispatch, and nothing else about
 * this surface moves.
 *
 * `problem` is on the same list although nothing on the wire carries it. It is
 * one registration per process, exactly like the other three, and a second
 * place to register one of four things would put back the split this surface
 * exists to remove.
 */
export interface Handlers {
  order: OrderHandler;
  quote: QuoteHandler;
  event: EventHandler;
  problem: ProblemReporter;
}

export type HandlerKind = keyof Handlers;

/**
 * The words `on` accepts, as a map over the handlers themselves.
 *
 * A merchant working outside TypeScript, or one who wrote `orders`, would
 * otherwise register a handler that is never called and hear nothing about it.
 * Written as a mapped type so that a kind added to `Handlers` and forgotten
 * here stops this file compiling.
 */
const HANDLER_KINDS: { readonly [Kind in HandlerKind]: true } = Object.freeze({
  order: true,
  quote: true,
  event: true,
  problem: true,
});

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
   * The calls for an order named by its identifier, without asking us
   * anything.
   *
   * This is the one place an identifier of ours is written by a merchant, and
   * it is here for the process that kept nothing else: a job queued against
   * our identifier, a row in their own database. It reaches no gateway, which
   * is the point — `get` below would tell them more about the order, and
   * during an outage it cannot tell them anything at all, while a delivery
   * that comes back as "the network failed, call again" is exactly the answer
   * they need to keep retrying.
   */
  forId(orderId: string): OrderHandle;

  /**
   * One order and the state it is in, with the calls that close it.
   *
   * A round trip, and what it buys is the order itself: its parameters, what
   * it was sold for, and where it stands.
   */
  get(orderId: string): Promise<LiveOrderWithStatus>;

  /**
   * Orders and the states they are in; with `open`, only those still owed
   * something.
   *
   * The list is what a process reads after a restart: every order it still
   * owes a delivery for, each one able to be delivered or refused on the spot.
   */
  list(query?: { readonly open?: boolean }): Promise<readonly LiveOrderWithStatus[]>;
}

export interface CoinslotClient {
  readonly catalog: CatalogNamespace;
  readonly orders: OrdersNamespace;

  /**
   * Registers what this process answers for one kind.
   *
   * Once per kind: a second registration is refused rather than replacing the
   * first, because one message goes to one handler and a silently replaced
   * handler is a process that has stopped answering without saying so.
   *
   * Handlers may be registered before or after `start`; the loop reads them
   * when an envelope arrives, not when it begins.
   */
  on<Kind extends HandlerKind>(kind: Kind, handler: Handlers[Kind]): void;

  /**
   * Opens the subscription and returns once it is running.
   *
   * The subscription is outgoing — this side opens it, and nothing of the
   * merchant's has to be reachable from outside. It carries the orders, the
   * price questions and the order events together, so a process needs one of
   * these and not three.
   */
  start(): Promise<void>;

  /**
   * Stops the subscription and waits for it to finish. Safe to call twice, and
   * safe to call on a client that was never started.
   *
   * Two things are abandoned rather than finished, and they are not abandoned
   * on the same terms. A poll parked at the gateway is dropped, and whatever
   * it would have carried was never handed to anybody, so it is redelivered.
   * An answer already on its way — a delivery the handler produced a moment
   * ago — is dropped too, and there the honest thing to say is that nobody on
   * this side knows whether it arrived first: the order may already be closed
   * by it, or may come back. The merchant is told which of their orders that
   * happened to, because on their side the work happened.
   *
   * Stopping does not drain. The contract has a word for a poll that asks for
   * whatever is queued right now and comes straight back, and it is not what a
   * worker shutting down wants: draining pulls more work into a process that
   * is going away.
   *
   * The handlers survive it. A supervisor that stops a client and starts it
   * again is running the same process, and having to register everything a
   * second time would be a second place for the two to disagree.
   */
  stop(): Promise<void>;
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
 * The reporter a client gets when the merchant registered none.
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

/** Refuses to compile if a kind is added to `Handlers` and not registered here. */
const assertEveryKindIsRegistered = (kind: never): never => {
  throw new TypeError(`on() has no place to put a handler for ${JSON.stringify(kind)}`);
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
   * The handlers, and the loop that dispatches to them.
   *
   * The registry belongs to the client and not to any one loop, which is what
   * lets a merchant stop and start again on the handlers they already
   * registered. `worker` is the loop currently running, if one is; it also
   * ends on its own when the gateway turns out to speak another dialect, which
   * is why every reader asks it whether it is still running rather than
   * assuming that a worker that exists is a worker that polls.
   */
  const registry: HandlerRegistry = { problem: reportToConsole };
  const registered = new Set<HandlerKind>();
  let worker: RunningWorker | undefined;
  /** Set while a stop is in flight, and shared by every caller of stop(). */
  let stopping: Promise<void> | undefined;

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

  const acceptCall = async (
    orderId: string,
    acceptance: Acceptance | undefined,
  ): Promise<OrderAcceptResponse> => {
    reachable();

    const answer = await callRoute(gateway, "accept_order", {
      path: { order_id: orderId },
      body: acceptance ?? {},
    });

    // Accepting the same order again is ordinary: an order is taken on afresh
    // on every redelivery, so a repeat does no work twice.
    return answer.ok ? answer.document : { ok: false, error: failedCall(true, answer.failure) };
  };

  /**
   * The calls one order answers to, closed over that order's identifier and
   * over this client.
   *
   * This closure is the whole mechanism. The identifier is captured here, once,
   * at the moment the order was read — off the stream or out of our record —
   * and never travels back through a merchant's hands, where it could be the
   * wrong string. What holds the client is the same closure: `orderCall` and
   * `acceptCall` above are this client's, so an order kept in a merchant's map
   * for four hours still knows which gateway to call and with whose key.
   */
  const callsFor = (orderId: string): OrderCalls => ({
    delivered: (delivery) => ({ delivered: delivery }),
    refused: (refusal) => ({ refused: refusal }),
    accepted: (acceptance) => ({ accepted: acceptance ?? {} }),
    deliver: (delivery) => orderCall("deliver_order", orderId, delivery),
    refuse: (refusal) => orderCall("refuse_order", orderId, refusal),
    accept: (acceptance) => acceptCall(orderId, acceptance),
  });

  const withCalls = <Shape extends Order>(order: Shape): Shape & OrderCalls =>
    Object.assign({}, order, callsFor(order.id));

  const askedWithAnswers = (question: QuoteRequest): LiveQuoteRequest =>
    Object.assign({}, question, {
      available: (price: Money, asOf?: string): QuoteResponse => ({
        available: true,
        price,
        as_of: asOf ?? new Date().toISOString(),
      }),
      unavailable: (asOf?: string): QuoteResponse => ({
        available: false,
        as_of: asOf ?? new Date().toISOString(),
      }),
    });

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
      forId: (orderId) => ({ id: orderId, ...callsFor(orderId) }),

      get: async (orderId) =>
        withCalls(await document("get_order", { path: { order_id: orderId } })),

      list: async (query) => {
        const listed = await document("list_orders", {
          // The wire carries the two words rather than a boolean, because a
          // query string carries text. The merchant writes the boolean their
          // language has and this is where the two meet.
          query: query?.open === undefined ? {} : { open: query.open ? "true" : "false" },
        });

        return listed.orders.map((order) => withCalls(order));
      },
    },

    on(kind, handler) {
      if (!Object.hasOwn(HANDLER_KINDS, kind)) {
        throw new TypeError(
          `on() was given ${JSON.stringify(kind)}, which is not a kind this stream carries: the kinds are ${Object.keys(
            HANDLER_KINDS,
          )
            .map((known) => `'${known}'`)
            .join(", ")}`,
        );
      }

      if (registered.has(kind)) {
        throw new TypeError(
          `on('${kind}') was called twice on one client: the second handler would silently replace the first, and one message goes to one handler`,
        );
      }

      // Narrowed off the generic so that the switch below is exhaustive over
      // the kinds rather than over whatever this call was instantiated with.
      const which: HandlerKind = kind;

      switch (which) {
        case "order": {
          // The merchant's handler is wrapped rather than registered as it
          // stands: the loop reads a plain order off the envelope, and the
          // calls that close it are this client's to attach.
          const answering = handler as Handlers["order"];

          registry.order = (arrived) => answering(withCalls(arrived));
          break;
        }
        case "quote": {
          const answering = handler as Handlers["quote"];

          registry.quote = (asked) => answering(askedWithAnswers(asked));
          break;
        }
        case "event": {
          registry.event = handler as Handlers["event"];
          break;
        }
        case "problem": {
          registry.problem = handler as Handlers["problem"];
          break;
        }
        default:
          return assertEveryKindIsRegistered(which);
      }

      // Written down only once everything that could refuse this call has
      // passed, so a call that threw leaves no trace and the same call made
      // again succeeds.
      registered.add(which);
    },

    start: async () => {
      reachable();

      if (stopping !== undefined) {
        throw new TypeError(
          "this client is being stopped: await that stop() before starting it again, or the loop being started would be racing the one going away",
        );
      }

      if (worker?.running() === true) {
        throw new TypeError(
          "this client is already started: a second loop would open a second long poll for one merchant, and an envelope handed to one of them is not handed to the other",
        );
      }

      if (
        registry.order === undefined &&
        registry.quote === undefined &&
        registry.event === undefined
      ) {
        throw new TypeError(
          "this client has nothing registered to answer with: register at least one of on('order'), on('quote') or on('event') before start(), or the loop would take work off the queue that nobody answers",
        );
      }

      worker = startWorker(gateway, registry);
    },

    stop: async () => {
      const owned = worker;

      // A client that was never started has nothing to stop, and saying so by
      // returning is what lets a shutdown routine call this unconditionally.
      if (owned === undefined) return;

      // One promise for every caller, so a shutdown routine and a signal
      // handler that both call stop() both wait for the same ending rather
      // than the second one returning at once and letting the process exit
      // with a delivery still in flight.
      stopping ??= owned.stop().finally(() => {
        if (worker === owned) worker = undefined;
        stopping = undefined;
      });

      await stopping;
    },
  };
};
