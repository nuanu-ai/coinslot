/**
 * What the Postgres store lets out when the database refuses.
 *
 * The store needs a database and is tested against one under `pnpm test:db`.
 * One thing about it must not wait for a server to be running, and this file is
 * that one thing: the shape of the exception. The account command reads it to
 * decide whether an operator is looking at a database the cabinet's migrations
 * have never been run against, and that link broke once — silently, and for
 * months — because the only thing holding it needed Postgres.
 *
 * What stands in for the database is the driver and nothing above it. Drizzle
 * still wraps what the driver throws and the store still walks the chain, so
 * what is under test is the whole road from a driver's error to the sentence
 * and the code a caller is handed.
 */

import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { postgresAccounts } from "./accounts-postgres.js";

/** A database that answers every query with one of its own errors. */
const refusing = (code: string, said: string): Pool =>
  ({
    query: () => Promise.reject(Object.assign(new Error(said), { code })),
    end: () => Promise.resolve(),
    on: () => undefined,
  }) as unknown as Pool;

describe("an exception out of the account store", () => {
  it("carries the database's own code, which is what a caller can act on", async () => {
    // 42P01 is "there is no table by that name", and the account command has a
    // sentence for it that names the migration to run. It can only recognise it
    // by the code, because the store deliberately does not pass the driver's
    // own exception up.
    const store = postgresAccounts(refusing("42P01", 'relation "cabinet_accounts" does not exist'));

    const failed: unknown = await store.list(new Date()).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(failed).toBeInstanceOf(Error);
    expect((failed as { code?: unknown }).code).toBe("42P01");
  });

  it("says which operation it was, and nothing the query carried", async () => {
    // Drizzle's own wrapper is the SQL it tried followed by every bound
    // parameter, so a failure during a sign-in would put a live session's
    // fingerprint in the log and one during a password change would put the new
    // derivation there. Neither is visible from reading the call site, which is
    // why nothing from the driver is allowed out of that file.
    const store = postgresAccounts(refusing("57P03", "the database is starting up"));
    const fingerprint = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    const failed: unknown = await store.whose([fingerprint], new Date()).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(String(failed)).toContain("reading of a session");
    expect(String(failed)).toContain("57P03");
    expect(String(failed)).not.toContain(fingerprint);
    // And no cause either: `console.error` prints an exception's causes, so a
    // cause kept for convenience would put the parameters straight back.
    expect((failed as { cause?: unknown }).cause).toBeUndefined();
  });
});
