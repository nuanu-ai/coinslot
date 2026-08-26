/**
 * The merchant's door.
 *
 * Stage one of the pilot plan asks for the minimum: one merchant, one key, sent
 * as a bearer token. What is not minimal is the comparison. A key checked with
 * `===` is checked one character at a time and stops at the first difference,
 * so the time the answer takes says how much of the key was right — and a key
 * that leaks a character per attempt is a key that can be walked out of the
 * system in a few thousand requests.
 *
 * Comparing the digests rather than the keys is what makes the timing say
 * nothing. It also solves the other half: a constant-time comparison over
 * different lengths is not one, and the naive fix — check the length first —
 * hands back the length. Digests are always the same size.
 */

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Whether the presented key is the merchant's, told in a fixed amount of time. */
export function keyMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * The key inside an Authorization header, or nothing.
 *
 * The scheme is matched without regard to case because that is what the HTTP
 * specification says it is, and a merchant whose client wrote "bearer" would
 * otherwise spend an afternoon on a key that is perfectly correct.
 */
export function bearerIn(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
