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
 * from: nothing is sent. Delivery is at least once with redelivery on the
 * gateway's visibility timeout, so an envelope nobody answered comes back on
 * its own, and that is the machine's own meaning of "not delivered". A retry
 * written on this side would be a second machine with a second opinion about
 * how many times a merchant's handler may run, and the two would disagree the
 * first time one of them restarted. The same holds for a handler that answers
 * with something the contract refuses, and for an envelope that arrives with
 * no handler registered for its kind: the merchant is told through the problem
 * channel, and an order or a price question comes back on its own. An event is
 * the exception and it is worth knowing about — it carries no acknowledgement,
 * so nothing here can ask for one again, and whether the gateway sends it a
 * second time is the gateway's business and not something this SDK knows.
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
} from "@coinslot/contracts";
import { retryDelayMs } from "./backoff.js";
import { contractVersion, speaksContract } from "./contract.js";
import { describeProblems, problemsOf } from "./schema.js";
import { callRoute, type Gateway } from "./transport.js";

/** What the merchant's code does with one paid order. */
export type OrderHandler = (order: Order) => HandlerAnswer | Promise<HandlerAnswer>;

/** What the merchant's code answers to "how much is this and is it there". */
export type QuoteHandler = (question: QuoteRequest) => QuoteResponse | Promise<QuoteResponse>;

/** What the merchant's code does with something that happened to an order. */
export type EventHandler = (event: OrderEvent) => void | Promise<void>;

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
 * The handlers the loop dispatches to, read at the moment an envelope is
 * handled rather than captured when the loop starts.
 *
 * That is what lets a merchant write `orders.subscribe(...)` and
 * `pricing.onQuote(...)` on two consecutive lines: the second registration is
 * in place before the first envelope can be dispatched, and the loop does not
 * have to be built twice or started twice.
 */
export interface HandlerRegistry {
  order?: OrderHandler | undefined;
  quote?: QuoteHandler | undefined;
  event?: EventHandler | undefined;
  problem: ProblemReporter;
}

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
 * The version gate would otherwise only fire on a gateway whose answer differs
 * in nothing but the version string — which is the one difference that is not
 * a difference of dialect. A gateway that added an envelope kind, or a field,
 * answers with a document this SDK refuses, and without this it would look
 * like a broken gateway forever. One field is read, and only when it is a
 * string; anything else here is a body that has nothing to say about versions.
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

export interface Subscription {
  /**
   * Stops the loop and waits for it to finish. Safe to call twice.
   *
   * Two things are abandoned rather than finished, and both come back on their
   * own. A poll parked at the gateway is dropped, and whatever it would have
   * carried is redelivered. An answer already on its way — a delivery the
   * handler produced a moment ago — is dropped too, and its order is
   * redelivered; the merchant is told through the problem channel, because on
   * their side the work happened and only the answer was lost.
   *
   * Stopping does not drain. The contract has a word for a poll that asks for
   * whatever is queued right now and comes straight back, and it is not what a
   * worker shutting down wants: draining pulls more work into a process that
   * is going away.
   */
  stop(): Promise<void>;
}

/** What `startWorker` hands its caller, which is a little more than a merchant sees. */
export interface RunningWorker extends Subscription {
  /** Whether the loop is still going. False once it has stopped for any reason. */
  running(): boolean;
}

export const startWorker = (
  gateway: Gateway,
  handlers: HandlerRegistry,
  clock: WorkerClock = systemClock,
): RunningWorker => {
  const controller = new AbortController();
  let stopping = false;
  let ended = false;

  /**
   * Reporting must not be able to end the worker. A merchant's reporter is
   * their code — a logger over a stream that closed during shutdown, a client
   * that was never configured — and an exception out of it would otherwise
   * unwind the loop and, from the loop's own last-resort handler, escape as an
   * unhandled rejection and take the host process down with it. There is
   * nowhere left to report a reporter that throws, so it is swallowed.
   */
  const report = (problem: WorkerProblem): void => {
    try {
      handlers.problem(problem);
    } catch {
      // Nowhere to say it. See above.
    }
  };

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
        message: `the answer for order ${order.id} did not reach us, and the order will be delivered again${stopping ? " after this worker stopped" : ""}: ${sent.failure.reason}`,
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

  /**
   * The one loss in this contract that nobody is told about, said out loud
   * here because this is the place it would reach the agent.
   *
   * A field named `__proto__` is removed while a delivery is parsed, before
   * any check runs — it is neither carried nor refused, and the merchant's
   * handler has no way to know that what it returned is not what went out.
   * `PROTOTYPE_KEY_IS_DROPPED` in the contracts package names this file as
   * where the loss actually costs something, so this file says it.
   *
   * No card can declare such a field, so nothing legitimate reaches here; a
   * merchant only meets it by delivering a name nobody asked for.
   */
  const warnAboutTheDroppedKey = (order: Order, answer: HandlerAnswer): void => {
    const delivered = "delivered" in answer ? answer.delivered : undefined;

    if (delivered !== undefined && Object.hasOwn(delivered, PROTOTYPE_KEY_IS_DROPPED)) {
      report({
        kind: WORKER_PROBLEM_KINDS.DELIVERY_FIELD_DROPPED,
        fatal: false,
        subject: order.id,
        message: `the delivery for order ${order.id} carried a field named ${PROTOTYPE_KEY_IS_DROPPED}, which is removed before anything can check it: the agent will not receive it, and no card can declare it`,
      });
    }
  };

  const handleOrder = async (order: Order): Promise<void> => {
    const handler = handlers.order;

    if (handler === undefined) {
      report({
        kind: WORKER_PROBLEM_KINDS.NO_HANDLER,
        fatal: false,
        subject: order.id,
        message: `order ${order.id} arrived and no handler was registered with orders.subscribe, so it was left unanswered and will be delivered again`,
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
        message: `a price question for ${question.merchant_item_id} arrived and no handler was registered with pricing.onQuote, so it was left unanswered`,
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
        message: `the price for question ${question.price_id} did not reach us${stopping ? " because this worker stopped" : ""}: ${sent.failure.reason}`,
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

  const handleEvent = async (event: OrderEvent): Promise<void> => {
    const handler = handlers.event;

    if (handler === undefined) {
      report({
        kind: WORKER_PROBLEM_KINDS.NO_HANDLER,
        fatal: false,
        subject: event.order_id,
        message: `${event.type} arrived for order ${event.order_id} and nothing is listening for events; pass onEvent to orders.subscribe to receive them`,
      });
      return;
    }

    try {
      await handler(event);
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
        await handleEvent(envelope.payload);
        return;
      default:
        // Unreachable while the contract carries three kinds, and here so
        // that a fourth added there stops this file compiling rather than
        // being dropped in silence by a switch with nothing to say about it.
        return assertEveryKindIsHandled(envelope);
    }
  };

  const run = async (): Promise<void> => {
    // One turn, so that handlers registered on the lines after the one that
    // started this loop are in place before the first envelope can arrive.
    await Promise.resolve();

    let failures = 0;

    while (!stopping) {
      const startedAt = clock.now();
      const answer = await callRoute(gateway, "poll_worker", {
        body: { wait_seconds: POLL_WAIT_SECONDS },
        signal: controller.signal,
      });

      if (stopping) break;

      if (!answer.ok) {
        // Before blaming the transport: a gateway of another dialect answers
        // with a document this SDK cannot parse, which arrives here as an
        // ordinary failure and would otherwise be retried forever under a
        // message about a broken gateway. Its version is the one field we can
        // still read out of what it sent.
        const spoken = versionSpokenIn(answer.failure.body);

        if (spoken !== undefined && !speaksContract(spoken)) {
          reportTheMismatch(spoken);
          return;
        }

        failures += 1;
        report({
          kind: WORKER_PROBLEM_KINDS.POLL_FAILED,
          fatal: false,
          message: `${answer.failure.reason} — asking again after a wait`,
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
