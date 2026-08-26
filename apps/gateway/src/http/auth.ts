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
import { merchantKeyFrom } from "@coinslot/contracts";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Whether the presented key is the merchant's, told in a fixed amount of time. */
export function keyMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * The key inside the merchant-key header value, or nothing.
 *
 * The parse itself lives in `@coinslot/contracts`, because the header the key
 * arrives in is the one thing the gateway and the SDK have to agree on and the
 * route table does not carry — so it is held in the one place both import
 * rather than written out here and, identically but separately, in the SDK.
 * This name stays because it is the gateway's own word for the step, and the
 * comparison below it — constant-time, over digests — is the gateway's alone
 * and no contract's business.
 */
export const bearerIn = merchantKeyFrom;
