/**
 * The Coinslot merchant SDK: what someone else's engineer installs so that
 * their catalog sells to agents. The fulfillment worker and the integration
 * check will arrive from here.
 *
 * The runtime dependency tree is minimal and listed in full: our own
 * `@coinslot/contracts` and `zod`, nothing else. A merchant installing the SDK
 * into their production should know exactly what arrives with it, rather than
 * inherit a foreign package tree they would then be maintaining themselves.
 * Every new third-party package in this tree is a recorded decision
 * (ADR-0003 §8).
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
