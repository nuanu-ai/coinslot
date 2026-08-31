/**
 * The one loop that carries everything the merchant's process receives.
 *
 * The transport is HTTP long polling against the gateway (ADR-0004): the
 * worker asks for the next batch, the gateway holds the request until
 * something arrives or its own window closes, and the answer is a batch of
 * envelopes or an empty one. An empty batch is the ordinary answer to a quiet
 * window and not a failure. There is one loop and not three, because the
 * stream carries three kinds on one connection and the portal promises the
 * merchant one subscription.
 *
 * How each kind is answered is the part worth reading before changing
 * anything, because the three are answered in three different places and none
 * of them is an acknowledgement of the envelope itself.
 *
 * An order is given to the merchant's handler, and whatever the handler
 * returns is posted to the order's answer route — in every mode, without the
 * merchant asking. In the synchronous mode that return is the whole of the
 * merchant's answer; in the asynchronous one it is usually an acceptance, and
 * the goods follow later through the explicit `deliver` call, which is the
 * merchant's to make and not this loop's.
 *
 * A price question is given to the price handler and the answer goes to the
 * quote route against the `price_id` the question carried.
 *
 * An event is handed over and nothing is sent back. An event notifies, it does
 * not ask for work.
 *
 * What happens when a handler throws is the design decision the rest follows
 * from: nothing is sent. An order nobody answered comes back on its own,
 * because the gateway's own order machine is watching for that answer and
 * decides there should be another attempt — that is the machine's meaning of
 * "not delivered". A retry written on this side would be a second machine with
 * a second opinion about how many times a merchant's handler may run, and the
 * two would disagree the first time one of them restarted. The same holds for a
 * handler that answers with something the contract refuses, and for an envelope
 * that arrives with no handler registered for its kind: the merchant is told
 * through the problem channel, and an order or a price question comes back on
 * its own.
 *
 * An event is the exception and it is worth knowing about. It carries no
 * acknowledgement, so nothing here can ask for one again and nothing on the
 * other side is waiting for a reply to notice that it went unanswered. The
 * contract makes no promise that one is ever sent a second time, and whether a
 * particular gateway sends one anyway is that gateway's business. A handler
 * that throws on an event has lost what it carried.
 *
 * The transport failures are the one thing this loop does retry, because there
 * is nothing else to do with them: a poll that did not reach the gateway
 * delivered no envelope to anybody. That retry is the backoff in
 * `backoff.ts` and nothing more.
 */

import {
  type HandlerAnswer,
  HandlerAnswerSchema,
  type Order,
  type OrderEvent,
  PROTOTYPE_KEY_IS_DROPPED,
  type QuoteRequest,
  type QuoteResponse,
  QuoteResponseSchema,
  type WorkerEnvelope,
  type WorkerEnvelopeKind,
} from "@nuanu-ai/coinslot-contracts";
import { retryDelayMs } from "./backoff.js";
import { contractVersion, speaksContract } from "./contract.js";
import { describeProblems, problemsOf } from "./schema.js";
import { callRoute, type Gateway, REACH, type TransportFailure, whatIsKnown } from "./transport.js";

/**
 * What follows from a failed answer for the order it was about.
 *
 * The three cases are three different things to tell a merchant, and only one
 * of them is a promise. An answer that never left certainly leaves the order
 * unanswered, so it comes back. An answer that reached us, or that vanished
 * into silence, may have closed the order already — saying it will be
 * delivered again would be promising a redelivery we have no grounds to
 * expect, and a merchant who acted on that promise would be waiting for an
 * order that never comes.
 */
const andSoTheOrder = (failure: TransportFailure): string =>
  failure.reach === REACH.NOT_RECEIVED
    ? ", so the order will be delivered again"
    : ", so whether the order is delivered again is not something this side can say";

/**
 * What this loop calls with one paid order off the stream.
 *
 * It is not what a merchant writes. The order a merchant's handler receives
 * carries the calls that close it, and putting those on it is `client.ts`'s
 * job: this loop reads the envelope and knows nothing about a gateway address
 * or an API key beyond the one it polls with. So the client registers a
 * function of this shape which wraps the merchant's own.
 */
export type OrderDispatch = (order: Order) => HandlerAnswer | Promise<HandlerAnswer>;

/** The same, for "how much is this and is it there". */
export type QuoteDispatch = (question: QuoteRequest) => QuoteResponse | Promise<QuoteResponse>;

/**
 * How this delivery of a message is named, for the one kind that needs it.
 *
 * `id` names this message and `sent_at` names when it went out. What the pair is
 * not is a dependable way to recognise a repeat: a gateway sending an order
 * again builds a fresh envelope around it under a fresh `id`, and what holds
 * still across such a repeat is the order's own identifier in the payload.
 */
export interface Delivered {
  readonly id: string;
  readonly sent_at: string;
}

/**
 * What the merchant's code does with something that happened to an order.
 *
 * The second argument is this delivery's own name, and it is the reason this
 * signature is not just the event. An order is answered against its own
 * identifier and a price question against its `price_id`; an event is answered
 * against nothing at all, so this pair is the only thing naming the message
 * itself rather than the order it is about, which is what a log line or a
 * question to us afterwards needs.
 *
 * It is not there to be deduplicated against. Nothing acknowledges an event, so
 * nothing asks for one again, and the contract makes no promise that one is ever
 * sent twice — which means the risk an event handler is written against is a
 * message that never arrives rather than one that arrives twice.
 */
export type EventHandler = (event: OrderEvent, delivered: Delivered) => void | Promise<void>;

/**
 * The things the worker has to tell the merchant about, under the names their
 * code can branch on.
 *
 * They are one vocabulary rather than several channels because every one of
 * them has the same shape of consequence — something did not get through — and
 * a merchant who wants to count them wants to count them together.
 */
export const WORKER_PROBLEM_KINDS = Object.freeze({
  /** The gateway speaks another dialect of the contract. The loop stops. */
  CONTRACT_VERSION_MISMATCH: "contract_version_mismatch",
  /** A poll did not reach the gateway or did not come back as an answer. */
  POLL_FAILED: "poll_failed",
  /** The merchant's handler threw. Nothing was answered and the work returns. */
  HANDLER_FAILED: "handler_failed",
  /** The handler answered with something the contract does not accept. */
  HANDLER_ANSWER_REFUSED: "handler_answer_refused",
  /** Something arrived that nobody had registered a handler for. */
  NO_HANDLER: "no_handler",
  /** The answer was produced and could not be delivered to the gateway. */
  ANSWER_FAILED: "answer_failed",
  /** The gateway would not take the answer: it names an order it cannot close. */
  ANSWER_REFUSED: "answer_refused",
  /** A price answer arrived too late to price the purchase it was asked for. */
  QUOTE_ANSWER_UNUSED: "quote_answer_unused",
  /** The worker stopped part-way through a batch and the rest went unread. */
  BATCH_ABANDONED: "batch_abandoned",
  /** The loop itself failed in a way nothing here anticipated. A defect in this SDK. */
  WORKER_FAILED: "worker_failed",
  /** A delivery carried the one field name this contract removes in silence. */
  DELIVERY_FIELD_DROPPED: "delivery_field_dropped",
} as const);

export type WorkerProblemKind = (typeof WORKER_PROBLEM_KINDS)[keyof typeof WORKER_PROBLEM_KINDS];

export interface WorkerProblem {
  readonly kind: WorkerProblemKind;
  /** What happened, in one sentence a person can act on. */
  readonly message: string;
  /** Whether the loop stopped because of it. */
  readonly fatal: boolean;
  /** The exception behind it, where there was one. */
  readonly cause?: unknown;
  /** The order or the price question it is about, where it is about one. */
  readonly subject?: string;
}

export type ProblemReporter = (problem: WorkerProblem) => void;

/**
 * Calls a merchant's reporter and lets nothing it does escape.
 *
 * Reporting must not be able to end the loop that reports. A merchant's
 * reporter is their code — a logger over a stream that closed during shutdown,
 * a client that was never configured — and an exception out of it would
 * otherwise unwind the worker and, from the worker's own last-resort handler,
 * escape as an unhandled rejection and take the host process down with it.
 * There is nowhere left to report a reporter that throws, so it is swallowed.
 *
 * Both ways of throwing, and the second is the one that hid. A reporter
 * declared `void` may still be an `async` function — TypeScript allows it, and
 * a merchant shipping problems to an HTTP logger will write one — and such a
 * reporter does not throw, it returns a promise that rejects a turn later, past
 * this `catch`, with nothing holding it. That is the unhandled rejection this
 * comment claims not to allow, arriving by the door the `try` does not cover.
 * So what comes back is settled too, and its failure dropped in the same
 * silence and for the same reason.
 *
 * It is at the top of the file rather than inside the loop because the loop is
 * not the only thing that reports: a merchant calling `deliver` on an order
 * directly has a reporter too, and the same reasoning covers it exactly.
 */
export const reportSafely = (reporter: ProblemReporter, problem: WorkerProblem): void => {
  try {
    // Anything with a `then` and not only a real Promise: a reporter built on
    // another library's promise, or one from another realm, fails in exactly
    // the same way and must be settled in exactly the same silence.
    const reporting = reporter(problem) as { then?: unknown } | undefined;

    if (typeof reporting?.then === "function") {
      void Promise.resolve(reporting).catch(() => {});
    }
  } catch {
    // Nowhere to say it. See above.
  }
};

/**
 * The one loss in this contract that nobody is told about, said out loud here
 * because this is the place it would reach the agent.
 *
 * A field named `__proto__` is removed while a delivery is parsed, before any
 * check runs — it is neither carried nor refused, and the merchant's handler
 * has no way to know that what it returned is not what went out. The contracts
 * package names the delivery as the place the loss lands in what the agent is
 * handed — `DeliverySchema` in its `handler.ts` — and a delivery is written
 * here, so this file says it too.
 *
 * No card can declare such a field, so nothing legitimate reaches here; a
 * merchant only meets it by delivering a name nobody asked for.
 *
 * It is one function because there are two roads to the same gateway and the
 * loss is the same on both: the worker answering with what a handler returned,
 * and a merchant calling `deliver` on an order himself. Written twice, one of
 * them would drift or, as it did, never be written at all.
 */
export const droppedFieldWarning = (
  orderId: string,
  delivered: Readonly<Record<string, unknown>> | undefined,
): WorkerProblem | null => {
  if (delivered === undefined || !Object.hasOwn(delivered, PROTOTYPE_KEY_IS_DROPPED)) {
    return null;
  }

  return {
    kind: WORKER_PROBLEM_KINDS.DELIVERY_FIELD_DROPPED,
    fatal: false,
    subject: orderId,
    message: `the delivery for order ${orderId} carried a field named ${PROTOTYPE_KEY_IS_DROPPED}, which is removed before anything can check it: the agent will not receive it, and no card can declare it`,
  };
};

/**
 * Which registration each kind on the stream is answered by, in the word a
 * merchant passes to `on`.
 *
 * This table is the vocabulary, and everything that has to know the stream's
 * kinds is derived from it rather than written out again: what a merchant may
 * register, what the registry holds, what `start` counts as an answer, and the
 * sentence that names a registration a merchant is missing. It is written over
 * the contract's own kinds, so a fourth kind added to the envelope — the
 * confirmation request, whose shape the contract does not carry yet — stops
 * this file compiling until it has a word of its own here. The `switch` in
 * `dispatch` below is the second half of that guard, and it is the one that
 * demands the behaviour.
 */
export const REGISTERED_AS = Object.freeze({
  order: "order",
  quote_request: "quote",
  order_event: "event",
} as const satisfies { readonly [Kind in WorkerEnvelopeKind]: string });

/**
 * The words a merchant registers something on the stream under.
 *
 * Indexed by the table's own keys and not by the contract's kinds, which reads
 * the same today and behaves very differently on the day a fourth kind is
 * added. Indexing by a key the table does not have yet collapses this type, and
 * with it `Handlers[Kind]` and the contextual type of every `coinslot.on(...)`
 * call — so the first compile after the contract grows reports sixty errors, of
 * which fifty-five are implicit-any at call sites that are not the problem, and
 * the three places that do need a hand are buried among them. Indexed this way
 * that same compile names two places, both real.
 *
 * Completeness is not what was lost: the `satisfies` clause on the table above
 * is what demands a word per contract kind, and it still fires.
 */
export type StreamHandlerKind = (typeof REGISTERED_AS)[keyof typeof REGISTERED_AS];

/** What answers each of them, in the shape this loop calls. */
export interface StreamDispatch {
  order: OrderDispatch;
  quote: QuoteDispatch;
  event: EventHandler;
}

/**
 * The handlers the loop dispatches to, read at the moment an envelope is
 * handled rather than captured when the loop starts.
 *
 * The registry belongs to the client and outlives any one loop. A merchant
 * registers what their process answers, starts, stops, and starts again on the
 * same handlers — and a handler registered while a loop is already running is
 * in place for the next envelope rather than for the next loop.
 */
export type HandlerRegistry = {
  [Kind in StreamHandlerKind]?: StreamDispatch[Kind] | undefined;
} & {
  problem: ProblemReporter;
};

/**
 * Time, as the loop sees it.
 *
 * A seam rather than a call to `setTimeout` in the middle of the loop, so that
 * a test can assert which delays were asked for without waiting through them.
 * It is not part of the published surface: a merchant has no business
 * replacing the clock their worker runs on.
 */
export interface WorkerClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export const systemClock: WorkerClock = {
  // Monotonic rather than the wall clock. The only thing this clock is asked
  // is how long something took, and a wall clock stepped backwards by an hour
  // — which is what a machine does when it corrects its time — would turn that
  // question into an hour-long sleep.
  now: () => performance.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * The shortest a quiet poll may take before the next one.
 *
 * The gateway holds a poll open for its own window, so in ordinary work this
 * costs nothing: by the time an empty batch comes back, the floor has long
 * passed and the next poll goes out at once — which is what keeps a waiting
 * agent's price question free of any polling lag (ADR-0004 §4). It exists for
 * the gateway that is not holding requests at all, misconfigured or half
 * broken, where a loop with no floor turns into as many requests a second as
 * the network allows. One second is the whole of the claim: slow enough that
 * nothing is hammered, fast enough that it is invisible against a window
 * measured in tens of seconds.
 */
export const QUIET_POLL_FLOOR_MS = 1_000;

/**
 * The contract version named inside something the SDK could not parse.
 *
 * A gateway that added an envelope kind, or a field, answers with a document
 * this SDK refuses, and the version it names is the one thing still readable
 * in what it sent. It goes into the sentence the merchant reads and no
 * further: this body was held to no schema of ours, so a proxy's error
 * envelope that happens to carry a field of that name must not be able to stop
 * a worker. One field is read, and only when it is a string; anything else is
 * a body with nothing to say about versions.
 */
const versionSpokenIn = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;

  const named = (body as { contract_version?: unknown }).contract_version;

  return typeof named === "string" && named !== "" ? named : undefined;
};

/** Refuses to compile if a kind is added to the contract and not handled here. */
const assertEveryKindIsHandled = (envelope: never): never => {
  throw new TypeError(
    `the worker was handed an envelope of a kind it does not know: ${JSON.stringify(envelope)}`,
  );
};

/**
 * How long the worker asks the gateway to hold a poll open, per ADR-0004 §1.
 *
 * It is a request and not an expectation. The gateway holds it for its own
 * window at most, and the contract says as much, so a shorter answer is
 * ordinary rather than a fault. Asking is what makes the number visible on the
 * wire, where a gateway that wanted to answer sooner can see it.
 */
export const POLL_WAIT_SECONDS = 25;

/**
 * How long the worker will wait for a poll before giving up on it.
 *
 * A window asked for is not a promise kept: a connection dropped silently by
 * something in the middle — a load balancer that recycled it, a firewall that
 * forgot it — leaves this side waiting on an answer that will never come, with
 * nothing reported and nothing retried. Without a deadline of our own the only
 * thing that eventually breaks that is whatever timeout the runtime happens to
 * default to, which is a number nobody here chose and which is measured in
 * minutes against a window measured in seconds.
 *
 * Twice the window, so a gateway that holds the full window and answers late is
 * never cut off, and a connection that has gone quiet costs one window of
 * silence rather than several minutes of it.
 *
 * This worker never comes near it against the gateway in this repository, and
 * that is not luck: every poll names the window it wants, and that gateway
 * holds a poll for the smaller of the window asked for and its own, so the wait
 * is bounded by the twenty-five seconds above however the gateway is
 * configured. Naming the window is this side's guarantee. The deadline is for
 * the other case — a connection that died without saying so.
 *
 * A second belt exists on the gateway's side, and it is not for this worker.
 * The window is optional on the wire, and a poll that names none is held for
 * the gateway's whole configured window instead; that window is refused above a
 * ceiling set under this number (`WORKER_POLL_WAIT_CEILING_MS` in
 * `apps/gateway/src/config.ts`), which is where this figure is copied. The
 * gateway depends on the contracts and the core machine rather than on the SDK,
 * so it cannot read it, and nothing checks that the copy still matches:
 * changing what is written here means changing it there in the same breath.
 *
 * It is also the reason two poll failures can be a minute and a half apart,
 * which matters to anybody counting them from outside. A gateway that refuses
 * connections fails a poll at once and the backoff is the whole gap; one that
 * accepts and never answers fails only when this deadline runs out, so the gap
 * is this plus the backoff. `DOUBT_MS` in packages/slice/src/subscription.ts is
 * that sum, and it is named here because raising this number silently narrows
 * it — and a window too narrow reads the quiet between two failures as a
 * recovery.
 */
export const POLL_DEADLINE_MS = POLL_WAIT_SECONDS * 2 * 1_000;

/** What `startWorker` hands its caller, which is the client and never a merchant. */
export interface RunningWorker {
  /**
   * Stops the loop and waits for it to finish. Safe to call twice.
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
   */
  stop(): Promise<void>;
  /** Whether the loop is still going. False once it has stopped for any reason. */
  running(): boolean;
}

export const startWorker = (
  gateway: Gateway,
  handlers: HandlerRegistry,
  clock: WorkerClock = systemClock,
  /**
   * The deadline is a parameter for the same reason the clock is: a test
   * cannot wait out fifty seconds to find out whether the worker gives up on a
   * poll, and a deadline nothing exercises is a deadline nobody has seen work.
   * It is not part of anything a merchant passes.
   */
  deadlineMs: number = POLL_DEADLINE_MS,
): RunningWorker => {
  const controller = new AbortController();
  let stopping = false;
  let ended = false;

  const report = (problem: WorkerProblem): void => reportSafely(handlers.problem, problem);

  const rest = async (ms: number): Promise<void> => {
    if (ms > 0) await clock.sleep(ms, controller.signal);
  };

  const reportTheMismatch = (spoken: string): void => {
    report({
      kind: WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH,
      fatal: true,
      // Both numbers are in the sentence: a merchant reading only one of them
      // cannot tell which of the two ends needs upgrading.
      message: `the gateway speaks contract version ${spoken} and this SDK speaks ${contractVersion}; the worker stopped rather than handle orders in a dialect it may be reading wrong`,
    });
  };

  const answerOrder = async (order: Order, answer: HandlerAnswer): Promise<void> => {
    const sent = await callRoute(gateway, "answer_order", {
      path: { order_id: order.id },
      body: answer,
      signal: controller.signal,
    });

    if (!sent.ok) {
      // Reported even when the worker is stopping, and especially then. The
      // handler has already run: goods may have been issued, and a merchant
      // reconciling a shutdown is entitled to know that an answer for this
      // order went nowhere.
      report({
        kind: WORKER_PROBLEM_KINDS.ANSWER_FAILED,
        fatal: false,
        subject: order.id,
        message: `the answer for order ${order.id} was produced and ${whatIsKnown(sent.failure)}${andSoTheOrder(sent.failure)}: ${sent.failure.reason}`,
      });
      return;
    }

    if (!sent.document.ok) {
      report({
        kind: WORKER_PROBLEM_KINDS.ANSWER_REFUSED,
        fatal: false,
        subject: order.id,
        message: `the answer for order ${order.id} was not accepted (${sent.document.error.code}): ${sent.document.error.message}`,
      });
    }
  };

  /** See `droppedFieldWarning`: the same loss, on the handler's road. */
  const warnAboutTheDroppedKey = (order: Order, answer: HandlerAnswer): void => {
    const dropped = droppedFieldWarning(
      order.id,
      "delivered" in answer ? answer.delivered : undefined,
    );

    if (dropped !== null) report(dropped);
  };

  const handleOrder = async (order: Order): Promise<void> => {
    const handler = handlers.order;

    if (handler === undefined) {
      report({
        kind: WORKER_PROBLEM_KINDS.NO_HANDLER,
        fatal: false,
        subject: order.id,
        message: `order ${order.id} arrived and no handler was registered with on('${REGISTERED_AS.order}'), so it was left unanswered and will be delivered again`,
      });
      return;
    }

    let answer: HandlerAnswer;

    try {
      answer = await handler(order);
    } catch (cause) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_FAILED,
        fatal: false,
        cause,
        subject: order.id,
        message: `the handler threw on order ${order.id}, so nothing was answered and the order will be delivered again: ${String(cause)}`,
      });
      return;
    }

    const checked = HandlerAnswerSchema.safeParse(answer);

    if (!checked.success) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED,
        fatal: false,
        subject: order.id,
        message: `the handler's answer for order ${order.id} is not one the contract carries, so nothing was sent and the order will be delivered again:\n${describeProblems(problemsOf(checked.error.issues))}`,
      });
      return;
    }

    warnAboutTheDroppedKey(order, answer);

    await answerOrder(order, checked.data);
  };

  const handleQuote = async (question: QuoteRequest): Promise<void> => {
    const handler = handlers.quote;

    if (handler === undefined) {
      report({
        kind: WORKER_PROBLEM_KINDS.NO_HANDLER,
        fatal: false,
        subject: question.price_id,
        message: `a price question for ${question.merchant_item_id} arrived and no handler was registered with on('${REGISTERED_AS.quote_request}'), so it was left unanswered`,
      });
      return;
    }

    let answer: QuoteResponse;

    try {
      answer = await handler(question);
    } catch (cause) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_FAILED,
        fatal: false,
        cause,
        subject: question.price_id,
        message: `the price handler threw on question ${question.price_id}, so no price was sent and the sale goes on the card's own price or does not go on at all: ${String(cause)}`,
      });
      return;
    }

    // Held to the contract before it is sent, for the same reason an order's
    // answer is: an amount written as a number instead of text is the easiest
    // mistake there is to make here, and sent out it would come back as the
    // gateway's complaint about a document, which reads as our fault and
    // names the merchant's field only inside a quoted blob.
    const checked = QuoteResponseSchema.safeParse(answer);

    if (!checked.success) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED,
        fatal: false,
        subject: question.price_id,
        message: `the price handler's answer for question ${question.price_id} is not one the contract carries, so no price was sent:\n${describeProblems(problemsOf(checked.error.issues))}`,
      });
      return;
    }

    const sent = await callRoute(gateway, "answer_quote", {
      path: { price_id: question.price_id },
      body: checked.data,
      signal: controller.signal,
    });

    if (!sent.ok) {
      report({
        kind: WORKER_PROBLEM_KINDS.ANSWER_FAILED,
        fatal: false,
        subject: question.price_id,
        // The advice about stock holds whichever of the three this was, which
        // is why it is not branched the way an order's consequence is. A price
        // that did arrive and was used produces an order before the question
        // expires, and a merchant releasing stock at that moment is releasing
        // stock they have already committed to an order they hold.
        message: `the price for question ${question.price_id} was answered and ${whatIsKnown(sent.failure)}; stock set aside under that identifier can be released once the question expires, whichever of those it was: ${sent.failure.reason}`,
      });
      return;
    }

    if (!sent.document.used) {
      report({
        kind: WORKER_PROBLEM_KINDS.QUOTE_ANSWER_UNUSED,
        fatal: false,
        subject: question.price_id,
        message: `the price for question ${question.price_id} arrived too late to be used, or the question is no longer held; stock set aside under that identifier can be released`,
      });
    }
  };

  const handleEvent = async (event: OrderEvent, delivered: Delivered): Promise<void> => {
    const handler = handlers.event;

    if (handler === undefined) {
      report({
        kind: WORKER_PROBLEM_KINDS.NO_HANDLER,
        fatal: false,
        subject: event.order_id,
        message: `${event.type} arrived for order ${event.order_id} and nothing is listening for events; register one with on('${REGISTERED_AS.order_event}') to receive them`,
      });
      return;
    }

    try {
      await handler(event, delivered);
    } catch (cause) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_FAILED,
        fatal: false,
        cause,
        subject: event.order_id,
        // Nothing here can ask for the event again — an event carries no
        // acknowledgement, so there is no call that says "send that one
        // once more". Whether the gateway sends it again anyway is the
        // gateway's, and this SDK does not know: the contract gives every
        // envelope an identifier and a delivery time precisely so that a
        // repeat can be recognised, which only means something if repeats
        // happen. So the honest thing to tell a merchant is that we cannot
        // get it back, not that it is gone.
        message: `the event handler threw on ${event.type} for order ${event.order_id}; nothing here can ask for that event again, and whether it is sent again is not something this SDK knows: ${String(cause)}`,
      });
    }
  };

  const dispatch = async (envelope: WorkerEnvelope): Promise<void> => {
    switch (envelope.kind) {
      case "order":
        await handleOrder(envelope.payload);
        return;
      case "quote_request":
        await handleQuote(envelope.payload);
        return;
      case "order_event":
        await handleEvent(envelope.payload, { id: envelope.id, sent_at: envelope.sent_at });
        return;
      default:
        // Unreachable while the contract carries three kinds, and here so
        // that a fourth added there stops this file compiling rather than
        // being dropped in silence by a switch with nothing to say about it.
        return assertEveryKindIsHandled(envelope);
    }
  };

  const run = async (): Promise<void> => {
    // One turn before the first poll goes out, so that a process which calls
    // start() without awaiting it and registers on the next line has that
    // registration in place before anything is asked of the gateway. A
    // handler registered later than that is in place too — the registry is
    // read when an envelope is dispatched, not when the loop begins — so this
    // buys only the synchronous lines immediately after the call, which is
    // exactly where a merchant writes them.
    await Promise.resolve();

    let failures = 0;

    while (!stopping) {
      const startedAt = clock.now();
      const answer = await callRoute(gateway, "poll_worker", {
        body: { wait_seconds: POLL_WAIT_SECONDS },
        // Two ways this call can end early, and they are different: the worker
        // was stopped, or the answer took longer than any answer should.
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs)]),
      });

      if (stopping) break;

      if (!answer.ok) {
        // A gateway of another dialect answers with a document this SDK cannot
        // parse, so the version it names is worth passing on — but only as a
        // remark, never as a verdict. Whatever this field was read out of was
        // not held to any schema of ours: a proxy's error envelope carrying a
        // field of that name would otherwise stop a merchant's worker for
        // good over something that needed waiting out. The one place a
        // mismatch is decided is a poll answer that parsed.
        const spoken = versionSpokenIn(answer.failure.body);
        const remark =
          spoken !== undefined && !speaksContract(spoken)
            ? ` — what answered names contract version ${spoken} while this SDK speaks ${contractVersion}, which may mean the gateway is of another version`
            : "";

        failures += 1;
        report({
          kind: WORKER_PROBLEM_KINDS.POLL_FAILED,
          fatal: false,
          message: `${answer.failure.reason}${remark} — asking again after a wait`,
        });
        await rest(retryDelayMs(failures, clock.random()));
        continue;
      }

      failures = 0;

      if (!speaksContract(answer.document.contract_version)) {
        reportTheMismatch(answer.document.contract_version);
        return;
      }

      const batch = answer.document.envelopes;
      let handled = 0;

      for (const envelope of batch) {
        if (stopping) break;
        await dispatch(envelope);
        handled += 1;
      }

      if (handled < batch.length) {
        // Said rather than left as a silence. An order or a price question
        // left in the batch comes back on its own; an event carries no
        // acknowledgement, so nothing here can ask for that one again, and a
        // merchant who stopped a worker mid-batch is entitled to know which
        // kinds went unread.
        report({
          kind: WORKER_PROBLEM_KINDS.BATCH_ABANDONED,
          fatal: false,
          message: `the worker stopped with ${batch.length - handled} of this batch's ${batch.length} messages unread (${batch
            .slice(handled)
            .map((envelope) => envelope.kind)
            .join(
              ", ",
            )}); orders and price questions come back on their own, and nothing here can ask for an event again`,
        });
      }

      if (batch.length === 0) {
        await rest(QUIET_POLL_FLOOR_MS - (clock.now() - startedAt));
      }
    }
  };

  const finished = run()
    .catch((cause: unknown) => {
      // Under its own name rather than as a failed poll, because nothing about
      // a poll failed: everything the loop expects to go wrong is handled
      // inside it, so reaching here means this SDK has a defect and the
      // merchant's worker is down until their process is restarted.
      report({
        kind: WORKER_PROBLEM_KINDS.WORKER_FAILED,
        fatal: true,
        cause,
        message: `the worker stopped on an error it did not expect, which is a defect in the Coinslot SDK rather than something the gateway did: ${String(cause)}`,
      });
    })
    .finally(() => {
      // However the loop ended — stopped, or fatally — it is over, and both
      // this worker and whoever is holding it should agree about that.
      ended = true;
      stopping = true;
    });

  return {
    running: () => !ended,
    stop: async () => {
      stopping = true;
      controller.abort();
      await finished;
    },
  };
};
