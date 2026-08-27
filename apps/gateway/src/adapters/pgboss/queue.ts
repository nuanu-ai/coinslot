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
 * A poll is woken in-process the moment something is published. Drawing on its
 * own is a poll of the database every `pollIntervalMs`; ADR-0004 §4 asks for no
 * polling lag at all on the one path where an agent is waiting. Since the
 * process that publishes an order is the same process a worker is parked
 * against, a signal between them costs nothing and closes that gap.
 *
 * The polling underneath it is this adapter's own and not the library's, and
 * the distinction matters to anybody reading `draw`. pg-boss polls inside
 * `work()`, which is how reminders are delivered; `draw` uses `fetch()`, which
 * asks once and answers. So what carries an envelope to a poll in another
 * process — and what would carry one to a second gateway the day there is one —
 * is the loop in `draw` calling `fetch` again, not anything the library is
 * doing on its own behalf.
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
 * What pg-boss will take as a queue name, and therefore what every name below
 * has to be.
 *
 * It is the library's own rule, copied: a space or a colon is refused, a period
 * and a hyphen are not — pg-boss's own internal queue is called
 * `__pgboss__send-it`. `pgboss/queue.db-test.ts` asks the real library whether
 * this still agrees with it.
 *
 * It used to be read by the tests alone, on the grounds that pg-boss does its
 * own checking and says why in a sentence worth reading. That held while every
 * queue name was a constant in this file. One of them is now built out of a
 * merchant identifier, and the failure moved: a merchant whose identifier
 * pg-boss will not take is not a start-up error somebody sees, it is one
 * merchant whose orders reach nobody, discovered at the first sale.
 */
export const A_NAME_PG_BOSS_ACCEPTS = /^[\w.\-/]+$/;

/**
 * The reminders queue, and the prefix each merchant's stream is named under.
 *
 * The shape is held to in a test, and the test that matters is the one against
 * the library: this rule was written down here from a reading of the
 * documentation as "a bare identifier, no periods", the first run against a
 * real pg-boss accepted `coinslot.envelopes` without complaint, and a rule
 * nobody had ever asked the library about had been standing in a comment as a
 * fact.
 */
export const ENVELOPES = "coinslot_envelopes";
export const REMINDERS = "coinslot_reminders";

/**
 * One merchant's stream, which is a pg-boss queue of its own.
 *
 * The alternative was one queue carrying every merchant's envelopes and a
 * filter on the way out, and it does not work: pg-boss hands out work by queue
 * name and has no way to fetch by anything inside a job, so filtering would
 * mean drawing a stranger's envelope in order to look at it — and a drawn
 * envelope is one nobody is offered again, this adapter finishing it in the
 * pass it was drawn in and the library failing it outright if that pass never
 * came. A worker polling would silently swallow everybody else's orders.
 *
 * What a queue costs is a row. With pg-boss's own partitioning left off, which
 * is the default, `createQueue` is an insert into its `queue` table and every
 * job lives in the one table underneath — so this is a row per merchant and not
 * a table per merchant.
 *
 * The name changed, and what that costs is named here rather than left to be
 * found. Nothing draws from the bare `coinslot_envelopes` any more. An
 * installation that had jobs sitting on it when this went out — an order
 * dispatch nobody had polled yet, a redelivery waiting out its own delay, a
 * hand-over pushed back because a charge was in flight — has those jobs on a
 * queue with no reader, and they are not moved by any migration. Those orders
 * are not lost sight of: the deadline reminders that would close them live on
 * `coinslot_reminders`, which is untouched, so each one still reaches its
 * ending, and the refund message it owes is published to the merchant's new
 * stream. But the work itself is never handed over.
 *
 * Emptying that queue first is what avoids it, and the order of the steps is
 * the whole of the advice. A worker holds nothing: a drawn envelope is finished
 * in the same pass it was drawn in, so bringing the gateway down does not let
 * anybody finish anything — it stops the only thing that was draining the
 * queue. Keep the old gateway running and polling, stop new purchases reaching
 * it, and wait until `select count(*) from pgboss.job where name =
 * 'coinslot_envelopes'` is zero.
 *
 * Two of the three kinds are published with a delay, and polling cannot reach
 * those before their time however long it runs. The wait is bounded by the
 * longest redelivery delay the configuration allows, and short of waiting it
 * out there is nothing that recovers them.
 */
export const streamOf = (merchantId: string): string => {
  if (!A_NAME_PG_BOSS_ACCEPTS.test(merchantId)) {
    throw new Error(
      `the merchant ${JSON.stringify(merchantId)} cannot name a queue: pg-boss holds a name to alphanumerics, underscores, hyphens, periods and forward slashes`,
    );
  }
  return `${ENVELOPES}_${merchantId}`;
};

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
  /** Workers parked on a stream, by the stream they are parked on. */
  readonly #waiters = new Map<string, Set<() => void>>();
  /**
   * The streams this process has already asked pg-boss to make.
   *
   * `create_queue` ends in `on conflict do nothing`, so asking twice is
   * harmless — but it is a round trip, and one per publish on a busy gateway is
   * a round trip nobody needs. Remembered per process rather than per
   * deployment: a second process makes the same call once and gets the same
   * nothing.
   */
  readonly #made = new Set<string>();
  #fire: ((reminder: Reminder) => Promise<void>) | null = null;
  #running = false;

  constructor(boss: PgBoss, options: PgBossQueueOptions) {
    this.#boss = boss;
    this.#options = options;
  }

  async publish(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<void> {
    const stream = await this.#stream(merchantId);
    const sent = await this.#boss.send(stream, envelope as unknown as object, {
      // Retries are the machine's to decide, so the queue keeps none of its own.
      retryLimit: 0,
      ...(afterMs === undefined || afterMs <= 0
        ? {}
        : { startAfter: new Date(Date.now() + afterMs) }),
    });

    // The library answers with the job's identifier, or with nothing when it
    // did not make one. Nothing is what an order never reaching a merchant
    // looks like from here, and swallowing it would make that silent.
    if (sent === null) {
      throw new Error(`the queue would not take the envelope ${envelope.id}`);
    }

    if (afterMs === undefined || afterMs <= 0) {
      this.#wakeEverybody(stream);
    }
  }

  async draw(merchantId: string, max: number, waitMs: number): Promise<readonly DrawnEnvelope[]> {
    const stream = await this.#stream(merchantId);
    const first = await this.#take(stream, max);
    if (first.length > 0 || waitMs <= 0) {
      return first;
    }

    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await this.#park(stream, Math.min(this.#options.pollIntervalMs, until - Date.now()));
      const drawn = await this.#take(stream, max);
      if (drawn.length > 0) {
        return drawn;
      }
    }
    return [];
  }

  async finish(merchantId: string, handle: string): Promise<void> {
    // Completing names the queue as well as the job, so a handle from one
    // merchant's stream cannot finish a delivery on another's: pg-boss looks
    // the job up under the name it is given and finds nothing.
    await this.#boss.complete(streamOf(merchantId), handle);
  }

  async remind(reminder: Reminder, afterMs: number): Promise<void> {
    const { attempts, retryDelayMs } = this.#options.reminders;
    const sent = await this.#boss.send(REMINDERS, reminder as unknown as object, {
      // The library's own retries, durably, rather than a handler catching its
      // own failure and writing to the database that had just refused it.
      retryLimit: Math.max(attempts - 1, 0),
      retryDelay: Math.max(Math.round(retryDelayMs / 1_000), 1),
      startAfter: new Date(Date.now() + Math.max(afterMs, 0)),
    });

    // A reminder that was not written down is a deadline that will never fire,
    // and the deadline is the only thing that ever closes an overdue order.
    if (sent === null) {
      throw new Error(
        `the queue would not take the ${reminder.kind} reminder for ${reminder.orderId}`,
      );
    }
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
    // A merchant's own stream is made the first time something is published to
    // it or drawn from it, because the merchants are rows now and this process
    // does not hold a list of them at start-up.
    // Both queues run on pg-boss's own defaults, and the important one is the
    // fifteen minutes a delivery may be held before the library gives up on it
    // and fails the job. That is deliberate for envelopes, where the machine
    // rather than the queue decides whether anything is repeated, and it has
    // never been thought about for reminders.
    //
    // Whoever thinks about it should know that these calls cannot be the place
    // it is changed. pg-boss writes a queue's settings when the queue is first
    // made and its `create_queue` ends in `on conflict do nothing`, so options
    // added here would apply to a database that has never run this and be
    // silently ignored by every database that has. Changing them on a live
    // installation is `updateQueue`, or a migration.
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
    for (const stream of [...this.#waiters.keys()]) {
      this.#wakeEverybody(stream);
    }
    await this.#boss.stop({ graceful: true });
  }

  /** This merchant's stream, made if this process has not made it yet. */
  async #stream(merchantId: string): Promise<string> {
    const name = streamOf(merchantId);
    if (!this.#made.has(name)) {
      await this.#boss.createQueue(name);
      this.#made.add(name);
    }
    return name;
  }

  async #take(stream: string, max: number): Promise<DrawnEnvelope[]> {
    const jobs = await this.#boss.fetch<WorkerEnvelope>(stream, {
      batchSize: Math.max(max, 1),
    });
    return jobs.map((job) => ({ envelope: job.data, handle: job.id }));
  }

  #park(stream: string, waitMs: number): Promise<void> {
    const parked = this.#waiters.get(stream) ?? new Set<() => void>();
    this.#waiters.set(stream, parked);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        parked.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(waitMs, 0));
      parked.add(wake);
    });
  }

  /**
   * Wakes the workers parked on one stream, and only them. Waking every parked
   * poll on every publish would send each of them back to a fetch on a stream
   * nothing had arrived on.
   */
  #wakeEverybody(stream: string): void {
    for (const wake of [...(this.#waiters.get(stream) ?? [])]) {
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
