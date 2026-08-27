/**
 * The command that makes an account, and the three that keep one.
 *
 * ADR-0009: no self-serve sign-up and no reset by mail. Registration with an
 * address is a decision nobody has taken (ADR-0010), so an account exists
 * because somebody ran this. That makes it the only door into the cabinet,
 * which is why it is a tested module with the terminal handed to it rather than
 * a script that prints as it goes.
 *
 * A password is never taken as an argument. One typed on a command line is in
 * the shell's history, in the process list of everybody on the machine, and in
 * whatever collects either — so the command generates one, prints it once, and
 * has nothing left afterwards that can be read back. A person who wants a
 * password of their own sets it from the cabinet.
 */

import type { Accounts } from "./accounts.js";
import { hashPassword, newPassword } from "./credentials.js";

/**
 * A shape an address has to have before anything is done with it.
 *
 * Deliberately not an attempt at the real grammar of an address, which is
 * larger than anybody thinks. What it catches is the mistakes somebody actually
 * makes at a terminal — a missing half, a space in the middle, a bare word —
 * and nothing here ever sends anything to the address anyway.
 */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const USAGE = [
  "Usage: pnpm --filter @coinslot/cabinet account <command>",
  "",
  "  add <address>       make an account and print a password for it, once",
  "  password <address>  set a new password, print it once, end every session",
  "  revoke <address>    end every session that person has, keeping the account",
  "  list                the accounts there are, and how many sessions are open",
  "",
  "There is no sign-up page and no reset by mail (ADR-0009): an account exists",
  "because somebody ran this.",
];

/**
 * One line with nothing left in it that a terminal will act on.
 *
 * Shown rather than removed, so that a row with something odd in it looks odd:
 * an address nobody can read is still better information than an address that
 * silently painted over the one above it. Anything already printable is left
 * exactly as it is, so an address with a letter outside ASCII in it reads as
 * itself.
 */
const printable = (line: string): string =>
  line.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (found) => {
    const at = found.codePointAt(0) ?? 0;
    return at <= 0xff ? `\\x${at.toString(16).padStart(2, "0")}` : `\\u{${at.toString(16)}}`;
  });

/** Postgres's own answer for "there is no table by that name". */
const NO_SUCH_TABLE = "42P01";

/**
 * Whether this is the database saying the cabinet's tables are not there.
 *
 * The store never lets the driver's own exception out — its message is the SQL
 * it tried followed by every bound parameter — so what arrives here is a
 * sentence and the database's own code carried beside it, and the code is what
 * this reads. It lives in this file rather than in the wiring next door because
 * this is where the sentences an operator reads are, and where they are tested.
 */
const missingTables = (thrown: unknown): boolean =>
  typeof thrown === "object" &&
  thrown !== null &&
  "code" in thrown &&
  String((thrown as { code: unknown }).code) === NO_SUCH_TABLE;

/**
 * Runs one command. The answer is the exit code.
 *
 * One failure is answered here rather than thrown: a database that has never
 * had the cabinet's migrations run against it. It is the first thing a person
 * meets on a new machine, and the database's own sentence for it names a table
 * they have never heard of and does not say what to run. Everything else goes
 * up as it is — an unfamiliar failure with a sentence invented over it is worse
 * than an unfamiliar failure.
 */
export async function runAccount(
  argv: readonly string[],
  accounts: Accounts,
  print: (line: string) => void,
): Promise<number> {
  // Everything this command prints goes through one rendering, rather than the
  // half-dozen places that print an address, because forgetting one of those is
  // the whole failure. What it takes out is the characters a terminal obeys
  // instead of showing: an escape that clears the line it is on, a carriage
  // return that writes over the row above, an override that reverses the
  // direction text reads in. An address carrying one arrives either from
  // somebody's shell or from a row written by hand, and a list of accounts
  // where one row can hide another cannot answer "who can sign into this
  // cabinet", which is the only question it is for.
  const say = (line: string): void => print(printable(line));
  try {
    return await dispatch(argv, accounts, say);
  } catch (thrown) {
    if (!missingTables(thrown)) {
      throw thrown;
    }
    say("The cabinet's tables are not in this database yet.");
    say("Run: pnpm --filter @coinslot/cabinet db:migrate");
    return 1;
  }
}

async function dispatch(
  argv: readonly string[],
  accounts: Accounts,
  say: (line: string) => void,
): Promise<number> {
  const [verb, address] = argv;

  if (verb === "list") {
    return await listAccounts(accounts, say);
  }
  if (verb !== "add" && verb !== "password" && verb !== "revoke") {
    for (const line of USAGE) {
      say(line);
    }
    return 2;
  }
  if (address === undefined) {
    say(`The ${verb} command needs an address: ${verb} someone@example.com`);
    return 2;
  }
  if (!LOOKS_LIKE_AN_ADDRESS.test(address.trim())) {
    say(`"${address}" is not an address of the shape someone@example.com.`);
    return 2;
  }

  if (verb === "add") {
    return await addAccount(accounts, say, address);
  }
  if (verb === "password") {
    return await changePassword(accounts, say, address);
  }
  return await revokeSessions(accounts, say, address);
}

async function addAccount(
  accounts: Accounts,
  say: (line: string) => void,
  address: string,
): Promise<number> {
  const password = newPassword();
  const made = await accounts.add(address, await hashPassword(password), new Date());
  if (made === null) {
    // Not an overwrite. Somebody running this twice must not silently replace a
    // password the person on the other end is already using.
    say(`${address.trim()} already has an account. Use "password" to set a new one.`);
    return 1;
  }

  say(`An account for ${made.email}.`);
  showPassword(say, password);
  return 0;
}

async function changePassword(
  accounts: Accounts,
  say: (line: string) => void,
  address: string,
): Promise<number> {
  const password = newPassword();
  const changed = await accounts.setPassword(address, await hashPassword(password));
  if (!changed) {
    say(`Nobody has an account at ${address.trim()}, so there is no password to change.`);
    return 1;
  }

  say(`A new password for ${address.trim()}, and every session they had is ended.`);
  showPassword(say, password);
  return 0;
}

async function revokeSessions(
  accounts: Accounts,
  say: (line: string) => void,
  address: string,
): Promise<number> {
  // Asked before it is done, because ending nothing and there being nobody are
  // two different answers and only one of them means somebody mistyped.
  if ((await accounts.byEmail(address)) === null) {
    say(`Nobody has an account at ${address.trim()}, so there are no sessions to end.`);
    return 1;
  }

  const ended = await accounts.endEveryFor(address);
  say(
    ended === 1
      ? `Ended 1 session for ${address.trim()}. The account is untouched.`
      : `Ended ${ended} sessions for ${address.trim()}. The account is untouched.`,
  );
  return 0;
}

async function listAccounts(accounts: Accounts, say: (line: string) => void): Promise<number> {
  const listed = await accounts.list(new Date());
  if (listed.length === 0) {
    say("There are no accounts. Nobody can sign into this cabinet yet.");
    say("Make one: pnpm --filter @coinslot/cabinet account add someone@example.com");
    return 0;
  }

  // Rendered before it is measured, not after: the column is as wide as what a
  // person will see, and an address that grew when it was rendered would
  // otherwise push its own row out of line.
  const rows = listed.map((row) => ({ ...row, email: printable(row.email) }));
  const widest = Math.max(...rows.map((row) => row.email.length));
  for (const row of rows) {
    const open = row.sessions === 1 ? "1 session open" : `${row.sessions} sessions open`;
    say(`${row.email.padEnd(widest)}  made ${row.createdAt.toISOString().slice(0, 10)}  ${open}`);
  }
  return 0;
}

/**
 * The one place a password is printed.
 *
 * Indented on a line of its own so it can be copied without picking it out of a
 * sentence, and said out loud to be the only copy — because it is. What is kept
 * is a `scrypt` derivation, and nothing here or anywhere else can read the
 * password back out of it.
 */
function showPassword(say: (line: string) => void, password: string): void {
  say("This is the password. It is shown once and nothing keeps a readable copy:");
  say("");
  say(`    ${password}`);
  say("");
  say("Hand it over, and have them set one of their own from the cabinet.");
}
