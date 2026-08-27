/**
 * The commands that make a merchant and keep their keys.
 *
 * There is no route behind any of this and that is the decision rather than the
 * stage it stopped at (ADR-0010): a merchant makes and revokes their own keys
 * from the cabinet, and the screens for it are the step after this one. Until
 * they exist, the keys are made the way the cabinet's accounts are — by
 * somebody at a terminal, through a tested module with the terminal handed to
 * it rather than a script that prints as it goes.
 *
 * A key is never taken as an argument. One typed on a command line is in the
 * shell's history and in the process list of everybody on the machine, so this
 * generates it, prints it once, and keeps nothing that can be read back: what
 * is written down is a SHA-256 digest. A key that is lost is gone, and the
 * answer to a lost key is a new one and then disabling the old — which is what
 * keys being rows is for.
 */

import { issueKey, makeMerchant } from "./app/merchants.js";
import type { Ids } from "./ports/clock.js";
import type { Store, StoredKey } from "./ports/store.js";

const USAGE = [
  "Usage: pnpm --filter @coinslot/gateway merchant <command>",
  "",
  "  add <name>                 make a merchant and print the identifier it got",
  "  list                       the merchants there are, and how many keys work",
  "  key <merchant> <label>     issue a key to a merchant and print it, once",
  "  keys <merchant>            that merchant's keys, working and revoked",
  "  disable <key>              stop one key working, touching no other",
  "",
  "A merchant and a key are named by the identifiers these commands print.",
  "Nothing here can show a key again: what is kept is a digest of it.",
];

/** Runs one command. The answer is the exit code. */
export async function runMerchant(
  argv: readonly string[],
  store: Store,
  ids: Ids,
  now: () => number,
  say: (line: string) => void,
): Promise<number> {
  const [verb, first, ...rest] = argv;

  if (verb === "list") {
    return await listMerchants(store, say);
  }
  if (verb === "add") {
    return first === undefined || first.trim() === ""
      ? needs(say, "add", "a name", 'add "Someone\'s shop"')
      : await addMerchant(store, ids, now, say, [first, ...rest].join(" "));
  }
  if (verb === "key") {
    if (first === undefined) {
      return needs(say, "key", "a merchant", 'key the_merchant "the shop\'s own worker"');
    }
    const label = rest.join(" ").trim();
    return label === ""
      ? needs(say, "key", "a label", 'key the_merchant "the shop\'s own worker"')
      : await addKey(store, ids, now, say, first, label);
  }
  if (verb === "keys") {
    return first === undefined
      ? needs(say, "keys", "a merchant", "keys the_merchant")
      : await listKeys(store, say, first);
  }
  if (verb === "disable") {
    return first === undefined
      ? needs(say, "disable", "a key", "disable mk_3f2a...")
      : await disableKey(store, now, say, first);
  }

  for (const line of USAGE) {
    say(line);
  }
  return 2;
}

function needs(say: (line: string) => void, verb: string, what: string, example: string): number {
  say(`The ${verb} command needs ${what}: ${example}`);
  return 2;
}

async function addMerchant(
  store: Store,
  ids: Ids,
  now: () => number,
  say: (line: string) => void,
  name: string,
): Promise<number> {
  const made = await makeMerchant(store, ids, name.trim(), now());
  if (made === null) {
    // Only reachable where the identifier was chosen rather than generated, and
    // it is answered rather than thrown because the caller may have meant it.
    say(`There is already a merchant under that identifier. Nothing was written.`);
    return 1;
  }

  say(`A merchant, ${made.name}.`);
  say("");
  say(`    ${made.id}`);
  say("");
  say(`They have no keys yet: pnpm --filter @coinslot/gateway merchant key ${made.id} "a name"`);
  return 0;
}

async function listMerchants(store: Store, say: (line: string) => void): Promise<number> {
  const merchants = await store.merchants();
  if (merchants.length === 0) {
    say("There are no merchants, so nothing can be published and no key opens anything.");
    say('Make one: pnpm --filter @coinslot/gateway merchant add "Someone\'s shop"');
    return 0;
  }

  const widest = Math.max(...merchants.map((merchant) => merchant.id.length));
  for (const merchant of merchants) {
    const keys = await store.keysOf(merchant.id);
    const working = keys.filter((key) => key.disabledAt === null).length;
    const counted = working === 1 ? "1 key works" : `${working} keys work`;
    say(
      `${merchant.id.padEnd(widest)}  ${dayOf(merchant.createdAt)}  ${merchant.selling.padEnd(8)}  ${counted}  ${merchant.name}`,
    );
  }
  return 0;
}

async function addKey(
  store: Store,
  ids: Ids,
  now: () => number,
  say: (line: string) => void,
  merchantId: string,
  label: string,
): Promise<number> {
  // Looked up first, so that naming a merchant who is not there is a sentence
  // somebody reads rather than a foreign key violation out of the driver.
  if ((await store.merchantById(merchantId)) === null) {
    say(`There is no merchant ${merchantId}, so there is nobody for a key to belong to.`);
    return 1;
  }

  const issued = await issueKey(store, ids, merchantId, label, now());
  say(`A key for ${merchantId}, called "${issued.key.label}", under ${issued.key.id}.`);
  say("This is the key. It is shown once and nothing keeps a readable copy:");
  say("");
  say(`    ${issued.secret}`);
  say("");
  say("Hand it over. A key that is lost is replaced by a new one and the old one disabled.");
  return 0;
}

async function listKeys(
  store: Store,
  say: (line: string) => void,
  merchantId: string,
): Promise<number> {
  if ((await store.merchantById(merchantId)) === null) {
    say(`There is no merchant ${merchantId}, so there are no keys to list.`);
    return 1;
  }

  const keys = await store.keysOf(merchantId);
  if (keys.length === 0) {
    say(`${merchantId} has no keys, so nothing of theirs can be reached over the API.`);
    return 0;
  }

  const widest = Math.max(...keys.map((key) => key.id.length));
  for (const key of keys) {
    say(`${key.id.padEnd(widest)}  ${dayOf(key.createdAt)}  ${standingOf(key)}  ${key.label}`);
  }
  return 0;
}

async function disableKey(
  store: Store,
  now: () => number,
  say: (line: string) => void,
  keyId: string,
): Promise<number> {
  const key = await store.disableKey(keyId, now());
  if (key === null) {
    say(`There is no key ${keyId}, so there is nothing to disable.`);
    return 1;
  }

  // Disabling one key touches no other key of that merchant, which is the whole
  // reason a key is a row. Said out loud, because somebody revoking a key that
  // has leaked needs to know whether they have just locked the merchant out.
  const others = (await store.keysOf(key.merchantId)).filter(
    (other) => other.id !== key.id && other.disabledAt === null,
  );
  say(`${key.id} ("${key.label}") no longer opens anything, from ${stampOf(key.disabledAt)}.`);
  say(
    others.length === 0
      ? `${key.merchantId} now has no working key, so nothing of theirs can be reached over the API.`
      : others.length === 1
        ? `${key.merchantId} has 1 other key and it still works.`
        : `${key.merchantId} has ${others.length} other keys and they still work.`,
  );
  return 0;
}

/** Where a key stands, in a word wide enough for both. */
function standingOf(key: StoredKey): string {
  return key.disabledAt === null ? "works  " : `revoked ${dayOf(key.disabledAt)}`;
}

const dayOf = (instant: number): string => new Date(instant).toISOString().slice(0, 10);

const stampOf = (instant: number | null): string =>
  instant === null ? "an instant nothing recorded" : new Date(instant).toISOString();
