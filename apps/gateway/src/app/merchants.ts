/**
 * Making a merchant, naming what their products are sold under, and issuing a
 * key to one.
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
import { ServiceNameSchema } from "@coinslot/contracts";
import type { Ids } from "../ports/clock.js";
import type { Store, StoredKey, StoredMerchant } from "../ports/store.js";

/**
 * How much randomness a key carries. Thirty-two bytes is more than anybody
 * will exhaust and is not a number anybody should have to think about again.
 */
const KEY_BYTES = 32;

/**
 * What every key starts with, so that one found in a log or a paste is
 * recognisable as ours and can be searched for by people who scan for leaked
 * credentials.
 */
export const KEY_PREFIX = "csk_";

/** A fresh key, in the only form its owner will ever see it. */
export function newKeySecret(): string {
  return `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
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
 * Issues one key to one merchant and hands back the secret, once.
 *
 * The caller is expected to have found the merchant first, so that "there is no
 * such merchant" is a sentence somebody reads rather than a foreign key
 * violation. This does not check again: two commands racing over a merchant
 * somebody is deleting is not a case worth a round trip, and the database
 * refuses it either way.
 */
export async function issueKey(
  store: Store,
  ids: Ids,
  merchantId: string,
  label: string,
  at: number,
): Promise<IssuedKey> {
  const secret = newKeySecret();
  const key = await store.addKey(
    { id: ids("mk"), merchantId, label, digest: keyDigest(secret) },
    at,
  );
  return { key, secret };
}

/**
 * What a merchant's first key is called until they name one of their own.
 *
 * Every key carries a label so that one of several can be told from the others,
 * and this one is made by a route rather than by a person, so the label has to
 * be written somewhere. It says where the key came from, because that is the
 * one thing its owner does not know about it: they never chose it.
 */
export const FIRST_KEY_LABEL = "the key this merchant registered with";

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

/** A merchant that has just been registered, with their first key, once. */
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
 * Makes a merchant and issues their first key — both or neither (ADR-0014 §1).
 * Null where the identifier is taken, which a generated one never is.
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
): Promise<Registration | null> {
  const secret = newKeySecret();
  const written = await store.registerMerchant(
    { id: ids("mch"), name: REGISTERED_MERCHANT_NAME },
    { id: ids("mk"), label: FIRST_KEY_LABEL, digest: keyDigest(secret) },
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
 * What the sandbox's merchant is listed as until somebody says otherwise.
 *
 * It says sandbox out loud on purpose: this name travels to a catalogue, and a
 * listing that reads like a real seller is the one thing a sandbox must not
 * look like.
 */
export const SEEDED_SERVICE_NAME = "Coinslot sandbox";

/** What seeding the sandbox's key came to, in a word somebody can print. */
export type SeedOutcome =
  /** There was no such key and now there is; here it is, the way it was given. */
  | { readonly kind: "issued"; readonly merchantId: string }
  /** The key is already there and works. Nothing was written. */
  | { readonly kind: "already_there" }
  /** The key is there and somebody disabled it. Nothing was written. */
  | { readonly kind: "disabled" };

/**
 * Makes sure the sandbox's merchant and its one key exist, and says what it
 * found.
 *
 * This is what lets `docker compose up` sell with no manual step: the key in
 * `compose.yaml` is handed to the cabinet and to the merchant process, and this
 * puts the matching row in the database so that the door recognises it. Run
 * again — a restart, a second replica — it writes nothing, because the key is
 * looked up by its digest before anything is issued.
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
): Promise<SeedOutcome> {
  const digest = keyDigest(secret);
  await store.addMerchant(SEEDED_MERCHANT, at);

  // A sandbox that comes up undiscoverable is a sandbox that cannot show the
  // thing it exists to show: without a listing name the challenge carries no
  // declaration at all, and a catalogue has nothing to read. So the seeded
  // merchant is given one — but only if it has none, because a name somebody
  // set by hand is a choice and this is a default.
  const merchant = await store.merchantById(SEEDED_MERCHANT.id);
  if (merchant !== null && merchant.serviceName === null) {
    await setServiceName(store, SEEDED_MERCHANT.id, SEEDED_SERVICE_NAME, at);
  }

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
  return { kind: "issued", merchantId: SEEDED_MERCHANT.id };
}

/** Where a key that is already there stands, in the word the caller prints. */
function standingOf(disabledAt: number | null): SeedOutcome {
  return disabledAt === null ? { kind: "already_there" } : { kind: "disabled" };
}
