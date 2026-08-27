/**
 * The real adapters, against a real Postgres.
 *
 * These are not in `pnpm test`. That command is free, deterministic and works
 * without a network, and a suite that needs a database server is none of those.
 * They run under `pnpm test:db`, which needs DATABASE_URL pointing at a
 * Postgres — `docker compose up -d` brings one up — and skips itself with that
 * sentence when there is none.
 *
 * What is checked here is only what cannot be checked in memory: that the two
 * adapters keep the same promises the in-memory ones do, in the one place where
 * keeping them is a different problem. Above all `withOrder`, whose hold is a
 * chain of promises in one process and a row lock in a database, and which is
 * the thing standing between two events about one order and a charge that
 * happens twice.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "@coinslot/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Gateway } from "../../app/gateway.js";
import type { Runtime } from "../../app/runtime.js";
import { countedIds, testConfig, workUntilStopped } from "../../testing/harness.js";
import { ScriptedFacilitator } from "../memory/facilitator.js";
import { PgBossQueue } from "../pgboss/queue.js";
import { connect, PostgresStore } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

if (databaseUrl === undefined || databaseUrl === "") {
  // Said out loud as well as in the skipped test's name, because a run that
  // reports "1 skipped" and nothing else looks like a suite that passed.
  console.log(
    "\n  The database tests need a Postgres and DATABASE_URL is not set." +
      "\n  Start one with `docker compose up -d`, then:" +
      "\n    DATABASE_URL=postgres://coinslot:coinslot@localhost:5432/coinslot pnpm test:db\n",
  );

  describe("the real adapters", () => {
    it.skip("are skipped: DATABASE_URL is not set, so there is no database to run them against", () => {
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
      // Every table, claims included. Left behind, a claim from the last run
      // owns the fingerprint this run presents and every purchase below is
      // refused — a suite that passes once and never again, on a volume that
      // outlives it.
      await pool.query("truncate table cards, orders, receipts, payment_claims");
      // And the queue's own tables, which are none of ours. They are dropped
      // rather than emptied, and dropped here rather than after the gateway is
      // up, and both of those are lessons from a run that failed.
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
      // What this costs is that pg-boss installs itself from nothing on every
      // run, which is worth having checked anyway.
      await pool.query("drop schema if exists pgboss cascade");

      store = new PostgresStore(connected.db, countedIds());
      boss = new PgBoss(databaseUrl);
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

    afterAll(async () => {
      await gateway.stop();
      await pool.end();
    });

    afterEach(() => {
      now = Date.parse("2026-08-26T12:00:00.000Z");
    });

    it("changes the card that is there when it is published again", async () => {
      const first = await store.publishCard(syncCard, now);
      const again = await store.publishCard({ ...syncCard, title: "Corrected" }, now + 1_000);

      expect(again.id).toBe(first.id);
      expect((await store.cardById(first.id))?.card.title).toBe("Corrected");
      expect(await store.cards()).toHaveLength(1);
    });

    it("publishes a card selling, and keeps a pause across the next publish", async () => {
      // The rule that matters most in this adapter, and it is expressed by
      // omission: `paused` is deliberately not in the upsert's `set:` clause.
      // An edit that puts it back is invisible to `pnpm test` — the only other
      // test for this rule runs against the in-memory store — and what it costs
      // is stock a merchant took off sale back in front of an agent.
      const card = { ...syncCard, merchant_item_id: "kept-paused" };
      const first = await store.publishCard(card, now);
      expect(first.paused).toBe(false);

      await store.setCardPaused(first.id, true);
      const again = await store.publishCard({ ...card, title: "Dearer" }, now + 1_000);

      expect(again.paused).toBe(true);
      expect(again.card.title).toBe("Dearer");
      expect((await store.cardById(first.id))?.paused).toBe(true);
      expect((await store.cards()).find((held) => held.id === first.id)?.paused).toBe(true);
    });

    it("takes a card off sale and puts it back, and says so about one that is not there", async () => {
      const stored = await store.publishCard({ ...syncCard, merchant_item_id: "switched" }, now);

      expect((await store.setCardPaused(stored.id, true))?.paused).toBe(true);
      expect((await store.cardById(stored.id))?.paused).toBe(true);
      expect((await store.setCardPaused(stored.id, false))?.paused).toBe(false);
      expect(await store.setCardPaused("itm_nobody_published_this", true)).toBeNull();
    });

    it("has the merchant selling until somebody says otherwise, and remembers when they do", async () => {
      // The row does not exist until the switch is first pressed, and an absent
      // row means selling. There is no state of the world in which we hold a
      // merchant's cards and cannot say whether they are selling, so this must
      // never answer "I do not know".
      expect(await store.selling()).toBe("open");

      await store.setSelling("paused");
      expect(await store.selling()).toBe("paused");

      await store.setSelling("open");
      expect(await store.selling()).toBe("open");
    });

    it("refuses to guess when the column holds a word the machine does not know", async () => {
      // A hand-edited row, or a value from a version of this code that is not
      // this one. Guessing here would be guessing about whether somebody is
      // selling, which is the one thing this column exists to answer.
      await store.setSelling("paused");
      await pool.query("update merchants set selling = $1", ["sort-of"]);

      await expect(store.selling()).rejects.toThrow(/sort-of/);

      await store.setSelling("open");
    });

    it("holds an order still, so two decisions cannot both write over the same read", async () => {
      // The double-charge test, against the lock that actually runs in
      // production. In memory this is a chain of promises; here it is
      // select ... for update, and the two have to mean the same thing.
      const published = await store.publishCard({ ...syncCard, merchant_item_id: "held" }, now);
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

    it("delivers a reminder, and delivers it again when the handler throws", async () => {
      // A reminder is the only thing that ever declares an overdue order, and
      // the whole of that path — the schedule, the delivery, the retry — is
      // pg-boss doing it. Nothing offline can watch that.
      const seen: string[] = [];
      let failures = 0;
      const watching = new PgBoss(databaseUrl);
      const own = new PgBossQueue(watching, {
        pollIntervalMs: 50,
        reminders: { attempts: 3, retryDelayMs: 1_000 },
      });
      own.onReminder(async (reminder) => {
        seen.push(reminder.kind);
        if (failures < 1) {
          failures += 1;
          throw new Error("the handler was briefly unhappy");
        }
      });
      await own.start();

      try {
        await own.remind(
          { kind: "deadline", orderId: "ord_r", deadline: "quote_expiry", at: 1 },
          0,
        );
        await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1), {
          timeout: 20_000,
          interval: 200,
        });
      } finally {
        await own.stop();
      }

      expect(failures).toBe(1);
    }, 40_000);

    it("takes on work to run every day without complaining", async () => {
      // The sweep of claims on payments is registered through this on every
      // start. It is unexecuted everywhere else, and a schedule pg-boss refuses
      // would take the gateway's start down with it.
      await expect(
        queue.everyDay("coinslot_a_daily_sweep", async () => undefined),
      ).resolves.toBeUndefined();
    }, 30_000);

    it("says an order is not there rather than throwing", async () => {
      expect(await store.withOrder("ord_nope", () => ({ result: 1 }))).toStrictEqual({
        found: false,
      });
    });

    it("carries an envelope through the queue and does not send it round again by itself", async () => {
      const published = await store.publishCard({ ...syncCard, merchant_item_id: "queued" }, now);
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");

      const drawn = await queue.draw(10, 2_000);
      expect(drawn).toHaveLength(0);

      await queue.publish({
        kind: "order_event",
        id: "env_db_1",
        sent_at: "2026-08-26T12:00:00.000Z",
        payload: {
          type: "order.unpaid_after_confirmation",
          order_id: "ord_db_1",
          at: "2026-08-26T12:00:00.000Z",
        },
      });

      const first = await queue.draw(10, 2_000);
      expect(first.map((d) => d.envelope.id)).toStrictEqual(["env_db_1"]);
      await queue.finish(first[0]?.handle ?? "");

      expect(await queue.draw(10, 200)).toStrictEqual([]);
    });

    it("walks a whole synchronous sale through the database and the queue", async () => {
      // Everything from here is the same flow the in-memory tests walk. What
      // this adds is that it survives the round trip through JSONB and through
      // a queue that is a table.
      const published = await store.publishCard({ ...syncCard, merchant_item_id: "walked" }, now);
      const offered = await gateway.beginPurchase(published.id, {});
      if (offered.step !== "pay") throw new Error("no price was offered");

      const worker = workUntilStopped(
        { gateway },
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
    }, 30_000);
  });
}
