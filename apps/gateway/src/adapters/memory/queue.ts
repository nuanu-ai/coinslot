/**
 * The queue, in memory.
 *
 * It keeps the two promises the flows are written against. A poll is held open
 * until an envelope arrives or the window closes, and a worker that is already
 * parked when one is published receives it with no polling lag at all — which
 * is ADR-0004 §4, and the reason the latency-critical case is a parked request
 * rather than a poll interval.
 *
 * A stream belongs to one merchant. There is one of them per merchant rather
 * than one queue everybody draws from, because a worker that had to draw an
 * envelope in order to see whose it was would already have taken it out of the
 * reach of the worker it was meant for.
 *
 * And a drawn envelope goes invisible rather than back on the stream. Nothing
 * in here decides that an unanswered delivery should be repeated: that fact
 * reaches the order machine as a reminder, the machine works out whether
 * another attempt fits inside the deadline and how long the wait before it is,
 * and the attempt itself arrives back here as an ordinary publish. A queue
 * that redelivered on its own would be a second opinion about the same order,
 * with its own backoff and its own patience, over the top of one that counts.
 *
 * The waiting is `setTimeout`, so a test drives it with vitest's fake timers
 * and nothing here has to keep a clock of its own.
 */

import type { WorkerEnvelope } from "@coinslot/contracts";
import type { DrawnEnvelope, Queue, Reminder, ReminderPatience } from "../../ports/queue.js";

type Waiter = () => void;

/** One merchant's stream: what is waiting on it and who is waiting for it. */
interface Stream {
  readonly ready: WorkerEnvelope[];
  /**
   * Published with a delay and not arrived yet. It is on the stream in every
   * sense that matters to somebody asking whether an order is still waiting to
   * be handed over, and out of reach of a worker until its moment.
   */
  readonly held: Set<WorkerEnvelope>;
  readonly waiters: Set<Waiter>;
}

export class MemoryQueue implements Queue {
  /**
   * One stream per merchant, which is what makes a worker unable to reach
   * anybody else's envelopes at all.
   *
   * It is separate streams rather than one stream that is filtered on the way
   * out, and the difference matters: a filter would have to draw a stranger's
   * envelope in order to look at it, and a drawn envelope is one nobody else is
   * offered until it is finished. Merchant A polling would quietly swallow
   * merchant B's orders.
   */
  readonly #streams = new Map<string, Stream>();
  /** Deliveries drawn and not yet answered, by the handle that answers them. */
  readonly #inFlight = new Map<string, { merchantId: string; envelope: WorkerEnvelope }>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #fire: ((reminder: Reminder) => Promise<void>) | null = null;
  #running = false;
  #handles = 0;
  readonly #patience: ReminderPatience;
  /** What would run daily, by name, so a test can run it when it wants to. */
  readonly daily = new Map<string, () => Promise<unknown>>();

  constructor(patience: ReminderPatience = { attempts: 3, retryDelayMs: 5 }) {
    this.#patience = patience;
  }

  async publish(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<void> {
    (await this.stage(merchantId, envelope, afterMs))();
  }

  /**
   * Takes an envelope for a stream without putting it there, and hands back the
   * call that puts it there.
   *
   * It exists for one caller: the store, writing an envelope that has to land
   * with the order implying it (ADR-0013). In a deployment those two are one
   * transaction and nothing sees the envelope until it commits. Here there is
   * no transaction, and the two halves are what stands in for one — anything
   * that would refuse refuses in this call, before the order is written, and
   * the envelope becomes visible in the call this hands back, after it. Without
   * the split, a worker could be handed an envelope for a change to an order
   * that the store had not written down yet.
   */
  async stage(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<() => void> {
    const stream = this.#streamOf(merchantId);
    return () => {
      if (afterMs === undefined || afterMs <= 0) {
        this.#arrive(merchantId, envelope);
        return;
      }
      stream.held.add(envelope);
      this.#later(() => {
        stream.held.delete(envelope);
        this.#arrive(merchantId, envelope);
      }, afterMs);
    };
  }

  async holdsOrder(merchantId: string, orderId: string): Promise<boolean> {
    const stream = this.#streamOf(merchantId);
    // Both what a worker could draw now and what is waiting out a delay. An
    // envelope somebody has already drawn is in neither, which is the same
    // answer the real queue gives and for the same reason.
    return [...stream.ready, ...stream.held].some(
      (envelope) => envelope.kind === "order" && envelope.payload.id === orderId,
    );
  }

  async draw(merchantId: string, max: number, waitMs: number): Promise<readonly DrawnEnvelope[]> {
    const first = this.#take(merchantId, max);
    if (first.length > 0 || waitMs <= 0) {
      return first;
    }

    await this.#park(merchantId, waitMs);
    return this.#take(merchantId, max);
  }

  async finish(merchantId: string, handle: string): Promise<void> {
    // A handle that is not there is not an error: it is the second answer to a
    // delivery that was already answered, and the portal promises a merchant
    // that repeating a call is safe. A handle another merchant holds is left
    // exactly where it is, so one worker cannot finish another's delivery.
    if (this.#inFlight.get(handle)?.merchantId === merchantId) {
      this.#inFlight.delete(handle);
    }
  }

  async remind(reminder: Reminder, afterMs: number): Promise<void> {
    this.#deliver(reminder, Math.max(afterMs, 0), 1);
  }

  /**
   * One delivery of a reminder, and another after it if the handler threw.
   *
   * pg-boss does this with its own retries and this does it with a timer, and
   * the two have to come to the same thing: a reminder is the only thing that
   * ever declares an overdue order, so a port that promised the retry and had
   * one adapter keeping it would be a promise nobody could rely on.
   */
  #deliver(reminder: Reminder, afterMs: number, attempt: number): void {
    this.#later(() => {
      const fire = this.#fire;
      if (fire === null) {
        return;
      }
      void fire(reminder).catch(() => {
        if (attempt < this.#patience.attempts) {
          this.#deliver(reminder, this.#patience.retryDelayMs, attempt + 1);
        }
      });
    }, afterMs);
  }

  onReminder(fire: (reminder: Reminder) => Promise<void>): void {
    if (this.#running) {
      throw new Error("where reminders go is set before the queue is started, not after");
    }
    this.#fire = fire;
  }

  /**
   * In memory this records what would be run and never runs it. Nothing in an
   * offline suite waits a day, and a fake day would be a schedule that fires on
   * a timer this adapter's tests then have to reason about.
   */
  async everyDay(name: string, work: () => Promise<unknown>): Promise<void> {
    this.daily.set(name, work);
  }

  async start(): Promise<void> {
    if (this.#fire === null) {
      // A queue started with nowhere to put reminders would swallow every
      // deadline in the system, and would do it silently.
      throw new Error("the queue has nowhere to put reminders and will not start");
    }
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    for (const stream of this.#streams.values()) {
      for (const wake of stream.waiters) {
        wake();
      }
      stream.waiters.clear();
    }
  }

  #streamOf(merchantId: string): Stream {
    const found = this.#streams.get(merchantId);
    if (found !== undefined) {
      return found;
    }
    const made: Stream = { ready: [], held: new Set(), waiters: new Set() };
    this.#streams.set(merchantId, made);
    return made;
  }

  #arrive(merchantId: string, envelope: WorkerEnvelope): void {
    const stream = this.#streamOf(merchantId);
    stream.ready.push(envelope);
    // Only this merchant's parked workers are woken. Waking everybody would
    // send every other poll back to an empty stream for nothing.
    for (const wake of stream.waiters) {
      wake();
    }
    stream.waiters.clear();
  }

  #take(merchantId: string, max: number): DrawnEnvelope[] {
    const stream = this.#streamOf(merchantId);
    const drawn = stream.ready.splice(0, Math.max(max, 0));
    return drawn.map((envelope) => {
      this.#handles += 1;
      const handle = `h${this.#handles}`;
      this.#inFlight.set(handle, { merchantId, envelope });
      return { envelope, handle };
    });
  }

  #park(merchantId: string, waitMs: number): Promise<void> {
    const stream = this.#streamOf(merchantId);
    return new Promise((resolve) => {
      const wake: Waiter = () => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        stream.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, waitMs);
      this.#timers.add(timer);
      stream.waiters.add(wake);
    });
  }

  #later(run: () => void, afterMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, afterMs);
    this.#timers.add(timer);
  }
}
