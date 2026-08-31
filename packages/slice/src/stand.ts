/**
 * A loopback-only console for walking the merchant and buyer sides together.
 *
 * It keeps the merchant key only in this process.  The page and feed receive
 * the fact of a connection, never the credential that opened it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  API_ROUTES,
  CardSchema,
  type Delivery,
  expandPath,
  MerchantCardListSchema,
  type Money,
  type Refusal,
} from "@nuanu-ai/coinslot-contracts";
import { type Buyer, makeBuyer } from "./buyer.js";
import { CATALOG } from "./cards.js";
import {
  listCards,
  listReceipts,
  pauseCard,
  pauseSelling,
  resumeCard,
  resumeSelling,
} from "./stand-gateway.js";
import { filledFrom } from "./stand-goods.js";
import { makeFeed } from "./stand-log.js";
import { makeStandMerchant, type OrderMood, type QuoteMood } from "./stand-merchant.js";
import { renderPage } from "./stand-page.js";

const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WATCH_MS = 60_000;
const ASK_EVERY_MS = 1_000;
// delivered_unpaid remains open: its goods exist, but a repeat purchase can
// still execute payment and move it to delivered.
const CLOSED_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "delivered",
  "rejected",
  "payment_unresolved",
  "declined",
  "expired",
  "cancelled",
  "refund_due",
  "refunded",
]);

const feed = makeFeed();
const merchant = makeStandMerchant(feed);
let apiKey: string | null = null;
let cards: ReturnType<typeof MerchantCardListSchema.parse>["cards"] = [];
let selling: string | null = null;
let cardDraft = JSON.stringify(CATALOG[0], null, 2);
let goodsDraft = "";
let paramsDraft = "{}";
let message: string | null = null;
let connectionGeneration = 0;
let connectionAbort = new AbortController();
let shuttingDown = false;
let actionTail: Promise<void> = Promise.resolve();
const feedResponses = new Map<ServerResponse, () => void>();
const postResponses = new Set<ServerResponse>();

const port = Number.parseInt(process.env.STAND_PORT ?? "8787", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("STAND_PORT must be a port number between 1 and 65535.");
}

const bodyOf = async (request: IncomingMessage): Promise<URLSearchParams> => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return new URLSearchParams(body);
};

const asJson = (text: string, named: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${named} must be JSON.`);
  }
};

const isLoopback = (address: string): boolean => {
  try {
    const host = new URL(address).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
};

const requireConnection = (): { readonly address: string; readonly key: string } => {
  const address = merchant.connected();
  if (address === null || apiKey === null)
    throw new Error("Connect a merchant key and gateway address first.");
  return { address, key: apiKey };
};

const say = (what: string): void => {
  message = what;
  feed.write("stand", what);
};

const readCards = async (generation: number): Promise<void> => {
  const { address, key } = requireConnection();
  const answer = await listCards(address, key);
  if (!connectionIsCurrent(generation)) return;
  const parsed = MerchantCardListSchema.safeParse(answer.body);
  if (!parsed.success) {
    feed.write("gateway", "The merchant card list could not be parsed.", {
      status: answer.status,
      body: answer.body,
      issues: parsed.error.issues,
    });
    say(`The gateway answered ${answer.status}, but its merchant card list was not readable.`);
    return;
  }
  cards = parsed.data.cards;
  selling = parsed.data.selling;
  for (const one of cards) merchant.learn(one.card.merchant_item_id, one.card.result);
  feed.write("gateway", "Read the merchant card list.", {
    status: answer.status,
    body: parsed.data,
  });
};

const connectionIsCurrent = (generation: number): boolean => generation === connectionGeneration;

const stopWatchingThisConnection = (): void => {
  connectionAbort.abort();
  connectionGeneration += 1;
  connectionAbort = new AbortController();
};

const waitForNextStatus = (signal: AbortSignal, milliseconds: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timeout = setTimeout(done, milliseconds, true);
    const cancelled = (): void => done(false);
    signal.addEventListener("abort", cancelled, { once: true });
    function done(continueWatching: boolean): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancelled);
      resolve(continueWatching);
    }
  });

const traceFetchFor =
  (generation: number): typeof fetch =>
  async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (connectionIsCurrent(generation))
      feed.write("buyer", "Request sent.", {
        method: request.method,
        url: request.url,
        payment_signature_present: request.headers.has("payment-signature"),
      });
    try {
      const response = await fetch(request);
      const text = await response.clone().text();
      let body: unknown = text === "" ? null : text;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        // The response was still an answer.  Keep its text, as a proxy page says
        // something about the proxy rather than disappearing as a parse error.
      }
      if (connectionIsCurrent(generation))
        feed.write("buyer", "Response received.", {
          status: response.status,
          url: request.url,
          body,
        });
      return response;
    } catch (error) {
      if (connectionIsCurrent(generation))
        feed.write("buyer", "Request did not complete.", {
          method: request.method,
          url: request.url,
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
  };

const buyerFor = (generation: number): Buyer => {
  const { address } = requireConnection();
  return makeBuyer({
    baseUrl: address,
    privateKey: TEST_BUYER_KEY,
    maxUsd: 50,
    fetch: traceFetchFor(generation),
  });
};

const objectWithOrder = (
  body: unknown,
): { readonly orderId: string; readonly hasGoods: boolean } | null => {
  if (typeof body !== "object" || body === null) return null;
  const document = body as Record<string, unknown>;
  return typeof document.order_id === "string"
    ? {
        orderId: document.order_id,
        hasGoods: document.delivered !== null && document.delivered !== undefined,
      }
    : null;
};

const watchOrder = async (
  buyer: Buyer,
  orderId: string,
  generation: number,
  signal: AbortSignal,
): Promise<void> => {
  const until = Date.now() + WATCH_MS;
  while (Date.now() < until) {
    const wait = Math.min(ASK_EVERY_MS, until - Date.now());
    if (!(await waitForNextStatus(signal, wait))) return;
    if (!connectionIsCurrent(generation)) return;
    if (Date.now() >= until) break;
    try {
      const status = await buyer.status(orderId);
      if (!connectionIsCurrent(generation)) return;
      feed.write("buyer", "Order status read while watching.", {
        order_id: orderId,
        status: status.status,
        state: status.state,
        body: status.body,
      });
      if (status.state !== null && CLOSED_ORDER_STATUSES.has(status.state)) return;
    } catch (error) {
      if (!connectionIsCurrent(generation)) return;
      feed.write("buyer", "The order watcher could not read status and will continue.", {
        order_id: orderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!connectionIsCurrent(generation)) return;
  feed.write("buyer", "Watching an order reached its ceiling.", {
    order_id: orderId,
    message: `The stand stopped watching ${orderId} after ${WATCH_MS / 1_000} seconds; that is not an ending and the merchant may still finish it.`,
  });
};

const setMoods = (form: URLSearchParams): void => {
  const order = form.get("order");
  const quote = form.get("quote");
  const orderMoods: readonly OrderMood[] = [
    "deliver",
    "accept_then_deliver",
    "accept_and_say_nothing",
    "refuse",
    "say_nothing",
    "answer_wrong_shape",
  ];
  const quoteMoods: readonly QuoteMood[] = ["price", "unavailable", "say_nothing"];
  if (!orderMoods.includes(order as OrderMood) || !quoteMoods.includes(quote as QuoteMood)) {
    throw new Error("The selected handler mood is not known to the stand.");
  }
  const delay = Number(form.get("deliver_after_ms"));
  if (!Number.isFinite(delay) || delay < 0)
    throw new Error("Deliver-after must be a non-negative number of milliseconds.");
  const amount = form.get("price_amount") ?? "";
  const currency = form.get("price_currency") ?? "";
  const refusal: Refusal = {
    code: (form.get("refusal_code") ?? "") as Refusal["code"],
    message: form.get("refusal_message") ?? "",
  };
  if (goodsDraft !== "") {
    const delivery = asJson(goodsDraft, "Goods") as Delivery;
    if (typeof delivery !== "object" || delivery === null || Array.isArray(delivery))
      throw new Error("Goods must be a JSON object.");
    merchant.moods.delivery = delivery;
  } else {
    merchant.moods.delivery = null;
  }
  merchant.moods.order = order as OrderMood;
  merchant.moods.quote = quote as QuoteMood;
  merchant.moods.deliverAfterMs = delay;
  merchant.moods.price = { amount, currency } as Money;
  merchant.moods.refusal = refusal;
};

const doAction = async (form: URLSearchParams): Promise<void> => {
  const action = form.get("action");
  switch (action) {
    case "connect": {
      const address = form.get("address") ?? "";
      const key = form.get("api_key") ?? "";
      if (address === "" || key === "")
        throw new Error("Gateway address and merchant key are both required.");
      stopWatchingThisConnection();
      const generation = connectionGeneration;
      // A new gateway is a new catalogue. Until its document parses, the old
      // gateway's cards must not remain actionable on this page.
      cards = [];
      selling = null;
      apiKey = key;
      await merchant.connect(address, key);
      if (!connectionIsCurrent(generation)) return;
      await readCards(generation);
      if (!connectionIsCurrent(generation)) return;
      say(`Connected to ${address}.`);
      return;
    }
    case "disconnect": {
      stopWatchingThisConnection();
      const generation = connectionGeneration;
      await merchant.disconnect();
      if (!connectionIsCurrent(generation)) return;
      apiKey = null;
      cards = [];
      selling = null;
      say("Disconnected the stand merchant.");
      return;
    }
    case "template": {
      const index = Number(form.get("template"));
      const template = CATALOG[index];
      if (template === undefined) throw new Error("That card template does not exist.");
      const draft = structuredClone(template) as Record<string, unknown>;
      if (draft.fulfillment === "async") draft.fulfill_deadline_seconds = 10;
      cardDraft = JSON.stringify(draft, null, 2);
      say("Copied the card template into the draft.");
      return;
    }
    case "publish": {
      const generation = connectionGeneration;
      const raw = form.get("card") ?? "";
      cardDraft = raw;
      const card = CardSchema.parse(asJson(raw, "Card"));
      const outcome = await merchant.publish(card);
      if (!connectionIsCurrent(generation)) return;
      feed.write("merchant", "Publish call answered.", outcome);
      await readCards(generation);
      if (!connectionIsCurrent(generation)) return;
      say("Sent the card draft to the merchant SDK.");
      return;
    }
    case "pause_card":
    case "resume_card": {
      const generation = connectionGeneration;
      const { address, key } = requireConnection();
      const itemId = form.get("item_id") ?? "";
      const answer =
        action === "pause_card"
          ? await pauseCard(address, key, itemId)
          : await resumeCard(address, key, itemId);
      if (!connectionIsCurrent(generation)) return;
      feed.write("gateway", `${action === "pause_card" ? "Paused" : "Resumed"} a card.`, answer);
      await readCards(generation);
      return;
    }
    case "pause_selling":
    case "resume_selling": {
      const generation = connectionGeneration;
      const { address, key } = requireConnection();
      const answer =
        action === "pause_selling"
          ? await pauseSelling(address, key)
          : await resumeSelling(address, key);
      if (!connectionIsCurrent(generation)) return;
      feed.write(
        "gateway",
        `${action === "pause_selling" ? "Paused" : "Resumed"} all selling.`,
        answer,
      );
      await readCards(generation);
      return;
    }
    case "moods":
      goodsDraft = form.get("goods") ?? "";
      setMoods(form);
      say("Changed the merchant handler moods.");
      return;
    case "fill": {
      const itemId = form.get("item_id");
      const card = cards.find((one) => one.id === itemId);
      if (card === undefined)
        throw new Error("The card to fill is no longer in the merchant card list.");
      paramsDraft = JSON.stringify(filledFrom(card.card.params), null, 2);
      say(`Filled the parameters declared by ${card.id}.`);
      return;
    }
    case "buy": {
      const generation = connectionGeneration;
      const signal = connectionAbort.signal;
      const buyer = buyerFor(generation);
      const itemId = form.get("item_id") ?? "";
      if (itemId === "") throw new Error("A public item id is required to buy.");
      const { address } = requireConnection();
      if (!isLoopback(address)) {
        say(
          `The stand is connected to ${address}. Connecting and publishing are allowed there, but buying is allowed only against a loopback gateway because this buyer can sign a real payment.`,
        );
        return;
      }
      const rawParams = form.get("params") ?? paramsDraft;
      paramsDraft = rawParams;
      const bought = await buyer.buy(
        itemId,
        asJson(rawParams, "Purchase parameters") as Record<string, unknown>,
      );
      if (!connectionIsCurrent(generation)) return;
      feed.write("buyer", "Purchase answered.", bought);
      const order = objectWithOrder(bought.body);
      if (order !== null && !order.hasGoods)
        void watchOrder(buyer, order.orderId, generation, signal).catch((error: unknown) => {
          if (!connectionIsCurrent(generation)) return;
          feed.write("buyer", "Order watcher failed.", {
            order_id: order.orderId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    case "invalid_payment": {
      const generation = connectionGeneration;
      const { address } = requireConnection();
      const itemId = form.get("item_id") ?? "";
      const rawParams = form.get("params") ?? paramsDraft;
      paramsDraft = rawParams;
      const response = await traceFetchFor(generation)(
        `${address.replace(/\/+$/, "")}${expandPath(API_ROUTES.purchase_item.path, { item_id: itemId })}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "payment-signature": "this is deliberately not a payment",
          },
          body: JSON.stringify({ params: asJson(rawParams, "Purchase parameters") }),
        },
      );
      if (!connectionIsCurrent(generation)) return;
      const body = await response.json().catch(() => null);
      if (!connectionIsCurrent(generation)) return;
      feed.write("buyer", "Unreadable payment answered.", {
        status: response.status,
        body,
      });
      return;
    }
    case "status": {
      const generation = connectionGeneration;
      const orderId = form.get("order_id") ?? "";
      const status = await buyerFor(generation).status(orderId);
      if (!connectionIsCurrent(generation)) return;
      feed.write("buyer", "Order status read.", { order_id: orderId, ...status });
      return;
    }
    case "receipts": {
      const generation = connectionGeneration;
      const { address, key } = requireConnection();
      const answer = await listReceipts(address, key);
      if (!connectionIsCurrent(generation)) return;
      feed.write("gateway", "Merchant receipts read.", answer);
      return;
    }
    default:
      throw new Error("The submitted stand action is not known.");
  }
};

const recordActionError = (error: unknown): void => {
  const detail = error instanceof Error ? error.message : String(error);
  message = detail;
  feed.write("stand", "Action could not be completed.", { error: detail });
};

const queueAction = (form: URLSearchParams): Promise<boolean> => {
  const queued = actionTail.then(async () => {
    if (shuttingDown) return false;
    try {
      await doAction(form);
    } catch (error) {
      if (shuttingDown) return false;
      recordActionError(error);
    }
    return !shuttingDown;
  });
  actionTail = queued.then(() => undefined);
  return queued;
};

const sayUnavailable = (response: ServerResponse): void => {
  if (!response.writableEnded && !response.destroyed)
    response
      .writeHead(503, { "content-type": "text/plain; charset=utf-8" })
      .end("The stand is shutting down; this action was not run.");
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/feed") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const stop = feed.listen((one) => {
      if (!response.writableEnded && !response.destroyed)
        response.write(`data: ${JSON.stringify(one)}\n\n`);
    });
    const closeFeed = (): void => {
      stop();
      feedResponses.delete(response);
    };
    feedResponses.set(response, closeFeed);
    request.once("close", closeFeed);
    response.once("close", closeFeed);
    return;
  }
  if (request.method === "POST") {
    postResponses.add(response);
    response.once("close", () => postResponses.delete(response));
    const origin = request.headers.origin;
    const allowed = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ]);
    if (origin !== undefined && !allowed.has(origin)) {
      response
        .writeHead(403, { "content-type": "text/plain; charset=utf-8" })
        .end("This form post did not come from this loopback stand.");
      return;
    }
    let form: URLSearchParams;
    try {
      form = await bodyOf(request);
    } catch (error) {
      if (!response.writableEnded && !response.destroyed) {
        recordActionError(error);
        response
          .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          .end("This form body could not be read.");
      }
      return;
    }
    if (shuttingDown) {
      sayUnavailable(response);
      return;
    }
    const ran = await queueAction(form);
    if (!ran || shuttingDown) {
      sayUnavailable(response);
      return;
    }
    if (!response.writableEnded && !response.destroyed)
      response.writeHead(303, { location: "/" }).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    const address = merchant.connected();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      renderPage({
        address,
        loopback: address !== null && isLoopback(address),
        moods: merchant.moods,
        cardDraft,
        goodsDraft,
        paramsDraft,
        cards,
        selling,
        heldOrders: [...merchant.taken.values()].map((one) => ({
          id: one.id,
          merchantItemId: one.merchant_item_id,
        })),
        message,
        entries: feed.entries(),
      }),
    );
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.");
});

server.listen(port, "127.0.0.1", () => console.log(`Coinslot stand: http://127.0.0.1:${port}`));

const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWatchingThisConnection();
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [response, closeFeed] of [...feedResponses]) {
    closeFeed();
    if (!response.writableEnded && !response.destroyed) response.end();
  }
  for (const response of postResponses) response.destroy();
  apiKey = null;
  cards = [];
  selling = null;
  await actionTail;
  await merchant.disconnect();
  await serverClosed;
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
