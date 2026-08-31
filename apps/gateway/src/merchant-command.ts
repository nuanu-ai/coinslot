/**
 * The commands that make a merchant and keep their keys.
 *
 * A merchant now makes and revokes their own keys over the API, and sets the
 * name their products are sold under, from their cabinet (ADR-0014), so this is
 * no longer the only way any of it happens. What it is for is everything those
 * routes deliberately cannot do: making a merchant without an invitation,
 * issuing a key to somebody who has lost every key they had, disabling a key by
 * naming it alone — which is what the route refuses when it is the key the
 * caller is holding — and taking a listing name away, which the route refuses
 * outright. Somebody at a terminal has the whole database in front of them and
 * needs no merchant to be scoped to; that is the difference, and it is why
 * these verbs stay.
 *
 * The listing name is the one worth reading twice, because the two sides differ
 * in what they allow rather than in who they are scoped to. A merchant sets a
 * name and changes it and can never end up with none: somebody reaching for
 * that from a cabinet wants either a different name or an end to selling, and
 * both of those are calls they already have. Here `--none` exists for the one
 * act neither of them is — a name that should never have been listed, pulled by
 * somebody with the whole database in front of them. It takes the merchant's
 * cards off sale as it goes, because a card sells only under a name, and the
 * command says so at the terminal.
 *
 * The address a merchant is paid at is the same shape of verb and has no such
 * escape, for the reason written beside it: there is no caller for whom taking
 * one away is the right act.
 *
 * It is a tested module with the terminal handed to it rather than a script
 * that prints as it goes, for the reason the cabinet's account command is.
 *
 * A key is never taken as an argument. One typed on a command line is in the
 * shell's history and in the process list of everybody on the machine, so this
 * generates it, prints it once, and keeps nothing that can be read back: what
 * is written down is a SHA-256 digest. A key that is lost is gone, and the
 * answer to a lost key is a new one and then disabling the old — which is what
 * keys being rows is for.
 */

import { ZodError } from "zod";
import { issueKey, makeMerchant, setPayoutWallet, setServiceName } from "./app/merchants.js";
import type { Ids } from "./ports/clock.js";
import type { Store, StoredKey, StoredMerchant } from "./ports/store.js";

const USAGE = [
  "Usage: pnpm --filter @coinslot/gateway merchant <command>",
  "",
  "  add <name>                 make a merchant and print the identifier it got",
  "  list                       the merchants there are, and how many keys work",
  "  listed-as <merchant> <name>",
  "                             the name this seller is shown under in a",
  "                             discovery catalog, or --none to take it away",
  "                             and their cards off sale with it",
  "  pays-to <merchant> <0x…>   the address this merchant's sales are paid into",
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
  if (verb === "listed-as") {
    if (first === undefined) {
      return needs(say, "listed-as", "a merchant", 'listed-as the_merchant "The pilot merchant"');
    }
    const named = rest.join(" ").trim();
    return named === ""
      ? needs(say, "listed-as", "a name", 'listed-as the_merchant "The pilot merchant"')
      : await setListingName(store, now, say, first, named === NO_NAME ? null : named);
  }
  if (verb === "pays-to") {
    if (first === undefined) {
      return needs(say, "pays-to", "a merchant", "pays-to the_merchant 0x…");
    }
    const address = rest.join(" ").trim();
    return address === ""
      ? needs(say, "pays-to", "an address", "pays-to the_merchant 0x…")
      : await setPaidAt(store, now, say, first, address);
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

/**
 * The word that takes a listing name away, rather than a verb of its own.
 *
 * A name is one argument, so "no name" needs some spelling, and an empty one
 * would be indistinguishable from a shell that swallowed a quote. This is a
 * word nobody would ever be listed under.
 */
const NO_NAME = "--none";

async function setListingName(
  store: Store,
  now: () => number,
  say: (line: string) => void,
  merchantId: string,
  serviceName: string | null,
): Promise<number> {
  let named: StoredMerchant | null;
  try {
    named = await setServiceName(store, merchantId, serviceName, now());
  } catch (thrown) {
    // The name will not survive the catalog, and the catalog would not say so.
    // What is printed is the rule and the name that broke it; nothing is
    // written, so the merchant keeps whatever they were listed under before.
    say(`That name cannot be listed: ${reasonOf(thrown)}`);
    say("Nothing was written.");
    return 1;
  }

  if (named === null) {
    say(`There is no merchant ${merchantId}, so there is nobody to list.`);
    return 1;
  }

  if (named.serviceName !== null) {
    say(`${named.id} is listed as "${named.serviceName}".`);
    return 0;
  }

  // The whole of what was just done, because the row is the smaller half of it.
  // A card sells only under a name — that name is what the payment request
  // calls the seller — so every card this merchant has published is off sale
  // from now, and somebody who read "nothing about the seller goes out" and
  // walked away would find that out from the merchant.
  say(`${named.id} is listed under no name, so nothing about the seller goes out.`);
  say("");
  say("Every card they have published is off sale until they are listed again:");
  say("a payment request has to name the seller, and there is nobody to name.");
  return 0;
}

/**
 * Where one merchant's sales are paid into, set from a terminal.
 *
 * There is no `--none` here and the omission is deliberate. Taking a listing
 * name away is a thing somebody at a terminal has a reason to do — a name that
 * should never have been listed is pulled, and the merchant's cards come off
 * sale with it. Taking an address away has no such use: nobody needs a
 * merchant's money to stop arriving somewhere, and the acts that stop their
 * selling are the pause and, from here, the name. What this verb is for is the
 * merchant who cannot reach their own cabinet, and for them the useful act is
 * setting an address rather than removing one.
 */
async function setPaidAt(
  store: Store,
  now: () => number,
  say: (line: string) => void,
  merchantId: string,
  address: string,
): Promise<number> {
  let paid: StoredMerchant | null;
  try {
    paid = await setPayoutWallet(store, merchantId, address, now());
  } catch (thrown) {
    // The one wrong answer available is writing down an address that is not
    // theirs, and nothing downstream would ever notice. What is printed is the
    // rule and the address that broke it; nothing is written, so the merchant
    // keeps whatever they were paid at before.
    say(`That is not an address this merchant can be paid at: ${reasonOf(thrown)}`);
    say("Nothing was written.");
    return 1;
  }

  if (paid === null) {
    say(`There is no merchant ${merchantId}, so there is nobody to pay.`);
    return 1;
  }

  say(`${paid.id} is paid at ${paid.payoutWallet}.`);
  return 0;
}

/** What a refusal said, in the words the person at the terminal should read. */
function reasonOf(thrown: unknown): string {
  if (thrown instanceof ZodError) {
    return thrown.issues.map((issue) => issue.message).join("; ");
  }
  return thrown instanceof Error ? thrown.message : String(thrown);
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
    // The name a merchant is known by to everybody else is the one their
    // products are sold under, so that is the one printed where they have
    // chosen it. Where they have not, the row falls back to the name in the
    // merchants table and says which of the two this is — a merchant made by
    // registering has a row name nobody typed, so a listing that showed only
    // that column would read identically down every row of them, and being
    // unlisted is the more useful fact anyway: it is why they cannot publish.
    const [whichName, name] =
      merchant.serviceName === null
        ? ["unlisted", merchant.name]
        : ["sold as", merchant.serviceName];
    say(
      `${merchant.id.padEnd(widest)}  ${dayOf(merchant.createdAt)}  ${merchant.selling.padEnd(8)}  ${counted.padEnd(COUNT_WIDTH)}  ${whichName.padEnd(8)}  ${name}`,
    );
  }
  return 0;
}

/**
 * How wide the count of working keys is printed, so the columns after it line
 * up. "12 keys work" is the widest a merchant is likely to reach; past a
 * hundred keys the row goes ragged rather than wrong.
 */
const COUNT_WIDTH = 12;

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
    say(
      `${key.id.padEnd(widest)}  ${dayOf(key.createdAt)}  ${standingOf(key)}  ${madeFor(key)}  ${lastCallOf(key)}  ${key.label}`,
    );
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

/**
 * Who a key was made for, in a word wide enough for both.
 *
 * This list is the only place either kind is printed, and it is a column rather
 * than something left to the label beside it. A label is a sentence somebody
 * can type, and the keys that were written before a key said what it was for
 * carry whatever sentence made them at the time — so the label is a hint and
 * this is the answer. What the operator does with it is tell the keys a
 * merchant put in their own code from the one their cabinet is signed in with,
 * which is the difference between revoking a worker and locking somebody out.
 */
function madeFor(key: StoredKey): string {
  return key.purpose === "cabinet" ? "cabinet " : "own code";
}

/**
 * When anything last called with this key, in a phrase wide enough for both
 * answers.
 *
 * The operator asks this about the keys a merchant never sees. A merchant's own
 * screen leaves the key their cabinet signs in with off the list, so "has that
 * cabinet stopped signing in" — the thing worth knowing before a row is cleared
 * away — can be read nowhere but here.
 *
 * The blank says there is no record and not that there were no calls, because
 * those are not the same thing and only one of them was checked: a key older
 * than the column carries this blank too, and nothing distinguishes it. Somebody
 * clearing away a cabinet key on the strength of "never called" would be
 * locking a person out on the strength of a word we did not earn.
 *
 * A day rather than an instant, like the two columns before it. The mark is
 * written every few minutes at best, so the seconds it carries would be a
 * precision this column does not have.
 */
function lastCallOf(key: StoredKey): string {
  return key.lastUsedAt === null ? "no calls recorded" : `called ${dayOf(key.lastUsedAt)}`;
}

const dayOf = (instant: number): string => new Date(instant).toISOString().slice(0, 10);

const stampOf = (instant: number | null): string =>
  instant === null ? "an instant nothing recorded" : new Date(instant).toISOString();
