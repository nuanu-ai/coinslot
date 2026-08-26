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
import type { DrawnEnvelope, Queue, Reminder, ReminderPatience } from "../../ports/queue.js";

/**
 * The two queues, named the way pg-boss will accept.
 *
 * A queue name becomes a database object name, and pg-boss refuses one that is
 * not a bare identifier: letters, digits and underscores, not starting with a
 * digit. The obvious `coinslot.envelopes` is refused at the first call, which
 * would be at start-up in production and nowhere at all in a test — nothing
 * offline touches this file. The shape is held to in a test instead.
 */
export const ENVELOPES = "coinslot_envelopes";
export const REMINDERS = "coinslot_reminders";

/** What pg-boss will take as a queue name, and therefore what these must be. */
export const A_NAME_PG_BOSS_ACCEPTS = /^[A-Za-z_]\w*$/;

export interface PgBossQueueOptions {
  /**
   * How long a poll waits on the library's own polling before giving up on this
   * turn. It only matters for work published by another process; work published
   * by this one wakes a parked poll immediately.
   */
  readonly pollIntervalMs: number;
  /** How patient the queue is with a reminder whose handler threw. */
  readonly reminders: ReminderPatience;
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
    const { attempts, retryDelayMs } = this.#options.reminders;
    await this.#boss.send(REMINDERS, reminder as unknown as object, {
      // The library's own retries, durably, rather than a handler catching its
      // own failure and writing to the database that had just refused it.
      retryLimit: Math.max(attempts - 1, 0),
      retryDelay: Math.max(Math.round(retryDelayMs / 1_000), 1),
      startAfter: new Date(Date.now() + Math.max(afterMs, 0)),
    });
  }

  onReminder(fire: (reminder: Reminder) => Promise<void>): void {
    if (this.#running) {
      throw new Error("where reminders go is set before the queue is started, not after");
    }
    this.#fire = fire;
  }

  async everyDay(name: string, work: () => Promise<unknown>): Promise<void> {
    await this.#boss.createQueue(name);
    await this.#boss.work(name, { batchSize: 1 }, async () => {
      await work();
    });
    // Registering the same name again replaces the schedule rather than adding
    // one, so a restart does not accumulate them.
    await this.#boss.schedule(name, "17 3 * * *");
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

/**
 * A queue on this database, ready to be started.
 *
 * pg-boss reports its internal failures as an event, and an unhandled one of
 * those is an uncaught exception and a dead process. That costs more here than
 * in most services: every parked purchase and every parked worker lives in this
 * process's memory, so a database hiccup that killed it would drop every agent
 * mid-purchase rather than degrading anything.
 */
export function queueOn(databaseUrl: string, options: PgBossQueueOptions): PgBossQueue {
  const boss = new PgBoss(databaseUrl);
  boss.on("error", (error: unknown) => {
    console.error("[gateway] the queue reported a failure", error);
  });
  return new PgBossQueue(boss, options);
}
