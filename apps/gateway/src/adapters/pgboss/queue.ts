/**
 * The queue, on pg-boss, in the same Postgres as everything else (ADR-0003 §6).
 *
 * The durable part is entirely the library's: the rows, the locking, the
 * delayed jobs, the visibility window after which an unanswered delivery
 * expires. The rule that put it there is ADR-0003 §9 — the wish to write a
 * queue on SELECT ... FOR UPDATE SKIP LOCKED by hand reads as a badly chosen
 * component rather than as a task — and none of it is written here.
 *
 * Two things this adapter does add, and both are worth reading.
 *
 * A poll is woken in-process the moment something is published. pg-boss finds
 * work by its own polling, which is a second or two; ADR-0004 §4 asks for no
 * polling lag at all on the one path where an agent is waiting. Since the
 * process that publishes an order is the same process a worker is parked
 * against, a signal between them costs nothing and closes that gap. The
 * library's polling stays underneath as the backstop, which is what would carry
 * a second gateway process the day there is one.
 *
 * And a job is completed as soon as it is handed over rather than held open
 * until the merchant answers. Whether an unanswered delivery is repeated is the
 * order machine's decision — it is the one that knows how many attempts are
 * left and whether another could still land inside the deadline — and pg-boss's
 * own retries are turned off so that there is only ever one opinion about that.
 * The reminder the gateway leaves itself is what carries the news of a silence
 * to the machine.
 */

import type { WorkerEnvelope } from "@coinslot/contracts";
import { type Job, PgBoss } from "pg-boss";
import type { DrawnEnvelope, Queue, Reminder } from "../../ports/queue.js";

/** The merchant's stream of envelopes. */
export const ENVELOPES = "coinslot.envelopes";
/** The reminders the gateway leaves itself: deadlines, and silent deliveries. */
export const REMINDERS = "coinslot.reminders";

export interface PgBossQueueOptions {
  /**
   * How long a poll waits on the library's own polling before giving up on this
   * turn. It only matters for work published by another process; work published
   * by this one wakes a parked poll immediately.
   */
  readonly pollIntervalMs: number;
}

export class PgBossQueue implements Queue {
  readonly #boss: PgBoss;
  readonly #options: PgBossQueueOptions;
  readonly #waiters = new Set<() => void>();
  #fire: ((reminder: Reminder) => Promise<void>) | null = null;
  #running = false;

  constructor(boss: PgBoss, options: PgBossQueueOptions) {
    this.#boss = boss;
    this.#options = options;
  }

  async publish(envelope: WorkerEnvelope, afterMs?: number): Promise<void> {
    await this.#boss.send(ENVELOPES, envelope as unknown as object, {
      // Retries are the machine's to decide, so the queue keeps none of its own.
      retryLimit: 0,
      ...(afterMs === undefined || afterMs <= 0
        ? {}
        : { startAfter: new Date(Date.now() + afterMs) }),
    });

    if (afterMs === undefined || afterMs <= 0) {
      this.#wakeEverybody();
    }
  }

  async draw(max: number, waitMs: number): Promise<readonly DrawnEnvelope[]> {
    const first = await this.#take(max);
    if (first.length > 0 || waitMs <= 0) {
      return first;
    }

    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await this.#park(Math.min(this.#options.pollIntervalMs, until - Date.now()));
      const drawn = await this.#take(max);
      if (drawn.length > 0) {
        return drawn;
      }
    }
    return [];
  }

  async finish(handle: string): Promise<void> {
    await this.#boss.complete(ENVELOPES, handle);
  }

  async remind(reminder: Reminder, afterMs: number): Promise<void> {
    await this.#boss.send(REMINDERS, reminder as unknown as object, {
      retryLimit: 0,
      startAfter: new Date(Date.now() + Math.max(afterMs, 0)),
    });
  }

  onReminder(fire: (reminder: Reminder) => Promise<void>): void {
    if (this.#running) {
      throw new Error("where reminders go is set before the queue is started, not after");
    }
    this.#fire = fire;
  }

  async start(): Promise<void> {
    const fire = this.#fire;
    if (fire === null) {
      // A queue started with nowhere to put reminders would swallow every
      // deadline in the system, and would do it silently.
      throw new Error("the queue has nowhere to put reminders and will not start");
    }

    await this.#boss.start();
    await this.#boss.createQueue(ENVELOPES);
    await this.#boss.createQueue(REMINDERS);

    await this.#boss.work<Reminder>(REMINDERS, { batchSize: 1 }, async (jobs: Job<Reminder>[]) => {
      for (const job of jobs) {
        await fire(job.data);
      }
    });

    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#wakeEverybody();
    await this.#boss.stop({ graceful: true });
  }

  async #take(max: number): Promise<DrawnEnvelope[]> {
    const jobs = await this.#boss.fetch<WorkerEnvelope>(ENVELOPES, {
      batchSize: Math.max(max, 1),
    });
    return jobs.map((job) => ({ envelope: job.data, handle: job.id }));
  }

  #park(waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(waitMs, 0));
      this.#waiters.add(wake);
    });
  }

  #wakeEverybody(): void {
    for (const wake of [...this.#waiters]) {
      wake();
    }
  }
}

/** A queue on this database, ready to be started. */
export function queueOn(databaseUrl: string, options: PgBossQueueOptions): PgBossQueue {
  return new PgBossQueue(new PgBoss(databaseUrl), options);
}
