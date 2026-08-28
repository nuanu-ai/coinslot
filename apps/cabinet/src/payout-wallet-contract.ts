/**
 * The payout address as the contract will describe it, written here until it
 * does.
 *
 * Everything in this file is somebody else's work in progress: the merchant
 * field, its rule and the two routes that read and set it are being added to
 * `@coinslot/contracts` on another branch. Nothing in the cabinet is allowed to
 * write a rule like that out a second time — a second copy of an address rule
 * is the copy that goes stale — so the whole of the borrowed surface is in one
 * file with one name, and the merge is the deletion of that file and an import
 * from the package instead.
 *
 * That is why this is its own module rather than a few declarations dropped
 * into the screen or into the client. Both of those read it; neither of them
 * owns it; and a temporary thing spread across two files is a temporary thing
 * somebody misses half of.
 *
 * The shapes mirror the seller name, which is the field this one is built
 * beside: the answer carries the value or null, the request carries the value
 * and no null, and the route table gives an address and a method rather than a
 * path written into a call. Whether the real contract refuses null the way the
 * seller name does is its author's decision and not ours — the cabinet offers
 * no control that empties this box either way, so nothing here depends on it.
 */

import { z } from "zod";

/**
 * An address on an EVM chain: `0x` and forty hexadecimal characters.
 *
 * Either case is accepted and neither is corrected. A wallet hands out an
 * address with some of its letters capitalised, and those capitals are not
 * decoration — they are a check on the address itself that a wallet on the
 * other end can run. Lowercasing what a merchant pasted would throw that away
 * before anybody could use it, and the merchant would then be comparing what we
 * show against something their own wallet spells differently.
 *
 * What this does not do is look anything up. A string that keeps this rule is
 * an address in shape only: it may be an address nobody holds, or an address
 * somebody else holds. That distinction is said on the screen rather than
 * papered over here, because there is nothing free the cabinet could check.
 */
export const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x followed by 40 hexadecimal characters");

/** What the merchant's payout address is, as the merchant reads it back. */
export const PayoutWalletSchema = z.strictObject({
  /** Where this merchant's money arrives, or nothing where none is set. */
  payout_wallet: EvmAddressSchema.nullable(),
});

/** What a merchant sends to set the address their money arrives at. */
export const PayoutWalletRequestSchema = z.strictObject({
  payout_wallet: EvmAddressSchema,
});

/**
 * Where the two calls go, in the shape the contract's own route table has.
 *
 * The client reaches for these exactly as it reaches for `API_ROUTES`, so the
 * merge changes which object is indexed and not how any call is made.
 */
export const PAYOUT_WALLET_ROUTES = {
  get_payout_wallet: { method: "GET", path: "/v0/payout-wallet" },
  set_payout_wallet: { method: "POST", path: "/v0/payout-wallet" },
} as const;
