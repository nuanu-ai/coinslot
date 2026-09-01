/**
 * Making a merchant, naming what their products are sold under, and issuing the
 * two kinds of key to one.
 *
 * It is one small module rather than a copy per caller because there are four
 * and they must not drift: the command somebody runs at a terminal, the seed the
 * sandbox comes up with, the routes a merchant reaches from their cabinet, and
 * the test harness. A second way of turning a secret into a digest would be a
 * key that works in one of them and not the others, and the failure would look
 * like a wrong key rather than like two hashes.
 *
 * Two things here are decisions rather than conveniences.
 *
 * The secret is generated and never taken from a caller. A key somebody chooses
 * is a key somebody reuses, and this one is compared against nothing — a
 * request is resolved by looking its digest up — so there is no length rule
 * left to enforce and nothing to enforce it at. Generating is what makes that
 * safe rather than merely tidy.
 *
 * And what is written down is the digest. The secret is handed back once, to
 * whoever asked for it, and this module keeps nothing: a copy of the table is
 * not a set of keys anybody can spend, and nobody — us included — can read a
 * merchant's key back out afterwards. What that costs is that a key which is
 * lost is gone, and the answer to a lost key is a new one and then disabling
 * the old, which is exactly what keys being rows is for.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { assertNever, type Environment, keyPrefixFor, type SurfaceMode } from "@coinslot/core";
import {
  checksummedAddressOf,
  EvmAddressSchema,
  ServiceNameSchema,
} from "@nuanu-ai/coinslot-contracts";
import type { Ids } from "../ports/clock.js";
import type { Store, StoredKey, StoredMerchant } from "../ports/store.js";

/**
 * How much randomness a key carries. Thirty-two bytes is more than anybody
 * will exhaust and is not a number anybody should have to think about again.
 */
const KEY_BYTES = 32;

/**
 * A fresh key, in the only form its owner will ever see it.
 *
 * The prefix carries the environment because that is the one thing about a key
 * that a person holding it can read without asking us, and it is what lets the
 * door tell somebody their key works — on the other site — instead of handing
 * them a bare 401 with nothing wrong with the key.
 */
export function newKeySecret(environment: Environment): string {
  return `${keyPrefixFor(environment)}${randomBytes(KEY_BYTES).toString("base64url")}`;
}

/**
 * The digest a key is stored and looked up under: SHA-256, in lower-case hex.
 *
 * Hex rather than the raw bytes because it goes into a text column and comes
 * back out of one, and a single spelling of it is the whole point — the door
 * and the command that issued the key have to produce the same string from the
 * same secret or the key simply does not work.
 */
export function keyDigest(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A key as it comes back from being issued: the row, and the secret, once. */
export interface IssuedKey {
  readonly key: StoredKey;
  /** The only time this is ever readable. Nothing keeps it. */
  readonly secret: string;
}

/**
 * Sets or clears the name a merchant is listed under in a discovery catalog,
 * and hands back the merchant as they now stand. Null where there is no such
 * merchant.
 *
 * The check is here rather than in the store, and it throws rather than
 * answering, because there is exactly one wrong answer available: writing a
 * name the catalog will not carry. The catalog drops what it cannot render and
 * tells nobody, so a merchant would end up trading under a word they did not
 * choose with nothing anywhere to say so. Refusing loudly at the one place a
 * name is written is the only version of this that somebody reads.
 */
export async function setServiceName(
  store: Store,
  merchantId: string,
  serviceName: string | null,
  at: number,
): Promise<StoredMerchant | null> {
  if (serviceName !== null) {
    // Throws with the schema's own words, which name the rule and the number.
    ServiceNameSchema.parse(serviceName);
  }
  return store.setServiceName(merchantId, serviceName, at);
}

/**
 * Sets the address one merchant's sales are paid into, and hands back the
 * merchant as they now stand. Null where there is no such merchant.
 *
 * Two things happen here and both are the reason this is a function rather than
 * a call on the store.
 *
 * The address is checked, and it throws rather than answering, for the reason
 * the listing name beside it does and with more on it: the one wrong answer
 * available is writing down an address that is not the merchant's. A mistyped
 * address is not a malformed one — it is another perfectly good address
 * belonging to somebody else — so nothing downstream will ever notice, and what
 * happens instead is that every sale the merchant makes from then on is paid to
 * a stranger, irreversibly. The capitals a wallet writes are the only warning
 * anybody gets, and this is where it is read.
 *
 * And the address is written out in one spelling before it is stored. An
 * address has two and the store holds one, so that a comparison somewhere else
 * cannot come out false for two spellings of one address, and so that what a
 * merchant reads back does not depend on which spelling they last sent. The one
 * it holds is the wallet's own — the mixed-case checksummed form — because that
 * is the string the merchant copied and the string they will compare against
 * when they look at the settings screen a month from now.
 */
export async function setPayoutWallet(
  store: Store,
  merchantId: string,
  payoutWallet: string,
  at: number,
): Promise<StoredMerchant | null> {
  // Throws with the schema's own words, which say what is wrong with the
  // address and what the two spellings of one are.
  const address = EvmAddressSchema.parse(payoutWallet);
  return store.setPayoutWallet(merchantId, checksummedAddressOf(address), at);
}

/** Writes down a merchant. Null where that identifier is already taken. */
export async function makeMerchant(
  store: Store,
  ids: Ids,
  name: string,
  at: number,
  id: string = ids("mch"),
): Promise<StoredMerchant | null> {
  return store.addMerchant({ id, name }, at);
}

/**
 * Issues one key for a merchant's own code and hands back the secret, once.
 *
 * The caller is expected to have found the merchant first, so that "there is no
 * such merchant" is a sentence somebody reads rather than a foreign key
 * violation. This does not check again: two commands racing over a merchant
 * somebody is deleting is not a case worth a round trip, and the database
 * refuses it either way.
 *
 * It makes one kind of key and takes no word for which. The other kind is
 * {@link issueCabinetKey}, and the two are two functions rather than one with a
 * parameter because they are two acts: this one answers a merchant asking for
 * something to put in their worker, and that one is a cabinet taking a
 * credential of its own. A parameter would make them look like one act done
 * twice, and the wrong value would put a row in a list its owner cannot touch.
 */
export async function issueKey(
  store: Store,
  ids: Ids,
  merchantId: string,
  label: string,
  at: number,
  environment: Environment,
): Promise<IssuedKey> {
  const secret = newKeySecret(environment);
  const key = await store.addKey(
    { id: ids("mk"), merchantId, label, digest: keyDigest(secret), purpose: "merchant_code" },
    at,
  );
  return { key, secret };
}

/**
 * Issues one key for a cabinet to call as this merchant with, once.
 *
 * There is no label to pass, because there is nobody to type one: a cabinet
 * asks for this every time somebody signs in, and the merchant never sees the
 * key or hears that it exists.
 */
export async function issueCabinetKey(
  store: Store,
  ids: Ids,
  merchantId: string,
  at: number,
  environment: Environment,
): Promise<IssuedKey> {
  const secret = newKeySecret(environment);
  const key = await store.addKey(
    {
      id: ids("mk"),
      merchantId,
      label: CABINET_KEY_LABEL,
      digest: keyDigest(secret),
      purpose: "cabinet",
    },
    at,
  );
  return { key, secret };
}

/**
 * What a key made for a cabinet from here on is called.
 *
 * One sentence for all of them, and no attempt to tell one sign-in from
 * another: the row already carries the instant it was made, and a label that
 * repeated it would be the same fact written twice in two formats.
 *
 * It is not chosen by anybody and is shown to nobody — the merchant's own list
 * leaves these keys out entirely. The one reader is a person at a terminal
 * looking at every key one merchant has, and what this gives them is a sentence
 * that says what the row is without their knowing how a cabinet works.
 *
 * What it is not is how anything tells the two kinds apart. The keys that
 * existed before a key said what it was for keep the label they were given —
 * registration's old one, which no code writes any more — so what the terminal
 * prints beside a key is the column, and this is a hint for a person reading.
 */
export const CABINET_KEY_LABEL = "the key a cabinet signs this merchant in with";

/**
 * A value nothing presented can ever equal, used where registration is closed.
 *
 * It exists so that a gateway with no invitation configured still does the same
 * work per attempt as one that has an invitation and was given the wrong code.
 * Thirty-two bytes of randomness, fresh in every process, so it is not a code
 * anybody could hold.
 */
const NO_INVITATION = randomBytes(32).toString("hex");

/**
 * Whether the code presented is the one this gateway is configured with.
 *
 * Two things are going on here and both are the reason it is a function rather
 * than an `===` at the call site.
 *
 * The comparison is over digests rather than over the codes themselves. That is
 * what makes it constant-time at all: `timingSafeEqual` refuses two buffers of
 * different lengths outright, so comparing the codes would throw on exactly the
 * guesses that are the wrong length and answer those differently from the ones
 * that are not — which is a way of learning the length one attempt at a time.
 * Two digests are always the same size.
 *
 * And a gateway with no code configured still does the whole comparison, against
 * a decoy, before answering no. Registration being closed is a fact about this
 * deployment and not about the caller, and a door that answered it faster would
 * be telling every passer-by which deployment takes registrations. The route
 * above it keeps the other half of that promise by answering closed and wrong
 * in the same words.
 */
export function invitationAccepted(expected: string | null, presented: string): boolean {
  const same = timingSafeEqual(
    createHash("sha256")
      .update(expected ?? NO_INVITATION, "utf8")
      .digest(),
    createHash("sha256").update(presented, "utf8").digest(),
  );
  // The digest of the decoy cannot be guessed, so this second test changes no
  // answer. It is here because "there is no code" must not depend on that.
  return same && expected !== null;
}

/**
 * A merchant that has just been registered, with the key their cabinet will
 * call as them with, once.
 */
export interface Registration {
  readonly merchant: StoredMerchant;
  readonly key: StoredKey;
  /** The only time this is ever readable. Nothing keeps it. */
  readonly secret: string;
}

/**
 * What a merchant made by registering is called in the merchant table.
 *
 * That column is the name a person reads at a terminal, beside the identifier
 * and the count of working keys, and it is not the name buyers read — the two
 * are different fields answering to different rules, and only the other one
 * ever leaves us. Somebody registering types neither, so this one has to come
 * from somewhere.
 *
 * It says how the merchant came to exist, because that is the only true thing
 * there is to say about a row nobody named. The alternatives were worse. Empty,
 * it is a blank column somebody has to work out the meaning of. The identifier
 * again, and the row carries it twice. Anything that reads like a name is a
 * name somebody will go looking for the owner of, and there is none.
 */
export const REGISTERED_MERCHANT_NAME = "registered with an invitation";

/**
 * Makes a merchant and the key a cabinet calls as them with — both or neither
 * (ADR-0014 §1). Null where the identifier is taken, which a generated one
 * never is.
 *
 * The key is not the first of the merchant's own, and that is the whole of what
 * registering hands over: whoever made this call is a cabinet, and what it
 * needs is a credential to act as this merchant with. A merchant made this way
 * has no keys of their own at all until they ask for one, and their own list of
 * keys is empty on the first visit — which is the truth about a merchant who
 * has written no code yet.
 *
 * No name for buyers is written, because registering does not ask for one. It
 * is chosen afterwards through `setServiceName`, and what stands between here
 * and there is that a merchant listed under nothing publishes nothing: the
 * refusal is at the publish, where a merchant is actually about to be shown to
 * strangers, rather than here, where they have nothing to show yet.
 */
export async function registerMerchant(
  store: Store,
  ids: Ids,
  at: number,
  environment: Environment,
): Promise<Registration | null> {
  const secret = newKeySecret(environment);
  const written = await store.registerMerchant(
    { id: ids("mch"), name: REGISTERED_MERCHANT_NAME },
    { id: ids("mk"), label: CABINET_KEY_LABEL, digest: keyDigest(secret) },
    at,
  );

  return written === null ? null : { merchant: written.merchant, key: written.key, secret };
}

/**
 * The merchant everything already in a database belongs to.
 *
 * It is a fixed identifier rather than a generated one because two things that
 * cannot see each other have to name the same merchant: the migration, which
 * writes this row and assigns every card, order and receipt that predates
 * merchants to it, and the seed below, which hangs the sandbox's key on it.
 *
 * The name is what somebody reads in a list at a terminal and nothing else uses
 * it. A sandbox brought up from nothing gets this row too, from the same
 * migration, which is what makes the two databases the same shape.
 */
export const SEEDED_MERCHANT = { id: "the_merchant", name: "The pilot merchant" } as const;

/**
 * What a seeded merchant is listed as, which is different on each of the three
 * stacks and is nothing at all on one of them.
 *
 * It says what it is out loud on purpose: this name travels to a catalog, and
 * a listing that reads like a real seller is the one thing a sandbox must not
 * look like. `Coinslot sandbox` is right for the laptop, wrong for the test
 * site, and wrong in a way that reaches strangers on the live one.
 *
 * A live stack is seeded with no name. A merchant with no name is off sale, so
 * a live stack nobody has named sells nothing, and the name it eventually
 * trades under is typed by a person rather than inherited from a constant
 * written for a sandbox.
 */
export function seededServiceNameFor(mode: SurfaceMode): string | null {
  switch (mode) {
    case "sandbox":
      return "Coinslot sandbox";
    case "test":
      return "Coinslot test site";
    case "live":
      return null;
    default: {
      const unnamed: never = mode;
      return assertNever(unnamed, "seededServiceNameFor");
    }
  }
}

/** What seeding the sandbox's key came to, in a word somebody can print. */
export type SeedOutcome =
  /**
   * There was no such key and now there is; here it is, the way it was given.
   *
   * `listedAs` is the name this run listed the merchant under, and null where
   * it left the listing as it found it — because there was already a name on
   * it, and that name is somebody's. It is carried out rather than left to be
   * inferred because listing a seller is the part of this that other people can
   * see: the name travels to a catalogue, and a start-up log that reported the
   * key and not the listing would be quiet about the half that goes outside.
   */
  | { readonly kind: "issued"; readonly merchantId: string; readonly listedAs: string | null }
  /** The key is already there and works. Nothing was written. */
  | { readonly kind: "already_there" }
  /** The key is there and somebody disabled it. It is left that way. */
  | { readonly kind: "disabled" };

/**
 * Makes sure the sandbox's merchant and its one key exist, and says what it
 * found.
 *
 * This is what lets `docker compose up` sell with no manual step: the key in
 * `compose.yaml` is handed to the cabinet and to the merchant process, and this
 * puts the matching row in the database so that the door recognises it. Run
 * again — a restart, a second replica — and nothing in the database changes:
 * the merchant row is insert-if-absent, and everything after it hangs off the
 * key lookup coming back empty. The listing name included, for the reason given
 * where it is written: on a database that already has the key, a merchant with
 * no listing name is a merchant somebody un-listed on purpose.
 *
 * A key that is there but disabled is left disabled and said out loud. Bringing
 * it back would make revocation a thing a restart undoes, and a key somebody
 * revoked deliberately is not a key this should quietly re-issue; the way back
 * is to seed a different one or to make a new one at a terminal.
 *
 * The merchant row is written here as well as by the migration, and both are
 * needed: the migration is the only thing that can assign existing rows to it,
 * and this is the only thing that exists for a store with no migrations behind
 * it at all — which is every test and the end-to-end harness.
 *
 * Two processes starting at the same instant both find no key and both write
 * one, and the digest is unique — so one of them is refused by the database.
 * That is caught rather than thrown on, and the answer is the same one a
 * sequential second run gets, because it is the same fact: the key is there.
 * Left to propagate, it would take the losing process down at start-up with an
 * error about the database being unreachable, which is the one thing that had
 * not happened.
 */
export async function seedSandboxKey(
  store: Store,
  ids: Ids,
  secret: string,
  at: number,
  mode: SurfaceMode,
): Promise<SeedOutcome> {
  const digest = keyDigest(secret);
  await store.addMerchant(SEEDED_MERCHANT, at);

  // Looked up in whatever state it is in, not through the door's own lookup:
  // the door answers nothing for a disabled key, and issuing a second key with
  // a digest already taken is what that silence would lead to here.
  const found = await store.keyByDigest(digest);
  if (found !== null) {
    return standingOf(found.disabledAt);
  }

  try {
    await store.addKey(
      {
        id: ids("mk"),
        merchantId: SEEDED_MERCHANT.id,
        label: "the sandbox key from the compose file",
        // One of the merchant's own: it is handed to a merchant process out of
        // a configuration file, which is exactly what a merchant does with a
        // key of theirs, and it is on the list they would revoke it from.
        purpose: "merchant_code",
        digest,
      },
      at,
    );
  } catch (thrown) {
    // Somebody wrote it between the read above and this line, or the write
    // failed for a reason that has nothing to do with a race. The two are told
    // apart by asking again: a key that is there now is the first answer,
    // whoever wrote it, and anything else is a failure this cannot repair and
    // must not swallow.
    const raced = await store.keyByDigest(digest);
    if (raced === null) {
      throw thrown;
    }
    return standingOf(raced.disabledAt);
  }

  // A sandbox that comes up undiscoverable is a sandbox that cannot show the
  // thing it exists to show: without a listing name the challenge carries no
  // declaration at all, and a catalogue has nothing to read. Nobody runs a
  // command to fix that on a database that came up from nothing, so the run
  // that issues the key writes the name too.
  //
  // Only that run, and this is the whole of why it is down here rather than
  // above the lookup. A database that already has the key has been up before,
  // and a merchant on it with no listing name is not a default nobody has got
  // to yet — it is `merchant listed-as the_merchant --none`, which is how
  // somebody takes the sandbox out of a catalogue. Writing the name back on the
  // next boot would make that command something a restart undoes, silently, and
  // the operator would find the sandbox listed again with nothing anywhere
  // saying who listed it. A name that is already there is left alone for the
  // matching reason: it is somebody's, and this is only a default.
  const merchant = await store.merchantById(SEEDED_MERCHANT.id);
  const wanted = seededServiceNameFor(mode);
  const listedAs = merchant !== null && merchant.serviceName === null ? wanted : null;
  if (listedAs !== null) {
    await setServiceName(store, SEEDED_MERCHANT.id, listedAs, at);
  }

  return { kind: "issued", merchantId: SEEDED_MERCHANT.id, listedAs };
}

/** Where a key that is already there stands, in the word the caller prints. */
function standingOf(disabledAt: number | null): SeedOutcome {
  return disabledAt === null ? { kind: "already_there" } : { kind: "disabled" };
}
