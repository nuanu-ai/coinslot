/**
 * The migration that gives an account a merchant, run against an account that
 * already existed.
 *
 * The rest of `pnpm test:db` runs against a database the migrator built from
 * nothing, where `0001_merchant_on_account.sql` alters an empty table — so the
 * one situation it was written for is exercised nowhere. That situation is a
 * deployed server with a row in `cabinet_accounts` that was written before
 * accounts had merchants at all, and it is the reason the two columns are
 * nullable: a NOT NULL column cannot be added to a table that already has rows
 * in it, and the migration would stop half way with the cabinet down.
 *
 * So a database is stood up at the version before the change, an account is
 * written the way that version wrote them, and then the migration runs. What is
 * checked is not that it completes: it is that the row is still there
 * afterwards, still signs in with the password it had, and reads as an account
 * with no merchant rather than as one whose merchant is an empty string.
 *
 * The migrations are applied as SQL rather than through drizzle's migrator,
 * because the point is to stop part way and the migrator applies everything in
 * the folder. What runs here is the exact text a deployment applies, split on
 * the breakpoints the migrator splits on.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@coinslot/gateway/testing/database";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postgresAccounts } from "./accounts-postgres.js";

/**
 * A database of this file's own, beside the one the rest of `pnpm test:db` uses.
 *
 * Standing the cabinet's tables up at the version before the change and then
 * moving them is not something to do to tables another suite is emptying
 * between its own tests.
 */
const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/coinslot_test_cabinet_migration";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");

/** One migration file, as the statements the migrator would run one by one. */
async function statementsOf(file: string): Promise<string[]> {
  const sql = await readFile(join(migrationsIn, file), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));

  describe("the migration that gives an account a merchant", () => {
    it.skip("is skipped: there is no Postgres to run it against", () => {
      // Intentionally empty: the message above is the whole point.
    });
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  const run = async (file: string): Promise<void> => {
    for (const statement of await statementsOf(file)) {
      await pool.query(statement);
    }
  };

  describe("the migration that gives an account a merchant", () => {
    beforeEach(async () => {
      await pool.query("drop table if exists cabinet_sessions, cabinet_accounts");
      await run("0000_accounts.sql");
    });

    it("leaves the account that was already there able to sign in", async () => {
      // The row a deployed cabinet is holding: an address, a derivation, and a
      // moment. Written with the columns that version had and no others, which
      // is what makes this a test of the migration rather than of the schema
      // file the code agrees with.
      await pool.query(
        `insert into cabinet_accounts (id, email, password_hash, created_at)
         values ($1, $2, $3, $4)`,
        [
          "acc_before_merchants",
          "dmitry@example.com",
          "scrypt$32768$8$1$c2FsdA$a2V5",
          new Date("2026-08-27T09:00:00.000Z"),
        ],
      );

      await run("0001_merchant_on_account.sql");

      const found = await postgresAccounts(pool).byEmail("dmitry@example.com");
      expect(found?.id).toBe("acc_before_merchants");
      expect(found?.passwordHash).toBe("scrypt$32768$8$1$c2FsdA$a2V5");
      // Read as having no merchant at all, which is a state the sign-in has a
      // sentence for — and not as one whose merchant is an empty identifier
      // with an empty key, which would be a cabinet asking the gateway to
      // accept nothing on every screen.
      expect(found?.merchant).toBeNull();
    });

    it("lets an account made after it carry a merchant, on the same table", async () => {
      // The negative control for the test above: the columns are not merely
      // absent-tolerant, they hold what they are given. Without this, a
      // migration that added nothing at all would pass everything here.
      await run("0001_merchant_on_account.sql");
      const accounts = postgresAccounts(pool);

      await accounts.add("fresh@example.com", "scrypt$32768$8$1$c2FsdA$a2V5", new Date(), {
        id: "mer_the_merchant",
        key: "the-merchants-own-key",
      });

      expect((await accounts.byEmail("fresh@example.com"))?.merchant).toStrictEqual({
        id: "mer_the_merchant",
        key: "the-merchants-own-key",
      });
    });
  });
}
