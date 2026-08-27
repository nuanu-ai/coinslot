/**
 * The mock merchant, pointed at a gateway that is already running.
 *
 * The same merchant the offline gate uses — the same two cards, the same price
 * desk, the same goods — except that it opens its subscription against a live
 * gateway over the network instead of one booted in its own process. That is
 * the whole difference, and it is deliberate: what a merchant's engineer reads
 * here is the code they would write, not a demonstration written to look like
 * it. `merchant.ts` holds the handlers; this file only wires them to an address
 * and keeps the process alive.
 *
 * What it is for: the local stack (ADR-0005 §7) comes up with a catalogue and
 * somewhere for an order to go, so the cabinet has something to show and a
 * purchase can be walked end to end. It is not a fixture of anything —
 * `pnpm test` never runs it.
 *
 * One thing here is not in `merchant.ts` and is invented: the asynchronous card
 * is taken on by the handler and delivered later by an explicit call, and in a
 * test that call is the test's. Here nobody makes it, so this file waits a few
 * seconds and makes it itself. That stands in for the provider issuing an eSIM
 * profile, which is what the card says happens, and the wait is the only part
 * of this merchant's behaviour that is a stand-in rather than the real shape.
 *
 *   GATEWAY_URL=http://localhost:8080 MERCHANT_API_KEY=… pnpm --filter @coinslot/slice serve
 */

import { startMerchant } from "./merchant.js";

const baseUrl = process.env.GATEWAY_URL ?? "http://localhost:8080";
const apiKey = process.env.MERCHANT_API_KEY;

if (apiKey === undefined || apiKey === "") {
  console.error(
    "[merchant] MERCHANT_API_KEY is not set — it is the key this merchant opens its subscription with, and there is no default for it",
  );
  process.exit(1);
}

/** How long the eSIM's provider is pretended to take. See the note above. */
const PROVISIONING_MS = 4_000;

/** How often the accepted orders are looked over. */
const SWEEP_MS = 500;

const merchant = startMerchant(baseUrl, apiKey);

const firstSeen = new Map<string, number>();
const delivered = new Set<string>();

/**
 * Delivers what has been taken on and has waited long enough.
 *
 * `deliverAccepted` does not forget an order once it has delivered it, so the
 * set here is what stops a second delivery — which the gateway would answer
 * honestly, but which would be this file's own defect rather than the
 * at-least-once behaviour the merchant is meant to demonstrate.
 */
const sweep = (): void => {
  const now = Date.now();
  for (const orderId of merchant.acceptedOrders.keys()) {
    if (delivered.has(orderId)) {
      continue;
    }
    const seen = firstSeen.get(orderId);
    if (seen === undefined) {
      firstSeen.set(orderId, now);
      console.log(`[merchant] took on ${orderId}, issuing in ${PROVISIONING_MS / 1_000}s`);
      continue;
    }
    if (now - seen < PROVISIONING_MS) {
      continue;
    }
    delivered.add(orderId);
    merchant
      .deliverAccepted(orderId)
      .then((answer) => {
        console.log(`[merchant] delivered ${orderId}: ${JSON.stringify(answer)}`);
      })
      .catch((thrown: unknown) => {
        // Not fatal to the process: one order that would not deliver leaves the
        // merchant selling, and the gateway will hold it to its deadline.
        console.error(`[merchant] could not deliver ${orderId}:`, thrown);
      });
  }
};

await merchant.start();
await merchant.publishCatalog();
console.log(`[merchant] subscribed to ${baseUrl}, two cards published`);

const sweeping = setInterval(sweep, SWEEP_MS);

const shutDown = async (signal: string): Promise<void> => {
  console.log(`[merchant] ${signal}: stopping`);
  clearInterval(sweeping);
  await merchant.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutDown("SIGTERM"));
process.on("SIGINT", () => void shutDown("SIGINT"));
