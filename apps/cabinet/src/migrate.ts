/**
 * Applies the cabinet's checked-in migrations to the database DATABASE_URL
 * names.
 *
 * A step somebody takes rather than something the cabinet does on start: a
 * process that migrates on boot migrates once per replica, and the day there
 * are two of them they race each other over the same tables. In the local stack
 * this runs in the `migrate` service, before the cabinet is started.
 *
 * These are the cabinet's own four tables and their history is kept apart from
 * the gateway's, in `drizzle.cabinet_migrations` — see `database.ts` for why
 * two migration sets cannot share one journal.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, migrateAccounts } from "./database.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is not set, so there is no database to migrate.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const pool = connect(databaseUrl);

try {
  await migrateAccounts(pool, join(here, "..", "drizzle"));
  console.log("The cabinet's accounts, sessions, passwords and links are up to date.");
} finally {
  await pool.end();
}
