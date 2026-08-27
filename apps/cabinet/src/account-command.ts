/**
 * The command that makes an account, and the three that keep one.
 *
 * ADR-0009: no self-serve sign-up and no reset by mail, because the pilot has
 * one merchant we create by hand. That makes this the only door into the
 * cabinet, which is why it is a tested module with the terminal handed to it
 * rather than a script that prints as it goes.
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

/** Runs one command. The answer is the exit code. */
export async function runAccount(
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

  const widest = Math.max(...listed.map((row) => row.email.length));
  for (const row of listed) {
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
