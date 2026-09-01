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
import { type Entry, makeFeed } from "./stand-log.js";
import { makeStandMerchant } from "./stand-merchant.js";
import { renderEntry } from "./stand-page.js";

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

/** What the gateway says when the goods are not the ones the card declares. */
const DELIVERY_REFUSED = {
  ok: false,
  error: {
    code: "delivery_does_not_match_card",
    message: "this delivery is not what the card for this order declares",
    retryable: true,
    problems: [
      {
        path: ["access_url"],
        code: "unrecognized_keys",
        message: "this card declares no such field",
      },
    ],
  },
};

/** A gateway that hands over one order and then will not take the delivery. */
const refusingDeliveryGateway = async (): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  let sent = false;
  const server: Server = createServer(async (request, response) => {
    if (request.url?.endsWith("/worker/poll") === true) {
      const envelopes = sent ? [] : [orderAfterMove()];
      sent = true;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes }));
      return;
    }
    for await (const _chunk of request) {
      // Drained before answering, so keep-alive cannot carry a body forward.
    }
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/deliver") === true) {
      // The refusal arrives under a clean status on purpose. An answer that
      // said no with a 4xx would be caught by the status arm of the reading
      // this is about, and the arm that matters here would never be reached.
      response.end(JSON.stringify(DELIVERY_REFUSED));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: "accepted" }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
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

/*
 * These read the detail rather than the title, and that is deliberate. What
 * this test is about is order — a delivery already in flight finishing before
 * the replacement connection does — and the sentences the console writes are
 * rewritten whenever somebody reading a screen cannot follow them. A test that
 * held those sentences would fail on a wording change and pass on a broken
 * ordering, which is the wrong way round.
 */
const detailOf = (entry: Entry): Record<string, unknown> =>
  typeof entry.detail === "object" && entry.detail !== null
    ? (entry.detail as Record<string, unknown>)
    : {};

/** The console saying it is holding the disconnect for work already begun. */
const isWaitingForDeliveries = (entry: Entry): boolean =>
  typeof detailOf(entry).deliveries === "number";

/** The gateway's answer to a delivery made on an order accepted earlier. */
const isDeliveryAnswered = (entry: Entry): boolean =>
  entry.kind === "merchant" && detailOf(entry).result !== undefined;

let merchant: ReturnType<typeof makeStandMerchant> | undefined;
const shutting: Array<() => Promise<void>> = [];

afterEach(async () => {
  await merchant?.disconnect();
  merchant = undefined;
  for (const close of shutting.splice(0)) {
    await close();
  }
});

describe("a closing call the gateway would not take", () => {
  it("writes it as a line the log reads as failed, with the reason on it", async () => {
    // The promise: a refusal that arrives under a clean status is still visible
    // in the log. It is the one line in a run of two hundred that a person at
    // the stand has to find, and everything about it looks ordinary — HTTP 200,
    // an answer where an answer was expected. What marks it is the reading in
    // `stand-page`, and that reading is fed by what this side puts in the
    // detail. Written whole under `result` alone the refusal is swallowed: the
    // envelope's `ok` sits one level down where nothing looks for it, and the
    // line renders like every other.
    const gateway = await refusingDeliveryGateway();
    shutting.push(gateway.close);
    const feed = makeFeed();

    merchant = makeStandMerchant(feed);
    merchant.moods.order = "accept_then_deliver";
    merchant.moods.deliverAfterMs = 0;
    await merchant.connect(gateway.url, KEY);
    await waitUntil(() => feed.entries().some(isDeliveryAnswered));

    const answered = feed.entries().find(isDeliveryAnswered);
    if (answered === undefined) throw new Error("the delivery was never answered");

    // Marked, by the reader the page actually uses rather than by a copy of its
    // rule written here.
    expect(renderEntry(answered)).toContain("bad");

    // And carrying what to do about it: the word a merchant's own program
    // branches on, and the finding their handler has to act on.
    const said = detailOf(answered).error;
    expect(said).toContain("delivery_does_not_match_card");
    expect(said).toContain("access_url");
    expect(said).toContain("this card declares no such field");
  });
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
      await waitUntil(() => feed.entries().some(isWaitingForDeliveries), 1_000);

      expect(replacementFinished).toBe(false);
      oldGateway.releaseDelivery();
      await replacing;
      await waitUntil(() => nextGateway.polls() > 0);

      const oldAnswer = feed.entries().findIndex(isDeliveryAnswered);
      const newConnection = feed
        .entries()
        .findIndex((entry) => detailOf(entry).base_url === nextGateway.url);
      expect(oldAnswer).toBeGreaterThanOrEqual(0);
      expect(oldAnswer).toBeLessThan(newConnection);
      expect(
        feed
          .entries()
          .slice(newConnection + 1)
          .some(isDeliveryAnswered),
      ).toBe(false);
    } finally {
      oldGateway.releaseDelivery();
    }
  });
});
