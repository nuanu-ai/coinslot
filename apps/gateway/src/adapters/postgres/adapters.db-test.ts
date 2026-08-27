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
 * What is checked here is only what cannot be checked in memory: that the two
 * adapters keep the same promises the in-memory ones do, in the one place where
 * keeping them is a different problem. Above all `withOrder`, whose hold is a
 * chain of promises in one process and a row lock in a database, and which is
 * the thing standing between two events about one order and a charge that
 * happens twice.
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
import type { Card } from "@coinslot/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Gateway } from "../../app/gateway.js";
import type { Runtime } from "../../app/runtime.js";
import type { OrderChange, Store } from "../../ports/store.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { countedIds, testConfig, workUntilStopped } from "../../testing/harness.js";
import { ScriptedFacilitator } from "../memory/facilitator.js";
import { MemoryStore } from "../memory/store.js";
import { PgBossQueue } from "../pgboss/queue.js";
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
      // Every run starts from an empty catalog, or the counts below would be
      // reading somebody else's leftovers.
      //
      // Every table this schema has, and the list is meant to stay that way. A
      // claim on a payment left behind owns the fingerprint this run presents,
      // and every purchase below is refused — a suite that passes once and
      // never again, on a volume that outlives it. The merchant's row is here
      // for the same reason before it has cost anybody an afternoon: it carries
      // whether they are selling at all, so a run that ever pauses them would
      // leave every later run's purchases turned away, and the failure would
      // look like anything but its cause. A table added to `schema.ts` belongs
      // in this list.
      await pool.query(
        "truncate table cards, orders, receipts, payment_claims, merchant_keys, merchants",
      );
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

      store = new PostgresStore(connected.db, countedIds());
      boss = new PgBoss({ connectionString: databaseUrl, schema: QUEUE_SCHEMA });
      queue = new PgBossQueue(boss, {
        pollIntervalMs: 50,
        reminders: { attempts: 3, retryDelayMs: 1_000 },
      });
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

      expect(results.map((r) => (r.found ? r.result : null)).sort()).toStrictEqual([1, 2, 3]);
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
      const alicePool = new Pool({ connectionString: databaseUrl, max: 1 });
      const bobPool = new Pool({ connectionString: databaseUrl, max: 1 });
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

        const aliceTaking = take(new PostgresStore(drizzle(alicePool), countedIds()), "alice");
        await bobMayStart;
        const bobTaking = take(new PostgresStore(drizzle(bobPool), countedIds()), "bob");
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

    it("claims a payment the same way in memory and in the database", async () => {
      // The whole of the application logic is tested against the in-memory
      // store, so every promise the flows rely on is really a promise about
      // both adapters. The replay guard is the one where the two are least
      // alike: a map and a check in memory, one insert and a primary key here.
      // The same script is run through each and the answers have to match, or
      // a purchase that the offline suite says is refused is a purchase that
      // goes through in production.
      const script = async (subject: Store) => ({
        first: await subject.claimPayment("fp-parity", "ord_one"),
        anotherOrder: await subject.claimPayment("fp-parity", "ord_two"),
        // The retry the portal promises is safe.
        ownRetry: await subject.claimPayment("fp-parity", "ord_one"),
        // Letting go is the holder's to do and nobody else's: an order that
        // never held this fingerprint asking for it back leaves it exactly
        // where it was, so one buyer can never free another buyer's signature.
        strangerLetsGo: await (async () => {
          await subject.releaseClaim("fp-parity", "ord_two");
          return subject.claimPayment("fp-parity", "ord_two");
        })(),
        // The holder letting go frees it, which is what a buyer turned away for
        // ownership gets back.
        holderLetsGo: await (async () => {
          await subject.releaseClaim("fp-parity", "ord_one");
          return subject.claimPayment("fp-parity", "ord_two");
        })(),
        // The sweep runs against a table this suite shares, so what is compared
        // is that something went and not how many — the count is not the same
        // question in a table other tests have written to.
        sweptSomething: (await subject.forgetClaimsBefore(Date.now() + 60_000)) > 0,
        afterTheSweep: await subject.claimPayment("fp-parity", "ord_two"),
      });

      const inTheDatabase = await script(store);
      const inMemory = await script(new MemoryStore(countedIds()));

      expect(inTheDatabase).toStrictEqual(inMemory);
      // Said outright as well as compared, so a day when both adapters are
      // wrong in the same way is not a day this test passes.
      expect(inTheDatabase).toStrictEqual({
        first: { claimed: true },
        anotherOrder: { claimed: false, heldBy: "ord_one" },
        ownRetry: { claimed: true },
        strangerLetsGo: { claimed: false, heldBy: "ord_one" },
        holderLetsGo: { claimed: true },
        sweptSomething: true,
        afterTheSweep: { claimed: true },
      });
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

      expect(await store.merchantForKey("door-a")).toBe(A);
      expect(await store.merchantForKey("door-b")).toBe(B);

      await store.disableKey("mk_door_a", now + 1_000);

      // And it is refused in exactly the words a key nobody was issued gets, so
      // a revoked key is not a way of confirming that a guess was once real.
      expect(await store.merchantForKey("door-a")).toBeNull();
      expect(await store.merchantForKey("a-digest-nobody-was-issued")).toBeNull();
      // B's key is untouched, which is the whole reason a key is a row.
      expect(await store.merchantForKey("door-b")).toBe(B);
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
  });
}
