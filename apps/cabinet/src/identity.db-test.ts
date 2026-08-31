/**
 * The cabinet's identity against a real database, on tables the checked-in
 * migrations built.
 *
 * Two things are checked here and neither can be checked anywhere else. The
 * first is the migration itself, run against a database standing at the version
 * before it with a row already in the table — which is what the deployed server
 * is, and which every other suite misses because it builds its tables from
 * nothing. The second is the component's own behaviour over drizzle and
 * Postgres rather than over its memory store: the column types, the cascade,
 * the unique index and the one measurement that only means something against a
 * real connection, which is how many questions a request costs.
 *
 * The migrations are applied as SQL rather than through drizzle's migrator,
 * because the point of half of this is to stop part way and the migrator
 * applies everything in the folder. What runs here is the exact text a
 * deployment applies, split on the breakpoints the migrator splits on.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "@coinslot/gateway/testing/database";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runAccount } from "./account-command.js";
import { loadConfig } from "./config.js";
import { type Identity, identityFor } from "./identity.js";
import type { Message } from "./mail.js";

/**
 * A database of this file's own, beside the one the rest of `pnpm test:db` uses.
 *
 * Standing the cabinet's tables up at the version before a change and then
 * moving them is not something to do to tables another suite is emptying
 * between its own tests.
 */
const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/coinslot_test_cabinet_identity";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "drizzle");

const MERCHANT = { id: "mer_the_merchant", key: "the-merchants-own-key-long-enough" };
const PASSWORD = "a-password-nobody-guesses";

/**
 * One migration file, as the statements the migrator would run one by one.
 *
 * A statement can be preceded by a comment explaining why it is written the way
 * it is, and Postgres takes those as happily as the migrator does. They are cut
 * here only because the split leaves them attached to the statement below, and
 * a chunk that is nothing but a comment is not a statement to send.
 */
async function statementsOf(file: string): Promise<string[]> {
  const sql = await readFile(join(migrationsIn, file), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement !== "");
}

if (databaseUrl === null) {
  console.log(noDatabaseHere(wanted));

  describe("the cabinet's identity on a real database", () => {
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

  const emptyEverything = async (): Promise<void> => {
    await pool.query(
      "drop table if exists cabinet_verifications, cabinet_credentials," +
        " cabinet_sessions, cabinet_accounts cascade",
    );
  };

  const mails: Message[] = [];
  const identityOn = (): Identity =>
    identityFor(
      loadConfig({
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
      }),
      {
        pool,
        postman: async (message) => {
          mails.push(message);
        },
      },
    );

  describe("the migration onto a database that already had an account in it", () => {
    beforeEach(async () => {
      mails.length = 0;
      await emptyEverything();
      await run("0000_accounts.sql");
      await run("0001_merchant_on_account.sql");
    });

    it("keeps the account, its address and the merchant it signs in for", async () => {
      // The row a deployed cabinet is holding, written with the columns that
      // version had and no others — which is what makes this a test of the
      // migration rather than of the schema file the code agrees with.
      await pool.query(
        `insert into cabinet_accounts (id, email, password_hash, created_at, merchant_id, merchant_key)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          "acc_the_deployed_one",
          "dmitry@example.com",
          "scrypt$32768$8$1$c2FsdA$a2V5",
          new Date("2026-08-27T09:00:00.000Z"),
          MERCHANT.id,
          MERCHANT.key,
        ],
      );
      // And a session, because there is one on a deployed server too.
      await pool.query(
        `insert into cabinet_sessions (fingerprint, account_id, created_at, expires_at)
         values ($1, $2, $3, $4)`,
        [
          "a-fingerprint",
          "acc_the_deployed_one",
          new Date("2026-08-27T09:00:00.000Z"),
          new Date("2099-01-01T00:00:00.000Z"),
        ],
      );

      await run("0002_the_old_sign_in_goes.sql");
      await run("0003_identity_component.sql");

      const person = await identityOn().byEmail("dmitry@example.com");
      expect(person?.id).toBe("acc_the_deployed_one");
      // The two columns that are ours rather than the component's, and the
      // whole reason this table kept its name through the change.
      expect(person?.merchant).toStrictEqual(MERCHANT);
      // Nobody has confirmed the address, because nobody ever could have.
      expect(person?.confirmed).toBe(false);
      // The moment the row was made is the moment it says, not the moment the
      // migration ran: an account's age is what somebody reads the listing for.
      const { rows } = await pool.query<{ created_at: Date; updated_at: Date }>(
        "select created_at, updated_at from cabinet_accounts",
      );
      expect(rows[0]?.created_at.toISOString()).toBe("2026-08-27T09:00:00.000Z");
      expect(rows[0]?.updated_at.toISOString()).toBe("2026-08-27T09:00:00.000Z");
    });

    it("leaves that account with no password, and the command gives it one", async () => {
      // The honest half of this migration. The old cabinet derived a password
      // its own way and the component derives its own; carrying the stored
      // value across would mean keeping the code that reads it, which is the
      // code this change removes. So the password does not survive — and the
      // command that replaces it has to work on a row that has never had one,
      // which is a row with no way of signing in attached to it at all.
      await pool.query(
        `insert into cabinet_accounts (id, email, password_hash, created_at, merchant_id, merchant_key)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          "acc_the_deployed_one",
          "dmitry@example.com",
          "scrypt$32768$8$1$c2FsdA$a2V5",
          new Date("2026-08-27T09:00:00.000Z"),
          MERCHANT.id,
          MERCHANT.key,
        ],
      );

      await run("0002_the_old_sign_in_goes.sql");
      await run("0003_identity_component.sql");

      const identity = identityOn();
      // Nothing signs in yet, whatever is typed.
      expect((await identity.signIn("dmitry@example.com", PASSWORD)).ok).toBe(false);

      const lines: string[] = [];
      const code = await runAccount(
        ["password", "dmitry@example.com"],
        identity,
        {
          say: (line) => lines.push(line),
          readKey: async () => {
            throw new Error("the password command has no key to read");
          },
        },
        async () => {
          throw new Error("the password command has no key to ask the gateway about");
        },
      );

      expect(code).toBe(0);
      const printed = /^ {4}(\S+)$/m.exec(lines.join("\n"))?.[1] ?? "";
      expect(printed).not.toBe("");
      const signed = await identity.signIn("dmitry@example.com", printed);
      expect(signed.ok).toBe(true);
      // And it is the same account, still pointed at the same merchant, so
      // nobody has to be handed a new one.
      expect(signed.ok && signed.opened.person.id).toBe("acc_the_deployed_one");
      expect(signed.ok && signed.opened.person.merchant).toStrictEqual(MERCHANT);
    });

    it("takes an account with no merchant across without inventing one", async () => {
      // The other row that exists on a deployed server: one written before an
      // account named the merchant it signs in for. It has to arrive on the
      // other side as an account with no merchant, which the cabinet has a
      // sentence for — and not as one whose merchant is an empty identifier
      // with an empty key, which would be a cabinet asking the gateway to
      // accept nothing on every screen.
      await pool.query(
        `insert into cabinet_accounts (id, email, password_hash, created_at)
         values ($1, $2, $3, $4)`,
        [
          "acc_before_merchants",
          "older@example.com",
          "scrypt$32768$8$1$c2FsdA$a2V5",
          new Date("2026-08-27T09:00:00.000Z"),
        ],
      );

      await run("0002_the_old_sign_in_goes.sql");
      await run("0003_identity_component.sql");

      expect((await identityOn().byEmail("older@example.com"))?.merchant).toBeNull();
    });
  });

  describe("the cabinet's identity on a real database", () => {
    beforeEach(async () => {
      mails.length = 0;
      await emptyEverything();
      for (const file of [
        "0000_accounts.sql",
        "0001_merchant_on_account.sql",
        "0002_the_old_sign_in_goes.sql",
        "0003_identity_component.sql",
      ]) {
        await run(file);
      }
    });

    it("registers, signs in and reads the session back off the cookie", async () => {
      const identity = identityOn();

      const made = await identity.register("dmitry@example.com", PASSWORD, MERCHANT);

      expect(made.ok).toBe(true);
      expect(made.ok && made.opened.person.merchant).toStrictEqual(MERCHANT);
      const signed = await identity.signIn("dmitry@example.com", PASSWORD);
      expect(signed.ok).toBe(true);
      const cookie = (signed.ok ? signed.opened.cookies : [])
        .map((line) => line.split(";")[0])
        .join("; ");
      expect((await identity.whoIs(cookie))?.email).toBe("dmitry@example.com");
      // And the key really is on the row rather than somewhere in the process.
      const { rows } = await pool.query<{ merchant_key: string }>(
        "select merchant_key from cabinet_accounts where email = $1",
        ["dmitry@example.com"],
      );
      expect(rows[0]?.merchant_key).toBe(MERCHANT.key);
    });

    it("replaces the key on a row, and says so from what the write answered", async () => {
      // Every sign-in does this, and what it turns on is a claim about drizzle
      // rather than about the memory store the rest of the suite runs on: that
      // an update answers with the row it wrote, carrying the columns this
      // cabinet added to the component's model. If it did not, the write would
      // land and be reported as though it had not, the key would never be
      // replaced on a deployed server, and the only sign of it would be a line
      // in the log at every sign-in. So the answer is checked against the
      // column, and both halves are read here.
      const identity = identityOn();
      await identity.register("dmitry@example.com", PASSWORD, MERCHANT);
      const who = await identity.byEmail("dmitry@example.com");

      const written = await identity.replaceMerchantKey(
        who?.id ?? "",
        MERCHANT.key,
        "the-next-key-long-enough",
      );

      expect(written).toBe(true);
      const { rows } = await pool.query<{ merchant_key: string; merchant_id: string }>(
        "select merchant_key, merchant_id from cabinet_accounts where email = $1",
        ["dmitry@example.com"],
      );
      expect(rows[0]?.merchant_key).toBe("the-next-key-long-enough");
      // And the merchant beside it is untouched: this is the same merchant,
      // reached with another of their keys.
      expect(rows[0]?.merchant_id).toBe(MERCHANT.id);
    });

    it("does not report a key written onto a row the database does not have", async () => {
      // What forgetting a key is allowed to happen after. An update that
      // matched nothing must not read as a key written down: the caller would
      // then take the key the row still names to be the one it had finished
      // with, and put the only working key beyond use.
      const identity = identityOn();

      expect(
        await identity.replaceMerchantKey(
          "no-such-account",
          MERCHANT.key,
          "the-next-key-long-enough",
        ),
      ).toBe(false);
    });

    it("writes only while the row still holds the key that was read off it", async () => {
      // The compare and the set are one statement in the database rather than a
      // read this code makes and a write it makes afterwards. A read followed
      // by a write is the same gap in a smaller costume: two sign-ins can both
      // read, both find what they expected, and both write. Held here as well
      // as against the memory store, because the condition has to be the
      // database's own — an `update ... where merchant_key = $expected` — and
      // whether drizzle carries a second where clause through is a claim about
      // drizzle.
      const identity = identityOn();
      await identity.register("dmitry@example.com", PASSWORD, MERCHANT);
      const who = await identity.byEmail("dmitry@example.com");

      const won = await identity.replaceMerchantKey(who?.id ?? "", MERCHANT.key, "the-first-fresh");
      const lost = await identity.replaceMerchantKey(who?.id ?? "", MERCHANT.key, "the-second");

      expect(won).toBe(true);
      expect(lost).toBe(false);
      const { rows } = await pool.query<{ merchant_key: string }>(
        "select merchant_key from cabinet_accounts where email = $1",
        ["dmitry@example.com"],
      );
      expect(rows[0]?.merchant_key).toBe("the-first-fresh");
    });

    it("refuses a second account at one address, because the database says so", async () => {
      // Not because something looked first: a check ahead of an insert is two
      // statements with a gap between them, and two registrations at once fit
      // inside that gap.
      const identity = identityOn();
      await identity.register("dmitry@example.com", PASSWORD, MERCHANT);

      const again = await identity.register("Dmitry@Example.com ", PASSWORD, MERCHANT);

      expect(again.ok).toBe(false);
      expect(again.ok === false && again.why).toBe("taken");
      const { rows } = await pool.query<{ count: string }>("select count(*) from cabinet_accounts");
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("takes an account's sessions and its password with it when it goes", async () => {
      // The cascade, which is in the database rather than in whichever code
      // path happened to delete the account. A session that outlived its owner
      // would be a row nothing can resolve and a query that fails on a join.
      const identity = identityOn();
      await identity.register("dmitry@example.com", PASSWORD, MERCHANT);
      await identity.signIn("dmitry@example.com", PASSWORD);

      await pool.query("delete from cabinet_accounts where email = $1", ["dmitry@example.com"]);

      for (const table of ["cabinet_sessions", "cabinet_credentials"]) {
        const { rows } = await pool.query<{ count: string }>(`select count(*) from ${table}`);
        expect(Number(rows[0]?.count), table).toBe(0);
      }
    });

    it("sends a link that replaces a password, and ends every session with it", async () => {
      const identity = identityOn();
      await identity.register("dmitry@example.com", PASSWORD, MERCHANT);
      await identity.signIn("dmitry@example.com", PASSWORD);
      await identity.askToConfirm("dmitry@example.com");
      const confirming = /token=([^\s&]+)/.exec(mails.at(-1)?.body ?? "")?.[1] ?? "";
      expect(await identity.confirm(confirming)).toBe(true);

      await identity.askForANewPassword("dmitry@example.com");
      const replacing = /token=([^\s&]+)/.exec(mails.at(-1)?.body ?? "")?.[1] ?? "";
      expect(await identity.setPasswordFrom(replacing, "a-password-of-their-own")).toBe(true);

      expect((await identity.signIn("dmitry@example.com", PASSWORD)).ok).toBe(false);
      expect((await identity.signIn("dmitry@example.com", "a-password-of-their-own")).ok).toBe(
        true,
      );
      // Every session opened with the old password went with it. The one left
      // is the one the line above just opened.
      const { rows } = await pool.query<{ count: string }>("select count(*) from cabinet_sessions");
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("sends nothing to an address nobody has confirmed", async () => {
      const identity = identityOn();
      await identity.register("dmitry@example.com", PASSWORD, MERCHANT);

      await identity.askForANewPassword("dmitry@example.com");

      expect(mails).toStrictEqual([]);
    });

    it("does not report a database that will not answer as an address being taken", async () => {
      // Found on the first run outside the tests, against a database that had
      // never been migrated. Every refusal used to be caught in one place, so a
      // connection that failed came back as the component saying no — and the
      // command answered "that address already has an account" while the real
      // trouble was that there were no tables to look in. On the registration
      // screen the same fault would have sent a merchant to check an invitation
      // that was never the problem.
      //
      // What separates the two is the type the component throws for its own
      // refusals. Anything else goes up, where the page says something here is
      // broken and the log gets the exception.
      const identity = identityOn();
      await emptyEverything();

      await expect(identity.register("dmitry@example.com", PASSWORD, MERCHANT)).rejects.toThrow();
      await expect(identity.signIn("dmitry@example.com", PASSWORD)).rejects.toThrow();
      await expect(identity.setPasswordFrom("a-token", PASSWORD)).rejects.toThrow();
      // The two that answer without asking the database at all, and still
      // answer correctly with none: a link nobody signed and a cookie nobody
      // signed are both refused on the signature, before a query.
      await expect(identity.confirm("a-token")).resolves.toBe(false);
      await expect(identity.whoIs("coinslot.session_token=nonsense")).resolves.toBeNull();
    });

    it("asks the database nothing about a cookie it did not sign", async () => {
      // The measurement that only means something against a real connection,
      // and the reason a browser carrying a pile of planted cookies is not a
      // browser turning one page view into a pile of queries. The component
      // checks its own signature over a value before it looks anything up, so a
      // value nobody signed with this cabinet's secret costs a comparison.
      //
      // It matters because there is no cap on how many values under this name
      // are considered — a cap is a way to push the merchant's own cookie out
      // of sight — and because the component looks a session up one identifier
      // at a time, so there is no batch to hide the cost in.
      const identity = identityOn();
      await identity.register("dmitry@example.com", PASSWORD, MERCHANT);
      const signed = await identity.signIn("dmitry@example.com", PASSWORD);
      const mine = (signed.ok ? signed.opened.cookies : [])
        .map((line) => line.split(";")[0])
        .join("; ");

      let asked = 0;
      const real = pool.query.bind(pool);
      // biome-ignore lint/suspicious/noExplicitAny: counting a driver's own calls
      (pool as any).query = (...args: unknown[]) => {
        asked += 1;
        return (real as (...given: unknown[]) => unknown)(...args);
      };
      try {
        const planted = Array.from(
          { length: 50 },
          (_, at) => `coinslot.session_token=${String(at).padStart(32, "a")}.${"b".repeat(43)}`,
        ).join("; ");

        expect(await identity.whoIs(planted)).toBeNull();
        expect(asked).toBe(0);

        // And the merchant's own, arriving behind all of them, still signs them
        // in — at the cost of the one lookup it takes to answer.
        asked = 0;
        expect((await identity.whoIs(`${planted}; ${mine}`))?.email).toBe("dmitry@example.com");
        expect(asked).toBeGreaterThan(0);
        expect(asked).toBeLessThan(10);
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: putting the driver back
        (pool as any).query = real;
      }
    });
  });
}
