/**
 * The queue, against a real Postgres.
 *
 * Almost everything this adapter promises is pg-boss keeping it — the delayed
 * job, the retry after a handler throws, the window after which a delivery
 * nobody answered is taken back — and none of it is visible offline. The
 * offline suite next door can only check the shape of the queue names. This is
 * where the promises themselves are checked.
 *
 * It is a file of its own rather than more tests in `adapters.db-test.ts`, and
 * the reason is the failure that produced it. That file starts a whole gateway,
 * and a started gateway has a worker polling `coinslot_reminders`. A test that
 * stands up a second queue against the same database and waits for its own
 * handler to be called is asking pg-boss to hand one job to two consumers;
 * pg-boss hands it to one of them, correctly, and it was the gateway's — so the
 * test's handler was never called and the test failed every run. Delivering a
 * job once is the queue working, not the queue broken. Nothing here starts a
 * gateway, and every test gets a pg-boss installation of its own, so no test in
 * this file is ever competing with anything for its own jobs.
 *
 * These are not in `pnpm test`, for the same reason the adapters next door are
 * not: that command is free, deterministic and works without a network. They
 * run under `pnpm test:db`.
 */

import type { WorkerEnvelope } from "@nuanu-ai/coinslot-contracts";
import { Pool } from "pg";
import { type Queue as LibraryQueueOptions, PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../../ports/queue.js";
import { readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { A_NAME_PG_BOSS_ACCEPTS, ENVELOPES, PgBossQueue, REMINDERS, streamOf } from "./queue.js";

// This suite's own database, made if it is not there. The sentence explaining
// that there is no server at all is printed once, by the adapters suite.
const databaseUrl = await readyDatabase(testDatabaseUrl());

/** Real time, because a queue that lives in a database keeps its own. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The merchant whose stream this suite publishes to and draws from. */
const A = "mch_a";
/** That merchant's stream, which is a pg-boss queue of its own (ADR-0010). */
const STREAM = streamOf(A);

/**
 * A pg-boss installation nobody else is using.
 *
 * Every test gets its own schema, and that is not tidiness. Queue settings are
 * written once — pg-boss's `create_queue` is an insert that does nothing on
 * conflict — so a test that needs a one-second visibility window would leave
 * that window on `coinslot_envelopes` for every test that ran after it, and the
 * suite's behaviour would depend on the order the tests happened to be declared
 * in. A schema each also means the installation itself is exercised from
 * nothing every run.
 */
const SCHEMAS = [
  "pgboss_reminder_retry",
  "pgboss_reminder_bound",
  "pgboss_reminder_delay",
  "pgboss_reminder_expiry",
  "pgboss_envelope_expiry",
  "pgboss_envelope_delay",
  "pgboss_every_day",
  "pgboss_queue_names",
  "pgboss_queue_settings",
  "pgboss_holds_order",
  "pgboss_holds_failed",
] as const;

if (databaseUrl === null) {
  // Said quietly: the sentence with the instructions in it is printed once, by
  // the adapters suite, and twice would read like two different problems.
  describe("the queue on a real database", () => {
    it.skip("is skipped: there is no Postgres to run it against", () => {
      // Intentionally empty: the skip is the message.
    });
  });
} else {
  const url = databaseUrl;

  describe("the queue on a real database", () => {
    let pool: Pool;
    const running: PgBossQueue[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: url });
      // Dropped rather than emptied, and before anything is started. pg-boss's
      // own deleteAllJobs truncates a partitioned table, which deadlocks
      // against a worker polling it; and emptying the jobs would leave the
      // queues and their schedules behind on a volume that outlives the run.
      for (const schema of SCHEMAS) {
        await pool.query(`drop schema if exists ${schema} cascade`);
      }
    }, 60_000);

    afterAll(async () => {
      // Stopped rather than left: a boss still polling holds connections open,
      // and the next file's first act is to drop the schema underneath it.
      await Promise.all(running.map((queue) => queue.stop().catch(() => undefined)));
      // Taken away again, so that a developer opening this database finds the
      // tables the gateway uses and not a row of pg-boss installations belonging to
      // a test run. The drop in beforeAll is what makes the suite repeatable
      // and stays there: a run that dies in the middle leaves its schemas
      // behind, and the next run must not care.
      for (const schema of SCHEMAS) {
        await pool.query(`drop schema if exists ${schema} cascade`);
      }
      await pool.end();
    });

    /**
     * A started boss on its own schema, and the adapter over it. Queues named
     * in `queues` are made first, so their settings are the ones that stand:
     * the adapter's own `createQueue` on an existing queue changes nothing.
     */
    async function labQueue(
      schema: (typeof SCHEMAS)[number],
      queues: Record<string, Omit<LibraryQueueOptions, "name">> = {},
    ): Promise<{ boss: PgBoss; queue: PgBossQueue }> {
      const boss = new PgBoss({ connectionString: url, schema });
      boss.on("error", (error: unknown) => {
        console.error(`[${schema}] the queue reported a failure`, error);
      });
      await boss.start();
      for (const [name, options] of Object.entries(queues)) {
        await boss.createQueue(name, options);
      }
      const queue = new PgBossQueue(boss, {
        pollIntervalMs: 50,
        reminders: { attempts: 3, retryDelayMs: 1_000 },
      });
      running.push(queue);
      return { boss, queue };
    }

    it("agrees with the rule the queue names are held to", async () => {
      // The adapter keeps a regular expression for what pg-boss takes as a
      // queue name, and offline that is only a regular expression agreeing with
      // itself. This is the library answering, and the first time it was asked
      // it disagreed: the comment beside the constants said a period was
      // refused and the obvious `coinslot.envelopes` would fail at start-up,
      // and pg-boss created that queue without a word. A rule copied out of a
      // reading rather than out of the library had been standing as a fact.
      const { boss } = await labQueue("pgboss_queue_names");

      const taken = [ENVELOPES, REMINDERS, STREAM, "coinslot.envelopes", "coinslot-envelopes"];
      for (const name of taken) {
        expect(name, name).toMatch(A_NAME_PG_BOSS_ACCEPTS);
        await expect(boss.createQueue(name)).resolves.toBeUndefined();
      }

      const refused = ["coinslot envelopes", "coinslot:envelopes", "coinslot#envelopes"];
      for (const name of refused) {
        expect(name, name).not.toMatch(A_NAME_PG_BOSS_ACCEPTS);
        await expect(boss.createQueue(name)).rejects.toThrow();
      }

      // A merchant's stream is named after the merchant now, so a merchant
      // whose identifier pg-boss will not take is not a start-up error somebody
      // sees — it is one merchant whose orders reach nobody, found at the first
      // sale. It is refused where the name is built instead.
      expect(() => streamOf("a merchant")).toThrow(/cannot name a queue/);
    }, 30_000);

    it("delivers a reminder, and delivers it again when the handler throws", async () => {
      // A reminder is the only thing that ever declares an overdue order. One
      // dropped because the database was briefly unreachable is a paid order
      // nobody ever marks for a refund, so the retry is not a nicety — and it
      // is the queue's job rather than the handler's, because a handler that
      // re-armed its own reminder would be writing to the thing that had just
      // thrown at it.
      const seen: Reminder[] = [];
      let failures = 0;
      const { queue } = await labQueue("pgboss_reminder_retry");
      queue.onReminder(async (reminder) => {
        seen.push(reminder);
        if (failures < 1) {
          failures += 1;
          throw new Error("the handler was briefly unhappy");
        }
      });
      await queue.start();

      await queue.remind(
        { kind: "deadline", orderId: "ord_r", deadline: "quote_expiry", at: 1 },
        0,
      );
      await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 25_000, interval: 100 });

      expect(failures).toBe(1);
      // The same reminder twice, not two different ones: what came back is the
      // deadline that was not dealt with, carrying the instant it runs out at.
      expect(seen).toStrictEqual([
        { kind: "deadline", orderId: "ord_r", deadline: "quote_expiry", at: 1 },
        { kind: "deadline", orderId: "ord_r", deadline: "quote_expiry", at: 1 },
      ]);
    }, 40_000);

    it("gives up on a reminder that never succeeds, after the number of attempts it was given", async () => {
      // The other half of the retry, and the half a test that throws once
      // cannot see. The port promises a reminder is delivered again "a bounded
      // number of times", and the configuration's own comment says delivering
      // it forever would turn a defect into a loop. A handler that always
      // throws is what asks whether the bound is real: with the attempts below
      // set to three, the third failure has to be the last word.
      const seen: Reminder[] = [];
      // Held in one place rather than written twice, because the second use is
      // inside a string the compiler cannot check.
      const schema = "pgboss_reminder_bound" satisfies (typeof SCHEMAS)[number];
      const { boss, queue } = await labQueue(schema);
      queue.onReminder(async (reminder) => {
        seen.push(reminder);
        throw new Error("this handler is never going to work");
      });
      await queue.start();

      await queue.remind(
        { kind: "deadline", orderId: "ord_doomed", deadline: "quote_expiry", at: 1 },
        0,
      );

      // Three deliveries in all — the first and two retries — and then the job
      // is failed rather than tried a fourth time.
      await vi.waitFor(
        async () => {
          const { rows } = await pool.query<{ state: string }>(
            `select state from ${schema}.job where name = $1`,
            [REMINDERS],
          );
          expect(rows.map((row) => row.state)).toStrictEqual(["failed"]);
        },
        { timeout: 30_000, interval: 250 },
      );
      expect(seen).toHaveLength(3);

      // Left alone from here: a failed reminder is not picked up again, which
      // is what stops a deadline nobody can act on from being retried for as
      // long as the gateway runs.
      await boss.supervise();
      expect(seen).toHaveLength(3);
    }, 60_000);

    it("holds a delayed reminder back until its moment", async () => {
      // Every deadline in the system is armed through this. A reminder that
      // fired the moment it was written would close an order whose merchant is
      // still honestly inside his deadline — the machine checks the instant it
      // carries against its own arithmetic, but only because it is told the
      // truth about when it fired.
      const seen: Reminder[] = [];
      const { queue } = await labQueue("pgboss_reminder_delay");
      queue.onReminder(async (reminder) => {
        seen.push(reminder);
      });
      await queue.start();

      await queue.remind(
        { kind: "delivery_unanswered", orderId: "ord_delayed", handOver: "dlv_1" },
        4_000,
      );

      // pg-boss looks for work about every two seconds, so by now it has looked
      // at least once and left this alone. Without that, "nothing yet" would
      // only mean nobody had got round to it.
      await sleep(2_800);
      expect(seen).toStrictEqual([]);

      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 25_000, interval: 100 });
      expect(seen[0]).toStrictEqual({
        kind: "delivery_unanswered",
        orderId: "ord_delayed",
        handOver: "dlv_1",
      });
    }, 40_000);

    it("gives a reminder back when the process that took it never answers", async () => {
      // The crash case, and the only reason a visibility window is worth
      // having. A gateway that took a deadline reminder and died before acting
      // on it must not take that deadline with it: the order it belongs to is
      // paid, and nothing else in the system will ever declare it overdue.
      //
      // One second of window instead of the default fifteen minutes, and the
      // dying is done by taking the job and not answering it.
      const { boss, queue } = await labQueue("pgboss_reminder_expiry", {
        [REMINDERS]: { expireInSeconds: 1 },
      });

      await queue.remind(
        { kind: "deadline", orderId: "ord_lost", deadline: "settle_response", at: 7 },
        0,
      );

      const taken = await boss.fetch<Reminder>(REMINDERS, { batchSize: 1 });
      expect(taken).toHaveLength(1);
      // While it is out with somebody, nobody else is given it. A queue that
      // handed the same deadline to two processes would have them both act on
      // it.
      expect(await boss.fetch<Reminder>(REMINDERS, { batchSize: 1 })).toStrictEqual([]);

      await sleep(1_500);
      // Asked for rather than waited for. pg-boss runs this itself, on a timer,
      // about once a minute; calling it by hand compresses that minute and
      // changes nothing else, so what is watched below is the same recovery a
      // running gateway gets without anybody asking.
      await boss.supervise();

      const again = await vi.waitFor(
        async () => {
          const jobs = await boss.fetch<Reminder>(REMINDERS, { batchSize: 1 });
          expect(jobs).toHaveLength(1);
          return jobs;
        },
        { timeout: 25_000, interval: 250 },
      );
      // The same job, not a second one somebody wrote: an order gets one
      // deadline, and it comes back rather than being duplicated.
      expect(again[0]?.id).toBe(taken[0]?.id);
      expect(again[0]?.data).toStrictEqual({
        kind: "deadline",
        orderId: "ord_lost",
        deadline: "settle_response",
        at: 7,
      });
    }, 60_000);

    it("does not give a drawn envelope back after its window, and that is the known gap", async () => {
      // The port says this out loud and calls it a real gap, so it is checked
      // rather than assumed. An envelope drawn into a poll response that never
      // reached the merchant's worker is lost: publish keeps no retries,
      // because whether an order is delivered again is the order machine's
      // decision and a queue with its own patience would be a second opinion
      // over the top of it. An order event has no such machine behind it and is
      // simply gone — that is the gap, and it needs an acknowledgement the
      // contract does not have.
      // Held in one place rather than written twice, because the second use is
      // inside a string the compiler cannot check.
      const schema = "pgboss_envelope_expiry" satisfies (typeof SCHEMAS)[number];
      const { boss, queue } = await labQueue(schema, {
        [STREAM]: { expireInSeconds: 1 },
      });
      const envelope: WorkerEnvelope = {
        kind: "order_event",
        id: "env_expiry_1",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.unpaid_after_confirmation",
          order_id: "ord_expiry",
          at: "2026-08-26T12:00:00.000Z",
        },
      };

      await queue.publish(A, envelope);
      const drawn = await queue.draw(A, 10, 5_000);
      expect(drawn.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_expiry_1"]);

      // Out with one worker, so not handed to a second.
      expect(await queue.draw(A, 10, 200)).toStrictEqual([]);

      await sleep(1_500);
      await boss.supervise();

      // And still not, once the window has run out. This is the promise the
      // port makes and the thing a reader would otherwise have to take on
      // trust.
      expect(await queue.draw(A, 10, 1_000)).toStrictEqual([]);

      // Where it went, so that "lost" is a place somebody can look rather than
      // a silence: the delivery is recorded as failed, not quietly dropped.
      const { rows } = await pool.query<{ state: string }>(
        `select state from ${schema}.job where name = $1`,
        [STREAM],
      );
      expect(rows.map((row) => row.state)).toStrictEqual(["failed"]);
    }, 60_000);

    it("makes both queues with the fifteen-minute window a lost delivery waits out", async () => {
      // Every other test here that cares about the visibility window makes the
      // queue itself with a window of one second, so none of them ever sees the
      // window production runs with. This is that number, read back off a queue
      // the adapter made the way `start()` makes it.
      //
      // Fifteen minutes is how long a delivery may be held by a process that
      // has died before the queue takes it back. For a reminder that is how
      // late an overdue order can be declared when the gateway carrying its
      // deadline goes down, so it is a number somebody may well want to change
      // — and the note beside `createQueue` says why that cannot be done by
      // passing options there. Changing it should break this test and send
      // whoever changed it to that note.
      const { boss, queue } = await labQueue("pgboss_queue_settings");
      queue.onReminder(async () => undefined);
      await queue.start();
      // A merchant's stream is made the first time anything reaches for it,
      // because the merchants are rows and this process holds no list of them
      // at start-up. So it is reached for, and then asked about.
      await queue.draw(A, 1, 0);

      for (const name of [STREAM, REMINDERS]) {
        const made = await boss.getQueue(name);
        expect(made?.expireInSeconds, name).toBe(900);
      }
    }, 30_000);

    it("holds a delayed envelope back, and reaches a poll in another process when it lands", async () => {
      // Two promises, and they need different setups to be worth anything.
      //
      // The first is the wait itself. The gateway publishes an envelope with
      // one when a delivery is to be tried again and when a charge is still in
      // flight, and that is the branch of publish which deliberately wakes
      // nobody — a delayed envelope has nothing to wake anybody for yet.
      //
      // The second is that a draw in one process is reached by a publish in
      // another. That needs an envelope published with no wait, because only
      // those signal the parked polls at all: the delayed one above would be
      // carried by a single instance's own `draw` loop just as well, so it
      // proves nothing about a second one. This is what would carry a second
      // gateway process the day there is one, and it is `draw` asking `fetch`
      // again rather than anything pg-boss does on its own — the library's
      // polling lives in `work()`, which envelopes never go through.
      //
      // The queue is made once, the way `start()` makes it, and the second
      // instance finds it already there, which is what a second gateway
      // starting against a running system does.
      const publisher = await labQueue("pgboss_envelope_delay", { [STREAM]: {} });
      const drawer = await labQueue("pgboss_envelope_delay");
      const envelopeAt = (id: string): WorkerEnvelope => ({
        kind: "order_event",
        id,
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.unpaid_after_confirmation",
          order_id: "ord_delayed_env",
          at: "2026-08-26T12:00:00.000Z",
        },
      });

      await publisher.queue.publish(A, envelopeAt("env_delayed_1"), 4_000);

      // Not yet, and long enough after publishing for a draw that ignored the
      // wait to have found it.
      expect(await drawer.queue.draw(A, 10, 2_500)).toStrictEqual([]);

      const drawn = await drawer.queue.draw(A, 10, 20_000);
      expect(drawn.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_delayed_1"]);
      await drawer.queue.finish(A, drawn[0]?.handle ?? "");

      // And now one with no wait on it, which wakes the publisher's own parked
      // polls and none of the drawer's. It arrives all the same.
      await publisher.queue.publish(A, envelopeAt("env_immediate_1"));
      const carried = await drawer.queue.draw(A, 10, 20_000);
      expect(carried.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_immediate_1"]);
      await drawer.queue.finish(A, carried[0]?.handle ?? "");
    }, 60_000);

    it("says whether a stream is still holding an order, and only about orders", async () => {
      // The sweep asks this before it sends an order out again, and what it
      // buys is the order's own deliveries: the machine counts every hand-over,
      // the count is what its attempt cap reads, and the closure at that cap is
      // a refund. A wrong answer here costs a merchant who was merely between
      // polls one of his retries.
      //
      // It cannot be checked offline, because the whole of it is a filter the
      // library builds — containment against the job's document — and an
      // in-memory queue agreeing with itself proves nothing about that.
      const { queue } = await labQueue("pgboss_holds_order", { [STREAM]: {} });
      const orderEnvelope = (id: string, orderId: string): WorkerEnvelope => ({
        kind: "order",
        id,
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          id: orderId,
          merchant_item_id: "sku-1",
          params: {},
          price: {
            amount: "12.00",
            currency: "USD",
            at: "2026-08-26T12:00:00.000Z",
            as_of: "2026-08-26T12:00:00.000Z",
          },
          test: true,
        },
      });

      // Nothing there at all.
      expect(await queue.holdsOrder(A, "ord_held")).toBe(false);

      await queue.publish(A, orderEnvelope("env_held_1", "ord_held"));
      expect(await queue.holdsOrder(A, "ord_held")).toBe(true);
      // And it is about this order rather than about the stream having
      // anything on it.
      expect(await queue.holdsOrder(A, "ord_somebody_else")).toBe(false);

      // A redelivery waiting out its delay counts: it is going to be handed
      // over, so an order with one is not an order that has reached nobody.
      await queue.publish(A, orderEnvelope("env_held_2", "ord_delayed_hold"), 60_000);
      expect(await queue.holdsOrder(A, "ord_delayed_hold")).toBe(true);

      // Drawn is not held. This is the gap the port names in its own words: an
      // envelope in a worker's hands looks from here exactly like one that was
      // never written, which is why the sweep has patience as well as this.
      const drawn = await queue.draw(A, 10, 2_000);
      expect(drawn.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_held_1"]);
      expect(await queue.holdsOrder(A, "ord_held")).toBe(false);

      // And an event about an order is not an order. Nothing ever re-sends an
      // event, so nothing should ever be told an order is still in hand
      // because a message about it is.
      //
      // The state this whole repair rests on is checked next door, in its own
      // test: an envelope whose window ran out is `failed`, and this has to
      // answer "not held" for it or the order it carried reaches nobody, ever.
      await queue.publish(A, {
        kind: "order_event",
        id: "env_held_3",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.unpaid_after_confirmation",
          order_id: "ord_held",
          at: "2026-08-26T12:00:00.000Z",
        },
      });
      expect(await queue.holdsOrder(A, "ord_held")).toBe(false);
    }, 60_000);

    it("says a failed envelope is not held, which is what the repair rests on", async () => {
      // The one state the whole repair depends on. An envelope drawn into a
      // poll response that never reached its worker is failed once its window
      // runs out — the test above pins that — and it is never offered again. If
      // this said "held" for it, the sweep would leave that order alone
      // forever: paid, with nobody ever handed the work, until its own
      // fulfillment deadline turned it into a debt.
      const schema = "pgboss_holds_failed" satisfies (typeof SCHEMAS)[number];
      const { boss, queue } = await labQueue(schema, {
        [STREAM]: { expireInSeconds: 1 },
      });
      const envelope: WorkerEnvelope = {
        kind: "order",
        id: "env_failed_1",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          id: "ord_failed",
          merchant_item_id: "sku-1",
          params: {},
          price: {
            amount: "12.00",
            currency: "USD",
            at: "2026-08-26T12:00:00.000Z",
            as_of: "2026-08-26T12:00:00.000Z",
          },
          test: true,
        },
      };

      await queue.publish(A, envelope);
      expect(await queue.holdsOrder(A, "ord_failed")).toBe(true);

      // Drawn and never answered, which is the process that died holding it.
      const drawn = await queue.draw(A, 10, 5_000);
      expect(drawn.map((delivery) => delivery.envelope.id)).toStrictEqual(["env_failed_1"]);

      await sleep(1_500);
      await boss.supervise();

      // Failed, said by the library rather than assumed, and then the answer
      // that matters: nothing is holding this order, so the sweep is free to
      // send it again.
      const { rows } = await pool.query<{ state: string }>(
        `select state from ${schema}.job where name = $1`,
        [STREAM],
      );
      expect(rows.map((row) => row.state)).toStrictEqual(["failed"]);
      expect(await queue.holdsOrder(A, "ord_failed")).toBe(false);
    }, 60_000);

    it("takes on work to run every day, runs it, and does not stack up schedules", async () => {
      // The gateway registers its sweep of old payment claims through this on
      // every start, so a schedule pg-boss refused would take start-up down
      // with it. Two things are worth more than "it did not throw": that the
      // work is really wired to the queue, and that registering it again — what
      // every restart does — replaces the schedule instead of adding one more.
      const { boss, queue } = await labQueue("pgboss_every_day");
      let ran = 0;

      await queue.everyDay("coinslot_a_daily_sweep", async () => {
        ran += 1;
      });

      await boss.send("coinslot_a_daily_sweep", {});
      await vi.waitFor(() => expect(ran).toBe(1), { timeout: 25_000, interval: 100 });

      const schedules = await boss.getSchedules("coinslot_a_daily_sweep");
      expect(schedules.map((schedule) => schedule.cron)).toStrictEqual(["17 3 * * *"]);

      await queue.everyDay("coinslot_a_daily_sweep", async () => {
        ran += 1;
      });
      expect(await boss.getSchedules("coinslot_a_daily_sweep")).toHaveLength(1);
    }, 60_000);
  });
}
