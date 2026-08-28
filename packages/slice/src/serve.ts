/**
 * The mock merchant, pointed at a gateway that is already running.
 *
 * The same merchant the offline gate uses — the same two cards, the same price
 * desk, the same goods — except that it opens its subscription against a live
 * gateway over the network instead of one booted in its own process. That is
 * the whole difference, and it is deliberate: what a merchant's engineer reads
 * here is the code they would write, not a demonstration written to look like
 * it. `merchant.ts` holds the handlers; this file wires them to an address,
 * keeps the process alive, and writes down whether the subscription is still
 * getting through — see `SUBSCRIPTION_FILE` below for what that last one can
 * and cannot claim.
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

import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMerchant } from "./merchant.js";
import {
  DOUBT_MS,
  NOTHING_HAS_GONE_WRONG,
  readProblems,
  subscriptionLine,
  type WhatIsKnown,
} from "./subscription.js";

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

/**
 * Where this process writes what it can say about its own subscription.
 *
 * The merchant has no port and nothing to ask it, so `docker compose ps` said
 * `running` and stopped there — which is true of a process selling two cards
 * and just as true of one whose worker ended on the first poll and never came
 * back. This file is the answer to that, and the healthcheck compose.yaml gives
 * this service is the thing that reads it: the line says whether the
 * subscription is believed to be getting through, and the file's own
 * modification time says the loop that wrote it is still turning. Both are
 * checked there, because either can be true while the other is not.
 *
 * What the line is derived from is worth knowing, because it bounds what it may
 * claim, and `subscription.ts` is where that reasoning lives and is tested.
 * The short of it: "getting through" means no poll failure has been reported
 * for DOUBT_MS, and nothing stronger. It is late at both ends — a gateway that
 * freezes rather than refusing goes unnoticed until the poll in flight times
 * out, and a recovery is noticed up to ninety seconds after it happens, so a
 * gateway restarted on purpose shows this container red for about that long. It
 * says nothing at all about whether the catalogue is still published or whether
 * a paid order would be routed here: a database emptied under a live
 * subscription leaves this line reading `selling` and the shelf bare.
 *
 * The name is written out a second time in compose.yaml, which is the price of
 * not having an environment variable for a path that is nobody's to configure.
 * Both sides ask the runtime for the directory rather than spelling it, so a
 * TMPDIR set on the service moves the two together.
 */
const SUBSCRIPTION_FILE = join(tmpdir(), "coinslot-merchant-subscription");

/**
 * Where the line is written before it is moved into place.
 *
 * A reader on the other side of this is a healthcheck that runs whenever it
 * likes, and a plain write truncates first: there is a moment in every one of
 * them where the file exists and is empty, and a probe that lands in it reads
 * no verdict at all. Writing beside it and renaming makes the swap atomic, so
 * the reader sees either the old line or the new one and never the gap between
 * them. Same directory, or the rename stops being a rename.
 */
const SUBSCRIPTION_FILE_BEING_WRITTEN = `${SUBSCRIPTION_FILE}.writing`;

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

/** What the SDK's reports have added up to. `subscription.ts` does the adding. */
let known: WhatIsKnown = NOTHING_HAS_GONE_WRONG;

/** Whether the last attempt to write the file failed, so it is said once. */
let writingFailed = false;

/** Reads what the SDK could not get through, and writes down what follows. */
const sayWhatIsKnown = (): void => {
  const now = Date.now();
  const reading = readProblems(merchant.problems, known, now);
  known = reading.known;

  for (const announcement of reading.announce) {
    if (announcement.said === "over") {
      console.error(`[merchant] the subscription is over and will not resume: ${announcement.why}`);
    } else if (announcement.said === "not_getting_through") {
      console.error(`[merchant] not getting through to ${baseUrl}: ${announcement.why}`);
    } else {
      console.log(
        `[merchant] no poll has failed for ${DOUBT_MS / 1_000}s, so ${baseUrl} is taken to be answering again`,
      );
    }
  }

  try {
    writeFileSync(SUBSCRIPTION_FILE_BEING_WRITTEN, `${subscriptionLine(known, baseUrl, now)}\n`);
    renameSync(SUBSCRIPTION_FILE_BEING_WRITTEN, SUBSCRIPTION_FILE);
    writingFailed = false;
  } catch (thrown) {
    // Not fatal and not silent. A file that stops being written goes stale, and
    // stale is what the healthcheck reads as a process no longer saying
    // anything — which is the truth here. What must not happen is a merchant
    // that stopped selling because its status file would not write.
    if (!writingFailed) {
      writingFailed = true;
      console.error(`[merchant] cannot write ${SUBSCRIPTION_FILE}, so it goes stale:`, thrown);
    }
  }
};

await merchant.start();
await merchant.publishCatalog();
console.log(`[merchant] subscribed to ${baseUrl}, two cards published`);
// Written now rather than at the first tick, so the file exists from the same
// moment the line above is printed. What it says at this point rests on the
// publish: the gateway was reached and it took both cards under this key.
sayWhatIsKnown();

const sweeping = setInterval(() => {
  sweep();
  sayWhatIsKnown();
}, SWEEP_MS);

const shutDown = async (signal: string): Promise<void> => {
  console.log(`[merchant] ${signal}: stopping`);
  clearInterval(sweeping);
  // So that the file left behind says the process went on purpose, rather than
  // reading as a heartbeat that froze.
  known = { ...known, stoppedBecause: signal };
  sayWhatIsKnown();
  await merchant.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutDown("SIGTERM"));
process.on("SIGINT", () => void shutDown("SIGINT"));
