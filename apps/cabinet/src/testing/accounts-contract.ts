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
import type { Accounts } from "../accounts.js";

const HOUR = 60 * 60 * 1_000;

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

        const made = await accounts.add("dmitry@example.com", "hash-one", at);
        const found = await accounts.byEmail("dmitry@example.com");

        expect(made?.email).toBe("dmitry@example.com");
        expect(found?.id).toBe(made?.id);
        expect(found?.passwordHash).toBe("hash-one");
        expect(found?.createdAt.toISOString()).toBe(at.toISOString());
      });

      it("answers nothing for an address nobody has", async () => {
        const accounts = await fresh();

        await expect(accounts.byEmail("nobody@example.com")).resolves.toBeNull();
      });

      it("is one per address, and a second attempt does not overwrite the first", async () => {
        // The command that makes accounts is run by hand, and running it twice
        // by mistake must not replace somebody's password with a new one they
        // have not been told.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        await accounts.add("dmitry@example.com", "hash-one", at);

        const again = await accounts.add("dmitry@example.com", "hash-two", at);

        expect(again).toBeNull();
        expect((await accounts.byEmail("dmitry@example.com"))?.passwordHash).toBe("hash-one");
      });

      it("is the same account however the address is typed", async () => {
        // A person who signs in as "Dmitry@Example.com " is the person whose
        // account was made as "dmitry@example.com", and a store that thought
        // otherwise would let two accounts exist for one person.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        await accounts.add("  Dmitry@Example.COM  ", "hash-one", at);

        const found = await accounts.byEmail("dmitry@example.com");

        expect(found?.email).toBe("dmitry@example.com");
        expect(await accounts.add("DMITRY@example.com", "hash-two", at)).toBeNull();
        expect((await accounts.byEmail(" dmitry@EXAMPLE.com "))?.id).toBe(found?.id);
      });
    });

    describe("a session", () => {
      it("names the person it belongs to", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at);

        await accounts.open("fingerprint-one", person?.id ?? "", at, new Date(+at + 12 * HOUR));
        const whose = await accounts.whose("fingerprint-one", new Date(+at + HOUR));

        expect(whose?.email).toBe("dmitry@example.com");
        expect(whose?.id).toBe(person?.id);
      });

      it("is nobody's once its time is up", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at);
        const until = new Date(+at + 12 * HOUR);
        await accounts.open("fingerprint-one", person?.id ?? "", at, until);

        // The instant it expires, not merely well after it.
        await expect(accounts.whose("fingerprint-one", until)).resolves.toBeNull();
        await expect(accounts.whose("fingerprint-one", new Date(+until + 1))).resolves.toBeNull();
        await expect(
          accounts.whose("fingerprint-one", new Date(+until - 1)),
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
        const person = await accounts.add("dmitry@example.com", "hash-one", at);
        const until = new Date(+at + HOUR);
        await accounts.open("laptop", person?.id ?? "", at, until);

        // Used, repeatedly, right up to the last minute.
        for (const minutes of [10, 20, 30, 40, 50, 59]) {
          await expect(
            accounts.whose("laptop", new Date(+at + minutes * 60 * 1_000)),
            `${minutes} minutes in`,
          ).resolves.not.toBeNull();
        }

        await expect(accounts.whose("laptop", until)).resolves.toBeNull();
      });

      it("is nobody's once it has been ended", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at);
        await accounts.open("fingerprint-one", person?.id ?? "", at, new Date(+at + 12 * HOUR));

        await accounts.end("fingerprint-one");

        await expect(accounts.whose("fingerprint-one", at)).resolves.toBeNull();
      });

      it("is ended one at a time, which is the whole reason it is a row", async () => {
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at);
        const until = new Date(+at + 12 * HOUR);
        await accounts.open("laptop", person?.id ?? "", at, until);
        await accounts.open("telephone", person?.id ?? "", at, until);

        await accounts.end("laptop");

        await expect(accounts.whose("laptop", at)).resolves.toBeNull();
        await expect(accounts.whose("telephone", at)).resolves.not.toBeNull();
      });

      it("is nobody's when nothing was ever opened under that identifier", async () => {
        const accounts = await fresh();

        await expect(accounts.whose("never-issued", new Date())).resolves.toBeNull();
        // And ending one that does not exist is not an error: a person pressing
        // sign out twice is not a broken cabinet.
        await expect(accounts.end("never-issued")).resolves.toBeUndefined();
      });

      it("does not pile up after it has expired", async () => {
        // Nothing sweeps this table on a timer, so opening a session is what
        // clears out the ones whose time is up. Without it the table grows for
        // the life of the deployment.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at);
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
        const one = await accounts.add("dmitry@example.com", "hash-one", at);
        const other = await accounts.add("someone@example.com", "hash-two", at);
        await accounts.open("laptop", one?.id ?? "", at, until);
        await accounts.open("telephone", one?.id ?? "", at, until);
        await accounts.open("theirs", other?.id ?? "", at, until);

        const ended = await accounts.endEveryFor("DMITRY@example.com");

        expect(ended).toBe(2);
        await expect(accounts.whose("laptop", at)).resolves.toBeNull();
        await expect(accounts.whose("telephone", at)).resolves.toBeNull();
        await expect(accounts.whose("theirs", at)).resolves.not.toBeNull();
      });

      it("says nothing was ended for an address nobody has", async () => {
        const accounts = await fresh();

        await expect(accounts.endEveryFor("nobody@example.com")).resolves.toBe(0);
      });
    });

    describe("a new password", () => {
      it("replaces the old one and ends every session that person had", async () => {
        // A password is set again because the old one is not trusted any more.
        // Sessions opened with it are exactly the thing that must not survive.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        const person = await accounts.add("dmitry@example.com", "hash-one", at);
        const other = await accounts.add("someone@example.com", "hash-two", at);
        await accounts.open("laptop", person?.id ?? "", at, new Date(+at + 12 * HOUR));
        await accounts.open("theirs", other?.id ?? "", at, new Date(+at + 12 * HOUR));

        const changed = await accounts.setPassword("Dmitry@Example.com", "hash-three");

        expect(changed).toBe(true);
        expect((await accounts.byEmail("dmitry@example.com"))?.passwordHash).toBe("hash-three");
        await expect(accounts.whose("laptop", at)).resolves.toBeNull();
        await expect(accounts.whose("theirs", at)).resolves.not.toBeNull();
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
        const one = await accounts.add("dmitry@example.com", "hash-one", at);
        await accounts.add("someone@example.com", "hash-two", at);
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

      it("says there are none rather than failing when nobody has an account", async () => {
        const accounts = await fresh();

        await expect(accounts.list(new Date())).resolves.toStrictEqual([]);
      });

      it("never hands out what it holds of a password", async () => {
        // This is what gets printed to a terminal. A summary carrying the
        // stored hash would put it in a scrollback and in whatever collects it.
        const accounts = await fresh();
        const at = new Date("2026-08-27T09:00:00.000Z");
        await accounts.add("dmitry@example.com", "the-stored-hash", at);

        const listed = await accounts.list(at);

        expect(JSON.stringify(listed)).not.toContain("the-stored-hash");
      });
    });
  });
}
