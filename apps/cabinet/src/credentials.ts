/**
 * The two secrets the cabinet mints and checks: a person's password and the
 * identifier of their session.
 *
 * ADR-0009 argues why this is written here rather than taken from a package.
 * The short of it: `scrypt` is the component, it ships with the runtime, and
 * what is written by hand is the encoding of a salt and the comparison of two
 * buffers. An authentication framework would bring a user model, a session
 * model and an adapter layer for a cabinet with one merchant in it.
 *
 * Three properties are the whole point of this file, and every one of them is
 * invisible from a screen:
 *
 * The stored value does not contain the password, and two accounts with the
 * same password do not have the same stored value. That is the salt.
 *
 * The comparison says nothing by how long it takes. `timingSafeEqual` over the
 * derived keys is half of it; the other half is that an address with no account
 * derives against a decoy anyway, so the sign-in form is not a list of who has
 * an account here.
 *
 * And what the database holds for a session is a fingerprint rather than the
 * identifier itself, so a dump of the table is not a pile of live sessions.
 */

import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

/**
 * The cost of one derivation.
 *
 * `N` of 2^15 with `r` of 8 asks for 32 MiB and takes roughly a tenth of a
 * second, which is the trade: high enough that guessing at the sign-in form is
 * hopeless against a generated password, low enough that a cabinet on a small
 * container answers a sign-in without thinking about it. `maxmem` has to be
 * raised past its own default of 32 MiB, because the derivation asks for
 * exactly that and a little more for its state.
 *
 * These numbers are written into every stored value, so raising them later is a
 * change to this constant and nothing else: rows written under the old cost
 * keep saying what they were derived under, and keep verifying.
 */
const COST = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const MAX_MEMORY = 128 * 1024 * 1024;

/**
 * The largest `N` this will attempt from a stored value.
 *
 * A row is ours and is not hostile input in any interesting sense, but a
 * corrupt one asking for a derivation the size of a disk should be a refused
 * sign-in rather than a process that stops answering while it tries.
 */
const MOST_WORK = 1 << 20;

/** The floor under a password somebody chooses for themselves. */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * The alphabet a generated password is spelled in.
 *
 * Lower case, no digits that look like letters and no letters that look like
 * digits: no `l`, no `o`, no `0`, no `1`. It gets read aloud or copied by hand
 * at least once, by whoever runs the command that makes an account, and a
 * character that can be mistaken for another is a conversation about why the
 * sign-in does not work.
 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** How many characters a generated password gets: 32^24, which is 120 bits. */
const GENERATED_LENGTH = 24;

/**
 * A password nobody chose and nobody will reuse.
 *
 * ADR-0009 leaves the sign-in form without a rate limit on purpose — a lockout
 * would hand anybody who knows an address a way to shut the merchant out of the
 * control that stops their selling. This is the other half of that argument:
 * the password guessing has to get through is not one a person thought of.
 */
export const newPassword = (): string => {
  let password = "";
  for (let taken = 0; taken < GENERATED_LENGTH; taken += 1) {
    // randomInt rather than a byte modulo the alphabet: 256 does not divide 32
    // evenly in the general case, and the bias that leaves is exactly the kind
    // of thing nobody notices in a password that still looks random.
    password += ALPHABET[randomInt(ALPHABET.length)];
  }
  return password;
};

/**
 * What goes in the database for a password.
 *
 * The value names its own algorithm and cost — `scrypt$N$r$p$salt$key` — so the
 * cost can be raised without a migration and without a column beside it that
 * can disagree with the rows it describes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, COST.N, COST.r, COST.p, KEY_LENGTH);
  return [
    "scrypt",
    COST.N,
    COST.r,
    COST.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Whether this password is the one behind that stored value.
 *
 * `stored` is allowed to be null, and that is not an accident of the caller's
 * shape: it is how the sign-in asks about an address that has no account. A
 * caller who short-circuited there would make the form an oracle — the
 * wrong-password answer takes a derivation and the no-such-person answer comes
 * back at once, and the difference is plain from outside without reading
 * anything. So a null derives against a decoy and then says no.
 *
 * A stored value this cannot read is a no, not an exception. A row that is
 * truncated, or from a format we no longer write, must land the person on the
 * sign-in page rather than on the error page — which they cannot get off,
 * because its only control leads back to a page that throws again.
 */
export async function passwordMatches(password: string, stored: string | null): Promise<boolean> {
  // A value that is missing and a value that cannot be read take the same road:
  // the decoy, which costs a derivation and then cannot match.
  const against = (stored === null ? null : parse(stored)) ?? DECOY;

  let derived: Buffer;
  try {
    derived = await deriveKey(
      password,
      against.salt,
      against.N,
      against.r,
      against.p,
      against.key.length,
    );
  } catch {
    return false;
  }
  if (derived.length !== against.key.length) {
    return false;
  }

  // The comparison happens either way, and only then is the decoy ruled out.
  // The other order would return before doing the work, which is the timing
  // difference this whole arrangement exists to remove.
  const same = timingSafeEqual(derived, against.key);
  return same && against !== DECOY;
}

/**
 * The stored value of a password nobody has.
 *
 * It exists so that an address with no account costs the same derivation as one
 * whose password is wrong. The key in it is random and no password derives to
 * it, which is the point — and it is ruled out explicitly as well, so that the
 * answer does not rest on a collision being unlikely.
 */
const DECOY: Stored = {
  N: COST.N,
  r: COST.r,
  p: COST.p,
  salt: randomBytes(16),
  key: randomBytes(KEY_LENGTH),
};

interface Stored {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(stored: string): Stored | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return null;
  }
  const [, work, block, parallel, salt, key] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const N = Number(work);
  const r = Number(block);
  const p = Number(parallel);
  const sane =
    Number.isInteger(N) &&
    N >= 2 &&
    N <= MOST_WORK &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= 32 &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= 16;
  if (!sane) {
    return null;
  }
  const held = Buffer.from(key, "base64url");
  // A stored key of no length would make the comparison below say yes to
  // anything, and `scrypt` refuses to derive nothing anyway. Unreadable.
  if (held.length === 0) {
    return null;
  }
  return { N, r, p, salt: Buffer.from(salt, "base64url"), key: held };
}

/**
 * One derivation, promised.
 *
 * Written out rather than taken from `promisify`, whose types pick the overload
 * without the parameters — and the parameters are the entire cost of this
 * function.
 */
const deriveKey = (
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  length: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, length, { N, r, p, maxmem: MAX_MEMORY }, (failed, key) => {
      if (failed !== null) {
        reject(failed);
        return;
      }
      resolve(key);
    });
  });

/**
 * A new session identifier: 32 bytes of randomness, and nothing else in it.
 *
 * Nothing about a person can be read out of it and nothing in it can be edited
 * into somebody else's session, because it says nothing — it is a lookup key
 * for a row, and the row is where the identity is.
 */
export const newSessionToken = (): string => randomBytes(32).toString("base64url");

/**
 * What the database holds for a session, which is not what the browser holds.
 *
 * A plain SHA-256 rather than a slow derivation, and that is deliberate: this
 * stands in front of 256 bits of randomness rather than in front of something a
 * person thought of, so there is nothing to guess and nothing to slow down. What
 * it buys is that a copy of the table — a backup, a dump, a query left in a
 * terminal's history — is not a pile of sessions somebody can spend.
 */
export const fingerprintOf = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");
