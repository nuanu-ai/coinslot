/**
 * The account store the cabinet runs on: two tables, through drizzle
 * (ADR-0003 §6).
 *
 * It keeps the promises written down in `testing/accounts-contract.ts`, and
 * `accounts.db-test.ts` runs that suite against a real database to say so.
 *
 * Two of them are kept by the database rather than by the code above it, and
 * that is deliberate. One address has one account because a unique index says
 * so, not because something checked before inserting — a check and an insert are
 * two statements with a gap between them, and two commands run at once fit
 * inside that gap. And a session cannot outlive the account it belongs to,
 * because the reference cascades.
 */

import { randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { type Account, type Accounts, emailAs } from "./accounts.js";
import { accounts, sessions } from "./schema.js";

/**
 * Where the cabinet's migrations keep their own history.
 *
 * Not the default, which is the gateway's. Two independent sets of migrations
 * sharing one journal would each read the other's entries as its own and
 * conclude there was nothing to apply.
 */
const MIGRATIONS_TABLE = "cabinet_migrations";

/** Postgres's own answer for "that value is already in a unique column". */
const ALREADY_THERE = "23505";

/** What this file throws: a sentence, a code, and nothing else. */
export interface DatabaseTrouble extends Error {
  /** The database's own code for what went wrong, where it gave one. */
  readonly code?: string;
}

/**
 * What is allowed out of this file when the database will not answer.
 *
 * Never the exception itself, and that is the whole of this function. Drizzle
 * wraps every driver error in one whose message is the SQL it tried followed by
 * every bound parameter — so a connection reset during a sign-in put the live
 * session's fingerprint into the log, and one during a password change put the
 * new derivation there. Both are values this cabinet exists to keep out of a
 * log, and neither is visible from reading the call site.
 *
 * What comes out instead names the operation and the database's own code for
 * what went wrong, which is what somebody reading the log can act on. There is
 * deliberately no `cause`: an exception printed by `console.error` prints its
 * causes too, so keeping one would put the parameters straight back.
 *
 * The code is a property as well as a word in the sentence, and that is not
 * decoration. A caller that has something better to say about one particular
 * failure has to be able to tell which one it is, and the first version of this
 * left the code inside a string — which turned the account command's "your
 * tables are not there yet, run the migration" into a sentence naming a table
 * an operator has never heard of, on their very first run. A code is the
 * database's own five characters and carries no parameter with it.
 */
function databaseTrouble(operation: string, thrown: unknown): DatabaseTrouble {
  const code = codeIn(thrown);
  const failed: DatabaseTrouble = new Error(
    `the cabinet's ${operation} was not answered by the database` +
      (code === null ? "" : ` (${code})`),
  );
  return code === null ? failed : Object.assign(failed, { code });
}

/** Runs one query, letting nothing out of it that carries a parameter. */
async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (thrown) {
    throw databaseTrouble(operation, thrown);
  }
}

/** The database's own code for what went wrong, from anywhere in the chain. */
function codeIn(thrown: unknown): string | null {
  let cause: unknown = thrown;
  for (let deep = 0; deep < 8 && typeof cause === "object" && cause !== null; deep += 1) {
    if ("code" in cause) {
      return String((cause as { code: unknown }).code);
    }
    cause = "cause" in cause ? (cause as { cause: unknown }).cause : null;
  }
  return null;
}

/**
 * One pool for the process, with the one listener it cannot run without.
 *
 * A pool reports the failure of a connection nobody is waiting on — a database
 * restart, a failover, an idle reaper — as an `error` event on itself, and an
 * `error` event with no listener is an uncaught exception and a dead process.
 * Every other kind of database trouble arrives at a caller, where `guarded`
 * turns it into a sentence; this one arrives at nobody, so without this the
 * cabinet exits and the merchant cannot reach the control that stops their
 * selling until somebody starts the process again.
 *
 * The gateway's store has carried the same three lines and the same reasoning
 * since before this file existed, and it did not travel here on its own.
 *
 * What is logged is the name and the message, not the object. Everywhere else
 * in this file the rule is that nothing the driver produced goes into a log
 * unread, because drizzle's wrapper carries the query's bound parameters; a
 * connection failure carries none, and `String` leaves every property behind in
 * either case.
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

/** Brings the cabinet's two tables up to date. A step somebody takes. */
export async function migrateAccounts(pool: Pool, migrationsFolder: string): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
}

export function postgresAccounts(pool: Pool): Accounts {
  const db: NodePgDatabase = drizzle(pool);

  const accountFrom = (row: {
    id: string;
    email: string;
    passwordHash: string;
    createdAt: Date;
    merchantId: string | null;
    merchantKey: string | null;
  }): Account => ({
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
    // Both columns or neither. A row with one of them filled in is a row
    // nothing can be done with — an identifier with no key draws no screen, and
    // a key with no identifier names nothing — so it is read as an account with
    // no merchant, which is a state the sign-in already has a sentence for.
    merchant:
      row.merchantId === null || row.merchantKey === null
        ? null
        : { id: row.merchantId, key: row.merchantKey },
  });

  return {
    async add(email, passwordHash, at, merchant) {
      try {
        const [row] = await db
          .insert(accounts)
          .values({
            id: `acc_${randomUUID()}`,
            email: emailAs(email),
            passwordHash,
            createdAt: at,
            merchantId: merchant?.id ?? null,
            merchantKey: merchant?.key ?? null,
          })
          .returning();
        return row === undefined ? null : accountFrom(row);
      } catch (thrown) {
        // The address is taken. This is the answer rather than an exception,
        // because it is what happens when somebody runs the command twice — and
        // it is caught from the database rather than avoided by looking first,
        // so that two runs at once cannot both find the address free.
        if (isAlreadyThere(thrown)) {
          return null;
        }
        throw databaseTrouble("account", thrown);
      }
    },

    async byEmail(email) {
      return await guarded("reading an account", async () => {
        const [row] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.email, emailAs(email)))
          .limit(1);
        return row === undefined ? null : accountFrom(row);
      });
    },

    async setPassword(email, passwordHash) {
      return await guarded("password change", async () => {
        const address = emailAs(email);
        // One transaction: a new password whose old sessions survived because the
        // second statement failed is the whole of what this is for.
        return await db.transaction(async (inside) => {
          const [changed] = await inside
            .update(accounts)
            .set({ passwordHash })
            .where(eq(accounts.email, address))
            .returning({ id: accounts.id });
          if (changed === undefined) {
            return false;
          }
          await inside.delete(sessions).where(eq(sessions.accountId, changed.id));
          return true;
        });
      });
    },

    async list(now) {
      return await guarded("listing of accounts", async () => {
        // The merchant's identifier is selected and its key is not, and that is
        // the whole of what this listing is allowed to know: it is printed to a
        // terminal, and a column selected here is a column that ends up in a
        // scrollback.
        const rows = await db
          .select({
            email: accounts.email,
            createdAt: accounts.createdAt,
            sessions: count(sessions.fingerprint),
            merchant: accounts.merchantId,
          })
          .from(accounts)
          .leftJoin(sessions, and(eq(sessions.accountId, accounts.id), gt(sessions.expiresAt, now)))
          .groupBy(accounts.email, accounts.createdAt, accounts.merchantId);
        // Sorted here rather than by the database, so that the order a person
        // reads off a terminal is the same one whichever store answered and on
        // whatever server. A database sorts by its own collation, and the
        // disagreement is real rather than theoretical: on Postgres 17, `C` and
        // `en-US-x-icu` put `renée@example.com` on opposite sides of
        // `renz@example.com`. Hyphens and dots, which is where one would look
        // for this first, are ordered the same way by both.
        return rows
          .map((row) => ({
            email: row.email,
            createdAt: row.createdAt,
            sessions: Number(row.sessions),
            merchant: row.merchant,
          }))
          .sort((one, other) => one.email.localeCompare(other.email));
      });
    },

    async open(fingerprint, accountId, at, until) {
      // The sweep and the insert are two statements and not one transaction,
      // deliberately. Nothing is lost if the second fails after the first: what
      // the sweep removes are sessions whose time was already up, and rolling
      // that back would only put expired rows back.
      return await guarded("opening of a session", async () => {
        const swept = await db.delete(sessions).where(lte(sessions.expiresAt, at)).returning({
          fingerprint: sessions.fingerprint,
        });
        await db
          .insert(sessions)
          // No clause for a fingerprint that is already there, and that is a
          // decision rather than an omission. It would mean 32 random bytes came
          // up twice; the previous version updated the row instead, which hands
          // an identifier somebody is already holding to a different person.
          // Stopping is the right answer to something that cannot happen.
          .values({ fingerprint, accountId, createdAt: at, expiresAt: until });
        return swept.length;
      });
    },

    async whose(fingerprints, now) {
      // Nothing to ask about is not a query. Left to drizzle an empty list
      // becomes `where false`, which is correct and is still a round trip to
      // the database — and a request carrying no cookie at all is the
      // commonest request this cabinet answers, every visitor's first one
      // among them.
      const asked = [...new Set(fingerprints)];
      if (asked.length === 0) {
        return [];
      }
      return await guarded("reading of a session", async () => {
        const rows = await db
          .select({
            fingerprint: sessions.fingerprint,
            id: accounts.id,
            email: accounts.email,
            passwordHash: accounts.passwordHash,
            createdAt: accounts.createdAt,
            merchantId: accounts.merchantId,
            merchantKey: accounts.merchantKey,
          })
          .from(sessions)
          .innerJoin(accounts, eq(accounts.id, sessions.accountId))
          .where(and(inArray(sessions.fingerprint, asked), gt(sessions.expiresAt, now)));
        return rows.map((row) => ({ fingerprint: row.fingerprint, account: accountFrom(row) }));
      });
    },

    async end(fingerprint) {
      return await guarded("ending of a session", async () => {
        await db.delete(sessions).where(eq(sessions.fingerprint, fingerprint));
      });
    },

    async endEveryFor(email) {
      return await guarded("ending of every session", async () => {
        const ended = await db
          .delete(sessions)
          .where(
            sql`${sessions.accountId} in (select ${accounts.id} from ${accounts} where ${accounts.email} = ${emailAs(email)})`,
          )
          .returning({ fingerprint: sessions.fingerprint });
        return ended.length;
      });
    },

    async close() {
      return await guarded("letting go of the connection", async () => {
        await pool.end();
      });
    },
  };
}

/**
 * Whether this is the database saying that address is taken.
 *
 * The chain of causes is walked rather than the thrown object alone, and that
 * is not defensiveness: drizzle wraps what the driver threw, so the code is one
 * level down and a check on the outer object finds nothing. Written the naive
 * way, this turned "that address already has an account" into a stack trace on
 * a terminal, and the account command's only honest answer into a crash. The
 * in-memory store could never have shown that — it has no driver to wrap.
 */
function isAlreadyThere(thrown: unknown): boolean {
  let cause: unknown = thrown;
  // Bounded, because a cause chain that points at itself would otherwise spin
  // here forever with nobody watching.
  for (let deep = 0; deep < 8 && typeof cause === "object" && cause !== null; deep += 1) {
    if ("code" in cause && String((cause as { code: unknown }).code) === ALREADY_THERE) {
      return true;
    }
    cause = "cause" in cause ? (cause as { cause: unknown }).cause : null;
  }
  return false;
}
