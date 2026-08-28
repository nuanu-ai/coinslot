/**
 * The connection the cabinet's own four tables live behind, and the step that
 * brings them up to date.
 *
 * Nothing here reads or writes a row. The component that signs people in does
 * all of that through drizzle (ADR-0009), and what this file owns is the two
 * things a component cannot own for us: a pool that does not take the process
 * down when a connection dies, and a migration history kept apart from the
 * gateway's.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Where the cabinet's migrations keep their own history.
 *
 * Not the default, which is the gateway's. Two independent sets of migrations
 * sharing one journal would each read the other's entries as its own and
 * conclude there was nothing to apply.
 */
const MIGRATIONS_TABLE = "cabinet_migrations";

/**
 * One pool for the process, with the one listener it cannot run without.
 *
 * A pool reports the failure of a connection nobody is waiting on — a database
 * restart, a failover, an idle reaper — as an `error` event on itself, and an
 * `error` event with no listener is an uncaught exception and a dead process.
 * Every other kind of database trouble arrives at a caller; this one arrives at
 * nobody, so without this the cabinet exits and the merchant cannot reach the
 * control that stops their selling until somebody starts the process again.
 *
 * The gateway's store has carried the same three lines and the same reasoning
 * since before this file existed, and it did not travel here on its own.
 *
 * What is logged is the name and the message, not the object. A driver's own
 * exception carries the query it was running and every value bound into it, and
 * those values are a session identifier and a password derivation; `String`
 * leaves every property behind.
 */
export function connect(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  const noticeTheFailure = (failed: unknown): void => {
    console.error(`[cabinet] a database connection failed: ${String(failed)}`);
  };

  // The pool's own listener covers a connection sitting idle in the pool. It
  // does not cover one that has been handed out: pg-pool removes it on the way
  // out and puts it back on the way in, so between those a checked-out client
  // has no listener at all — and an error event with no listener is an uncaught
  // exception and a dead process.
  //
  // That matters here because a transaction is exactly a checked-out client
  // held across more than one statement. `acquire` fires before the removal and
  // `release` after the restoration, so this pair leaves no gap at either edge.
  // The gateway learned this the expensive way and this is the same three lines
  // (`apps/gateway/src/adapters/postgres/store.ts`).
  pool.on("error", noticeTheFailure);
  pool.on("acquire", (client) => client.on("error", noticeTheFailure));
  pool.on("release", (_failed, client) => client.removeListener("error", noticeTheFailure));
  return pool;
}

/** Brings the cabinet's four tables up to date. A step somebody takes. */
export async function migrateAccounts(pool: Pool, migrationsFolder: string): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
}
