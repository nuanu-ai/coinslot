/**
 * The command that makes an account, and the three that keep one.
 *
 * A merchant registers for themselves now (ADR-0014), so this is no longer the
 * only door into the cabinet. It is still the door somebody walks through when
 * a merchant already exists at the gateway and needs a person who can sign in
 * as them — which is what the first account on a deployed server is.
 *
 * It is also still the answer to a lost password, but no longer the only one. A
 * merchant whose address has been confirmed asks the cabinet for a link and
 * never needs anybody at a terminal; this is what is left for the case that is
 * not covered, which is an account nobody has confirmed the address of. The
 * listing says which is which, so that whoever runs this can tell before they
 * start.
 *
 * A password is never taken as an argument. One typed on a command line is in
 * the shell's history, in the process list of everybody on the machine, and in
 * whatever collects either — so the command generates one, prints it once, and
 * has nothing left afterwards that can be read back. A person who wants a
 * password of their own sets it from the cabinet.
 *
 * The merchant's key is not taken as an argument either, and for exactly the
 * same reason: it is a secret, the reasoning above does not care which kind,
 * and an argument is an argument. It is read from standard input instead, so
 * that whoever runs this can pipe it in from wherever they are holding it.
 */

import { newPassword } from "./credentials.js";
import type { AccountMerchant, Identity } from "./identity.js";
import { printable } from "./printable.js";

/**
 * A shape an address has to have before anything is done with it.
 *
 * Deliberately not an attempt at the real grammar of an address, which is
 * larger than anybody thinks. What it catches is the mistakes somebody actually
 * makes at a terminal — a missing half, a space in the middle, a bare word —
 * and nothing here ever sends anything to the address anyway.
 */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * The shortest key this will accept.
 *
 * The floor the gateway holds its own keys to. The comparison at the other end
 * is constant-time over equal lengths, and a key short enough to walk through
 * makes that care pointless. It is checked here because this is now the one
 * place a key is taken in at all — the cabinet has none in its configuration.
 */
const SHORTEST_KEY = 16;

const USAGE = [
  "Usage: pnpm --filter @coinslot/cabinet account <command>",
  "",
  "  add <address> <merchant>  make an account for that merchant and print a",
  "                            password for it, once; the merchant's key is",
  "                            read from standard input",
  "  password <address>        set a new password, print it once, end every session",
  "  revoke <address>          end every session that person has, keeping the account",
  "  list                      the accounts there are, their merchant, and how",
  "                            many sessions are open",
  "",
  "A merchant can register for themselves, and ask for a key once they are in",
  "(ADR-0014). This command is for the other case: a merchant that already",
  "exists at the gateway and needs somebody who can sign in as them.",
  "",
  "The merchant's key is read from standard input rather than taken as an",
  "argument, because an argument is in the shell's history and in the process",
  "list of everybody on the machine. Pipe it in from wherever you are holding",
  "it rather than typing it on the line that runs this.",
];

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

/** The terminal this command is run at, handed in rather than reached for. */
export interface Terminal {
  /** One line to whoever is watching. */
  readonly say: (line: string) => void;
  /**
   * The merchant's key, off standard input.
   *
   * A function rather than a value, so that it is read only by the one verb
   * that needs one. Read eagerly, the three verbs that have no key to take
   * would each sit waiting on a terminal with nothing printed.
   */
  readonly readKey: () => Promise<string>;
  /**
   * The moment this run happens at, with the obvious default.
   *
   * So that a test asking what the listing says about a session can put itself
   * at a moment when that session is alive. Reading the wall clock here instead
   * made one test fail every day after nine in the evening, which is a test
   * that reports on the hour rather than on the code.
   */
  readonly now?: () => Date;
}

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
  identity: Identity,
  terminal: Terminal,
): Promise<number> {
  const print = terminal.say;
  const now = terminal.now ?? (() => new Date());
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
    return await dispatch(argv, identity, say, now, terminal.readKey);
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
  identity: Identity,
  say: (line: string) => void,
  now: () => Date,
  readKey: () => Promise<string>,
): Promise<number> {
  const [verb, address, merchant] = argv;

  if (verb === "list") {
    return await listAccounts(identity, say, now);
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
    return await addAccount(identity, say, address, merchant, readKey);
  }
  if (verb === "password") {
    return await changePassword(identity, say, address);
  }
  return await revokeSessions(identity, say, address);
}

async function addAccount(
  identity: Identity,
  say: (line: string) => void,
  address: string,
  merchantId: string | undefined,
  readKey: () => Promise<string>,
): Promise<number> {
  // Both halves of the merchant before anything is generated or written. An
  // account made without them is one somebody can sign into and then see
  // nothing at all with, because the cabinet reaches the gateway with the key
  // on the row of whoever is signed in (ADR-0014 §2).
  if (merchantId === undefined || merchantId.trim() === "") {
    say(`The add command needs the merchant this account signs in for:`);
    say(`    add ${address.trim()} mer_the_identifier`);
    say("The merchant's key is read from standard input, not given here.");
    return 2;
  }
  // Nothing is guessed about the shape of an identifier the gateway hands out,
  // beyond it being one word: this value is a record of which catalogue the
  // account is looking at, and the gateway resolves the merchant from the key
  // rather than from this.
  if (/\s/.test(merchantId.trim())) {
    say(`"${merchantId}" is not a merchant identifier: it has a space in it.`);
    return 2;
  }

  const merchant = await merchantKey(say, merchantId.trim(), readKey);
  if (merchant === null) {
    return 2;
  }

  const password = newPassword();
  const made = await identity.make(address, password, merchant);
  if (made === null) {
    // Not an overwrite. Somebody running this twice must not silently replace a
    // password the person on the other end is already using, nor point their
    // cabinet at a merchant that is not the one they have been working as.
    say(`${address.trim()} already has an account. Use "password" to set a new one.`);
    return 1;
  }

  say(`An account for ${made.email}, signing in as ${merchant.id}.`);
  showPassword(say, password);
  return 0;
}

/**
 * The merchant's key off standard input, or null having said what was wrong.
 *
 * Trimmed, because a key arrives through a pipe and a pipe puts a newline on
 * the end of almost everything. A key with whitespace in the middle of it is
 * not a thing the gateway issues, so nothing is lost by it — and a key stored
 * with a stray newline is a cabinet whose every screen says the gateway will
 * not take this key, with nothing on the page to say why.
 *
 * Neither refusal quotes what arrived. It is a secret whether or not it is the
 * right one, and a terminal's scrollback is exactly where it should not be.
 */
async function merchantKey(
  say: (line: string) => void,
  id: string,
  readKey: () => Promise<string>,
): Promise<AccountMerchant | null> {
  const key = (await readKey()).trim();
  if (key === "") {
    say("The add command reads the merchant's key from standard input, and nothing arrived.");
    say("Pipe it in from wherever you are holding it rather than typing it on the line:");
    say("    ... | pnpm --filter @coinslot/cabinet account add someone@example.com mer_x");
    return null;
  }
  if (key.length < SHORTEST_KEY) {
    say(
      `That key is shorter than ${SHORTEST_KEY} characters, which is not one the gateway issues.`,
    );
    return null;
  }
  return { id, key };
}

async function changePassword(
  identity: Identity,
  say: (line: string) => void,
  address: string,
): Promise<number> {
  const password = newPassword();
  const changed = await identity.replacePassword(address, password);
  if (!changed) {
    say(`Nobody has an account at ${address.trim()}, so there is no password to change.`);
    return 1;
  }

  say(`A new password for ${address.trim()}, and every session they had is ended.`);
  showPassword(say, password);
  return 0;
}

async function revokeSessions(
  identity: Identity,
  say: (line: string) => void,
  address: string,
): Promise<number> {
  // Asked before it is done, because ending nothing and there being nobody are
  // two different answers and only one of them means somebody mistyped.
  if ((await identity.byEmail(address)) === null) {
    say(`Nobody has an account at ${address.trim()}, so there are no sessions to end.`);
    return 1;
  }

  const ended = await identity.endEverySessionFor(address);
  say(
    ended === 1
      ? `Ended 1 session for ${address.trim()}. The account is untouched.`
      : `Ended ${ended} sessions for ${address.trim()}. The account is untouched.`,
  );
  return 0;
}

async function listAccounts(
  identity: Identity,
  say: (line: string) => void,
  now: () => Date,
): Promise<number> {
  const listed = await identity.list(now());
  if (listed.length === 0) {
    say("There are no accounts. Nobody can sign into this cabinet yet.");
    say("A merchant can register for one from the cabinet, or make one here:");
    say("    ... | pnpm --filter @coinslot/cabinet account add someone@example.com mer_x");
    return 0;
  }

  // Rendered before it is measured, not after: the column is as wide as what a
  // person will see, and an address that grew when it was rendered would
  // otherwise push its own row out of line.
  const rows = listed.map((row) => ({ ...row, email: printable(row.email) }));
  const widest = Math.max(...rows.map((row) => row.email.length));
  for (const row of rows) {
    const open = row.sessions === 1 ? "1 session open" : `${row.sessions} sessions open`;
    // The merchant's identifier, which says which catalogue this person's
    // screens show. An account with none is named as what it is rather than
    // printed with a gap where the others have a word: it was made before
    // accounts had merchants, and it cannot sign in at all.
    const whose = row.merchant ?? "no merchant, cannot sign in";
    // Whether the address has been confirmed, because that is what decides
    // whether this person can be sent a new password or has to be given one
    // from here. Somebody running this command is usually running it for
    // exactly that reason.
    const address = row.confirmed ? "address confirmed" : "address not confirmed";
    say(
      `${row.email.padEnd(widest)}  made ${row.createdAt.toISOString().slice(0, 10)}  ${open}  ${address}  ${whose}`,
    );
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
