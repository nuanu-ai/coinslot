/**
 * The one thing about the stand's merchant that cannot be seen by looking.
 *
 * Everything else is watched on the page as it happens: a card publishes or is
 * refused, an order arrives and is answered, a mood changes and the next order
 * goes the other way. A subscription that outlived its replacement is
 * different — it goes on taking orders from a gateway nobody is watching, and
 * what shows on the screen afterwards is a run that makes no sense for a reason
 * that is not on it.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION, type WorkerEnvelope } from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { makeFeed } from "./stand-log.js";
import { makeStandMerchant } from "./stand-merchant.js";

const KEY = "the-key-the-stand-connects-with";

const waitUntil = async (that: () => boolean, within = 5_000): Promise<void> => {
  const until = Date.now() + within;
  while (!that()) {
    if (Date.now() > until) {
      throw new Error(`still not true after ${within}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * A gateway that answers a poll and counts it, and nothing else.
 *
 * The SDK's own fake gateway is not reachable from here — the package publishes
 * one entry point and no subpath — and widening a published package so a test
 * can reach its helper is not a trade worth making. The answer has to name the
 * contract version: a poll answered without one is a gateway the worker decides
 * it cannot speak to, and it ends the loop on the spot, which would make the
 * second gateway look silent for a reason that has nothing to do with this.
 */
const pollCounter = async (): Promise<{
  url: string;
  polls: () => number;
  close: () => Promise<void>;
}> => {
  let polls = 0;
  const server: Server = createServer((request, response) => {
    if (request.url?.endsWith("/worker/poll") === true) {
      polls += 1;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes: [] }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    polls: () => polls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

const orderAfterMove = (): WorkerEnvelope => ({
  kind: "order",
  id: "envelope-after-move",
  sent_at: "2026-08-31T00:00:00Z",
  payload: {
    id: "order-after-move",
    merchant_item_id: "the-item-both-gateways-name",
    params: {},
    price: {
      amount: "1.00",
      currency: "USD",
      at: "2026-08-31T00:00:00Z",
      as_of: "2026-08-31T00:00:00Z",
    },
    test: false,
  },
});

const orderGateway = async (): Promise<{
  url: string;
  delivered: () => unknown;
  close: () => Promise<void>;
}> => {
  let sent = false;
  let answer: unknown;
  const server: Server = createServer(async (request, response) => {
    if (request.url?.endsWith("/worker/poll") === true) {
      const envelopes = sent ? [] : [orderAfterMove()];
      sent = true;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    answer = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, result: "delivered" }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    delivered: () => answer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

const blockingDeliveryGateway = async (): Promise<{
  url: string;
  deliveryBegan: () => boolean;
  releaseDelivery: () => void;
  close: () => Promise<void>;
}> => {
  let sent = false;
  let began = false;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server: Server = createServer(async (request, response) => {
    if (request.url?.endsWith("/worker/poll") === true) {
      const envelopes = sent ? [] : [orderAfterMove()];
      sent = true;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes }));
      return;
    }
    for await (const _chunk of request) {
      // Consume the body before responding so this test gateway mirrors HTTP
      // connection reuse rather than leaving bytes behind for the next request.
    }
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/deliver") === true) {
      began = true;
      await released;
      response.end(JSON.stringify({ ok: true, result: "delivered" }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: "accepted" }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    deliveryBegan: () => began,
    releaseDelivery: () => release?.(),
    close: async () => {
      release?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
};

let merchant: ReturnType<typeof makeStandMerchant> | undefined;
const shutting: Array<() => Promise<void>> = [];

afterEach(async () => {
  await merchant?.disconnect();
  merchant = undefined;
  for (const close of shutting.splice(0)) {
    await close();
  }
});

describe("connecting the stand somewhere else", () => {
  it("stops the subscription it had, so no gateway keeps a mouth on this merchant", async () => {
    const first = await pollCounter();
    const second = await pollCounter();
    shutting.push(first.close, second.close);

    merchant = makeStandMerchant(makeFeed());
    await merchant.connect(first.url, KEY);
    await waitUntil(() => first.polls() > 0);

    await merchant.connect(second.url, KEY);
    await waitUntil(() => second.polls() > 0);

    // What the first gateway had seen when the move finished. Anything after
    // this is a subscription that outlived its replacement.
    const afterTheMove = first.polls();
    await waitUntil(() => second.polls() > 1, 10_000);

    expect(first.polls()).toBe(afterTheMove);
    expect(merchant.connected()).toBe(second.url);
  });

  it("forgets goods learned from the gateway it left", async () => {
    const first = await pollCounter();
    const second = await orderGateway();
    shutting.push(first.close, second.close);

    merchant = makeStandMerchant(makeFeed());
    await merchant.connect(first.url, KEY);
    await waitUntil(() => first.polls() > 0);
    merchant.learn("the-item-both-gateways-name", { old_gateway_field: { type: "string" } });

    await merchant.connect(second.url, KEY);
    await waitUntil(() => second.delivered() !== undefined);

    expect(second.delivered()).toEqual({ delivered: {} });
  });

  it("waits for a delivery already in flight before replacing the gateway", async () => {
    const oldGateway = await blockingDeliveryGateway();
    const nextGateway = await pollCounter();
    shutting.push(oldGateway.close, nextGateway.close);
    const feed = makeFeed();

    merchant = makeStandMerchant(feed);
    merchant.moods.order = "accept_then_deliver";
    merchant.moods.deliverAfterMs = 0;
    await merchant.connect(oldGateway.url, KEY);
    await waitUntil(oldGateway.deliveryBegan);

    try {
      let replacementFinished = false;
      const replacing = merchant.connect(nextGateway.url, KEY).then(() => {
        replacementFinished = true;
      });
      await waitUntil(
        () =>
          feed.entries().some(
            (entry) => entry.title === "Waiting for in-flight delivery work before disconnect.",
          ),
        1_000,
      );

      expect(replacementFinished).toBe(false);
      oldGateway.releaseDelivery();
      await replacing;
      await waitUntil(() => nextGateway.polls() > 0);

      const oldAnswer = feed
        .entries()
        .findIndex((entry) => entry.title === "The accepted-order delivery answered.");
      const newConnection = feed
        .entries()
        .findIndex(
          (entry) =>
            entry.title === "Connected the merchant." &&
            (entry.detail as { base_url?: string }).base_url === nextGateway.url,
        );
      expect(oldAnswer).toBeGreaterThanOrEqual(0);
      expect(oldAnswer).toBeLessThan(newConnection);
      expect(
        feed
          .entries()
          .slice(newConnection + 1)
          .some((entry) => entry.title === "The accepted-order delivery answered."),
      ).toBe(false);
    } finally {
      oldGateway.releaseDelivery();
    }
  });
});
