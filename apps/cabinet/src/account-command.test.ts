/**
 * The command that makes an account, because there is no other way to get one.
 *
 * ADR-0009: no self-serve sign-up and no reset by mail. That makes this command
 * the only door into the cabinet, and a broken one is a cabinet nobody can open
 * — which is why it is tested at all rather than left as a script.
 *
 * The tests are about what a person reading a terminal gets and what the store
 * holds afterwards. The password it prints is checked against the account it
 * made, so a command that printed one thing and stored another would fail here
 * instead of at the sign-in form.
 */

import { describe, expect, it } from "vitest";
import { runAccount } from "./account-command.js";
import { type Accounts, memoryAccounts } from "./accounts.js";
import { hashPassword, passwordMatches } from "./credentials.js";
import { sessionFor } from "./testing/accounts-contract.js";

const HOUR = 60 * 60 * 1_000;

interface Run {
  readonly code: number;
  readonly said: string;
  /** The password the command printed, where it printed one. */
  readonly password: string | null;
}

const run = async (accounts: Accounts, ...argv: string[]): Promise<Run> => {
  const lines: string[] = [];
  const code = await runAccount(argv, accounts, (line) => lines.push(line));
  const said = lines.join("\n");
  // The command prints a password indented on a line of its own, so that it can
  // be copied without picking it out of a sentence.
  const shown = /^ {4}(\S+)$/m.exec(said);
  return { code, said, password: shown?.[1] ?? null };
};

describe("making an account", () => {
  it("makes one that can be signed into with the password it printed", async () => {
    const accounts = memoryAccounts();

    const made = await run(accounts, "add", "dmitry@example.com");

    expect(made.code).toBe(0);
    expect(made.said).toContain("dmitry@example.com");
    expect(made.password).not.toBeNull();
    const stored = await accounts.byEmail("dmitry@example.com");
    expect(stored).not.toBeNull();
    await expect(passwordMatches(made.password ?? "", stored?.passwordHash ?? "")).resolves.toBe(
      true,
    );
  });

  it("says the password is shown once and is not kept anywhere readable", async () => {
    // Whoever runs this has to know that scrolling back is the only copy, and
    // that we cannot recover it for them later.
    const accounts = memoryAccounts();

    const made = await run(accounts, "add", "dmitry@example.com");

    expect(made.said).toContain("once");
    expect(made.said).not.toContain(
      String((await accounts.byEmail("dmitry@example.com"))?.passwordHash),
    );
  });

  it("refuses an address that already has one rather than replacing the password", async () => {
    // Run twice by mistake, this would otherwise leave the person holding a
    // password that no longer works and no sign that anything happened.
    const accounts = memoryAccounts();
    await run(accounts, "add", "dmitry@example.com");
    const before = (await accounts.byEmail("dmitry@example.com"))?.passwordHash;

    const again = await run(accounts, "add", "dmitry@example.com");

    expect(again.code).not.toBe(0);
    expect(again.said).toContain("already");
    expect(again.password).toBeNull();
    expect((await accounts.byEmail("dmitry@example.com"))?.passwordHash).toBe(before);
  });

  it("refuses something that is not an address, and says which part is wrong", async () => {
    const accounts = memoryAccounts();

    for (const bad of ["dmitry", "dmitry@", "@example.com", "a b@example.com", ""]) {
      const tried = await run(accounts, "add", bad);
      expect(tried.code, bad).not.toBe(0);
      expect(tried.said, bad).toMatch(/address/i);
    }
    await expect(accounts.list(new Date())).resolves.toStrictEqual([]);
  });

  it("says what it wanted when it is given no address at all", async () => {
    const accounts = memoryAccounts();

    const nothing = await run(accounts, "add");

    expect(nothing.code).not.toBe(0);
    expect(nothing.said).toContain("add");
  });
});

describe("setting a new password from the command line", () => {
  it("replaces the old one and ends every session that person had", async () => {
    // This is what is run when a password has gone somewhere it should not
    // have. A session opened with the old one surviving would make the whole
    // exercise pointless.
    const accounts = memoryAccounts();
    const at = new Date("2026-08-27T09:00:00.000Z");
    const person = await accounts.add("dmitry@example.com", await hashPassword("old"), at);
    await accounts.open("laptop", person?.id ?? "", at, new Date(+at + 12 * HOUR));

    const changed = await run(accounts, "password", "dmitry@example.com");

    expect(changed.code).toBe(0);
    expect(changed.password).not.toBeNull();
    const stored = (await accounts.byEmail("dmitry@example.com"))?.passwordHash ?? "";
    await expect(passwordMatches("old", stored)).resolves.toBe(false);
    await expect(passwordMatches(changed.password ?? "", stored)).resolves.toBe(true);
    await expect(sessionFor(accounts, "laptop", at)).resolves.toBeNull();
  });

  it("says so rather than inventing an account for an address nobody has", async () => {
    const accounts = memoryAccounts();

    const missing = await run(accounts, "password", "nobody@example.com");

    expect(missing.code).not.toBe(0);
    expect(missing.said).toContain("nobody@example.com");
    await expect(accounts.byEmail("nobody@example.com")).resolves.toBeNull();
  });
});

describe("ending somebody's sessions from the command line", () => {
  it("ends every one of them and says how many", async () => {
    const accounts = memoryAccounts();
    const at = new Date("2026-08-27T09:00:00.000Z");
    const person = await accounts.add("dmitry@example.com", "hash", at);
    await accounts.open("laptop", person?.id ?? "", at, new Date(+at + 12 * HOUR));
    await accounts.open("telephone", person?.id ?? "", at, new Date(+at + 12 * HOUR));

    const ended = await run(accounts, "revoke", "dmitry@example.com");

    expect(ended.code).toBe(0);
    expect(ended.said).toContain("2");
    await expect(sessionFor(accounts, "laptop", at)).resolves.toBeNull();
    await expect(sessionFor(accounts, "telephone", at)).resolves.toBeNull();
    // The account is still there: ending a session is not deleting a person.
    await expect(accounts.byEmail("dmitry@example.com")).resolves.not.toBeNull();
  });

  it("does not pretend to have ended something for an address nobody has", async () => {
    const accounts = memoryAccounts();

    const nothing = await run(accounts, "revoke", "nobody@example.com");

    expect(nothing.code).not.toBe(0);
    expect(nothing.said).toContain("nobody@example.com");
  });
});

describe("listing what accounts there are", () => {
  it("names each address, when it was made, and how many sessions are open", async () => {
    const accounts = memoryAccounts();
    const at = new Date("2026-08-27T09:00:00.000Z");
    const person = await accounts.add("dmitry@example.com", "hash-one", at);
    await accounts.add("someone@example.com", "hash-two", at);
    await accounts.open("laptop", person?.id ?? "", at, new Date(+at + 12 * HOUR));

    const listed = await run(accounts, "list");

    expect(listed.code).toBe(0);
    expect(listed.said).toContain("dmitry@example.com");
    expect(listed.said).toContain("someone@example.com");
    expect(listed.said).toContain("2026-08-27");
    expect(listed.said).toMatch(/1 session/);
    // Never the stored value of a password, on the screen or in a scrollback.
    expect(listed.said).not.toContain("hash-one");
    expect(listed.said).not.toContain("hash-two");
  });

  it("says there are none rather than printing an empty table", async () => {
    const accounts = memoryAccounts();

    const listed = await run(accounts, "list");

    expect(listed.code).toBe(0);
    expect(listed.said).toMatch(/no accounts/i);
  });
});

describe("an address carrying characters a terminal acts on", () => {
  /**
   * Turn the colours over, then go back to the start of the line.
   *
   * The carriage return is the half that matters: whatever is printed after it
   * lands on top of what the terminal has already shown.
   */
  const ERASES_A_ROW = "\u001b[7m\r";

  it("is shown rather than obeyed, wherever it is printed", async () => {
    // The shape check catches a missing half and a space in the middle, which
    // are the mistakes people make at a terminal; it says nothing about an
    // escape sequence, and a row can also arrive from a hand-written insert or
    // a restored dump that never went through it at all. So the rendering is
    // where the printing happens rather than where the input arrives, and it
    // covers every line this command writes.
    //
    // What is at stake is small and specific: `account list` is the only answer
    // to "who can sign into this cabinet", and a row that can erase the row
    // above it is an answer with somebody quietly missing from it.
    const accounts = memoryAccounts();
    const at = new Date("2026-08-27T09:00:00.000Z");
    await accounts.add(`a${ERASES_A_ROW}b@example.com`, "hash", at);
    await accounts.add("dmitry@example.com", "hash", at);

    const listed = await run(accounts, "list");

    expect(listed.code).toBe(0);
    expect(listed.said).not.toContain("\u001b");
    expect(listed.said).not.toContain("\r");
    expect(listed.said).toContain("a\\x1b[7m\\x0db@example.com");
    // Both people are still there, and neither row is short of a column.
    expect(listed.said).toContain("dmitry@example.com");
    const columns = listed.said.split("\n").map((line) => line.indexOf("made"));
    expect(new Set(columns).size).toBe(1);
  });

  it("is shown rather than obeyed in a refusal as well", async () => {
    // The rejection echoes what was typed, which is a path into the terminal
    // that needs no account and no database at all.
    const accounts = memoryAccounts();

    const refused = await run(accounts, "add", `${ERASES_A_ROW}not an address`);

    expect(refused.code).not.toBe(0);
    expect(refused.said).not.toContain("\u001b");
    expect(refused.said).toContain("\\x1b");
  });
});

describe("a database the migrations have never been run against", () => {
  /** A store whose every call fails the way the Postgres one does. */
  const withoutTables = (): Accounts => {
    const failing = () => {
      throw Object.assign(
        new Error("the cabinet's listing of accounts was not answered by the database (42P01)"),
        { code: "42P01" },
      );
    };
    return new Proxy(memoryAccounts(), {
      get: (store, member) => (member === "close" ? store.close.bind(store) : failing),
    }) as Accounts;
  };

  it("says which command puts the tables there, on every verb", async () => {
    // The first thing a person meets on a new machine. What the database says
    // for itself names a table nobody has heard of and does not say what to
    // run, and a stack trace into the store's internals is worse than either.
    //
    // This was unreachable for a while and nothing noticed: the store stopped
    // letting the driver's exception out, in order to keep the query's bound
    // parameters from reaching the log, and the recognition further up was
    // still looking for a property the new exception did not carry.
    for (const argv of [
      ["list"],
      ["add", "dmitry@example.com"],
      ["revoke", "dmitry@example.com"],
    ]) {
      const said = await run(withoutTables(), ...argv);

      expect(said.code, argv.join(" ")).toBe(1);
      expect(said.said, argv.join(" ")).toContain("tables are not in this database yet");
      expect(said.said, argv.join(" ")).toContain("db:migrate");
      // Not the database's own words, and nothing about a table or a column.
      expect(said.said, argv.join(" ")).not.toContain("42P01");
      expect(said.said, argv.join(" ")).not.toContain("cabinet_accounts");
    }
  });

  it("lets any other failure go up rather than blaming the migrations", async () => {
    // An unfamiliar failure with a confident sentence written over it sends
    // somebody to run a migration that was never the problem.
    const elsewhere: Accounts = new Proxy(memoryAccounts(), {
      get: () => () => {
        throw Object.assign(
          new Error("the cabinet's listing of accounts was not answered (57P03)"),
          {
            code: "57P03",
          },
        );
      },
    }) as Accounts;

    await expect(run(elsewhere, "list")).rejects.toThrow("57P03");
  });
});

describe("a command nobody meant to run", () => {
  it("names the ones there are rather than doing something close to it", async () => {
    const accounts = memoryAccounts();

    for (const argv of [[], ["delete", "dmitry@example.com"], ["--help"]]) {
      const said = await run(accounts, ...argv);
      expect(said.code, argv.join(" ")).not.toBe(0);
      for (const verb of ["add", "password", "revoke", "list"]) {
        expect(said.said, argv.join(" ")).toContain(verb);
      }
    }
  });
});
