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
import { and, count, eq, gt, lte, sql } from "drizzle-orm";
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
 */
function databaseTrouble(operation: string, thrown: unknown): Error {
  const code = codeIn(thrown);
  return new Error(
    `the cabinet's ${operation} was not answered by the database` +
      (code === null ? "" : ` (${code})`),
  );
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

export function connect(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
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
  }): Account => ({
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
  });

  return {
    async add(email, passwordHash, at) {
      try {
        const [row] = await db
          .insert(accounts)
          .values({
            id: `acc_${randomUUID()}`,
            email: emailAs(email),
            passwordHash,
            createdAt: at,
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
        const rows = await db
          .select({
            email: accounts.email,
            createdAt: accounts.createdAt,
            sessions: count(sessions.fingerprint),
          })
          .from(accounts)
          .leftJoin(sessions, and(eq(sessions.accountId, accounts.id), gt(sessions.expiresAt, now)))
          .groupBy(accounts.email, accounts.createdAt)
          .orderBy(accounts.email);
        return rows.map((row) => ({
          email: row.email,
          createdAt: row.createdAt,
          sessions: Number(row.sessions),
        }));
      });
    },

    async open(fingerprint, accountId, at, until) {
      return await guarded("opening of a session", async () => {
        const swept = await db.delete(sessions).where(lte(sessions.expiresAt, at)).returning({
          fingerprint: sessions.fingerprint,
        });
        await db
          .insert(sessions)
          .values({ fingerprint, accountId, createdAt: at, expiresAt: until })
          // A fingerprint is 32 random bytes, so this never happens; if it ever
          // did, the second sign-in must not fail on top of the first.
          .onConflictDoUpdate({
            target: sessions.fingerprint,
            set: { accountId, createdAt: at, expiresAt: until },
          });
        return swept.length;
      });
    },

    async whose(fingerprint, now) {
      return await guarded("reading of a session", async () => {
        const [row] = await db
          .select({
            id: accounts.id,
            email: accounts.email,
            passwordHash: accounts.passwordHash,
            createdAt: accounts.createdAt,
          })
          .from(sessions)
          .innerJoin(accounts, eq(accounts.id, sessions.accountId))
          .where(and(eq(sessions.fingerprint, fingerprint), gt(sessions.expiresAt, now)))
          .limit(1);
        return row === undefined ? null : accountFrom(row);
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
