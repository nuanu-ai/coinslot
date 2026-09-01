/**
 * The one line a worker says when it starts: which gateway it is working
 * against, and whether the money there is real.
 *
 * The keys these tests connect with are built from `keyPrefixFor` in
 * `@coinslot/core`, which is the home of the rule (ADR-0020), and that is
 * deliberate rather than convenient. The SDK cannot import that module — it is
 * private to this workspace and this package is published with the runtime
 * dependency tree ADR-0003 §8 writes down — so it carries its own copy of the
 * two prefixes, and a copy is a thing that drifts. Building the keys here out
 * of core's own answer is what turns a drift into a failed test: a prefix
 * changed on one side and not the other stops `pnpm test` instead of going
 * quiet in a merchant's log. The import is a devDependency and reaches nothing
 * that is published — `files` ships `dist`, and the build excludes the tests.
 */

import { keyPrefixFor } from "@coinslot/core";
import type { Order, WorkerEnvelope } from "@nuanu-ai/coinslot-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "./client.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";
import { waitUntil } from "./testing/waiting.js";
import { batch, polling } from "./testing/worker-stream.js";

const AT = "2026-08-26T10:20:00Z";

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: { amount: "5.00", currency: "USD", at: AT, as_of: AT },
  test: false,
};

const arriving = {
  kind: "order",
  id: "env-1",
  sent_at: AT,
  payload: order,
} satisfies WorkerEnvelope;

/**
 * Everything that reached the console during one test, both streams together.
 *
 * Both, because "nothing was said about the world" has to hold wherever a line
 * could have been written, and because a connect notice sent down the channel
 * the merchant registered for problems would be a defect this file should
 * catch: every test below registers a reporter, so a line that went there
 * would leave this array empty and fail the assertion.
 */
const written: string[] = [];
const realInfo = console.info;
const realError = console.error;

let gateway: FakeGateway | undefined;
let running: { stop(): Promise<void> } | undefined;

const capture = (...given: unknown[]): void => {
  written.push(given.map(String).join(" "));
};

beforeEach(() => {
  written.length = 0;
  console.info = capture;
  console.error = capture;
});

afterEach(async () => {
  try {
    await running?.stop();
    await gateway?.close();
  } finally {
    running = undefined;
    gateway = undefined;
    console.info = realInfo;
    console.error = realError;
  }
});

/**
 * A worker running against a gateway that hands it two orders and then holds
 * its poll open, which is what makes "once" mean something: the loop goes round
 * more than once before anything is counted.
 */
const workerHolding = async (
  apiKey: string,
): Promise<{ url: string; coinslot: ReturnType<typeof createClient> }> => {
  gateway = await startFakeGateway({
    apiKey,
    routes: {
      poll_worker: polling(batch(arriving), batch(arriving)),
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
    },
  });

  const coinslot = createClient({ apiKey, baseUrl: gateway.url });

  // A reporter of the merchant's own, so that nothing the loop has to say
  // reaches the console and what is left on it is the connect line alone.
  coinslot.on("problem", () => {});
  coinslot.on("order", (arrived) => arrived.delivered({ access_url: "https://a.example" }));

  running = coinslot;
  await coinslot.start();

  const url = gateway.url;

  await waitUntil(
    () => (gateway?.callsTo("answer_order").length ?? 0) === 2,
    "two orders answered",
  );

  return { url, coinslot };
};

describe("the line a worker says at connect", () => {
  it("names the gateway and says the money there is not real, for a test key", async () => {
    // The promise: an engineer tailing a worker's log can tell which of the two
    // deployments it joined without going to look for the key that started it.
    const { url } = await workerHolding(`${keyPrefixFor("test")}9f2c4a`);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain(url);
    expect(written[0]).toContain("test key");
    expect(written[0]).toMatch(/money there is not real/);
  });

  it("names the gateway and says the money there is real, for a live key", async () => {
    const { url } = await workerHolding(`${keyPrefixFor("live")}9f2c4a`);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain(url);
    expect(written[0]).toContain("live key");
    expect(written[0]).toMatch(/money there is real/);
    expect(written[0]).not.toMatch(/not real/);
  });

  it("says nothing at all about the world for a key that names none", async () => {
    // The negative control, and the case that has to stay silent: a key issued
    // before the prefix existed, and anything else that is not one of the two.
    // No line is better than a wrong claim about whose money is at stake, and
    // there is nothing here to guess from — the key is all this side reads.
    await workerHolding("csk_9f2c4ad1e0b7");

    expect(written).toStrictEqual([]);

    await running?.stop();
    await gateway?.close();
    running = undefined;
    gateway = undefined;

    await workerHolding("merchant-key-from-somewhere-else");

    expect(written).toStrictEqual([]);
  });

  it("does not say it a second time when a client is stopped and started again", async () => {
    // A supervisor that stops a worker and starts it on the same client is
    // running the same process against the same gateway with the same key, and
    // a line repeated on every cycle is a line people learn to scroll past.
    const { coinslot } = await workerHolding(`${keyPrefixFor("test")}9f2c4a`);

    expect(written).toHaveLength(1);

    await coinslot.stop();
    await coinslot.start();
    await waitUntil(
      () => (gateway?.callsTo("poll_worker").length ?? 0) >= 3,
      "the loop to poll again",
    );

    expect(written).toHaveLength(1);
  });
});
