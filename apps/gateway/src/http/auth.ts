/**
 * The merchant's door.
 *
 * A key is a row and the door is a lookup (ADR-0010): what arrives is hashed,
 * the digest is looked up, and what comes back is the merchant it belongs to or
 * nothing at all. The hashing and the lookup both live elsewhere — in
 * `app/merchants.ts` and behind the store's `merchantForKey` — so what is left
 * here is the one thing that is genuinely about HTTP: reading the key out of
 * the header it arrives in.
 *
 * The comparison this file used to hold is gone with the single key it
 * compared, and the property it bought is not. A key checked with `===` is
 * checked one character at a time and stops at the first difference, so the
 * time the answer takes says how much of the key was right — a key that leaks a
 * character per attempt is a key that can be walked out of the system in a few
 * thousand requests. A lookup by digest says nothing of the kind: nothing is
 * compared against a secret, what travels is a fixed-size digest, and what
 * answers is an index. That is constant-time by construction rather than by
 * care, which is why the care is no longer written down anywhere.
 */

import { merchantKeyFrom } from "@nuanu-ai/coinslot-contracts";

/**
 * The key inside the merchant-key header value, or nothing.
 *
 * The parse itself lives in `@nuanu-ai/coinslot-contracts`, because the header the key
 * arrives in is the one thing the gateway and the SDK have to agree on and the
 * route table does not carry — so it is held in the one place both import
 * rather than written out here and, identically but separately, in the SDK.
 * This name stays because it is the gateway's own word for the step.
 */
export const bearerIn = merchantKeyFrom;
