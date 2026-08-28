/**
 * The stream a test hands the worker, written the way the gateway writes it.
 *
 * Two pieces. `batch` builds one poll answer — the contract version the SDK
 * speaks and the envelopes in it — so a test says what arrives and not how a
 * poll answer is spelled. `polling` plays the answers in order and then holds
 * the poll open the way a gateway holds a long poll, which is the part that is
 * easy to get wrong: a script that runs out and answers `undefined` leaves a
 * loop whose sleeps the test has made instant asking as fast as it can for as
 * long as the test runs.
 *
 * The envelopes are typed as the contract's own, so a fixture that has drifted
 * from what the wire carries stops this package compiling rather than being
 * scripted into a test that then proves the SDK reads something no gateway
 * would send.
 */

import type { WorkerEnvelope } from "@coinslot/contracts";
import { contractVersion } from "../contract.js";
import type { GatewayAnswer } from "./fake-gateway.js";

/** One poll answer carrying these envelopes, at the version this SDK speaks. */
export const batch = (...carried: WorkerEnvelope[]): GatewayAnswer => ({
  body: { contract_version: contractVersion, envelopes: carried },
});

/** Answers the scripted batches in order and then holds the poll open. */
export const polling = (
  ...script: GatewayAnswer[]
): ((call: unknown, index: number) => GatewayAnswer | Promise<GatewayAnswer>) => {
  const parked = new Promise<GatewayAnswer>(() => {});
  return (_call: unknown, index: number) => script[index] ?? parked;
};
