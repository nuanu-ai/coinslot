/**
 * The real adapters, against a real Postgres.
 *
 * These are not in `pnpm test`. That command is free, deterministic and works
 * without a network, and a suite that needs a database server is none of those.
 * They run under `pnpm test:db`, which needs a Postgres — `docker compose up -d
 * --wait postgres` brings one up — and skips itself with a sentence saying so
 * when there is none.
 *
 * The database it runs against is `coinslot_test`, which is this suite's own
 * and not the one the stack runs on: see `testing/database.ts` for what
 * happened when they were the same.
 *
 * What the two adapters both promise is not written out here. It is one suite
 * in `testing/store-contract.ts`, run at the foot of this file against a real
 * Postgres and under `pnpm test` against the maps in memory, so that a
 * difference between them is a failure rather than two test files drifting
 * apart in the same direction.
 *
 * What is left in this file is what cannot be checked in memory at all: the
 * round trip through JSONB and through a queue that is a table, the columns
 * written from the document, the driver's own refusals, the pool and its
 * listeners, the advisory lock across two connections, and the migrations. Above
 * all `withOrder` under two clients that share nothing in this process, where
 * the hold is a row lock rather than a chain of promises, and which is the thing
 * standing between two events about one order and a charge that happens twice.
 *
 * The queue's own promises — the delayed reminder, the retry after a handler
 * throws, the window after which an unanswered delivery is taken back — are
 * next door in `pgboss/queue.db-test.ts`. They cannot be checked here: this
 * file starts a gateway, a started gateway has a worker on `coinslot_reminders`
 * already, and a test that waits for its own second consumer to be handed the
 * job is waiting for the queue to do the wrong thing.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card, Receipt, WorkerEnvelope } from "@coinslot/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Gateway } from "../../app/gateway.js";
import type { Runtime } from "../../app/runtime.js";
import type { OrderChange } from "../../ports/store.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { countedIds, testConfig, workUntilStopped } from "../../testing/harness.js";
import { describeStore } from "../../testing/store-contract.js";
import { ScriptedFacilitator } from "../memory/facilitator.js";
import { PgBossQueue, streamOf } from "../pgboss/queue.js";
import { connect, PostgresStore } from "./store.js";

/** The merchant everything in this suite belongs to, and a second one beside it. */
const A = "mch_a";
const B = "mch_b";

// Made if it is not there, so that an existing volume needs nothing done to it.
const wanted = testDatabaseUrl();
const databaseUrl = await readyDatabase(wanted);

/**
 * Where this suite's pg-boss lives, which is not where a deployment's does.
 *
 * The suite has a database of its own now, so this is belt and braces rather
 * than the thing standing between a test run and somebody's queue. It stays
 * because it is also what keeps the two db-test files out of each other's way,
 * and because `DATABASE_URL` can still be pointed at a database somebody else
 * is using.
 */
const QUEUE_SCHEMA = "pgboss_adapters";

/**
 * Emptying every table this schema has, in one statement, in one place.
 *
 * The list is meant to stay complete, and it is written once because it is
 * asked for twice — the file empties them before it starts, and the shared
 * store contract empties them before each of its own cases. Two copies of a
 * list that must stay complete are one copy that will not.
 *
 * Why it is every table and not the two that hold the fixtures. A claim on a
 * payment left behind owns the fingerprint this run presents, and every
 * purchase below is refused: a suite that passes once and never again, on a
 * volume that outlives it. The merchant's row is here for the same reason
 * before it has cost anybody an afternoon — it carries whether they are
 * selling at all, so a run that ever paused them would leave every later run's
 * purchases turned away, and the failure would look like anything but its
 * cause.
 *
 * A table added to `schema.ts` belongs in this list.
 */
const EMPTY_EVERY_TABLE =
  "truncate table cards, orders, receipts, payment_claims, merchant_keys, merchants";

/**
 * Terminates one named backend, from a connection of its own.
 *
 * It takes the session as a number rather than going looking for it, and the
 * two versions this replaced are the reason. Terminating everything holding an
 * advisory lock took the gateway's own connections down and failed thirteen
 * tests that had nothing to do with any of it. Narrowing that to sessions whose
 * last statement was `pg_try_advisory_lock` looked exact and was not: the other
 * lock tests in this file run through the shared pool and leave its connections
 * sitting idle on exactly that statement, so the wrong one was killed depending
 * on what had run before. What is left is a pid the caller knows because it
 * asked its own single-connection pool for it.
 *
 * The answer is read rather than discarded, and that line is the whole reason
 * the tests below test anything. `pg_terminate_backend` returns false for a pid
 * that is no longer a running backend, and it is a warning rather than an
 * error, so a helper that ignores it terminates nothing and says nothing.
 * Every assertion downstream still holds in that case: no connection breaks, no
 * error is emitted, the unlock succeeds, the work returns what it returned.
 * Measured — aimed at a pid that could not exist, both tests passed. So the
 * premise they are named for is checked here, once, where the failure can still
 * be told apart from a defect in the store.
 */
async function terminate(pid: number): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl ?? "", max: 1 });
  try {
    const { rows } = await pool.query<{ gone: boolean }>(
      "select pg_terminate_backend($1) as gone",
      [pid],
    );
    if (rows[0]?.gone !== true) {
      throw new Error(
        `backend ${pid} was not terminated, so nothing below is testing what it says it is`,
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * Runs the work and hands back whatever reached Node with nobody listening for
 * it while that was going on.
 *
 * The tests that terminate a connection are about an `error` event on a client
 * no longer carrying a listener, which in Node is an uncaught exception. Left to
 * the runner that shows up as a failed run with the errors reported beside the
 * results — the run's exit code says something went wrong, but every assertion
 * in the test still passes, so the test itself is green and reports nothing.
 * That is the same shape as the helper above discarding what it was told, and
 * it is worth not having twice.
 *
 * So the test asks directly. A listener of its own is on for the length of the
 * call and off again afterwards, and what it collected is something to assert
 * about. The runner's own listener still fires as well, which is wanted: two
 * signals agreeing is better than one, and this one is the one that names the
 * test.
 */
async function whatWentUnlistened(work: () => Promise<void>): Promise<string[]> {
  const unlistened: string[] = [];
  const collect = (thrown: unknown) => {
    unlistened.push(String(thrown));
  };
  process.on("uncaughtException", collect);
  try {
    await work();
  } finally {
    process.removeListener("uncaughtException", collect);
  }
  return unlistened;
}

/** Which server session a connection is, so a lock can be attributed to it. */
async function backendPid(of: Pool): Promise<number> {
  const { rows } = await of.query<{ pid: number }>("select pg_backend_pid() as pid");
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("a connection would not say which backend it is");
  }
  return pid;
}

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

if (databaseUrl === null) {
  // Said out loud as well as in the skipped test's name, because a run that
  // reports "1 skipped" and nothing else looks like a suite that passed.
  console.log(noDatabaseHere(wanted));

  describe("the real adapters", () => {
    it.skip("are skipped: there is no Postgres to run them against", () => {
      // Intentionally empty: the message above is the whole point.
    });
  });
} else {
  describe("the real adapters", () => {
    let pool: Pool;
    let store: PostgresStore;
    /**
     * The pool the shared store contract runs on, kept apart from the one this
     * file's own store and gateway share.
     *
     * Its size is the load-bearing part. Two of the contract's cases hold a
     * decision open while a second decision runs, and a decision is a
     * transaction holding a connection for as long as it lasts — so on a pool
     * of one the second would wait for a connection rather than for a lock, and
     * "these two orders do not wait for each other" would be answered by the
     * pool instead of by the database.
     */
    let contract: ReturnType<typeof connect>;
    let queue: PgBossQueue;
    let boss: PgBoss;
    let gateway: Gateway;
    let facilitator: ScriptedFacilitator;
    let now = Date.parse("2026-08-26T12:00:00.000Z");

    beforeAll(async () => {
      // The schema first, from the same checked-in migrations a deployment
      // applies, so this suite fails on a migration that does not apply rather
      // than on a table it happened to find.
      const here = dirname(fileURLToPath(import.meta.url));
      const migrating = new Pool({ connectionString: databaseUrl });
      await migrate(drizzle(migrating), {
        migrationsFolder: join(here, "..", "..", "..", "drizzle"),
      });
      await migrating.end();

      const connected = connect(databaseUrl);
      pool = connected.pool;
      // Through `connect` like every other pool here, so the contract's own
      // connections carry the same error listeners the rest of them do. Four,
      // which is more than the two its cases need at once and small enough that
      // a pool exhausted by something else is still a visible failure.
      contract = connect(databaseUrl, { max: 4 });
      // Every run starts from an empty catalog, or the counts below would be
      // reading somebody else's leftovers.
      await pool.query(EMPTY_EVERY_TABLE);
      // And the queue's own tables, which are none of ours. They are dropped
      // rather than emptied, dropped before the gateway is up rather than
      // after, and dropped from an installation of this suite's own rather than
      // from the one a deployment uses. All three are lessons from runs that
      // failed.
      //
      // Emptying them is what pg-boss's own deleteAllJobs does, and it does it
      // as `TRUNCATE pgboss.job` — an exclusive lock on a partitioned table and
      // every partition under it. Called after the gateway has started, that
      // lands on top of the reminder worker already polling those same
      // partitions, and the two deadlock: `deadlock detected`, in beforeAll,
      // taking the whole file down before a single test runs. It is a race, so
      // it does not happen every time, which is the worst way for it to fail.
      //
      // Dropping the schema also clears what emptying the jobs leaves behind:
      // the queues themselves and their schedules. `everyDay` registers a cron
      // entry that survives on the volume, so a suite that only deleted jobs
      // would inherit yesterday's schedules for as long as the volume lives.
      //
      // And it is `pgboss_adapters` rather than `pgboss` because the port this
      // suite connects to is published for exactly this, so the database it
      // runs against is the one the containers use. Dropping the schema a
      // running gateway's workers are polling takes that gateway's queue out
      // from under it — it logs `relation "pgboss.job_common" does not exist`
      // and goes on reporting itself healthy. This suite installs its own and
      // leaves a deployment's alone.
      //
      // What it costs is that pg-boss arrives at a schema that is never there
      // yet, so its own migration of an existing installation is exercised
      // nowhere. That is a thing to remember at the next pg-boss upgrade.
      await pool.query(`drop schema if exists ${QUEUE_SCHEMA} cascade`);

      boss = new PgBoss({ connectionString: databaseUrl, schema: QUEUE_SCHEMA });
      queue = new PgBossQueue(boss, {
        pollIntervalMs: 50,
        reminders: { attempts: 3, retryDelayMs: 1_000 },
      });
      // The queue is made first because the store writes through it: an
      // envelope that must not be lost goes into the same transaction as the
      // order that implies it (ADR-0013), which is the arrangement `main.ts`
      // makes and the one the tests below are about.
      store = new PostgresStore(connected.db, countedIds(), queue.envelopes());
      facilitator = new ScriptedFacilitator();

      const runtime: Runtime = {
        config: testConfig({ PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" }),
        store,
        queue,
        facilitator,
        clock: () => now,
        ids: countedIds(),
      };
      gateway = new Gateway(runtime);
      await gateway.start();
    }, 60_000);

    // Every card, order and receipt belongs to a merchant that exists, so the
    // row is written back after each truncate rather than once: without it the
    // first publish of the next test is refused by the foreign key, which is
    // the schema doing its job and the fixture forgetting its own.
    beforeEach(async () => {
      await store.addMerchant({ id: A, name: "The merchant of this suite" }, now);
      await store.addMerchant({ id: B, name: "The other merchant" }, now);
    });

    afterAll(async () => {
      await gateway.stop();
      // Taken away again, the way the queue suite next door takes its own away,
      // so that a developer opening this database finds the gateway's tables
      // and not a test run's pg-boss beside them. The drop in beforeAll is what
      // makes the suite repeatable and stays there: a run that dies in the
      // middle leaves this behind, and the next run must not care.
      await pool.query(`drop schema if exists ${QUEUE_SCHEMA} cascade`);
      await pool.end();
      await contract.pool.end();
    });

    afterEach(() => {
      now = Date.parse("2026-08-26T12:00:00.000Z");
    });

    it("changes the card that is there when it is published again", async () => {
      const first = await store.publishCard(A, syncCard, now);
      const again = await store.publishCard(A, { ...syncCard, title: "Corrected" }, now + 1_000);

      expect(again.id).toBe(first.id);
      expect((await store.cardById(first.id))?.card.title).toBe("Corrected");
      expect(await store.cards(A)).toHaveLength(1);
    });

    it("publishes a card selling, and keeps a pause across the next publish", async () => {
      // The rule that matters most in this adapter, and it is expressed by
      // omission: `paused` is deliberately not in the upsert's `set:` clause.
      // An edit that puts it back is invisible to `pnpm test` — the only other
      // test for this rule runs against the in-memory store — and what it costs
      // is stock a merchant took off sale back in front of an agent.
      const card = { ...syncCard, merchant_item_id: "kept-paused" };
      const first = await store.publishCard(A, card, now);
      expect(first.paused).toBe(false);

      await store.setCardPaused(A, first.id, true);
      const again = await store.publishCard(A, { ...card, title: "Dearer" }, now + 1_000);

      expect(again.paused).toBe(true);
      expect(again.card.title).toBe("Dearer");
      expect((await store.cardById(first.id))?.paused).toBe(true);
      expect((await store.cards(A)).find((held) => held.id === first.id)?.paused).toBe(true);
    });

    it("takes a card off sale and puts it back, and says so about one that is not there", async () => {
      const stored = await store.publishCard(A, { ...syncCard, merchant_item_id: "switched" }, now);

      expect((await store.setCardPaused(A, stored.id, true))?.paused).toBe(true);
      expect((await store.cardById(stored.id))?.paused).toBe(true);
      expect((await store.setCardPaused(A, stored.id, false))?.paused).toBe(false);
      expect(await store.setCardPaused(A, "itm_nobody_published_this", true)).toBeNull();
    });

    it("has the merchant selling until somebody says otherwise, and remembers when they do", async () => {
      // The row does not exist until the switch is first pressed, and an absent
      // row means selling. There is no state of the world in which we hold a
      // merchant's cards and cannot say whether they are selling, so this must
      // never answer "I do not know".
      expect(await store.selling(A)).toBe("open");

      await store.setSelling(A, "paused");
      expect(await store.selling(A)).toBe("paused");

      await store.setSelling(A, "open");
      expect(await store.selling(A)).toBe("open");
    });

    it("refuses to guess when the column holds a word the machine does not know", async () => {
      // A hand-edited row, or a value from a version of this code that is not
      // this one. Guessing here would be guessing about whether somebody is
      // selling, which is the one thing this column exists to answer.
      await store.setSelling(A, "paused");
      // Named, because there is more than one merchant in this database now and
      // an unqualified update would leave the other one holding a word the
      // machine does not know for the rest of the file.
      await pool.query("update merchants set selling = $1 where id = $2", ["sort-of", A]);

      await expect(store.selling(A)).rejects.toThrow(/sort-of/);

      await store.setSelling(A, "open");
    });

    it("holds an order still, so two decisions cannot both write over the same read", async () => {
      // The double-charge test, against the lock that actually runs in
      // production. In memory this is a chain of promises; here it is
      // select ... for update, and the two have to mean the same thing.
      const published = await store.publishCard(A, { ...syncCard, merchant_item_id: "held" }, now);
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      const bump = () =>
        store.withOrder(orderId, async (found) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const attempts = found.order.dispatch.attempts + 1;
          return {
            save: { ...found, order: { ...found.order, dispatch: { attempts, accepted: false } } },
            result: attempts,
          };
        });

      const results = await Promise.all([bump(), bump(), bump()]);

      // Sorted as numbers rather than by the default sort, which compares them
      // as text and agrees with the numbers only while there are fewer than ten
      // of them. Raised to eleven, the bare sort would start lying by passing.
      expect(
        results
          .map((r) => (r.found ? r.result : null))
          .sort((one, other) => Number(one) - Number(other)),
      ).toStrictEqual([1, 2, 3]);
      expect((await store.orderById(orderId))?.order.dispatch.attempts).toBe(3);
    });

    it("lets one of two separate database clients take an order, and makes the other wait to find out", async () => {
      // The ownership rule, against two clients that share nothing in this
      // process. The test above races three calls through one store, and a
      // chain of promises in the adapter would pass it just as well as a row
      // lock; the in-memory adapter passes its own version of it for exactly
      // that reason. Here there are two pools and two connections, so the only
      // thing that can make the second wait for the first is the database.
      //
      // What is being decided is the rule the gateway decides inside this same
      // hold: an order is taken by the first verified payment, and a second
      // buyer is turned away. Both callers read the order before either writes,
      // if nothing holds them apart — and then both are its owner, both are
      // sent to a merchant, and one of the two charges fails on a merchant who
      // has already handed over the goods.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "contested" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      // One connection each, and that is load-bearing rather than tidy. The
      // check below names the two backends by their identifiers, so a pool that
      // quietly opened a second connection would leave it watching a session
      // that is not doing the work.
      //
      // Through `connect` rather than built here, like every other pool a store
      // in this file is given. That is what puts the error listener on the
      // clients these two check out, and alice's is checked out and left idle
      // for as long as the poll below takes.
      const alice = connect(databaseUrl, { max: 1 });
      const bob = connect(databaseUrl, { max: 1 });
      const alicePool = alice.pool;
      const bobPool = bob.pool;
      const reads: string[] = [];
      let aliceHeldBobUp = false;

      try {
        const alicePid = await backendPid(alicePool);
        const bobPid = await backendPid(bobPool);
        expect(alicePid).not.toBe(bobPid);

        let letBobIn: () => void = () => undefined;
        const bobMayStart = new Promise<void>((resolve) => {
          letBobIn = resolve;
        });

        /** What one client came away with: the order, or the name of whoever has it. */
        type Taken = { readonly took: true } | { readonly took: false; readonly heldBy: string };

        const take = (client: PostgresStore, who: string) =>
          client.withOrder(orderId, async (found): Promise<OrderChange<Taken>> => {
            reads.push(who);
            if (who === "alice") {
              letBobIn();
              // Waited for rather than slept through: what is wanted is the
              // moment bob's transaction is actually stuck behind alice's. It
              // gives up rather than throwing, so that a lock that never took
              // shows up below as two owners — the defect itself — and not as
              // a timeout in the plumbing.
              //
              // The question is asked about the two backends by name, and it
              // took three goes to get there. Counting backends waiting on any
              // lock passed whether or not the waiter was bob. Adding the query
              // text ruled out pg-boss, which is running against this same
              // database and whose own fetch is a `for update`, but still
              // passed for any two sessions contending over any row of this
              // table — an adversarial review demonstrated exactly that with a
              // decoy pair and no row lock at all. `pg_blocking_pids(bobPid)`
              // naming `alicePid` cannot be produced by anybody else: it says
              // this session is held up by that one, and the only lock alice
              // holds is the one her `select ... for update` took on this
              // order's row.
              const until = Date.now() + 5_000;
              while (Date.now() < until && !aliceHeldBobUp) {
                const { rows } = await pool.query<{ blockers: number[] }>(
                  "select pg_blocking_pids($1) as blockers",
                  [bobPid],
                );
                aliceHeldBobUp = (rows[0]?.blockers ?? []).includes(alicePid);
                if (!aliceHeldBobUp) {
                  await new Promise((resolve) => setTimeout(resolve, 50));
                }
              }
            }

            if (found.paidBy !== null && found.paidBy !== who) {
              return { result: { took: false, heldBy: found.paidBy } };
            }
            // Noted before the write goes back, so that the order of these
            // marks says something. Alice reads first because the test starts
            // her first; what is not arranged is that she gets all the way to
            // deciding before bob reads at all, and without the hold she does
            // not — bob's read lands between her read and her write.
            reads.push(`${who} decided`);
            return { save: { ...found, paidBy: who }, result: { took: true } };
          });

        const aliceTaking = take(new PostgresStore(alice.db, countedIds()), "alice");
        await bobMayStart;
        const bobTaking = take(new PostgresStore(bob.db, countedIds()), "bob");
        const [first, second] = await Promise.all([aliceTaking, bobTaking]);

        const decided = [first, second].map((lookup) => (lookup.found ? lookup.result : null));
        // Exactly one, and the other told whose it is. Without the hold both
        // read an order nobody owns and both take it.
        expect(decided).toStrictEqual([{ took: true }, { took: false, heldBy: "alice" }]);
        // And the database is what made bob wait: his session, held up by her
        // session, on the one row she had locked.
        expect(aliceHeldBobUp).toBe(true);
        // The marks are the same fact told as a sequence rather than as a
        // catalogue query, and they stand on the wait above being a wait for
        // the real lock. Without it alice polls out her five seconds, bob reads
        // and decides while she waits, and the marks come out "alice", "bob",
        // "bob decided", "alice decided" — both of them having read an order
        // that was still nobody's.
        expect(reads).toStrictEqual(["alice", "alice decided", "bob"]);
        expect((await store.orderById(orderId))?.paidBy).toBe("alice");
      } finally {
        await alicePool.end();
        await bobPool.end();
      }
    }, 30_000);

    it("gives one payment to one order, in one statement, and refuses it to any other", async () => {
      // The replay guard, against the primary key that actually enforces it.
      // Two requests presenting the same payment at the same instant both reach
      // the insert and the database picks between them; what comes back either
      // way is the row that stands.
      expect(await store.claimPayment("fp-db-1", "ord_a")).toStrictEqual({ claimed: true });
      expect(await store.claimPayment("fp-db-1", "ord_b")).toStrictEqual({
        claimed: false,
        heldBy: "ord_a",
      });
      expect(await store.claimPayment("fp-db-1", "ord_a")).toStrictEqual({ claimed: true });
    });

    it("gives one payment to exactly one of two orders racing for it", async () => {
      const [first, second] = await Promise.all([
        store.claimPayment("fp-db-race", "ord_race_a"),
        store.claimPayment("fp-db-race", "ord_race_b"),
      ]);

      const won = [first, second].filter((claim) => claim.claimed);
      expect(won).toHaveLength(1);
    });

    it("forgets claims older than an instant, and says how many went", async () => {
      await store.claimPayment("fp-db-old", "ord_old");

      expect(await store.forgetClaimsBefore(Date.now() + 60_000)).toBeGreaterThan(0);
      expect(await store.claimPayment("fp-db-old", "ord_new")).toStrictEqual({ claimed: true });
    });

    it("keeps the open column in step with the state inside the document", async () => {
      // `open` is a column of its own, written from the document by `rowFor` on
      // every insert and every update, and it is what `GET /orders?open=true`
      // answers from. The in-memory adapter has no such column — it works the
      // answer out from the state each time it is asked — so nothing offline
      // can catch the two disagreeing, and a column that fell behind would
      // quietly drop a live order out of the list the cabinet works from.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "listed" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      const idsOf = async (query?: { readonly open?: boolean }) =>
        (await store.orders(A, query)).map((record) => record.order.id);

      expect(await idsOf({ open: true })).toContain(orderId);

      // Closed inside the document, and nothing said about the column.
      await store.withOrder(orderId, (found) => ({
        save: { ...found, order: { ...found.order, state: "expired" } },
        result: null,
      }));

      expect(await idsOf({ open: true })).not.toContain(orderId);
      // Still there, though: closed is not deleted, and the unfiltered list is
      // what somebody reconciling a day's orders reads.
      expect(await idsOf()).toContain(orderId);
    });

    it("says an order is not there rather than throwing", async () => {
      expect(await store.withOrder("ord_nope", () => ({ result: 1 }))).toStrictEqual({
        found: false,
      });
    });

    it("leaves the row alone when a decision asked for nothing to be written", async () => {
      // `updated_at` is written from `rowFor` on every save, and it is the only
      // place a write with nothing to write shows up at all — the document that
      // came back would be identical either way, so the shared suite can ask
      // this only of the state and not of the row.
      //
      // What it costs to be wrong is not the column. A store that wrote on
      // every decision is a store where a call that changed nothing puts back
      // what it read over whatever landed in between, which is the lost update
      // the hold exists to prevent, reached by the one call that was not trying
      // to write.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "untouched" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      const writtenAt = async (): Promise<string> => {
        const { rows } = await pool.query<{ at: Date }>(
          "select updated_at as at from orders where id = $1",
          [orderId],
        );
        const at = rows[0]?.at;
        if (at === undefined) {
          throw new Error(`there is no order ${orderId}, so there is no row to read`);
        }
        return at.toISOString();
      };

      const before = await writtenAt();
      // Far enough apart that two writes could not land on one instant. The
      // column resolves to microseconds and this is twenty milliseconds, so a
      // write that did happen has nowhere to hide.
      await new Promise((resolve) => setTimeout(resolve, 20));

      await store.withOrder(orderId, (found) => ({
        // The order this decision would have written, handed back as its answer
        // rather than named in `save`.
        result: { ...found, order: { ...found.order, state: "cancelled" as const } },
      }));

      expect(await writtenAt()).toBe(before);

      // The negative control, and it is what makes the line above mean
      // anything: a decision that does ask for a write moves the column, so
      // "unchanged" is this store keeping its word rather than this column
      // never moving.
      await store.withOrder(orderId, (found) => ({
        save: { ...found, priceId: "written on purpose" },
        result: null,
      }));

      expect(await writtenAt()).not.toBe(before);
    });

    it("carries an envelope through the queue and does not send it round again by itself", async () => {
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "queued" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");

      const drawn = await queue.draw(A, 10, 2_000);
      expect(drawn).toHaveLength(0);

      await queue.publish(A, {
        kind: "order_event",
        id: "env_db_1",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.unpaid_after_confirmation",
          order_id: "ord_db_1",
          at: "2026-08-26T12:00:00.000Z",
        },
      });

      const first = await queue.draw(A, 10, 2_000);
      expect(first.map((d) => d.envelope.id)).toStrictEqual(["env_db_1"]);
      await queue.finish(A, first[0]?.handle ?? "");

      expect(await queue.draw(A, 10, 200)).toStrictEqual([]);
    });

    it("walks a whole synchronous sale through the database and the queue", async () => {
      // Everything from here is the same flow the in-memory tests walk. What
      // this adds is that it survives the round trip through JSONB and through
      // a queue that is a table.
      const published = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "walked" },
        now,
      );
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");

      const worker = workUntilStopped(
        { gateway, merchant: { id: A, name: "", key: "", keyId: "" } },
        { onOrder: () => ({ delivered: { access_code: "SESAME" } }) },
      );
      // A fingerprint of this run's own, so the claim left behind by a previous
      // run — or by another test in this one — is never what decides it.
      const paid = `walked-${randomUUID()}`;
      const bought = await gateway.payPurchase(offered.order.order.id, paid, paid);
      await worker.stop();

      expect(bought.step).toBe("settled");
      if (bought.step !== "settled") throw new Error("the purchase did not settle");
      expect(bought.order.order.state).toBe("delivered");
      expect(bought.delivery).toStrictEqual({ access_code: "SESAME" });

      const receipt = await store.receiptForOrder(offered.order.order.id);
      expect(receipt?.outcome).toBe("delivered");
      expect(receipt?.price.amount).toBe("80.00");
      // And it is in the list as well as findable by its order. The two are
      // different queries and only one of them had ever been run against a
      // database; a receipt somebody can fetch but that never appears in the
      // list is a day's takings that does not add up.
      const listed = await store.receipts(A);
      expect(listed.map((one) => one.order_id)).toContain(offered.order.order.id);
      expect(listed.find((one) => one.order_id === offered.order.order.id)).toStrictEqual(receipt);
    }, 30_000);
    it("resolves a working key to its merchant and answers nothing for a disabled one", async () => {
      // The door, against the SQL that runs in production. In memory this is a
      // map lookup and a null check; here the exclusion of a revoked key is a
      // predicate, and the two have to mean the same thing — a disabled key that
      // came back would be a revocation that did not take.
      await store.addKey({ id: "mk_door_a", merchantId: A, label: "A's", digest: "door-a" }, now);
      await store.addKey({ id: "mk_door_b", merchantId: B, label: "B's", digest: "door-b" }, now);

      expect(await store.workingKey("door-a")).toMatchObject({ id: "mk_door_a", merchantId: A });
      expect((await store.workingKey("door-b"))?.merchantId).toBe(B);

      await store.disableKey("mk_door_a", now + 1_000);

      // And it is refused in exactly the words a key nobody was issued gets, so
      // a revoked key is not a way of confirming that a guess was once real.
      expect(await store.workingKey("door-a")).toBeNull();
      expect(await store.workingKey("a-digest-nobody-was-issued")).toBeNull();
      // B's key is untouched, which is the whole reason a key is a row.
      expect((await store.workingKey("door-b"))?.merchantId).toBe(B);
    });

    it("keeps the instant a key was first revoked at when it is revoked again", async () => {
      // The update is written as a coalesce rather than an assignment, and only
      // a database runs it. A retry after a dropped connection must not rewrite
      // the one fact somebody reconstructing an incident works from.
      await store.addKey({ id: "mk_twice", merchantId: A, label: "A's", digest: "twice" }, now);

      expect((await store.disableKey("mk_twice", now + 1_000))?.disabledAt).toBe(now + 1_000);
      expect((await store.disableKey("mk_twice", now + 9_000))?.disabledAt).toBe(now + 1_000);
    });

    it("refuses a key for a merchant that is not there", async () => {
      // The foreign key, doing what the in-memory adapter's own guard stands in
      // for. A key that opens a door onto nothing is worse than a command that
      // failed.
      await expect(
        store.addKey({ id: "mk_x", merchantId: "mch_nobody", label: "x", digest: "d" }, now),
      ).rejects.toThrow();
    });

    it("does not let a decision about an order move it to another merchant", async () => {
      // The column is left out of the update on purpose, which is a rule
      // expressed by omission and therefore one nothing else would catch. What
      // it guards is the two readers agreeing: a merchant's own lists filter on
      // the column, and the interpreter publishes an order's envelopes to the
      // merchant inside the document. A save that moved one and not the other
      // would put an order in one merchant's list and its work on another's
      // stream, and nothing would say so.
      const published = await store.publishCard(A, { ...syncCard, merchant_item_id: "kept" }, now);
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const orderId = offered.order.order.id;

      await store.withOrder(orderId, (found) => ({
        save: { ...found, merchantId: B },
        result: null,
      }));

      expect((await store.orderById(orderId))?.merchantId).toBe(A);
      expect((await store.merchantOrder(A, orderId))?.order.id).toBe(orderId);
      expect(await store.merchantOrder(B, orderId)).toBeNull();
    });

    it("gives each merchant their own cards, orders and receipts and nobody else's", async () => {
      // The scoping, in SQL. Every one of these reads is a predicate rather
      // than a filter over what came back, so a row of somebody else's is never
      // selected — and this is the test that dies if one of those predicates is
      // taken out.
      const mine = await store.publishCard(A, { ...syncCard, merchant_item_id: "scoped-a" }, now);
      const theirs = await store.publishCard(B, { ...syncCard, merchant_item_id: "scoped-b" }, now);
      const offered = await gateway.beginPurchase(theirs.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      const theirOrder = offered.order.order.id;
      await store.putReceipt(B, {
        id: "rcp_theirs",
        order_id: theirOrder,
        item_id: theirs.id,
        price: {
          amount: "80.00",
          currency: "USD",
          at: "2026-08-26T12:00:00.000Z",
          as_of: "2026-08-26T12:00:00.000Z",
        },
        paid_at: "2026-08-26T12:00:00.000Z",
        outcome: "delivered",
        test: true,
      });

      // Named one at a time rather than as whole lists, because this suite
      // empties its tables once for the file: what matters is that each of
      // these rows is in exactly one merchant's answer.
      expect((await store.cards(A)).map((card) => card.id)).toContain(mine.id);
      expect((await store.cards(A)).map((card) => card.id)).not.toContain(theirs.id);
      expect((await store.cards(B)).map((card) => card.id)).toStrictEqual([theirs.id]);
      expect((await store.orders(A)).map((held) => held.order.id)).not.toContain(theirOrder);
      expect((await store.orders(B)).map((held) => held.order.id)).toStrictEqual([theirOrder]);
      expect((await store.receipts(A)).map((held) => held.id)).not.toContain("rcp_theirs");
      expect((await store.receipts(B)).map((held) => held.id)).toStrictEqual(["rcp_theirs"]);
      // A receipt written again is brought into line with its order, not sold
      // to somebody else. The merchant is deliberately left out of the upsert's
      // set clause, which is a rule expressed by omission and therefore one
      // nothing else would catch.
      await store.putReceipt(A, {
        id: "rcp_theirs",
        order_id: theirOrder,
        item_id: theirs.id,
        price: {
          amount: "80.00",
          currency: "USD",
          at: "2026-08-26T12:00:00.000Z",
          as_of: "2026-08-26T12:00:00.000Z",
        },
        paid_at: "2026-08-26T12:00:00.000Z",
        outcome: "refund_due",
        test: true,
      });
      expect((await store.receipts(A)).map((held) => held.id)).not.toContain("rcp_theirs");
      expect((await store.receipts(B)).map((held) => held.outcome)).toStrictEqual(["refund_due"]);
      expect(await store.merchantOrder(A, theirOrder)).toBeNull();
      expect((await store.merchantOrder(B, theirOrder))?.order.id).toBe(theirOrder);
      // Pausing is a write, and the same predicate guards it: another
      // merchant's card is neither changed nor reported, which is the same
      // answer a card that is not there gets.
      expect(await store.setCardPaused(A, theirs.id, true)).toBeNull();
      expect((await store.cardById(theirs.id))?.paused).toBe(false);
      // Republishing is the other write. The merchant is half of the conflict
      // target, so a publish only ever edits the publisher's own card.
      const mineAgain = await store.publishCard(
        A,
        { ...syncCard, merchant_item_id: "scoped-b", title: "A's own, under B's identifier" },
        now,
      );
      expect(mineAgain.id).not.toBe(theirs.id);
      expect((await store.cardById(theirs.id))?.card.title).toBe(syncCard.title);
      // And the hold on an order finds nothing where the order is not this
      // merchant's — the ownership is part of the same read as the lock.
      expect(
        await store.withOrder(theirOrder, () => ({ result: "moved it" }), { merchantId: A }),
      ).toStrictEqual({ found: false });
    });

    /**
     * The effects that must not be lost, against the database where the losing
     * would happen (ADR-0013).
     *
     * In memory the promise is an ordering inside one process, which is a
     * different problem from this one: here the envelope is a row pg-boss owns,
     * written on our connection through the handle it takes in its send
     * options, and whether it is really in our transaction is a fact about
     * Postgres that no offline test can establish.
     */
    describe("an effect written where the state is", () => {
      /** How many jobs with this envelope's identifier are on that stream. */
      const jobsFor = async (merchantId: string, envelopeId: string): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(
          `select count(*) as n from ${QUEUE_SCHEMA}.job where name = $1 and data->>'id' = $2`,
          [streamOf(merchantId), envelopeId],
        );
        return Number(rows[0]?.n ?? "0");
      };

      const anEnvelope = (id: string): WorkerEnvelope => ({
        kind: "order_event",
        id,
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.unpaid_after_confirmation",
          order_id: "ord_written_with_the_state",
          at: "2026-08-26T12:00:00.000Z",
        },
      });

      const aReceipt = (orderId: string, itemId: string): Receipt => ({
        id: `rcp_${randomUUID()}`,
        order_id: orderId,
        item_id: itemId,
        price: {
          amount: "80.00",
          currency: "USD",
          at: "2026-08-26T12:00:00.000Z",
          as_of: "2026-08-26T12:00:00.000Z",
        },
        paid_at: "2026-08-26T12:00:00.000Z",
        outcome: "delivered",
        test: true,
      });

      /** An order of A's, priced and waiting to be paid for. */
      const anOrder = async (name: string): Promise<{ id: string; itemId: string }> => {
        const card = await store.publishCard(A, { ...syncCard, merchant_item_id: name }, now);
        const offered = await gateway.beginPurchase(card.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        return { id: offered.order.order.id, itemId: card.id };
      };

      it("is not there at all when the write it went in with rolled back", async () => {
        // The decisive one. The envelope goes into the transaction first and
        // the receipt after it names a merchant that does not exist, so
        // Postgres refuses the second write and takes the first down with it.
        // A pg-boss insert that had gone out on the library's own connection
        // would survive that, and the count below would be one.
        const order = await anOrder("rolled-back");
        const envelopeId = `env_${randomUUID()}`;

        await expect(
          store.withOrder(order.id, (found) => ({
            save: { ...found, priceId: "the write that never happened" },
            alongside: [
              { kind: "envelope", merchantId: A, envelope: anEnvelope(envelopeId) },
              { kind: "receipt", merchantId: "mch_nobody", receipt: aReceipt(order.id, "item") },
            ],
            result: null,
          })),
        ).rejects.toThrow();

        expect(await jobsFor(A, envelopeId)).toBe(0);
        expect(await store.receiptForOrder(order.id)).toBeNull();
        expect((await store.orderById(order.id))?.priceId).not.toBe(
          "the write that never happened",
        );
      });

      it("is there with the order when the write went through", async () => {
        // The negative control for the case above: the same three writes with
        // nothing refusing, so that "no job" there means the rollback and not
        // that this never writes one.
        const order = await anOrder("went-through");
        const envelopeId = `env_${randomUUID()}`;

        await store.withOrder(order.id, (found) => ({
          save: { ...found, priceId: "the write that happened" },
          alongside: [
            { kind: "envelope", merchantId: A, envelope: anEnvelope(envelopeId) },
            { kind: "receipt", merchantId: A, receipt: aReceipt(order.id, order.itemId) },
          ],
          result: null,
        }));

        expect(await jobsFor(A, envelopeId)).toBe(1);
        expect((await store.receiptForOrder(order.id))?.order_id).toBe(order.id);
        expect((await store.orderById(order.id))?.priceId).toBe("the write that happened");
      });
    });

    it("lets one gateway run the sweep and tells the other it is taken", async () => {
      // The lock has to hold across processes and not merely across one,
      // because the overlap that makes it necessary is two gateways — or one
      // gateway handed its own job again after the queue's window ran out. So
      // this is two stores on two pools, which is as close to two processes as
      // one test gets, and the in-memory flag that stands in for this offline
      // could never show it.
      //
      // What it costs to be wrong: both runs read the world, both find the same
      // envelope missing, and both send it. That spends one of the order's
      // deliveries, and the closure at the attempt cap is a refund.
      const oneGateway = connect(databaseUrl, { max: 2 });
      const otherGateway = connect(databaseUrl, { max: 2 });
      const onePool = oneGateway.pool;
      const otherPool = otherGateway.pool;
      try {
        const one = new PostgresStore(oneGateway.db, countedIds());
        const other = new PostgresStore(otherGateway.db, countedIds());

        // The first is held inside the work, so the second arrives while it is
        // genuinely still running rather than after it.
        let letGo: () => void = () => undefined;
        const holding = new Promise<void>((resolve) => {
          letGo = resolve;
        });
        let started: () => void = () => undefined;
        const hasStarted = new Promise<void>((resolve) => {
          started = resolve;
        });

        const first = one.runAlone("a_test_sweep", async () => {
          started();
          await holding;
          return "the one that ran";
        });
        await hasStarted;

        const second = await other.runAlone("a_test_sweep", async () => "should not happen");
        expect(second).toStrictEqual({ ran: false });

        letGo();
        expect(await first).toStrictEqual({ ran: true, result: "the one that ran" });

        // And it is let go afterwards rather than held for the life of the
        // process: the next run finds it free. A lock that leaked would stop
        // every sweep from here on, silently.
        expect(await other.runAlone("a_test_sweep", async () => "free again")).toStrictEqual({
          ran: true,
          result: "free again",
        });
      } finally {
        await onePool.end();
        await otherPool.end();
      }
    }, 30_000);

    it("does not pile a listener onto a connection every time it is handed out", async () => {
      // The other half of the guard. It goes on when a client is checked out and
      // comes off when it is checked back in, and without the second half every
      // query through the pool leaves one behind. A gateway serves the same
      // connection thousands of times a day, so the pile is unbounded: Node
      // starts warning about a leak at eleven listeners on one emitter, and an
      // operator gets a warning about a defect that is not there — plus, when
      // the connection does fail, the one failure written out once per listener.
      //
      // One connection in the pool and twenty turns through it, which is twice
      // what Node tolerates and needs no timing to reproduce. The warning is
      // what is asserted on rather than a count of listeners, because the
      // warning is the thing somebody would actually meet.
      const guarded = connect(databaseUrl, { max: 1 });
      const complaints: string[] = [];
      const noteIt = (warning: Error) => complaints.push(warning.name);
      process.on("warning", noteIt);
      try {
        for (let turn = 0; turn < 20; turn += 1) {
          await guarded.pool.query("select 1");
        }
        // Warnings are emitted on a later tick than the call that caused them.
        await new Promise((resolve) => setImmediate(resolve));
        expect(complaints.filter((name) => name === "MaxListenersExceededWarning")).toStrictEqual(
          [],
        );
      } finally {
        process.removeListener("warning", noteIt);
        await guarded.pool.end();
      }
    }, 30_000);

    it("survives the connection holding an order's transaction being terminated under it", async () => {
      // The same pinned-and-idle connection as the sweep below, on the path that
      // takes money. `withOrder` runs its work inside a drizzle transaction, and
      // a transaction is a client checked out of the pool for the length of the
      // callback — `connect()`, the callback, `release()` in a `finally`, and no
      // error listener anywhere in between.
      //
      // It is not query-bound for that whole stretch either. The runner arms the
      // order's deadlines inside this callback, and that is a round trip on
      // pg-boss's own pool: the transaction's client sits idle, with no query in
      // flight for a fatal to surface through. So a backend terminated then —
      // an administrator, a failover, a pooler dropping an idle session — emits
      // `error` on a client nobody is listening to, which in Node is an uncaught
      // exception and a dead process, and this is the path a purchase runs on.
      //
      // Three things are checked. That nothing reached Node unlistened, asked
      // for directly rather than left to the runner's exit code — without the
      // guard the assertions below all pass and only the run fails, which is a
      // test reporting nothing. That the failure reaches the caller as a
      // failure, since the transaction cannot commit on a connection that is
      // gone. And that the decision it was carrying was not written.
      const owner = connect(databaseUrl, { max: 1 });
      const ownPool = owner.pool;
      try {
        const published = await store.publishCard(
          A,
          { ...syncCard, merchant_item_id: "cut-off-mid-decision" },
          now,
        );
        const offered = await gateway.beginPurchase(published.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        const orderId = offered.order.order.id;

        const own = new PostgresStore(owner.db, countedIds());
        // One connection in the pool, so this is the one the transaction will
        // check out and the one terminated inside it. Asked for before rather
        // than hunted for after, which is what keeps this off everybody else's.
        const pinned = await backendPid(ownPool);

        const unlistened = await whatWentUnlistened(async () => {
          const deciding = own.withOrder(orderId, async (found) => {
            await terminate(pinned);
            // Long enough for the client to notice and emit. Nothing is in
            // flight on it while this waits, which is the whole point.
            await new Promise((resolve) => setTimeout(resolve, 250));
            return { save: { ...found, paidBy: "whoever" }, result: "decided" };
          });

          // Named rather than bare, and the reason is a lesson from this very
          // branch. `terminate` now throws when the backend it aimed at was
          // not there — which is right — but that throw happens inside this
          // callback, drizzle rolls it back and rethrows, and a bare
          // `toThrow()` is satisfied by it. So a run in which nothing was
          // terminated passed everything below, including the check that
          // nothing went unlistened. The matcher is what makes this a test of
          // the connection dying rather than of any failure at all.
          // The words are drizzle's, not Postgres's: when the connection dies
          // mid-transaction the rollback is what fails, and its wrapper carries
          // that rather than the backend's own sentence. Matching it is still
          // the point — a run in which nothing was terminated fails here with
          // the terminate helper's own complaint instead.
          await expect(deciding).rejects.toThrow(/Failed query: rollback/);
        });

        expect(unlistened).toStrictEqual([]);

        // And nothing was written: a decision made on a transaction that could
        // not commit is a decision that did not happen.
        expect((await store.orderById(orderId))?.paidBy).toBeNull();

        // The pool drew a fresh connection rather than handing the broken one
        // back out, so the store still works.
        expect((await own.orderById(orderId))?.order.id).toBe(orderId);
      } finally {
        await ownPool.end();
      }
    }, 30_000);

    it("survives the connection holding the lock being terminated under it", async () => {
      // The connection is pinned out of the pool and then left idle for the
      // whole run, with no query in flight for a fatal to surface through. A
      // checked-out client carries no error listener — the pool takes its own
      // off on the way out and puts it back on release — so without one of ours
      // the `error` event a terminated backend emits is an uncaught exception
      // and a dead process, taking every parked purchase and parked worker with
      // it. The triggers are ordinary: an administrator, a failover, a pooler
      // dropping an idle session, a provider's idle-session timeout.
      //
      // Two things are checked. That nothing reached Node unlistened, asked for
      // directly: leaving it to the run's exit code means every assertion here
      // passes and only the run fails, which is a test that reports nothing.
      // And the answer: the work's own result comes back, rather than the
      // unlock's failure — which sits in a `finally` and would otherwise
      // replace it, reporting a sweep that finished as one that failed and
      // handing its work out again.
      //
      // A pool of its own, so that what is terminated below can only ever be
      // this test's connection. Aimed at the shared one it would take the
      // gateway's own down with it, which is a thing this test did on the way
      // to being written.
      //
      // One connection in it, and that is load-bearing rather than thrift: the
      // second run below has to be handed the same client, so that a broken one
      // put back in the pool is a broken one it draws. With room to spare, a
      // client returned in that state is simply never used again and the test
      // watches nothing.
      const owner = connect(databaseUrl, { max: 1 });
      const ownPool = owner.pool;
      try {
        const own = new PostgresStore(owner.db, countedIds());
        // The pool holds one connection, so this is the one `runAlone` will
        // pin and the one terminated below. Asked for before rather than
        // hunted for after, which is what keeps this off everybody else's.
        const pinned = await backendPid(ownPool);

        let ran: unknown;
        const unlistened = await whatWentUnlistened(async () => {
          ran = await own.runAlone("a_terminated_sweep", async () => {
            await terminate(pinned);
            // Long enough for the client to notice and emit.
            await new Promise((resolve) => setTimeout(resolve, 250));
            return "the work still finished";
          });
        });

        expect(unlistened).toStrictEqual([]);
        expect(ran).toStrictEqual({ ran: true, result: "the work still finished" });

        // And the store still works afterwards: the broken client was destroyed
        // rather than handed back to the pool for somebody else's query to fail
        // on, and the lock went with the backend.
        expect(await own.runAlone("a_terminated_sweep", async () => "free")).toStrictEqual({
          ran: true,
          result: "free",
        });
      } finally {
        await ownPool.end();
      }
    }, 30_000);

    it("gives back the work's own failure and not the connection's", async () => {
      // The other direction of the same `finally`. When the work fails and the
      // unlock fails behind it, the reason that reaches whoever is reading is
      // the work's — the connection's is logged and dropped. Swapped, an
      // operator looking for why a sweep died would find a database error in
      // place of the thing that actually went wrong.
      const owner = connect(databaseUrl, { max: 1 });
      const ownPool = owner.pool;
      try {
        const own = new PostgresStore(owner.db, countedIds());
        const pinned = await backendPid(ownPool);

        const failing = own.runAlone("a_failing_terminated_sweep", async () => {
          await terminate(pinned);
          await new Promise((resolve) => setTimeout(resolve, 250));
          throw new Error("the sweep fell over on its own");
        });

        await expect(failing).rejects.toThrow("the sweep fell over on its own");
      } finally {
        await ownPool.end();
      }
    }, 30_000);

    it("lets go of the lock when the work it was holding for throws", async () => {
      // A sweep that failed part-way is a sweep that has to be able to run
      // tomorrow. Held past a failure, the lock would turn one bad run into a
      // repair that never happens again for as long as the process lives.
      //
      // The second store is on a pool of its own, and that is the whole test
      // rather than scenery. Postgres hands the same session an advisory lock
      // it already holds without complaint, so a retry that happened to get the
      // same connection back would be told yes whether the first run had let go
      // or not — and this passed, wrongly, until it asked from somewhere else.
      const its = connect(databaseUrl, { max: 1 });
      const otherPool = its.pool;
      try {
        const other = new PostgresStore(its.db, countedIds());

        await expect(
          store.runAlone("a_failing_sweep", async () => {
            throw new Error("the sweep fell over");
          }),
        ).rejects.toThrow("the sweep fell over");

        expect(await other.runAlone("a_failing_sweep", async () => "free")).toStrictEqual({
          ran: true,
          result: "free",
        });
      } finally {
        await otherPool.end();
      }
    }, 30_000);

    it("lets go of the name when the unlock fails on a connection that is still alive", async () => {
      // The failure the `finally` above cannot see. A terminated backend takes
      // its locks with it, so an unlock that fails because the connection died
      // costs nothing; an unlock that fails on a session which is still there
      // leaves the name held by a client that goes straight back into the pool
      // holding it. Every sweep after that is told the name is taken and does
      // nothing, and the line it logs is the same line a healthy skip logs —
      // so the daily safety net for effects that went missing is off, and
      // nothing anybody reads says so.
      //
      // What produces it in a deployment is a statement timeout: SQLSTATE
      // 57014, the statement cancelled, the session untouched.
      //
      // Here the unlock is made to fail directly rather than by racing a
      // timeout against a function that returns in microseconds. What is
      // substituted is only the cause — the session is a real one, it really
      // does still hold the lock, because the unlock genuinely never ran — and
      // what is asserted is real database state, asked from a connection that
      // shares nothing with it.
      const held = connect(databaseUrl, { max: 1 });
      const asking = connect(databaseUrl, { max: 1 });
      try {
        const realConnect = held.pool.connect.bind(held.pool);
        Object.assign(held.pool, {
          connect: async () => {
            const client = await realConnect();
            const realQuery = client.query.bind(client);
            Object.assign(client, {
              query: (...args: Parameters<typeof realQuery>) => {
                if (typeof args[0] === "string" && args[0].includes("pg_advisory_unlock")) {
                  return Promise.reject(
                    Object.assign(new Error("canceling statement due to statement timeout"), {
                      code: "57014",
                    }),
                  );
                }
                return realQuery(...args);
              },
            });
            return client;
          },
        });

        const stubborn = new PostgresStore(held.db, countedIds());
        // The run itself is a success and is reported as one. An unlock nobody
        // could complete is not the sweep's failure to hand back to the queue.
        expect(await stubborn.runAlone("a_wedged_sweep", async () => "swept")).toStrictEqual({
          ran: true,
          result: "swept",
        });

        // And the name is free again, because the connection was released with
        // the failure and the pool ended the session rather than keeping it.
        // Ending a session is asynchronous, so this waits — but only for two
        // seconds, well inside the ten the pool would otherwise take to reap an
        // idle connection. A window that reached the reaper would pass with or
        // without the fix.
        const next = new PostgresStore(asking.db, countedIds());
        const until = Date.now() + 2_000;
        let free = await next.runAlone("a_wedged_sweep", async () => "free");
        while (!free.ran && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          free = await next.runAlone("a_wedged_sweep", async () => "free");
        }

        expect(free).toStrictEqual({ ran: true, result: "free" });
      } finally {
        await held.pool.end();
        await asking.pool.end();
      }
    }, 30_000);

    describe("the sweep of what an order is still owed", () => {
      const asyncCard: Card = {
        merchant_item_id: "swept-esim",
        title: "A seven day eSIM",
        description: "Seven days of data",
        price: { amount: "12.00", currency: "USD" },
        result: { activation_code: { type: "string" } },
        fulfillment: "async",
        fulfill_deadline_seconds: 3_600,
      };

      beforeEach(async () => {
        // The sweep asks about every order in the gateway, so what the earlier
        // tests in this file left behind would be swept too and the counts
        // below would be reading their orders as well as this one's. Emptied
        // here rather than in `beforeAll`, which runs once for the file.
        await pool.query("truncate table receipts, orders");
        // And the stream is drained, because the envelopes the earlier tests
        // wrote are still on it and this one counts what arrives.
        await queue.draw(A, 100, 0);
      });

      it("is a no-op on the second run once the first has been acted on", async () => {
        // Run twice against a live database, which is the thing to prove rather
        // than to promise. Two of the three arms are no-ops for a reason in the
        // orders themselves: the receipt is there, so the order is no longer
        // one without a receipt; the merchant has taken the order, so it is no
        // longer sitting in paid.
        const card = await store.publishCard(A, asyncCard, now);
        const offered = await gateway.beginPurchase(card.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        const orderId = offered.order.order.id;

        const paid = `swept-${randomUUID()}`;
        await gateway.runner.presentVerifiedPayment(orderId, paid, paid, now);
        expect((await store.orderById(orderId))?.order.state).toBe("paid");

        // The envelope this sale wrote is drawn off the stream and thrown away.
        // With the dispatch committing alongside the order there is no longer a
        // way to make the gateway produce one without the other, so the state
        // the sweep exists for has to be arranged.
        expect(await queue.draw(A, 10, 2_000)).toHaveLength(1);

        now += gateway.runtime.config.sweepDispatchGraceMs + 60_000;

        const first = await gateway.runner.sweep();
        // Nothing else is running it, so it ran. `null` is how a run says it
        // found the work already in somebody else's hands.
        expect(first).not.toBeNull();
        expect(first?.dispatched).toBe(1);
        expect(first?.refused).toBe(0);

        // The merchant's worker takes the order, which is what the envelope was
        // for and what makes the order no longer one that has reached nobody.
        const worker = workUntilStopped(
          { gateway, merchant: { id: A, name: "", key: "", keyId: "" } },
          { onOrder: () => ({ accepted: {} }) },
        );
        await vi.waitFor(async () => {
          expect((await store.orderById(orderId))?.order.state).toBe("dispatched");
        });
        await worker.stop();

        const second = await gateway.runner.sweep();
        expect(second).toStrictEqual({ dispatched: 0, receipted: 0, rearmed: 0, refused: 0 });
      }, 30_000);

      it("writes the receipt a delivered order has none of, once", async () => {
        const card = await store.publishCard(A, { ...asyncCard, merchant_item_id: "swept-r" }, now);
        const offered = await gateway.beginPurchase(card.id, {});
        if (offered.step !== "pay") throw new Error("no price was offered");
        const orderId = offered.order.order.id;

        const paid = `swept-r-${randomUUID()}`;
        await gateway.runner.presentVerifiedPayment(orderId, paid, paid, now);
        const worker = workUntilStopped(
          { gateway, merchant: { id: A, name: "", key: "", keyId: "" } },
          { onOrder: () => ({ delivered: { activation_code: "CODE" } }) },
        );
        await vi.waitFor(async () => {
          expect((await store.orderById(orderId))?.order.state).toBe("delivered");
        });
        await worker.stop();

        // The receipt is taken out from under it, which is what a record from
        // an older version of this code looks like from here.
        await pool.query("delete from receipts where order_id = $1", [orderId]);
        expect(await store.receiptForOrder(orderId)).toBeNull();

        const first = await gateway.runner.sweep();
        expect(first?.receipted).toBe(1);
        const written = await store.receiptForOrder(orderId);
        expect(written?.outcome).toBe("delivered");

        const second = await gateway.runner.sweep();
        expect(second?.receipted).toBe(0);
        expect(await store.receiptForOrder(orderId)).toStrictEqual(written);
      }, 30_000);
    });

    /**
     * Everything both stores promise, against the one that a merchant's money
     * actually rests on.
     *
     * Inside this suite rather than beside it, because what it needs — the
     * migrated database, the pools, the emptied tables — is what `beforeAll`
     * builds and `afterAll` takes down. Declared as a sibling it would run
     * after the pools had been ended.
     *
     * A store and a pool of its own, and that is the part worth reading before
     * it is changed back. The rest of this file's store shares its pool with a
     * started gateway whose pg-boss workers are polling, and writes its
     * envelopes onto a real stream. The contract needs neither — it never asks
     * for a write alongside an order — and handing it that store would put its
     * transactions and its truncates in the same pool as work nobody in the
     * contract asked for. What the contract's pool does need is room for more
     * than one transaction at a time: two of its cases hold a decision open
     * while another runs, and on a pool of one they would wait for a connection
     * rather than for a lock, which is a different thing that looks identical.
     *
     * Each case is given an empty store, which here means every table emptied.
     * That takes the merchants this file's own `beforeEach` writes as well; the
     * contract makes whatever it needs, and the next case in this file gets
     * them back from that hook.
     */
    describeStore("the store on Postgres", async () => {
      await contract.pool.query(EMPTY_EVERY_TABLE);
      return new PostgresStore(contract.db, countedIds());
    });
  });
}
