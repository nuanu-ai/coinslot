/**
 * The account store the cabinet actually runs on, against a real Postgres.
 *
 * This is not in `pnpm test`: that command is free, deterministic and works
 * without a network, and a suite needing a database server is none of those. It
 * runs under `pnpm test:db`, which needs a Postgres — `docker compose up -d
 * --wait postgres` brings one up — and skips itself with a sentence saying so
 * when there is none.
 *
 * The database is `coinslot_test`, which the gateway's suites already own and
 * which is not the one the stack runs on. The reason that separation exists is
 * written out in the gateway's `testing/database.ts`, and the same guard is
 * reused here rather than written again: a suite that empties tables must never
 * be pointed at the database a merchant's cabinet is showing.
 *
 * What this file proves that the in-memory suite cannot: that a session ends
 * when a row is deleted rather than when a map forgets a key, that a second
 * account at one address is refused by the database and not merely by a check
 * above it, and that the migrations in `drizzle/` actually produce the tables
 * the store queries. That last one is the whole reason a checked-in migration
 * exists — a schema file the code agrees with and the database has never seen
 * is a deployment that fails on its first sign-in.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@coinslot/gateway/testing/database";
import { afterAll, describe, it } from "vitest";
import { connect, migrateAccounts, postgresAccounts } from "./accounts-postgres.js";
import { describeAccounts } from "./testing/accounts-contract.js";

const wanted = testDatabaseUrl();
const databaseUrl = await readyDatabase(wanted);

if (databaseUrl === null) {
  // Said out loud as well as in the skipped test's name: a run reporting "1
  // skipped" and nothing else reads like a suite that passed.
  console.log(noDatabaseHere(wanted));

  describe("the account store on Postgres", () => {
    it.skip("is skipped: there is no Postgres to run it against", () => {
      // Intentionally empty: the message above is the whole point.
    });
  });
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const pool = connect(databaseUrl);
  await migrateAccounts(pool, join(here, "..", "drizzle"));
  const store = postgresAccounts(pool);

  afterAll(async () => {
    await pool.end();
  });

  describeAccounts("the account store on Postgres", async () => {
    await pool.query("truncate table cabinet_sessions, cabinet_accounts");
    // The pool outlives one test, so closing is the file's job rather than each
    // test's; the contract still calls close, and here it has nothing to do.
    return { ...store, close: async () => undefined };
  });
}
