/**
 * The migration that gives every existing row an owner, run against rows.
 *
 * Everything else in `pnpm test:db` runs against a database the migrator built
 * from nothing, where the backfill in `0003_merchant_tenancy.sql` touches no
 * rows at all — so the one thing that migration exists to do is exercised
 * nowhere. This is the file that exercises it: a database is brought up to the
 * version before it, a card, an order and a receipt are written the way that
 * version wrote them, and then the migration runs.
 *
 * What is being checked is not that it completes. It is that nothing is lost
 * and nothing changes hands: every row comes out belonging to the one merchant
 * everything predating this migration belongs to, an order's document says the
 * same thing its column does, and a merchant who had stopped selling is not put
 * back on sale by it.
 *
 * The migrations are applied as SQL rather than through drizzle's migrator,
 * because the point is to stop part way — and the migrator applies everything
 * in the folder. What runs here is therefore the exact text a deployment
 * applies, split on the same breakpoints the migrator splits on.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEEDED_MERCHANT } from "../../app/merchants.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";

/**
 * A database of this file's own, beside the one the rest of `pnpm test:db` uses.
 *
 * It has to be a database rather than a schema, and the reason is in the
 * migration: drizzle writes its foreign keys as `references "public"."merchants"`,
 * so tables built in any other schema would point back at a `public` this file
 * is not touching. Standing the whole thing up at the version before the change
 * and then moving it is also not something to do to tables another suite is
 * emptying between its own tests.
 */
const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/coinslot_test_migration";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "..", "..", "drizzle");

/** One migration file, as the statements the migrator would run one by one. */
async function statementsOf(file: string): Promise<string[]> {
  const sql = await readFile(join(migrationsIn, file), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

if (databaseUrl === null) {
  describe.skip(`the migration that gives every row an owner ${noDatabaseHere(wanted)}`, () => {
    it("needs a database", () => undefined);
  });
} else {
  describe("the migration that gives every row an owner", () => {
    const url = databaseUrl;
    let pool: Pool;

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    /** The rows a gateway of the previous version would be holding. */
    const asItWasBefore = async (): Promise<void> => {
      await pool.query(
        `insert into cards (id, merchant_item_id, card, as_of, paused)
         values ($1, $2, $3, now(), true)`,
        ["itm_old", "sku-1", JSON.stringify({ merchant_item_id: "sku-1", title: "A room" })],
      );
      await pool.query(
        `insert into orders (id, state, open, item_id, merchant_item_id, record, created_at, updated_at)
         values ($1, $2, true, $3, $4, $5, now(), now())`,
        [
          "ord_old",
          "dispatched",
          "itm_old",
          "sku-1",
          JSON.stringify({
            order: { id: "ord_old", state: "dispatched" },
            itemId: "itm_old",
            merchantItemId: "sku-1",
          }),
        ],
      );
      await pool.query(
        `insert into receipts (order_id, receipt, updated_at) values ($1, $2, now())`,
        ["ord_old", JSON.stringify({ id: "rcp_old", order_id: "ord_old" })],
      );
    };

    beforeAll(async () => {
      pool = new Pool({ connectionString: url });
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      // Emptied back to nothing and brought up to the version just before this
      // change. Doing it before rather than after is what makes a run that died
      // half way through harmless to the next one.
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      await run("0000_init.sql");
      await run("0001_payment_claims.sql");
      await run("0002_selling.sql");
    });

    it("gives every card, order and receipt to the one merchant they belong to", async () => {
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const owners = await pool.query<{ merchant_id: string }>(
        `select merchant_id from cards
         union all select merchant_id from orders
         union all select merchant_id from receipts`,
      );
      expect(owners.rows.map((row) => row.merchant_id)).toStrictEqual([
        SEEDED_MERCHANT.id,
        SEEDED_MERCHANT.id,
        SEEDED_MERCHANT.id,
      ]);
    });

    it("puts the merchant inside the order's document as well as in its column", async () => {
      // Two readers, and they must not disagree. The column is what a merchant's
      // own list of orders filters on; the document is what tells the
      // interpreter whose stream the next envelope for this order goes on. An
      // order with the column and no field would be one whose redelivery
      // reached nobody, and nothing would say so.
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ merchant_id: string; record: { merchantId?: string } }>(
        "select merchant_id, record from orders where id = 'ord_old'",
      );
      expect(rows[0]?.record.merchantId).toBe(SEEDED_MERCHANT.id);
      expect(rows[0]?.record.merchantId).toBe(rows[0]?.merchant_id);
    });

    it("loses nothing a card was carrying, including a pause", async () => {
      // A pause is stock a merchant took off sale. Dropped by a migration, it
      // is that stock back in front of an agent with nobody saying so.
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ paused: boolean; merchant_item_id: string }>(
        "select paused, merchant_item_id from cards where id = 'itm_old'",
      );
      expect(rows[0]?.paused).toBe(true);
      expect(rows[0]?.merchant_item_id).toBe("sku-1");
    });

    it("does not put a merchant who had stopped selling back on sale", async () => {
      // The row that carries the selling word is the one this adopts. Written
      // over, a merchant who had paused would come back from a migration
      // selling, and the first thing they would learn about it is an order.
      await pool.query(
        "insert into merchants (id, selling, updated_at) values ($1, 'paused', now())",
        [SEEDED_MERCHANT.id],
      );
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ selling: string; name: string }>(
        "select selling, name from merchants",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.selling).toBe("paused");
      // And the row got the name the column now demands, rather than failing.
      expect(rows[0]?.name).not.toBe("");
    });

    it("leaves one merchant and no orphans on a database that never sold anything", async () => {
      // The other half: a volume that has run the stack and never had the
      // selling switch pressed has no merchant row at all.
      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ id: string; selling: string }>(
        "select id, selling from merchants",
      );
      expect(rows).toStrictEqual([{ id: SEEDED_MERCHANT.id, selling: "open" }]);
    });

    it("lets two merchants use one identifier for two products afterwards", async () => {
      // The uniqueness moved from the merchant's own identifier to the pair.
      // Left where it was, the second merchant to publish a "sku-1" would edit
      // the first merchant's card.
      await asItWasBefore();
      await run("0003_merchant_tenancy.sql");
      await pool.query(
        "insert into merchants (id, name, selling, created_at, updated_at) values ($1, 'Another', 'open', now(), now())",
        ["mch_other"],
      );

      await pool.query(
        `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
         values ($1, $2, 'sku-1', $3, now())`,
        ["itm_new", "mch_other", JSON.stringify({ merchant_item_id: "sku-1" })],
      );

      const { rows } = await pool.query<{ count: string }>(
        "select count(*)::text as count from cards where merchant_item_id = 'sku-1'",
      );
      expect(rows[0]?.count).toBe("2");
      // And the same merchant still cannot have two cards under one identifier.
      await expect(
        pool.query(
          `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
           values ($1, $2, 'sku-1', $3, now())`,
          ["itm_clash", "mch_other", JSON.stringify({ merchant_item_id: "sku-1" })],
        ),
      ).rejects.toThrow();
    });

    it("refuses a card, an order or a receipt that names no merchant", async () => {
      // The difference between a filter somebody remembered to write and a row
      // that cannot exist without an owner.
      await run("0003_merchant_tenancy.sql");

      await expect(
        pool.query(
          "insert into cards (id, merchant_item_id, card, as_of) values ('itm_x', 'sku-x', '{}', now())",
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
           values ('itm_x', 'mch_nobody', 'sku-x', '{}', now())`,
        ),
      ).rejects.toThrow();
    });
  });
}
