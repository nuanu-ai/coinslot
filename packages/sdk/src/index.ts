/**
 * The Coinslot merchant SDK: what someone else's engineer installs so that
 * their catalog sells to agents. The fulfillment worker and the integration
 * check will arrive from here.
 *
 * The package has a hard budget for third-party runtime dependencies — zero
 * (ADR-0003 §8). A merchant installing the SDK into their production must not
 * receive a foreign package tree along with it, one they would then be
 * maintaining themselves. The only dependency is our own contracts.
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
