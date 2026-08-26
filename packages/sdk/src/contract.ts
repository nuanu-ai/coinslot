/**
 * Which contract this package speaks, and whether it understands another.
 *
 * It sits in a file of its own because both ends of the package need it and
 * neither should reach through the other: the worker checks the version on the
 * answer to every poll, and `index.ts` publishes the same check to a merchant
 * who wants to make it themselves.
 */

import { CONTRACT_VERSION } from "@coinslot/contracts";

/** The contract version this SDK talks in. */
export const contractVersion = CONTRACT_VERSION;

/**
 * Whether the SDK understands a contract of the given version. The gateway
 * names its own version in the response, the merchant's worker checks it with
 * this function and fails at startup rather than on the first order, where a
 * divergence of dialects costs the buyer money.
 */
export function speaksContract(version: string): boolean {
  return version === CONTRACT_VERSION;
}
