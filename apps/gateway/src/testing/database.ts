/**
 * The database the suite that needs a database is allowed to empty.
 *
 * It is not the one the stack runs on, and that separation is the whole of this
 * file. `compose.yaml` publishes Postgres on 5432 so that a terminal and this
 * suite can reach it, and the suite empties every table it finds and drops the
 * queue's schema — so pointed at the stack's own database it empties the
 * catalogue a merchant just published and the orders the cabinet is showing,
 * while somebody is looking at them. That happened: a merchant process
 * published two cards and the catalogue afterwards held seven of this suite's
 * fixtures and neither of them. Nothing warned anybody, and nothing was broken
 * afterwards either, which is the worst version of it — the evening is spent
 * looking for a bug in the cabinet.
 *
 * So the suite gets `coinslot_test` beside `coinslot`, on the same server, and
 * takes it as its own.
 *
 * The database is created here rather than only by an init script on the
 * postgres service, and the reason is worth keeping. Postgres runs the scripts
 * in `/docker-entrypoint-initdb.d` only when it initialises an empty data
 * directory, and the volume outlives `docker compose down`. Every developer who
 * has already run the stack — which is all of them — would find `pnpm test:db`
 * failing with "database coinslot_test does not exist" until somebody told them
 * to destroy their volume. A safety change that arrives as a broken morning is
 * a safety change people work around. The init script is still there for a
 * fresh volume, so that a psql session finds the database without running the
 * suite first; this is what makes it true everywhere else.
 */

import { Pool } from "pg";

/** The database this suite owns. */
export const TEST_DATABASE = "coinslot_test";

/** The database the stack runs on, which this suite must never be given. */
const THE_STACK_DATABASE = "coinslot";

/** Where the suite looks when nobody says otherwise. */
export const DEFAULT_TEST_DATABASE_URL = `postgres://coinslot:coinslot@localhost:5432/${TEST_DATABASE}`;

/** Postgres's own answer for "that database is not there". */
const NO_SUCH_DATABASE = "3D000";

/**
 * What the suite should run against: DATABASE_URL when it is set, and the
 * suite's own database when it is not.
 *
 * Being set to the stack's database is refused rather than obeyed. This suite
 * empties what it is given, and there is no reading of "empty the database the
 * cabinet is showing" that is worth being quietly helpful about. Point it at
 * any other name.
 */
export function testDatabaseUrl(): string {
  const given = process.env.DATABASE_URL;
  if (given === undefined || given === "") {
    return DEFAULT_TEST_DATABASE_URL;
  }
  if (databaseNameOf(given) === THE_STACK_DATABASE) {
    throw new Error(
      `DATABASE_URL names "${THE_STACK_DATABASE}", which is the database docker compose runs the` +
        ` gateway and the cabinet against. This suite empties every table it finds and drops the` +
        ` queue's schema, so it will not be pointed there. Leave DATABASE_URL unset to use` +
        ` "${TEST_DATABASE}", or name any other database.`,
    );
  }
  return given;
}

/**
 * Makes sure that database is there, and says whether the server is.
 *
 * `null` means there is no Postgres to talk to at all, which is an ordinary
 * thing for somebody who has not started one and is answered with a sentence
 * rather than with a wall of connection errors.
 */
export async function readyDatabase(url: string): Promise<string | null> {
  const first = await tryConnecting(url);
  if (first === "ok") {
    return url;
  }
  if (first !== NO_SUCH_DATABASE) {
    return null;
  }

  // The server is up and the database is not there yet, so make it. This is the
  // path every existing volume takes, and it is why an init script alone would
  // not do.
  const maintenance = new Pool({ connectionString: withDatabase(url, "postgres") });
  try {
    await maintenance.query(`create database "${databaseNameOf(url)}"`);
  } catch (error) {
    // Two runs starting at once both find it missing and both create it; the
    // one that loses says it is already there, which is the answer we wanted.
    if (!isAlreadyThere(error)) {
      throw error;
    }
  } finally {
    await maintenance.end();
  }

  return (await tryConnecting(url)) === "ok" ? url : null;
}

/** The sentence printed when there is no server, naming what to do about it. */
export function noDatabaseHere(url: string): string {
  return (
    `\n  The database tests need a Postgres and there is none at ${withoutPassword(url)}.` +
    "\n  Start one with `docker compose up -d --wait postgres`, then:" +
    "\n    pnpm test:db\n"
  );
}

async function tryConnecting(url: string): Promise<"ok" | string> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("select 1");
    return "ok";
  } catch (error) {
    return codeOf(error) ?? "unreachable";
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** 42P04 is "that database already exists". */
function isAlreadyThere(error: unknown): boolean {
  return codeOf(error) === "42P04";
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

function withDatabase(url: string, name: string): string {
  const changed = new URL(url);
  changed.pathname = `/${name}`;
  return changed.toString();
}

/** For printing: a connection string with the password taken out of it. */
function withoutPassword(url: string): string {
  const shown = new URL(url);
  if (shown.password !== "") {
    shown.password = "***";
  }
  return shown.toString();
}
