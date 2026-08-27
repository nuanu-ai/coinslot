/**
 * Which database the suite that needs a database is given.
 *
 * This is offline on purpose. It is the one part of that arrangement that
 * decides something before any connection is made, and it is the part that
 * stops `pnpm test:db` emptying the catalogue and the orders somebody has
 * `docker compose up` in front of them. A rule that only holds when a database
 * happens to be running is not the rule we want here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEST_DATABASE_URL, TEST_DATABASE, testDatabaseUrl } from "./database.js";

const given = process.env.DATABASE_URL;

afterEach(() => {
  if (given === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = given;
  }
});

describe("the database the suite is given", () => {
  it("is its own when nobody says otherwise", () => {
    delete process.env.DATABASE_URL;

    expect(testDatabaseUrl()).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(testDatabaseUrl()).toContain(TEST_DATABASE);
  });

  it("is whatever DATABASE_URL names, when it names something else", () => {
    process.env.DATABASE_URL = "postgres://someone:secret@example.test:5432/somewhere_else";

    expect(testDatabaseUrl()).toBe("postgres://someone:secret@example.test:5432/somewhere_else");
  });

  it("is never the database the stack runs on, however it is spelled", () => {
    // The accident this exists for: a developer with the stack up runs the
    // suite against the database the cabinet is showing, and the suite empties
    // it without a word. Refusing is the warning.
    for (const url of [
      "postgres://coinslot:coinslot@localhost:5432/coinslot",
      "postgres://coinslot:coinslot@127.0.0.1:5432/coinslot",
      "postgres://coinslot:coinslot@postgres:5432/coinslot?sslmode=disable",
    ]) {
      process.env.DATABASE_URL = url;
      expect(() => testDatabaseUrl(), url).toThrow(/will not be pointed there/);
    }
  });

  it("says what to do instead, rather than only saying no", () => {
    process.env.DATABASE_URL = "postgres://coinslot:coinslot@localhost:5432/coinslot";

    // The message is the whole of the fix for whoever hits it, so it names the
    // database that is refused, the one to use, and the way out.
    expect(() => testDatabaseUrl()).toThrow(/names "coinslot"/);
    expect(() => testDatabaseUrl()).toThrow(new RegExp(TEST_DATABASE));
    expect(() => testDatabaseUrl()).toThrow(/name any other database/);
  });

  it("treats an empty DATABASE_URL as nobody having said anything", () => {
    // An unset variable and one set to nothing arrive the same way through a
    // shell, and the second must not be read as "connect to the empty string".
    process.env.DATABASE_URL = "";

    expect(testDatabaseUrl()).toBe(DEFAULT_TEST_DATABASE_URL);
  });
});
