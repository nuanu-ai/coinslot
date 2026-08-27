/**
 * Making a merchant, and issuing a key to one.
 *
 * It is one small module rather than three copies because there are three
 * callers and they must not drift: the command somebody runs at a terminal, the
 * seed the sandbox comes up with, and the test harness. A second way of turning
 * a secret into a digest would be a key that works in one of them and not the
 * others, and the failure would look like a wrong key rather than like two
 * hashes.
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

import { createHash, randomBytes } from "node:crypto";
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
 */
export async function seedSandboxKey(
  store: Store,
  ids: Ids,
  secret: string,
  at: number,
): Promise<SeedOutcome> {
  await store.addMerchant(SEEDED_MERCHANT, at);

  // Looked up in whatever state it is in, not through the door's own lookup:
  // the door answers nothing for a disabled key, and issuing a second key with
  // a digest already taken is what that silence would lead to here.
  const existing = await store.keyByDigest(keyDigest(secret));
  if (existing !== null) {
    return existing.disabledAt === null ? { kind: "already_there" } : { kind: "disabled" };
  }

  await store.addKey(
    {
      id: ids("mk"),
      merchantId: SEEDED_MERCHANT.id,
      label: "the sandbox key from the compose file",
      digest: keyDigest(secret),
    },
    at,
  );
  return { kind: "issued", merchantId: SEEDED_MERCHANT.id };
}
