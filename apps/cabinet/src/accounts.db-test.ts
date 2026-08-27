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
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Accounts } from "./accounts.js";
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

  describe("when the database will not answer", () => {
    /**
     * Everything an unhandled exception would put in the log.
     *
     * `console.error` prints an exception's causes as well as its own message,
     * so the whole chain is what actually reaches whatever collects the log —
     * and the whole chain is what this reads.
     */
    const asLogged = (thrown: unknown): string => {
      const said: string[] = [];
      let at: unknown = thrown;
      for (let deep = 0; deep < 8 && at !== null && at !== undefined; deep += 1) {
        said.push(String(at), JSON.stringify(at) ?? "");
        at = typeof at === "object" && "cause" in at ? (at as { cause: unknown }).cause : null;
      }
      return said.join(" ");
    };

    /** A store whose every query fails, which is a pool that has been let go. */
    const broken = async (): Promise<Accounts> => {
      const its = connect(databaseUrl);
      const store = postgresAccounts(its);
      // Through the store's own `close`, which is the one member of the
      // contract the suite next door cannot exercise: it runs against a shared
      // pool and has to leave it open.
      await store.close();
      return store;
    };

    it("does not put the parameters of the failed query into the exception", async () => {
      // Drizzle wraps every driver error in one whose message is the SQL it
      // tried followed by every bound parameter. Left alone, a connection reset
      // during a sign-in put the live session's fingerprint into the log, and
      // one during a password change put the new derivation there — the two
      // values this whole arrangement exists to keep out of a log, on a path
      // nobody reading the call site would think about.
      const store = await broken();
      const fingerprint = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
      const stored = "scrypt$32768$8$1$c2FsdHNhbHRzYWx0c2E$VEhJUy1JUy1USEUtREVSSVZFRC1LRVk";

      const said = await Promise.all(
        [
          () => store.whose(fingerprint, new Date()),
          () => store.setPassword("dmitry@example.com", stored),
          () => store.add("dmitry@example.com", stored, new Date()),
          () => store.open(fingerprint, "acc_1", new Date(), new Date()),
          () => store.end(fingerprint),
          () => store.byEmail("dmitry@example.com"),
          () => store.endEveryFor("dmitry@example.com"),
          () => store.list(new Date()),
        ].map(async (run) => {
          try {
            await run();
            return "";
          } catch (thrown) {
            return asLogged(thrown);
          }
        }),
      );

      for (const line of said) {
        expect(line, line).not.toBe("");
        expect(line, line).not.toContain(fingerprint);
        expect(line, line).not.toContain(stored);
        expect(line, line).not.toContain("VEhJUy1JUy1USEUtREVSSVZFRC1LRVk");
        // And no SQL either: a query's text names the tables, which is fine,
        // but drizzle's message is the query *and* the parameters together and
        // there is no version of it that carries one without the other.
        expect(line, line).not.toContain("params:");
      }
      // What it does say is what somebody reading a log can act on.
      expect(said[0]).toContain("session");
    });
  });

  describe("when a connection is dropped while nobody is using it", () => {
    it("is logged, and the pool goes on rather than the process ending", async () => {
      // A database restart, a failover, an idle reaper or `docker compose
      // restart postgres` closes a connection the pool is holding and nobody is
      // waiting on. `pg` reports that as an `error` event on the pool itself,
      // and an `error` event with no listener is an uncaught exception in Node
      // — the cabinet exits, and the merchant cannot reach the control that
      // stops their selling until somebody starts it again. Every other kind of
      // database trouble surfaces on the next query, where somebody is waiting
      // for an answer; this one does not.
      //
      // The drop is real rather than simulated: the backend behind this pool's
      // own idle connection is terminated from a second connection, which is
      // what a restart of the server does to every connection at once.
      const said: string[] = [];
      const printed = vi.spyOn(console, "error").mockImplementation((...line) => {
        said.push(line.map(String).join(" "));
      });

      const its = connect(databaseUrl);
      const { rows } = await its.query<{ pid: number }>("select pg_backend_pid() as pid");
      const backend = rows[0]?.pid ?? 0;
      expect(backend).toBeGreaterThan(0);

      const other = connect(databaseUrl);
      await other.query("select pg_terminate_backend($1)", [backend]);
      await other.end();

      // Waited for rather than slept through, and bounded: the connection is
      // gone once the pool has let go of it, which on a local server is a few
      // milliseconds and on a slow one is not.
      for (let waited = 0; waited < 100 && its.totalCount > 0; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(its.totalCount).toBe(0);

      // Still here, and still able to answer. Without a listener on the pool
      // this line is never reached, because the process is gone by now — which
      // is why the failure shows up as an unhandled error on the run rather
      // than as a failed assertion in this test.
      await expect(its.query("select 1 as ok")).resolves.toMatchObject({ rowCount: 1 });
      await its.end();

      // And somebody reading the log is told, because a connection that went
      // away silently is a restart nobody can correlate anything with.
      printed.mockRestore();
      expect(said.join("\n")).toContain("[cabinet] an idle database connection failed");
    });
  });

  describeAccounts("the account store on Postgres", async () => {
    await pool.query("truncate table cabinet_sessions, cabinet_accounts");
    // The pool outlives one test, so closing is the file's job rather than each
    // test's; the contract still calls close, and here it has nothing to do.
    return { ...store, close: async () => undefined };
  });
}
