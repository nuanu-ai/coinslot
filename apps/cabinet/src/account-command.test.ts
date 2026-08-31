/**
 * The command that makes an account for a merchant who already exists.
 *
 * A merchant can register for themselves now (ADR-0014), so this is not the
 * only door into the cabinet any more. It is the one that gets used when the
 * merchant is already at the gateway and needs a person who can sign in as
 * them, and it is still the only answer to a lost password, because nothing
 * here sends mail — a broken one is a cabinet somebody cannot get back into.
 *
 * The tests are about what a person reading a terminal gets and what the store
 * holds afterwards. The password it prints is checked against the account it
 * made, so a command that printed one thing and stored another would fail here
 * instead of at the sign-in form. The merchant's key is checked the other way
 * round: it goes into the store and never comes back out onto the terminal.
 */

import { describe, expect, it } from "vitest";
import { type CabinetKeyCheck, runAccount } from "./account-command.js";
import { loadConfig } from "./config.js";
import { type Identity, identityFor } from "./identity.js";

/**
 * The component the command is driven against, on its own memory store.
 *
 * The real one, doing the real deriving: what these tests hold is that the
 * password the command printed is the password that signs in, and a stubbed
 * store could not be wrong about that in the way a real one can.
 *
 * The rows come back with it so that a test can count sessions and can put a
 * row into a state no door produces — an account with no merchant on it.
 */
const store = (): {
  identity: Identity;
  sessions: () => Record<string, unknown>[];
  forgetMerchant: (email: string) => void;
  /**
   * Writes an account row straight into the store, past every door.
   *
   * For the one test whose subject is a row no door would accept: an address
   * carrying characters a terminal acts on. Such a row arrives from a
   * hand-written insert or a restored dump, never from a form, which is
   * precisely why the listing renders every line it prints rather than trusting
   * what was let in.
   */
  putRow: (row: Record<string, unknown>) => void;
} => {
  const rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
  };
  const identity = identityFor(
    loadConfig({
      DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
      AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    }),
    { rows },
  );
  return {
    identity,
    putRow: (row) => {
      (rows.cabinet_accounts ?? []).push({
        id: `acc_${(rows.cabinet_accounts ?? []).length + 1}`,
        emailVerified: false,
        name: "",
        createdAt: new Date(),
        updatedAt: new Date(),
        merchantId: null,
        merchantKey: null,
        ...row,
      });
    },
    sessions: () => rows.cabinet_sessions ?? [],
    forgetMerchant: (email) => {
      for (const row of rows.cabinet_accounts ?? []) {
        if (row.email === email) {
          row.merchantId = null;
          row.merchantKey = null;
        }
      }
    },
  };
};

/** The password an account in this file is made with, where a test needs one. */
const PASSWORD = "a-password-nobody-guesses";

/** The day these runs happen on, which is what the listing prints. */
const TODAY = new Date().toISOString().slice(0, 10);

/** The merchant an account made in this file belongs to. */
const MERCHANT = "mer_the_merchant";
/**
 * The key that arrives on standard input, unless a test sends something else.
 *
 * Long enough to be accepted, and written here as a readable phrase rather than
 * as something that looks like a real key: what the tests hold is that it never
 * comes back out, and a value you can search the output for is what makes that
 * checkable.
 */
const KEY = "the-merchants-own-key-long-enough";

interface Run {
  readonly code: number;
  readonly said: string;
  /** The password the command printed, where it printed one. */
  readonly password: string | null;
}

/**
 * The moment every run in this file happens at, unless one says otherwise.
 *
 * Fixed rather than the wall clock: the listing counts sessions that are alive
 * now, so a test that made one at a written-down instant and then asked the
 * real clock was a test that passed until nine in the evening and failed after
 * it. It did, on the day it was written.
 */
const NOON = new Date("2026-08-27T12:00:00.000Z");

/**
 * What the gateway says when the command asks whether a key is a cabinet's.
 *
 * The default is the answer a key made for a cabinet gets: another one, which
 * this command throws away. A test that is about the refusals hands over its
 * own, and one that is about anything else never notices this is here.
 */
const takesTheKey: CabinetKeyCheck = async () => ({
  ok: true,
  document: "another-cabinet-key-nobody-keeps",
});

const running = async (
  identity: Identity,
  argv: readonly string[],
  readKey: () => Promise<string> = async () => KEY,
  ask: CabinetKeyCheck = takesTheKey,
): Promise<Run> => {
  const lines: string[] = [];
  const code = await runAccount(
    argv,
    identity,
    {
      say: (line) => lines.push(line),
      readKey,
      now: () => NOON,
    },
    ask,
  );
  const said = lines.join("\n");
  // The command prints a password indented on a line of its own, so that it can
  // be copied without picking it out of a sentence.
  const shown = /^ {4}(\S+)$/m.exec(said);
  return { code, said, password: shown?.[1] ?? null };
};

const run = async (identity: Identity, ...argv: string[]): Promise<Run> =>
  await running(identity, argv);

describe("making an account", () => {
  it("makes one that can be signed into with the password it printed", async () => {
    const { identity } = store();

    const made = await run(identity, "add", "dmitry@example.com", MERCHANT);

    expect(made.code).toBe(0);
    expect(made.said).toContain("dmitry@example.com");
    expect(made.password).not.toBeNull();
    expect(await identity.byEmail("dmitry@example.com")).not.toBeNull();
    // The password it printed is the password that signs in, which is the whole
    // of what this command promises: printing one thing and storing another
    // would be discovered by whoever was handed it, at the sign-in form.
    const signed = await identity.signIn("dmitry@example.com", made.password ?? "");
    expect(signed.ok).toBe(true);
  });

  it("puts the merchant it was named on the account, with the key that came in on standard input", async () => {
    // ADR-0014 §2: the cabinet reaches the gateway with the key on the row of
    // whoever is signed in. An account made without one is an account that can
    // sign in and then see nothing at all, so this is the whole of what the
    // command is for now.
    const { identity } = store();

    const made = await run(identity, "add", "dmitry@example.com", MERCHANT);

    expect(made.code).toBe(0);
    expect((await identity.byEmail("dmitry@example.com"))?.merchant).toStrictEqual({
      id: MERCHANT,
      key: KEY,
    });
  });

  it("never prints the key it was handed", async () => {
    // The key goes to a terminal's scrollback and to whatever collects it, and
    // unlike the password beside it there is nothing to be gained by showing it
    // — whoever ran this is holding it already.
    const { identity } = store();

    const made = await run(identity, "add", "dmitry@example.com", MERCHANT);

    expect(made.said).not.toContain(KEY);
  });

  it("takes a key with the newline a pipe puts on the end of it", async () => {
    // `something | account add ...` ends the value with a newline more often
    // than not, and a key stored with one on the end is a key the gateway
    // refuses — on every screen, with nothing on the page to say why.
    const { identity } = store();

    const made = await running(identity, ["add", "dmitry@example.com", MERCHANT], async () => {
      return `  ${KEY}\n`;
    });

    expect(made.code).toBe(0);
    expect((await identity.byEmail("dmitry@example.com"))?.merchant?.key).toBe(KEY);
  });

  it("refuses when no key arrives on standard input, and says where it looks for one", async () => {
    const { identity } = store();

    const tried = await running(identity, ["add", "dmitry@example.com", MERCHANT], async () => "");

    expect(tried.code).not.toBe(0);
    expect(tried.said).toMatch(/standard input/i);
    await expect(identity.byEmail("dmitry@example.com")).resolves.toBeNull();
  });

  it("refuses a key short enough to walk through", async () => {
    // The floor the gateway holds its own key to. The comparison at the other
    // end is over equal lengths, and a key short enough to guess makes that
    // care pointless — and this is the only place a key is accepted now that
    // the cabinet has no key in its configuration.
    const { identity } = store();

    const tried = await running(
      identity,
      ["add", "dmitry@example.com", MERCHANT],
      async () => "walk-through",
    );

    expect(tried.code).not.toBe(0);
    expect(tried.said).toMatch(/16 characters/);
    // And what arrived is not quoted back. It is a secret whether or not it is
    // the right one, and a terminal's scrollback is where it should not be.
    expect(tried.said).not.toContain("walk-through");
    await expect(identity.byEmail("dmitry@example.com")).resolves.toBeNull();
  });

  it("refuses a key the merchant made for their own code, and says which kind is wanted", async () => {
    // Accepted quietly, such a key makes a cabinet that works by halves: every
    // sign-in fails to replace it and says so in the log nobody is reading, and
    // the keys screen grows a Revoke button the gateway then refuses. The
    // gateway can tell the two kinds apart and this is the call that asks it —
    // the same call the sign-in makes afterwards, so the question is not
    // invented for the occasion.
    const { identity } = store();

    const tried = await running(
      identity,
      ["add", "dmitry@example.com", MERCHANT],
      async () => KEY,
      async () => ({
        ok: false,
        status: 403,
        why: "this call is made with the key a cabinet signs in with, and that is not one",
      }),
    );

    expect(tried.code).not.toBe(0);
    expect(tried.said).toMatch(/own code/i);
    expect(tried.said).not.toContain(KEY);
    await expect(identity.byEmail("dmitry@example.com")).resolves.toBeNull();
  });

  it("writes nothing when the gateway does not answer, rather than guessing", async () => {
    // "I could not ask" is not "the key is fine". An account written on a guess
    // is the same half-working cabinet, found later and by somebody else.
    const { identity } = store();

    const tried = await running(
      identity,
      ["add", "dmitry@example.com", MERCHANT],
      async () => KEY,
      async () => ({ ok: false, status: 0, why: "the gateway could not be reached" }),
    );

    expect(tried.code).not.toBe(0);
    expect(tried.said).toMatch(/gateway/i);
    await expect(identity.byEmail("dmitry@example.com")).resolves.toBeNull();
  });

  it("asks the gateway with the key as it will be stored, and not before the shape is right", async () => {
    // Trimmed, because that is the value that goes on the row and asking about
    // a different one would be asking about nothing. And not at all for a key
    // that is already refused here: a command that reached the network to find
    // out what it can see for itself is a command that hangs when the gateway
    // is down for a reason that has nothing to do with the gateway.
    const { identity } = store();
    const asked: string[] = [];
    const remember: CabinetKeyCheck = async (key) => {
      asked.push(key);
      return { ok: true, document: "another-cabinet-key-nobody-keeps" };
    };

    await running(
      identity,
      ["add", "dmitry@example.com", MERCHANT],
      async () => `  ${KEY}\n`,
      remember,
    );
    await running(
      identity,
      ["add", "someone@example.com", MERCHANT],
      async () => "too-short",
      remember,
    );

    expect(asked).toStrictEqual([KEY]);
  });

  it("says what it wanted when it is given no merchant to make the account for", async () => {
    const { identity } = store();

    const nothing = await run(identity, "add", "dmitry@example.com");

    expect(nothing.code).not.toBe(0);
    expect(nothing.said).toMatch(/merchant/i);
    await expect(identity.byEmail("dmitry@example.com")).resolves.toBeNull();
  });

  it("says the password is shown once and is not kept anywhere readable", async () => {
    // Whoever runs this has to know that scrolling back is the only copy, and
    // that we cannot recover it for them later.
    const { identity } = store();

    const made = await run(identity, "add", "dmitry@example.com", MERCHANT);

    expect(made.said).toContain("once");
  });

  it("refuses an address that already has one rather than replacing the password", async () => {
    // Run twice by mistake, this would otherwise leave the person holding a
    // password that no longer works and no sign that anything happened.
    const { identity } = store();
    const first = await run(identity, "add", "dmitry@example.com", MERCHANT);

    const again = await run(identity, "add", "dmitry@example.com", "mer_somebody_else");

    expect(again.code).not.toBe(0);
    expect(again.said).toContain("already");
    expect(again.password).toBeNull();
    // The password from the first run still signs in, so nobody is left
    // holding one that quietly stopped working.
    expect((await identity.signIn("dmitry@example.com", first.password ?? "")).ok).toBe(true);
    // And the merchant it was pointed at the first time, so a second run cannot
    // quietly move somebody's cabinet to a catalogue that is not theirs.
    expect((await identity.byEmail("dmitry@example.com"))?.merchant?.id).toBe(MERCHANT);
  });

  it("refuses something that is not an address, and says which part is wrong", async () => {
    const { identity } = store();

    for (const bad of ["dmitry", "dmitry@", "@example.com", "a b@example.com", ""]) {
      const tried = await run(identity, "add", bad, MERCHANT);
      expect(tried.code, bad).not.toBe(0);
      expect(tried.said, bad).toMatch(/address/i);
    }
    await expect(identity.list(new Date())).resolves.toStrictEqual([]);
  });

  it("says what it wanted when it is given no address at all", async () => {
    const { identity } = store();

    const nothing = await run(identity, "add");

    expect(nothing.code).not.toBe(0);
    expect(nothing.said).toContain("add");
  });
});

describe("setting a new password from the command line", () => {
  it("replaces the old one and ends every session that person had", async () => {
    // This is what is run when a password has gone somewhere it should not
    // have. A session opened with the old one surviving would make the whole
    // exercise pointless.
    const { identity, sessions } = store();
    await identity.make("dmitry@example.com", PASSWORD, { id: MERCHANT, key: KEY });
    await identity.signIn("dmitry@example.com", PASSWORD);
    expect(sessions()).toHaveLength(1);

    const changed = await run(identity, "password", "dmitry@example.com");

    expect(changed.code).toBe(0);
    expect(changed.password).not.toBeNull();
    expect((await identity.signIn("dmitry@example.com", PASSWORD)).ok).toBe(false);
    expect((await identity.signIn("dmitry@example.com", changed.password ?? "")).ok).toBe(true);
    // Every session the old password opened is gone. The one row left is the
    // one the line above just opened with the new password.
    expect(sessions()).toHaveLength(1);
  });

  it("says so rather than inventing an account for an address nobody has", async () => {
    const { identity } = store();

    const missing = await run(identity, "password", "nobody@example.com");

    expect(missing.code).not.toBe(0);
    expect(missing.said).toContain("nobody@example.com");
    await expect(identity.byEmail("nobody@example.com")).resolves.toBeNull();
  });
});

describe("ending somebody's sessions from the command line", () => {
  it("ends every one of them and says how many", async () => {
    const { identity, sessions } = store();
    await identity.make("dmitry@example.com", PASSWORD, { id: MERCHANT, key: KEY });
    await identity.signIn("dmitry@example.com", PASSWORD);
    await identity.signIn("dmitry@example.com", PASSWORD);
    expect(sessions()).toHaveLength(2);

    const ended = await run(identity, "revoke", "dmitry@example.com");

    expect(ended.code).toBe(0);
    expect(ended.said).toContain("2");
    expect(sessions()).toHaveLength(0);
    // The account is still there: ending a session is not deleting a person.
    await expect(identity.byEmail("dmitry@example.com")).resolves.not.toBeNull();
  });

  it("does not pretend to have ended something for an address nobody has", async () => {
    const { identity } = store();

    const nothing = await run(identity, "revoke", "nobody@example.com");

    expect(nothing.code).not.toBe(0);
    expect(nothing.said).toContain("nobody@example.com");
  });
});

describe("listing what accounts there are", () => {
  it("names each address, when it was made, and how many sessions are open", async () => {
    const { identity } = store();
    await identity.make("dmitry@example.com", PASSWORD, { id: MERCHANT, key: KEY });
    await identity.make("someone@example.com", PASSWORD, { id: MERCHANT, key: KEY });
    await identity.signIn("dmitry@example.com", PASSWORD);

    const listed = await run(identity, "list");

    expect(listed.code).toBe(0);
    expect(listed.said).toContain("dmitry@example.com");
    expect(listed.said).toContain("someone@example.com");
    expect(listed.said).toContain(TODAY);
    expect(listed.said).toMatch(/1 session/);
    // Never a password, nor anything derived from one, on the screen or in a
    // scrollback.
    expect(listed.said).not.toContain(PASSWORD);
  });

  it("says which merchant each account is looking at, and never that merchant's key", async () => {
    // Two accounts on one cabinet are two merchants now, and this listing is
    // the only place anybody can see which is which. The key is what makes that
    // true and is not printed: it goes into a scrollback and into whatever
    // collects it, and whoever is reading this listing does not need it.
    const { identity, forgetMerchant } = store();
    await identity.make("dmitry@example.com", PASSWORD, { id: MERCHANT, key: KEY });
    await identity.make("older@example.com", PASSWORD, { id: MERCHANT, key: KEY });
    forgetMerchant("older@example.com");

    const listed = await run(identity, "list");

    expect(listed.said).toContain(MERCHANT);
    expect(listed.said).not.toContain(KEY);
    // The account made before merchants existed is named as what it is, rather
    // than shown with a blank where the others have an identifier.
    expect(listed.said).toMatch(/older@example\.com.*no merchant/);
  });

  it("says there are none rather than printing an empty table", async () => {
    const { identity } = store();

    const listed = await run(identity, "list");

    expect(listed.code).toBe(0);
    expect(listed.said).toMatch(/no accounts/i);
  });
});

describe("an address carrying characters a terminal acts on", () => {
  /**
   * Three ways of writing something other than what is on the page.
   *
   * The carriage return goes back to the start of the line, so whatever is
   * printed after it lands on top of what the terminal has already shown. The
   * escape turns the colours over. The last one is a right-to-left override: it
   * reverses the direction the rest of the line reads in, reordering an address
   * without changing a byte of it — and it is a format character rather than a
   * control one, so a rendering that knew only about control characters would
   * let it straight through.
   */
  const ERASES_A_ROW = "\u001b[7m\r\u202e";

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
    const { identity, putRow } = store();
    putRow({
      email: `a${ERASES_A_ROW}b@example.com`,
      merchantId: MERCHANT,
      merchantKey: KEY,
    });
    await identity.make("dmitry@example.com", PASSWORD, { id: MERCHANT, key: KEY });

    const listed = await run(identity, "list");

    expect(listed.code).toBe(0);
    expect(listed.said).not.toContain("\u001b");
    expect(listed.said).not.toContain("\r");
    expect(listed.said).not.toContain("\u202e");
    expect(listed.said).toContain("a\\x1b[7m\\x0d\\u{202e}b@example.com");
    // Both people are still there, and neither row is short of a column.
    expect(listed.said).toContain("dmitry@example.com");
    const columns = listed.said.split("\n").map((line) => line.indexOf("made"));
    expect(new Set(columns).size).toBe(1);
  });

  it("is shown rather than obeyed in a refusal as well", async () => {
    // The rejection echoes what was typed, which is a path into the terminal
    // that needs no account and no database at all.
    const { identity } = store();

    const refused = await run(identity, "add", `${ERASES_A_ROW}not an address`);

    expect(refused.code).not.toBe(0);
    expect(refused.said).not.toContain("\u001b");
    expect(refused.said).toContain("\\x1b");
  });
});

describe("a database the migrations have never been run against", () => {
  /** An identity whose every call fails the way the Postgres one does. */
  const withoutTables = (): Identity => {
    const failing = () => {
      throw Object.assign(
        new Error("the cabinet's listing of accounts was not answered by the database (42P01)"),
        { code: "42P01" },
      );
    };
    return new Proxy(store().identity, {
      get: (real, member) => (member === "close" ? real.close.bind(real) : failing),
    }) as Identity;
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
      ["add", "dmitry@example.com", MERCHANT],
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
    const elsewhere: Identity = new Proxy(store().identity, {
      get: () => () => {
        throw Object.assign(
          new Error("the cabinet's listing of accounts was not answered (57P03)"),
          {
            code: "57P03",
          },
        );
      },
    }) as Identity;

    await expect(run(elsewhere, "list")).rejects.toThrow("57P03");
  });
});

describe("a command nobody meant to run", () => {
  it("names the ones there are rather than doing something close to it", async () => {
    const { identity } = store();

    for (const argv of [[], ["delete", "dmitry@example.com"], ["--help"]]) {
      const said = await run(identity, ...argv);
      expect(said.code, argv.join(" ")).not.toBe(0);
      for (const verb of ["add", "password", "revoke", "list"]) {
        expect(said.said, argv.join(" ")).toContain(verb);
      }
    }
  });

  it("says where the merchant's key is read from, so nobody puts it on the line", async () => {
    // The usage text is where somebody looks before they type. A key given as
    // an argument is in the shell's history and in the process list of
    // everybody on the machine, and the only moment that can be prevented is
    // before it is typed.
    const { identity } = store();

    const said = await run(identity, "--help");

    expect(said.said).toMatch(/standard input/i);
  });
});

describe("the verbs that have no key to read", () => {
  it("do not go looking on standard input for one", async () => {
    // A command run without a pipe in front of it waits forever on standard
    // input, so a verb that read it whether or not it needed it would be three
    // of the four verbs hanging at a terminal with nothing printed.
    const { identity } = store();
    await identity.make("dmitry@example.com", PASSWORD, { id: MERCHANT, key: KEY });
    const neverAsked = async (): Promise<string> => {
      throw new Error("standard input was read by a command that has no key to take");
    };

    for (const argv of [
      ["list"],
      ["password", "dmitry@example.com"],
      ["revoke", "dmitry@example.com"],
    ]) {
      const said = await running(identity, argv, neverAsked);
      expect(said.code, argv.join(" ")).toBe(0);
    }
  });
});
