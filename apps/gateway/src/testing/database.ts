/**
 * The database the suite that needs a database is allowed to empty.
 *
 * It is not the one the stack runs on, and that separation is the whole of this
 * file. `compose.yaml` publishes Postgres on a laptop's 5432 so that a terminal
 * and this suite can reach it, and the suite empties every table it finds and drops the
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

/**
 * How a host that keeps its database somewhere else says so.
 *
 * The default above is the laptop's answer, and it is only the laptop's:
 * `compose.yaml` publishes Postgres on 5432 there, and the same file tells a
 * deployment to bind `127.0.0.1:55432:5432` instead, because the password is in
 * a repository. On that host the default names a port with nothing behind it,
 * and until this variable existed there was no way to say otherwise that did
 * not mean lying about DATABASE_URL.
 *
 * It is a name of its own rather than DATABASE_URL because DATABASE_URL is
 * already spoken for: it is what `db:migrate` and `account add` are handed, and
 * what it names for them is `coinslot` — the one database this suite refuses.
 * A variable with "test" in it cannot be mistaken for that one, so it is the
 * specific answer and wins when both are set.
 */
const TEST_DATABASE_URL_VARIABLE = "COINSLOT_TEST_DATABASE_URL";

/** Postgres's own answer for "that database is not there". */
const NO_SUCH_DATABASE = "3D000";

/**
 * What the suite should run against: COINSLOT_TEST_DATABASE_URL when it names
 * something, DATABASE_URL when it does and that one does not, and the suite's
 * own database on the laptop's port when neither says anything.
 *
 * Being pointed at the stack's database is refused rather than obeyed, and
 * whichever variable did the pointing is what the refusal names. This suite
 * empties what it is given, and there is no reading of "empty the database the
 * cabinet is showing" that is worth being quietly helpful about. Point it at
 * any other name.
 *
 * The environment is an argument, with the real one as its default, so that
 * this — the whole of the decision, made before any connection exists — is
 * tested with no Postgres anywhere near it.
 */
export function testDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  const named = namedDatabaseUrl(environment);
  if (named === undefined) {
    return DEFAULT_TEST_DATABASE_URL;
  }

  const { variable, url } = named;
  const database = databaseNamedBy(variable, url);
  if (database === THE_STACK_DATABASE) {
    throw new Error(
      `${variable} names "${THE_STACK_DATABASE}", which is the database docker compose runs the` +
        ` gateway and the cabinet against. This suite empties every table it finds and drops the` +
        ` queue's schema, so it will not be pointed there. Leave ${TEST_DATABASE_URL_VARIABLE} and` +
        ` DATABASE_URL unset to use "${TEST_DATABASE}", or name any other database.`,
    );
  }
  if (database === "") {
    // Measured against postgres:17-alpine: an address that stops at the port,
    // and one ending in a bare slash, both connect to the database named after
    // the user — `coinslot` on every stack this file is about. So an address
    // that looks finished is how the refusal above gets walked past.
    throw new Error(
      `${variable} stops at the server and names no database, and Postgres fills that in with the` +
        ` name of the user connecting — "${THE_STACK_DATABASE}" here, which is the database the` +
        ` cabinet is showing. Put the database on the end of the address:` +
        ` ".../${TEST_DATABASE}".`,
    );
  }
  return url;
}

/**
 * The variable this run was sent by, and what it said — or nothing, when the
 * run is an ordinary one on a laptop.
 *
 * The two variables are read differently when they are set to nothing, and the
 * difference is which suite they belong to. DATABASE_URL is not this one's: an
 * unset variable and one emptied by a shell arrive the same way, and neither is
 * this suite's business, so both mean the default. COINSLOT_TEST_DATABASE_URL
 * exists for nothing but this, and there is no run it could be describing when
 * it is empty — whoever set it is on a host where the default's localhost:5432
 * is the wrong server, so falling back there is either a connection error
 * naming an address nobody chose or a suite emptying whatever else answers on
 * that port. It says so instead.
 */
function namedDatabaseUrl(
  environment: Record<string, string | undefined>,
): { variable: string; url: string } | undefined {
  const own = environment[TEST_DATABASE_URL_VARIABLE];
  if (own !== undefined) {
    if (own === "") {
      throw new Error(
        `${TEST_DATABASE_URL_VARIABLE} is set to nothing at all, which is not a way of asking for` +
          ` the default. Give it the address of the server this suite may empty, or unset it to` +
          ` use ${withoutPassword(DEFAULT_TEST_DATABASE_URL)}.`,
      );
    }
    return { variable: TEST_DATABASE_URL_VARIABLE, url: own };
  }

  const inherited = environment.DATABASE_URL;
  if (inherited === undefined || inherited === "") {
    return undefined;
  }
  return { variable: "DATABASE_URL", url: inherited };
}

/**
 * The database that address names, or a refusal saying which variable holds an
 * address that is not one.
 *
 * What it will not do is quote the value back. A connection string is mostly a
 * password, and this sentence ends up in CI output and in scrollback somebody
 * pastes; the name of the variable is what the reader needs, and the value is
 * in front of them already.
 */
function databaseNamedBy(variable: string, url: string): string {
  if (!URL.canParse(url)) {
    throw new Error(
      `${variable} is not an address. It has to be a Postgres connection string naming the` +
        ` database this suite may empty, of the shape` +
        ` "postgres://user:password@host:port/${TEST_DATABASE}".`,
    );
  }
  return databaseNameOf(url);
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
