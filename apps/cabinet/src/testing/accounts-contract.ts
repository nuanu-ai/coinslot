/**
 * The promises an account store keeps, written once and run against both of
 * them.
 *
 * There are two stores: the one the cabinet runs on, which is Postgres, and the
 * one its own tests run on, which is a map in memory. Two implementations of
 * one interface drift, and the way they drift is that the fast one is the one
 * everybody develops against — so the promise a person's session actually rests
 * on is the one nobody checked. This file is the answer: the same suite runs
 * under `pnpm test` against memory and under `pnpm test:db` against a real
 * database, and a difference between them is a failure rather than a surprise
 * in front of a merchant.
 *
 * What is deliberately not here: anything about passwords. The store holds an
 * opaque string and never looks inside it, so these tests use plain words for
 * it — a store that started caring what a password hash looks like would be a
 * store that has to be told when the hashing changes.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Account, AccountMerchant, Accounts } from "../accounts.js";

const HOUR = 60 * 60 * 1_000;

/**
 * The merchant an account in this suite belongs to.
 *
 * The key here is a plain readable word rather than something that looks like a
 * real one, because the store never reads it: it is a secret to the store in
 * the same way a password derivation is, which is to say an opaque string it
 * writes down and hands back. What must not happen to it is tested where it can
 * be — in the store that talks to a real database, whose exceptions carry the
 * parameters of the query that failed.
 */
const THE_MERCHANT: AccountMerchant = { id: "mer_the_merchant", key: "the-merchant-key" };

/**
 * The one session behind one identifier, or null.
 *
 * A store answers about as many identifiers as a request carried, because that
 * is the question its caller has. Most of the promises below are about a single
 * session, and reading them through this keeps each one about its promise
 * instead of about the shape of the answer. The promises that are about the
 * list itself are written out in full further down.
 */
export const sessionFor = async (
  accounts: Accounts,
  fingerprint: string,
  now: Date,
): Promise<Account | null> => (await accounts.whose([fingerprint], now))[0]?.account ?? null;

/** Runs the whole contract against one store. */
export function describeAccounts(name: string, open: () => Promise<Accounts>): void {
  describe(name, () => {
    let store: Accounts | null = null;

    const fresh = async (): Promise<Accounts> => {
      store = await open();
      return store;
    };

    afterEach(async () => {
      await store?.close();
      store = null;
    });

    describe("an account", () => {
      it("is found again by the address it was made with", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");

        const made = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        const found = await accounts.byEmail("dmitry@example.com");

        expect(made?.email).toBe("dmitry@example.com");
        expect(found?.id).toBe(made?.id);
        expect(found?.passwordHash).toBe("hash-one");
        expect(found?.createdAt.toISOString()).toBe(at.toISOString());
      });

      it("names the merchant it belongs to and holds that merchant's key", async () => {
        // ADR-0014 §2. Without these two on the row the cabinet has no key to
        // reach the gateway with per request, and every account signed in would
        // be looking at whichever merchant the process was configured for —
        // which is a second person reading the first merchant's money.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");

        const made = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);

        expect(made?.merchant).toStrictEqual(THE_MERCHANT);
        expect((await accounts.byEmail("dmitry@example.com"))?.merchant).toStrictEqual(THE_MERCHANT);
      });

      it("can have no merchant at all, which is what the accounts made before them are", async () => {
        // The two columns are nullable because there is a row on a deployed
        // server that was written before merchants had accounts, and a NOT NULL
        // column cannot be added to a table that already has rows in it. What
        // such an account means is decided above this store: it cannot sign in,
        // because there is no key to draw a single screen with.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");

        const made = await accounts.add("dmitry@example.com", "hash-one", at, null);

        expect(made?.merchant).toBeNull();
        expect((await accounts.byEmail("dmitry@example.com"))?.merchant).toBeNull();
      });

      it("answers nothing for an address nobody has", async () => {
        const accounts = await fresh();

        await expect(accounts.byEmail("nobody@example.com")).resolves.toBeNull();
      });

      it("is one per address, and a second attempt does not overwrite the first", async () => {
        // The command that makes accounts is run by hand, and running it twice
        // by mistake must not replace somebody's password with a new one they
        // have not been told — nor point their cabinet at a different merchant.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);

        const again = await accounts.add("dmitry@example.com", "hash-two", at, {
          id: "mer_somebody_else",
          key: "somebody-elses-key",
        });

        expect(again).toBeNull();
        const kept = await accounts.byEmail("dmitry@example.com");
        expect(kept?.passwordHash).toBe("hash-one");
        expect(kept?.merchant).toStrictEqual(THE_MERCHANT);
      });

      it("is the same account however the address is typed", async () => {
        // A person who signs in as "Dmitry@Example.com " is the person whose
        // account was made as "dmitry@example.com", and a store that thought
        // otherwise would let two accounts exist for one person.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        await accounts.add("  Dmitry@Example.COM  ", "hash-one", at, THE_MERCHANT);

        const found = await accounts.byEmail("dmitry@example.com");

        expect(found?.email).toBe("dmitry@example.com");
        expect(await accounts.add("DMITRY@example.com", "hash-two", at, THE_MERCHANT)).toBeNull();
        expect((await accounts.byEmail(" dmitry@EXAMPLE.com "))?.id).toBe(found?.id);
      });
    });

    describe("a session", () => {
      it("names the person it belongs to", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);

        await accounts.open("fingerprint-one", person?.id ?? "", at, new Date(+at + 12 * HOUR));
        const whose = await sessionFor(accounts, "fingerprint-one", new Date(+at + HOUR));

        expect(whose?.email).toBe("dmitry@example.com");
        expect(whose?.id).toBe(person?.id);
      });

      it("is nobody's once its time is up", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        const until = new Date(+at + 12 * HOUR);
        await accounts.open("fingerprint-one", person?.id ?? "", at, until);

        // The instant it expires, not merely well after it.
        await expect(sessionFor(accounts, "fingerprint-one", until)).resolves.toBeNull();
        await expect(
          sessionFor(accounts, "fingerprint-one", new Date(+until + 1)),
        ).resolves.toBeNull();
        await expect(
          sessionFor(accounts, "fingerprint-one", new Date(+until - 1)),
        ).resolves.not.toBeNull();
      });

      it("is not given more time by being used", async () => {
        // ADR-0009 §6: twelve hours from the moment it opens, never extended.
        // A store that pushed the expiry forward on every read would be a
        // sliding window, which is the arrangement that decision refuses — a
        // session that never ends as long as somebody keeps a tab in front of
        // them is the case the twelve hours exist to catch.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        const until = new Date(+at + HOUR);
        await accounts.open("laptop", person?.id ?? "", at, until);

        // Used, repeatedly, right up to the last minute.
        for (const minutes of [10, 20, 30, 40, 50, 59]) {
          await expect(
            sessionFor(accounts, "laptop", new Date(+at + minutes * 60 * 1_000)),
            `${minutes} minutes in`,
          ).resolves.not.toBeNull();
        }

        await expect(sessionFor(accounts, "laptop", until)).resolves.toBeNull();
      });

      it("is nobody's once it has been ended", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        await accounts.open("fingerprint-one", person?.id ?? "", at, new Date(+at + 12 * HOUR));

        await accounts.end("fingerprint-one");

        await expect(sessionFor(accounts, "fingerprint-one", at)).resolves.toBeNull();
      });

      it("is ended one at a time, which is the whole reason it is a row", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        const until = new Date(+at + 12 * HOUR);
        await accounts.open("laptop", person?.id ?? "", at, until);
        await accounts.open("telephone", person?.id ?? "", at, until);

        await accounts.end("laptop");

        await expect(sessionFor(accounts, "laptop", at)).resolves.toBeNull();
        await expect(sessionFor(accounts, "telephone", at)).resolves.not.toBeNull();
      });

      it("is nobody's when nothing was ever opened under that identifier", async () => {
        const accounts = await fresh();

        await expect(sessionFor(accounts, "never-issued", new Date())).resolves.toBeNull();
        // And ending one that does not exist is not an error: a person pressing
        // sign out twice is not a broken cabinet.
        await expect(accounts.end("never-issued")).resolves.toBeUndefined();
      });
    });

    describe("several identifiers asked about together", () => {
      it("says which of them are live and whose each one is", async () => {
        // The question the cabinet actually has. A browser can send several
        // cookies of one name, and the cabinet cannot decide who is asking
        // until it knows about all of them — including whether two of them
        // belong to two different people, which is the case it refuses.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const until = new Date(+at + 12 * HOUR);
        const one = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        const other = await accounts.add("someone@example.com", "hash-two", at, THE_MERCHANT);
        await accounts.open("laptop", one?.id ?? "", at, until);
        await accounts.open("telephone", one?.id ?? "", at, until);
        await accounts.open("theirs", other?.id ?? "", at, until);

        const live = await accounts.whose(["laptop", "theirs", "telephone"], at);

        expect(
          [...live]
            .map((session) => `${session.fingerprint}:${session.account.email}`)
            .sort()
            .join(" "),
        ).toBe("laptop:dmitry@example.com telephone:dmitry@example.com theirs:someone@example.com");
      });

      it("leaves out the ones that were never opened, were ended, or have run out", async () => {
        // Three ways of not being a session, and none of them is told apart
        // from the others: they are one answer to whoever is asking.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        await accounts.open("laptop", person?.id ?? "", at, new Date(+at + 12 * HOUR));
        await accounts.open("telephone", person?.id ?? "", at, new Date(+at + HOUR));
        await accounts.open("ended", person?.id ?? "", at, new Date(+at + 12 * HOUR));
        await accounts.end("ended");

        const live = await accounts.whose(
          ["laptop", "telephone", "ended", "never-issued"],
          new Date(+at + 2 * HOUR),
        );

        expect(live.map((session) => session.fingerprint)).toStrictEqual(["laptop"]);
      });

      it("answers each identifier once, however many times it is given", async () => {
        // A browser that sent the same cookie twice must not read as two
        // sessions, because two sessions is the thing the cabinet refuses to
        // choose between.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        await accounts.open("laptop", person?.id ?? "", at, new Date(+at + 12 * HOUR));

        const live = await accounts.whose(["laptop", "laptop", "laptop"], at);

        expect(live.length).toBe(1);
      });

      it("answers nothing when asked about nothing", async () => {
        // The commonest request the cabinet answers is one with no cookie at
        // all, and it must not become a query.
        const accounts = await fresh();

        await expect(accounts.whose([], new Date())).resolves.toStrictEqual([]);
      });

      it("is refused for an account that is not there", async () => {
        // The database refuses it, because a session points at an account. The
        // in-memory store used to accept it and answer `null` afterwards, which
        // is the shape of divergence this suite exists to catch: the forgiving
        // one is the one everybody develops against.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");

        await expect(
          accounts.open("laptop", "acc_nobody", at, new Date(+at + HOUR)),
        ).rejects.toThrow();
        await expect(sessionFor(accounts, "laptop", at)).resolves.toBeNull();
      });

      it("is refused under an identifier that already has one", async () => {
        // Thirty-two random bytes twice, which is not a thing that happens.
        // What must not happen if it ever did is the identifier somebody is
        // already holding quietly becoming somebody else's session.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const one = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        const other = await accounts.add("someone@example.com", "hash-two", at, THE_MERCHANT);
        await accounts.open("laptop", one?.id ?? "", at, new Date(+at + 12 * HOUR));

        await expect(
          accounts.open("laptop", other?.id ?? "", at, new Date(+at + 12 * HOUR)),
        ).rejects.toThrow();
        expect((await sessionFor(accounts, "laptop", at))?.email).toBe("dmitry@example.com");
      });

      it("does not pile up after it has expired", async () => {
        // Nothing sweeps this table on a timer, so opening a session is what
        // clears out the ones whose time is up. Without it the table grows for
        // the life of the deployment.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        await accounts.open("yesterday", person?.id ?? "", at, new Date(+at + HOUR));

        const later = new Date(+at + 48 * HOUR);
        const swept = await accounts.open(
          "today",
          person?.id ?? "",
          later,
          new Date(+later + 12 * HOUR),
        );

        expect(swept).toBe(1);
        expect((await accounts.list(later))[0]?.sessions).toBe(1);
      });
    });

    describe("ending every session one person has", () => {
      it("leaves everybody else signed in", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const until = new Date(+at + 12 * HOUR);
        const one = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        const other = await accounts.add("someone@example.com", "hash-two", at, THE_MERCHANT);
        await accounts.open("laptop", one?.id ?? "", at, until);
        await accounts.open("telephone", one?.id ?? "", at, until);
        await accounts.open("theirs", other?.id ?? "", at, until);

        const ended = await accounts.endEveryFor("DMITRY@example.com");

        expect(ended).toBe(2);
        await expect(sessionFor(accounts, "laptop", at)).resolves.toBeNull();
        await expect(sessionFor(accounts, "telephone", at)).resolves.toBeNull();
        await expect(sessionFor(accounts, "theirs", at)).resolves.not.toBeNull();
      });

      it("says nothing was ended for an address nobody has", async () => {
        const accounts = await fresh();

        await expect(accounts.endEveryFor("nobody@example.com")).resolves.toBe(0);
      });

      it("does not let an address decide which rows are deleted", async () => {
        // This is the one query written as SQL rather than assembled by the
        // query builder, and an address is a string somebody chose. Written
        // with the value pasted into the text instead of bound to it, an
        // address shaped like the one below would end every session in the
        // table — including the sessions of people it names nothing about.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const until = new Date(+at + 12 * HOUR);
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        await accounts.open("theirs", person?.id ?? "", at, until);

        const crafted = "' or '1'='1";
        await expect(accounts.endEveryFor(crafted)).resolves.toBe(0);
        await expect(accounts.endEveryFor("x'; delete from cabinet_sessions; --")).resolves.toBe(0);

        await expect(sessionFor(accounts, "theirs", at)).resolves.not.toBeNull();
      });
    });

    describe("a new password", () => {
      it("replaces the old one and ends every session that person had", async () => {
        // A password is set again because the old one is not trusted any more.
        // Sessions opened with it are exactly the thing that must not survive.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        const other = await accounts.add("someone@example.com", "hash-two", at, THE_MERCHANT);
        await accounts.open("laptop", person?.id ?? "", at, new Date(+at + 12 * HOUR));
        await accounts.open("theirs", other?.id ?? "", at, new Date(+at + 12 * HOUR));

        const changed = await accounts.setPassword("Dmitry@Example.com", "hash-three");

        expect(changed).toBe(true);
        expect((await accounts.byEmail("dmitry@example.com"))?.passwordHash).toBe("hash-three");
        await expect(sessionFor(accounts, "laptop", at)).resolves.toBeNull();
        await expect(sessionFor(accounts, "theirs", at)).resolves.not.toBeNull();
      });

      it("is refused for an address nobody has", async () => {
        const accounts = await fresh();

        await expect(accounts.setPassword("nobody@example.com", "hash")).resolves.toBe(false);
      });
    });

    describe("listing the accounts", () => {
      it("names each one and counts only the sessions that are still alive", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const one = await accounts.add("dmitry@example.com", "hash-one", at, THE_MERCHANT);
        await accounts.add("someone@example.com", "hash-two", at, THE_MERCHANT);
        await accounts.open("live", one?.id ?? "", at, new Date(+at + 12 * HOUR));
        await accounts.open("dead", one?.id ?? "", at, new Date(+at + HOUR));

        const listed = await accounts.list(new Date(+at + 2 * HOUR));

        expect(listed.map((row) => row.email)).toStrictEqual([
          "dmitry@example.com",
          "someone@example.com",
        ]);
        expect(listed[0]?.sessions).toBe(1);
        expect(listed[1]?.sessions).toBe(0);
        expect(listed[0]?.createdAt.toISOString()).toBe(at.toISOString());
      });

      it("is in one order whichever store answered and whatever the database would have chosen", async () => {
        // The order is decided in the process, not by the database, so that a
        // person reading a terminal sees the same list from either store and
        // from any deployment. The addresses here are what makes that testable:
        // measured on Postgres 17, the `C` collation and `en-US-x-icu` put
        // `renée@example.com` on opposite sides of `renz@example.com`, and
        // JavaScript's own `<` agrees with `C` while `localeCompare` agrees
        // with ICU. Two addresses of plain lower-case letters, or a hyphen or a
        // dot, are ordered the same way by all four and would hold nothing.
        //
        // They go in in an order that is neither answer, so what is read is a
        // sort and not the order they were added in.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        for (const address of ["renz@example.com", "renée@example.com", "dmitry@example.com"]) {
          await accounts.add(address, "hash", at, THE_MERCHANT);
        }

        const listed = await accounts.list(at);

        expect(listed.map((row) => row.email)).toStrictEqual([
          "dmitry@example.com",
          "renée@example.com",
          "renz@example.com",
        ]);
      });

      it("says there are none rather than failing when nobody has an account", async () => {
        const accounts = await fresh();

        await expect(accounts.list(new Date())).resolves.toStrictEqual([]);
      });

      it("never hands out what it holds of a password, nor the merchant's key", async () => {
        // This is what gets printed to a terminal. A summary carrying either of
        // the two secrets on the row would put it in a scrollback and in
        // whatever collects it. The merchant's identifier is not a secret and
        // is on the summary on purpose: it is how somebody reading the list
        // tells which of two accounts is looking at which catalogue.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        await accounts.add("dmitry@example.com", "the-stored-hash", at, {
          id: "mer_the_merchant",
          key: "the-merchants-own-key",
        });
        await accounts.add("nobody@example.com", "another-stored-hash", at, null);

        const listed = await accounts.list(at);

        expect(JSON.stringify(listed)).not.toContain("the-stored-hash");
        expect(JSON.stringify(listed)).not.toContain("the-merchants-own-key");
        expect(listed.map((row) => row.merchant)).toStrictEqual(["mer_the_merchant", null]);
      });
    });
  });
}
