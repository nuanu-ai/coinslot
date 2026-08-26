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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "@coinslot/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
      await pool.query("truncate table cards, orders, receipts");

      store = new PostgresStore(connected.db, countedIds());
      queue = new PgBossQueue(new PgBoss(databaseUrl), { pollIntervalMs: 50 });
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
      await queue.stop();
      await queue.start();
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
      const bought = await gateway.payPurchase(offered.order.order.id, "PAYMENT");
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
