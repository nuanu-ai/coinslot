/**
 * A merchant proving their own integration, with nobody else in the room.
 *
 * The promise: a merchant who has published a card and started a worker can
 * press one button and find out whether a stranger's agent could actually buy
 * the thing — and find it out from a document that says which door it got to
 * and what that door said, rather than from somebody watching a terminal beside
 * them.
 *
 * Two things here are the whole subject and everything else supports them.
 *
 * The walk has to go out of the front door. Every call it makes is a real HTTP
 * request to the address in `PUBLIC_BASE_URL`, which is the address a stranger's
 * agent would call, and this suite puts a recording server at that address and
 * points it back at the gateway. So the assertions are not "the walk says it
 * called the storefront" — they are "the storefront was called, here is the
 * request line". An implementation that reached inside the process instead
 * would record nothing and fail here, which is the one failure a document
 * assembled from our own internals could otherwise hide.
 *
 * And a walk that does not finish is a document. Every refusal on the way — the
 * card is off sale, the parameters do not fit, the merchant's worker never
 * answered — comes back as the transcript with the storefront's own sentence in
 * the step that stopped it. A 500 here would take the one thing the merchant
 * came for and throw it away.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CDP_FACILITATOR_URL } from "@coinslot/core";
import type { Card, Order, TestPurchase } from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  harness,
  type OrderHandler,
  type SeededMerchant,
  type Served,
  serve,
  theMerchantKey,
  workUntilStopped,
} from "../testing/harness.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

/** Delivered in the answer to the purchase, and cheap enough to be under any ceiling. */
const nowCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "1.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

/** The same, but the buyer has to say something about what it is buying. */
const askingCard: Card = {
  ...nowCard,
  merchant_item_id: "room-with-a-view",
  params: { floor: { type: "string", required: true, title: "Which floor" } },
};

/** The money moves at the purchase and the goods come later. */
const laterCard: Card = {
  merchant_item_id: "esim-30d",
  title: "An eSIM for thirty days",
  description: "Thirty days of data, delivered to the address given at purchase",
  price: { amount: "2.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Where to send it" } },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

/**
 * A server standing where the public storefront's address points, forwarding
 * every request to the gateway and writing down what went past.
 *
 * It exists because `PUBLIC_BASE_URL` is what the walk is supposed to use, and
 * the only way to prove it did is to make that address somewhere else. The
 * gateway listens on its own port and never learns about this one.
 */
interface Storefront {
  readonly url: string;
  /** Every request line the storefront saw, in order. */
  readonly seen: readonly string[];
  aimAt(gateway: string): void;
  close(): Promise<void>;
}

/** Headers a proxy must not copy: the hop's own, which the next hop writes itself. */
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "content-encoding",
]);

const bodyOf = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const recordingStorefront = async (): Promise<Storefront> => {
  const seen: string[] = [];
  let gateway: string | null = null;

  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    seen.push(`${request.method ?? "GET"} ${path}`);

    void (async () => {
      if (gateway === null) {
        response.statusCode = 502;
        response.end();
        return;
      }
      const body = await bodyOf(request);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (HOP_HEADERS.has(name) || value === undefined) continue;
        headers[name] = Array.isArray(value) ? (value[0] ?? "") : value;
      }

      const answered = await fetch(`${gateway}${path}`, {
        method: request.method,
        headers,
        ...(body.length === 0 ? {} : { body }),
      });

      response.statusCode = answered.status;
      answered.headers.forEach((value, name) => {
        if (HOP_HEADERS.has(name)) return;
        response.setHeader(name, value);
      });
      response.end(Buffer.from(await answered.arrayBuffer()));
    })().catch((thrown: unknown) => {
      response.statusCode = 502;
      response.end(String(thrown));
    });
  });

  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    aimAt: (at) => {
      gateway = at;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

let open: { harnessed: Harness; served: Served; storefront: Storefront } | null = null;

/**
 * A gateway whose public address is the recording storefront's.
 *
 * The storefront is stood up first, because its address has to be in the
 * gateway's configuration before the gateway is built; the gateway's own port
 * is then handed to it, so the two know each other in the order a deployment
 * behind a proxy knows itself.
 */
const started = async (overrides: Record<string, string> = {}) => {
  const storefront = await recordingStorefront();
  const harnessed = await harness({
    PAY_TO_ADDRESS: PAY_TO,
    // The scripted facilitator is what this whole suite settles through, and it
    // is what the configuration has to say it is: a gateway that named a real
    // facilitator would be asked for a buyer of its own, which is a different
    // test and is below.
    FACILITATOR_URL: "sandbox:scripted",
    PUBLIC_BASE_URL: storefront.url,
    ...overrides,
  });
  const served = await serve(harnessed);
  storefront.aimAt(served.url);
  open = { harnessed, served, storefront };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  await open?.storefront.close();
  open = null;
});

const keyOf = (merchant: SeededMerchant): Record<string, string> => ({
  authorization: `Bearer ${merchant.key}`,
});

const publish = async (
  served: Served,
  card: Card,
  headers: Record<string, string> = { authorization: `Bearer ${theMerchantKey("test")}` },
): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", { body: card, headers });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { id: string }).id;
};

/** The call the cabinet's button makes, with the merchant's worker turning beside it. */
const walk = async (
  harnessed: Harness,
  served: Served,
  itemId: string,
  options: {
    readonly params?: Record<string, unknown>;
    readonly headers?: Record<string, string>;
    readonly onOrder?: OrderHandler;
    /** Whose worker turns beside the call; the harness's own by default. */
    readonly merchantId?: string;
    /** False where the point of the test is that nobody is listening. */
    readonly worker?: boolean;
  } = {},
) => {
  const worker =
    options.worker === false
      ? null
      : workUntilStopped(harnessed, {
          onOrder: options.onOrder ?? (() => ({ delivered: { access_code: "SESAME" } })),
          ...(options.merchantId === undefined ? {} : { merchantId: options.merchantId }),
        });

  try {
    return await served.call("POST", `/v0/cards/${itemId}/test-purchase`, {
      body: { params: options.params ?? {} },
      headers: options.headers ?? keyOf(harnessed.merchant),
    });
  } finally {
    await worker?.stop();
  }
};

const walked = (body: unknown): TestPurchase => body as TestPurchase;

const stepNamed = (document: TestPurchase, name: string) =>
  document.steps.find((step) => step.step === name);

describe("a merchant walks a test purchase of their own card", () => {
  it("buys the card, the order reaches the handler, and the goods come back", async () => {
    // The whole promise in one test: the merchant presses a button, our buyer
    // walks the path a stranger's agent walks, and what comes back names the
    // order the merchant can look up and the goods their own worker produced.
    const { harnessed, served } = await started();
    const itemId = await publish(served, nowCard);
    const handled: Order[] = [];

    const answered = await walk(harnessed, served, itemId, {
      onOrder: (order) => {
        handled.push(order);
        return { delivered: { access_code: "SESAME-1" } };
      },
    });

    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const document = walked(answered.body);
    expect(document.outcome).toBe("delivered");
    expect(document.delivered).toStrictEqual({ access_code: "SESAME-1" });
    expect(document.steps.map((step) => step.step)).toStrictEqual([
      "catalog",
      "price",
      "payment",
      "delivery",
    ]);
    expect(document.steps.every((step) => step.ok)).toBe(true);

    // The order really reached the merchant's own handler, and the identifier
    // in the document is the one they will find among their orders.
    expect(handled).toHaveLength(1);
    expect(document.order_id).toBe(handled[0]?.id);
    const orders = await served.call("GET", "/v0/orders", { headers: keyOf(harnessed.merchant) });
    expect(
      (orders.body as { orders: { id: string }[] }).orders.map((order) => order.id),
    ).toContain(document.order_id);
  });

  it("carries the parameters the merchant's own card asks for", async () => {
    // A card that asks a question has to be testable with the answer, or the
    // button only ever works for the cards that ask nothing.
    const { harnessed, served } = await started();
    const itemId = await publish(served, askingCard);
    const handled: Order[] = [];

    const answered = await walk(harnessed, served, itemId, {
      params: { floor: "7" },
      onOrder: (order) => {
        handled.push(order);
        return { delivered: { access_code: `ROOM-7${String(order.params.floor)}` } };
      },
    });

    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(walked(answered.body).outcome).toBe("delivered");
    expect(handled[0]?.params).toStrictEqual({ floor: "7" });
  });

  it("ends honestly at accepted where the card's goods come later", async () => {
    // The asynchronous card cannot end in the goods and must not pretend to.
    // The money moved, the merchant took the order on, and the buyer collects
    // at the order's own door — which is a success with a different word.
    const { harnessed, served } = await started();
    const itemId = await publish(served, laterCard);

    const answered = await walk(harnessed, served, itemId, {
      params: { email: "buyer@example.com" },
      onOrder: () => ({ accepted: {} }),
    });

    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const document = walked(answered.body);
    expect(document.outcome).toBe("accepted");
    expect(document.delivered).toBeNull();
    expect(document.order_id).not.toBeNull();
    expect(stepNamed(document, "delivery")?.said).toContain("later");
  });
});

describe("the walk goes out of the front door", () => {
  it("calls the public storefront, at the address the configuration names", async () => {
    // The negative control for the whole feature. An implementation that called
    // the gateway's own flows in this process would produce the same document
    // and record nothing here.
    const { harnessed, served, storefront } = await started();
    const itemId = await publish(served, nowCard);

    const answered = await walk(harnessed, served, itemId);
    const document = walked(answered.body);

    expect(storefront.seen).toContain("GET /x402/catalog");
    expect(storefront.seen.filter((line) => line === `POST /x402/${itemId}/purchase`)).toHaveLength(
      2,
    );
    expect(storefront.seen).toContain(`GET /x402/orders/${document.order_id}/status`);
    // And the document says the same thing: every address it names is under the
    // public base, so a merchant reading it is reading their buyers' addresses.
    for (const step of document.steps) {
      expect(step.address.startsWith(storefront.url), step.address).toBe(true);
    }
    // The gateway's own port is not the public one, so an address built from
    // the request rather than the configuration would show up here.
    expect(JSON.stringify(document)).not.toContain(served.url);
  });
});

describe("a walk that does not finish is a document", () => {
  it("stops at the price with the storefront's own sentence when the card is off sale", async () => {
    const { harnessed, served } = await started();
    const itemId = await publish(served, nowCard);
    await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: keyOf(harnessed.merchant) });

    const answered = await walk(harnessed, served, itemId);

    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const document = walked(answered.body);
    expect(document.outcome).toBe("stopped");
    expect(document.order_id).toBeNull();
    expect(document.delivered).toBeNull();
    // The card is off sale, so it is out of the catalog too, and the sentence
    // is the storefront's rather than one we wrote about it.
    expect(stepNamed(document, "catalog")?.ok).toBe(false);
    expect(stepNamed(document, "price")?.said).toBe("this product is not on sale at the moment");
    expect(document.steps.at(-1)?.ok).toBe(false);
  });

  it("stops at the price when the parameters are not what the card asks for", async () => {
    // The mistake a merchant makes with their own card, answered with the
    // storefront's own words about it rather than a stack trace.
    const { harnessed, served } = await started();
    const itemId = await publish(served, laterCard);

    const answered = await walk(harnessed, served, itemId, { params: {} });

    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const document = walked(answered.body);
    expect(document.outcome).toBe("stopped");
    expect(stepNamed(document, "price")?.ok).toBe(false);
    expect(stepNamed(document, "price")?.said).toContain("card asks for");
  });

  it("says where it stopped when nobody is running the merchant's worker", async () => {
    // The commonest thing a merchant gets wrong, and the reason the button
    // exists. Nothing is subscribed, so the synchronous order is never
    // answered; the walk comes back with an order and no goods.
    const { harnessed, served } = await started({
      QUOTE_RESPONSE_MS: "100",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "500",
    });
    const itemId = await publish(served, nowCard);

    const answered = await walk(harnessed, served, itemId, { worker: false });

    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const document = walked(answered.body);
    expect(document.outcome).toBe("stopped");
    expect(document.delivered).toBeNull();
    expect(document.steps.at(-1)?.ok).toBe(false);
  });
});

describe("what the door refuses before any walk begins", () => {
  it("answers another merchant's card exactly as a card that is not there", async () => {
    // A test purchase is not a way of buying somebody else's product, and not a
    // way of finding out what they sell either.
    const { harnessed, served } = await started();
    const seller = await harnessed.addMerchant("Another merchant");
    const theirs = await publish(served, nowCard, keyOf(seller));

    const answered = await walk(harnessed, served, theirs, { worker: false });
    const missing = await walk(harnessed, served, "itm_nothing_here", { worker: false });

    expect(answered.status).toBe(404);
    expect(answered.body).toStrictEqual({
      error: { code: "no_such_item", message: "there is no such product", retryable: false },
    });
    expect(missing.body).toStrictEqual(answered.body);
  });

  it("refuses on a gateway where the money is real", async () => {
    // The buyer is ours and so is what it spends. A test purchase on the live
    // site would be us spending real money whenever somebody pressed a button.
    const { harnessed, served } = await started({
      PAYMENT_NETWORK: "eip155:8453",
      FACILITATOR_URL: CDP_FACILITATOR_URL,
      CDP_API_KEY_ID: "key-id",
      CDP_API_KEY_SECRET: "key-secret",
    });
    const live = { authorization: `Bearer ${theMerchantKey("live")}` };
    const itemId = await publish(served, nowCard, live);

    const answered = await walk(harnessed, served, itemId, { headers: live, worker: false });

    expect(answered.status).toBe(409);
    const { error } = answered.body as { error: { code: string; message: string } };
    expect(error.code).toBe("test_purchase_refused");
    expect(error.message).toContain("real");
  });

  it("says the stand has no test buyer rather than failing at the payment", async () => {
    // A gateway that settles through a real facilitator needs a funded wallet
    // of ours to buy with. Without one the honest answer is at the door, in
    // words, and not a signature that goes nowhere.
    const { harnessed, served } = await started({
      FACILITATOR_URL: "https://x402.org/facilitator",
    });
    const itemId = await publish(served, nowCard);

    const answered = await walk(harnessed, served, itemId, { worker: false });

    expect(answered.status).toBe(409);
    const { error } = answered.body as { error: { code: string; message: string } };
    expect(error.code).toBe("test_purchase_refused");
    expect(error.message).toContain("TEST_PURCHASE_BUYER_KEY");
  });

  it("refuses a card priced above what the test buyer may spend at once", async () => {
    // Test funds are free and a faucet is not infinite. The refusal names both
    // numbers, so the merchant knows what to publish instead.
    const { harnessed, served } = await started({ TEST_PURCHASE_MAX_USD: "2.00" });
    const itemId = await publish(served, { ...nowCard, price: { amount: "9.00", currency: "USD" } });

    const answered = await walk(harnessed, served, itemId, { worker: false });

    expect(answered.status).toBe(409);
    const { error } = answered.body as { error: { code: string; message: string } };
    expect(error.code).toBe("test_purchase_refused");
    expect(error.message).toContain("9.00");
    expect(error.message).toContain("2.00");
  });

  it("refuses a merchant who has walked more purchases than the hour allows", async () => {
    // One merchant cannot drain the faucet the whole test site buys from. The
    // ceiling is a count within a moving hour, and it lets go when the hour
    // does.
    const { harnessed, served } = await started({ TEST_PURCHASE_PER_HOUR: "2" });
    const itemId = await publish(served, nowCard);

    await walk(harnessed, served, itemId);
    await walk(harnessed, served, itemId);
    const refused = await walk(harnessed, served, itemId, { worker: false });

    expect(refused.status).toBe(429);
    const { error } = refused.body as {
      error: { code: string; message: string; retryable: boolean };
    };
    expect(error.code).toBe("test_purchase_refused");
    expect(error.message).toContain("2");
    // This one is a "not yet" rather than a "no", and the flag has to say so or
    // a cabinet will show the merchant a dead end.
    expect(error.retryable).toBe(true);

    harnessed.advance(60 * 60 * 1_000 + 1);
    const later = await walk(harnessed, served, itemId);
    expect(later.status, JSON.stringify(later.body)).toBe(200);
  });

  it("counts the ceiling against one merchant and not against the site", async () => {
    // A ceiling that counted every merchant's walks together would let one
    // merchant lock the rest of the test site out.
    const { harnessed, served } = await started({ TEST_PURCHASE_PER_HOUR: "1" });
    const seller = await harnessed.addMerchant("A second merchant");
    const mine = await publish(served, nowCard);
    const theirs = await publish(served, { ...nowCard, merchant_item_id: "room-202" }, keyOf(seller));

    await walk(harnessed, served, mine);
    const refused = await walk(harnessed, served, mine, { worker: false });
    const others = await walk(harnessed, served, theirs, {
      headers: keyOf(seller),
      merchantId: seller.id,
      onOrder: () => ({ delivered: { access_code: "THEIRS" } }),
    });

    expect(refused.status).toBe(429);
    expect(others.status, JSON.stringify(others.body)).toBe(200);
  });
});
