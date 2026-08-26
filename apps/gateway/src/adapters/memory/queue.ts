/**
 * The queue, in memory.
 *
 * It keeps the two promises the flows are written against. A poll is held open
 * until an envelope arrives or the window closes, and a worker that is already
 * parked when one is published receives it with no polling lag at all — which
 * is ADR-0004 §4, and the reason the latency-critical case is a parked request
 * rather than a poll interval.
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

export class MemoryQueue implements Queue {
  readonly #ready: WorkerEnvelope[] = [];
  /** Deliveries drawn and not yet answered, by the handle that answers them. */
  readonly #inFlight = new Map<string, WorkerEnvelope>();
  readonly #waiters = new Set<Waiter>();
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

  async publish(envelope: WorkerEnvelope, afterMs?: number): Promise<void> {
    if (afterMs === undefined || afterMs <= 0) {
      this.#arrive(envelope);
      return;
    }
    this.#later(() => this.#arrive(envelope), afterMs);
  }

  async draw(max: number, waitMs: number): Promise<readonly DrawnEnvelope[]> {
    const first = this.#take(max);
    if (first.length > 0 || waitMs <= 0) {
      return first;
    }

    await this.#park(waitMs);
    return this.#take(max);
  }

  async finish(handle: string): Promise<void> {
    // A handle that is not there is not an error: it is the second answer to a
    // delivery that was already answered, and the portal promises a merchant
    // that repeating a call is safe.
    this.#inFlight.delete(handle);
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
    for (const wake of this.#waiters) {
      wake();
    }
    this.#waiters.clear();
  }

  #arrive(envelope: WorkerEnvelope): void {
    this.#ready.push(envelope);
    for (const wake of this.#waiters) {
      wake();
    }
    this.#waiters.clear();
  }

  #take(max: number): DrawnEnvelope[] {
    const drawn = this.#ready.splice(0, Math.max(max, 0));
    return drawn.map((envelope) => {
      this.#handles += 1;
      const handle = `h${this.#handles}`;
      this.#inFlight.set(handle, envelope);
      return { envelope, handle };
    });
  }

  #park(waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake: Waiter = () => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, waitMs);
      this.#timers.add(timer);
      this.#waiters.add(wake);
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
