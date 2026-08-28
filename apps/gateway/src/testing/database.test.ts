/**
 * Which database the suite that needs a database is given.
 *
 * This is offline on purpose. It is the one part of that arrangement that
 * decides something before any connection is made, and it is the part that
 * stops `pnpm test:db` emptying the catalogue and the orders somebody has
 * `docker compose up` in front of them. A rule that only holds when a database
 * happens to be running is not the rule we want here.
 *
 * The variable names are spelled out rather than imported. They are what an
 * operator types on a host where the database is not on 5432, and a rename that
 * left every document in the repository pointing at the old name would go green
 * if this file read the new one out of the source.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEST_DATABASE_URL, TEST_DATABASE, testDatabaseUrl } from "./database.js";

/** The database the cabinet is showing. Never this suite's. */
const stack = "postgres://coinslot:coinslot@localhost:5432/coinslot";

/** A server bound where a deployment binds it rather than where a laptop does. */
const moved = `postgres://coinslot:coinslot@localhost:55432/${TEST_DATABASE}`;

const started = process.env.COINSLOT_TEST_DATABASE_URL;

afterEach(() => {
  if (started === undefined) {
    delete process.env.COINSLOT_TEST_DATABASE_URL;
  } else {
    process.env.COINSLOT_TEST_DATABASE_URL = started;
  }
});

describe("the database the suite is given", () => {
  it("is its own when nobody says otherwise", () => {
    expect(testDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(DEFAULT_TEST_DATABASE_URL).toContain(TEST_DATABASE);
  });

  it("is the server COINSLOT_TEST_DATABASE_URL names", () => {
    // The reason the variable exists: this file's default finds the database
    // where `compose.yaml` publishes it on a laptop, and a host that publishes
    // it anywhere else — a deployment binds `127.0.0.1:55432:5432`, because the
    // password is in a repository — has no other way to say so.
    expect(testDatabaseUrl({ COINSLOT_TEST_DATABASE_URL: moved })).toBe(moved);
  });

  it("takes that over a DATABASE_URL meant for something else", () => {
    // On such a host DATABASE_URL is already spoken for: it is what
    // `db:migrate` and `account add` are handed, and what it names there is the
    // stack's own database. The variable with "test" in its name is the
    // specific one, so it wins, and the suite runs where it was sent instead of
    // refusing over a variable that was never about it.
    expect(testDatabaseUrl({ COINSLOT_TEST_DATABASE_URL: moved, DATABASE_URL: stack })).toBe(moved);
  });

  it("is whatever DATABASE_URL names, when it names something else", () => {
    const elsewhere = "postgres://someone:secret@example.test:5432/somewhere_else";

    expect(testDatabaseUrl({ DATABASE_URL: elsewhere })).toBe(elsewhere);
  });

  it("is never the database the stack runs on, whichever variable names it", () => {
    // The accident this exists for: a developer with the stack up runs the
    // suite against the database the cabinet is showing, and the suite empties
    // it without a word. Refusing is the warning — and a second way of naming
    // a database is a second way of walking into it.
    for (const variable of ["COINSLOT_TEST_DATABASE_URL", "DATABASE_URL"]) {
      for (const url of [
        "postgres://coinslot:coinslot@localhost:5432/coinslot",
        "postgres://coinslot:coinslot@127.0.0.1:55432/coinslot",
        "postgres://coinslot:coinslot@postgres:5432/coinslot?sslmode=disable",
      ]) {
        expect(() => testDatabaseUrl({ [variable]: url }), `${variable}=${url}`).toThrow(
          /will not be pointed there/,
        );
      }
    }
  });

  it("says which variable said it, and what to do instead", () => {
    // The message is the whole of the fix for whoever hits it, so it names the
    // variable that has to change — with two of them, "DATABASE_URL names
    // coinslot" sends half the people who read it to the wrong line.
    expect(() => testDatabaseUrl({ COINSLOT_TEST_DATABASE_URL: stack })).toThrow(
      /^COINSLOT_TEST_DATABASE_URL names "coinslot"/,
    );
    expect(() => testDatabaseUrl({ DATABASE_URL: stack })).toThrow(
      /^DATABASE_URL names "coinslot"/,
    );
    expect(() => testDatabaseUrl({ DATABASE_URL: stack })).toThrow(new RegExp(TEST_DATABASE));
    expect(() => testDatabaseUrl({ DATABASE_URL: stack })).toThrow(/name any other database/);
  });

  it("refuses an address that names no database at all", () => {
    // Measured against postgres:17-alpine rather than assumed: an address that
    // stops at the port, and one that ends in a bare slash, both connect to the
    // database named after the user — which on this stack is `coinslot`. So a
    // URL that looks finished walks straight past the refusal above and empties
    // the cabinet's database.
    for (const url of [
      "postgres://coinslot:coinslot@localhost:55432",
      "postgres://coinslot:coinslot@localhost:55432/",
    ]) {
      expect(() => testDatabaseUrl({ COINSLOT_TEST_DATABASE_URL: url }), url).toThrow(
        /names no database/,
      );
      expect(() => testDatabaseUrl({ DATABASE_URL: url }), url).toThrow(/names no database/);
    }
  });

  it("refuses an empty COINSLOT_TEST_DATABASE_URL rather than quietly using 5432", () => {
    // A variable emptied by accident — a line in a `.env` with its value
    // deleted, a shell expanding a name that is not set — is not a request for
    // the default. Whoever set this one at all is on a host where the default's
    // localhost:5432 is the wrong server, so falling back to it there is a
    // connection error naming an address nobody chose, or a run against
    // whatever else answers on that port.
    expect(() => testDatabaseUrl({ COINSLOT_TEST_DATABASE_URL: "" })).toThrow(
      /^COINSLOT_TEST_DATABASE_URL is set to nothing/,
    );
  });

  it("treats an empty DATABASE_URL as nobody having said anything", () => {
    // The other half of that: DATABASE_URL is not this suite's variable. An
    // unset one and one set to nothing arrive the same way through a shell, and
    // the second must not be read as "connect to the empty string".
    expect(testDatabaseUrl({ DATABASE_URL: "" })).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it("says which variable it could not read, without repeating what was in it", () => {
    // A connection string is mostly a password, and what a suite throws ends up
    // in CI output and in a scrollback somebody pastes. Naming the variable is
    // the whole of what the reader needs; the value they can look at
    // themselves.
    const thrown = (): string => {
      try {
        testDatabaseUrl({ COINSLOT_TEST_DATABASE_URL: "postgres//coinslot:s3cret@localhost/x" });
        return "";
      } catch (error) {
        return String(error);
      }
    };

    expect(thrown()).toContain("COINSLOT_TEST_DATABASE_URL");
    expect(thrown()).not.toContain("s3cret");
  });

  it("reads the environment this process was started with when given none", () => {
    // Everything above hands the function an environment, which is what makes
    // this file offline. That must not quietly become the only environment the
    // suite ever looks at: `pnpm test:db` calls this with nothing.
    process.env.COINSLOT_TEST_DATABASE_URL = moved;

    expect(testDatabaseUrl()).toBe(moved);
  });
});
