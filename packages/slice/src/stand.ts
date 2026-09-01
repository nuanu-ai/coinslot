/**
 * A local console with three seats at one wire.
 *
 * A purchase has three participants, and this process lets one person sit in
 * each of them in turn: the merchant who publishes, the agent who buys, and the
 * merchant's own code answering orders. The tabs are those seats; the log is
 * shared by all three and threaded by the order, because a purchase told in
 * three places is only legible if the three places agree on which purchase.
 *
 * It keeps the merchant key only in this process. The page and the log receive
 * the fact of a connection and the environment the key names, never the
 * credential that opened it.
 *
 * One rule shapes the code more than any other: an agent call never blocks the
 * console. A synchronous purchase does not answer until the handler has
 * answered, so a POST that waited for it would freeze the very tab you need to
 * go to. Every agent call is therefore started and left running, the exchange
 * says it is waiting, and the answer arrives into the page later.
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Environment, environmentOfKeyPrefix } from "@coinslot/core";
import {
  type CardInput,
  type Delivery,
  MerchantCardListSchema,
  type Money,
  type ParamSpec,
  type PublicCard,
  type Receipt,
  ReceiptListSchema,
  type Refusal,
  type SellingState,
} from "@nuanu-ai/coinslot-contracts";
import type { PaymentRequired } from "@x402/core/types";
import { CATALOG } from "./cards.js";
import {
  type Answered,
  type ChallengeView,
  makeStandBuyer,
  readChallenge,
  type StandBuyer,
} from "./stand-buyer.js";
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
import {
  type HeldAnswer,
  makeStandMerchant,
  type OrderMood,
  type QuoteMood,
} from "./stand-merchant.js";
import {
  type Beat,
  type ExchangeView,
  renderEntry,
  renderPage,
  type SaidBack,
  type Tab,
} from "./stand-page.js";

const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BUYER_CEILING_USD = 50;

const feed = makeFeed();
const merchant = makeStandMerchant(feed);

let apiKey: string | null = null;
// What the key names about itself, kept beside it so the page can say which
// environment somebody is pointed at without ever being handed the credential.
let keyEnvironment: Environment | null = null;
let cards: ReturnType<typeof MerchantCardListSchema.parse>["cards"] = [];
let selling: SellingState | null = null;
let receipts: readonly Receipt[] = [];
let receiptsRead = false;
let publicItems: readonly PublicCard[] = [];
let publicItemsRead = false;
let cardDraft = JSON.stringify(CATALOG[0], null, 2);
let goodsDraft = "";
let paramsDraft = "{}";
let chosen: string | null = null;
let said: SaidBack | null = null;
let connectionGeneration = 0;
let shuttingDown = false;
let actionTail: Promise<void> = Promise.resolve();
const feedResponses = new Map<ServerResponse, () => void>();
const postResponses = new Set<ServerResponse>();

/** The agent's current conversation with one product. */
interface Exchange {
  readonly itemId: string;
  readonly title: string;
  readonly beats: Beat[];
  /** The challenge in hand, waiting for a signature that is yours to give. */
  challenge: PaymentRequired | null;
  challengeView: ChallengeView | null;
  orderId: string | null;
  waiting: boolean;
  closed: boolean;
}

let exchange: Exchange | null = null;

const port = Number.parseInt(process.env.STAND_PORT ?? "8787", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("STAND_PORT must be a port number between 1 and 65535.");
}

/* --- saying things ------------------------------------------------------ */

const say = (what: string): void => {
  said = { words: what, problem: false };
  feed.write("stand", what);
};

const recordActionError = (error: unknown): void => {
  const detail = error instanceof Error ? error.message : String(error);
  said = { words: detail, problem: true };
  feed.write("stand", "Action could not be completed.", { error: detail });
};

const wordsOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/* --- pushing to open pages ---------------------------------------------- */

const toEveryPage = (payload: Record<string, unknown>): void => {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of feedResponses.keys()) {
    if (!response.writableEnded && !response.destroyed) response.write(line);
  }
};

/**
 * Tells every open page that what it is drawing has changed underneath it.
 *
 * The page reloads on this, and only while nothing is focused: an order
 * arriving in the inbox is worth interrupting a reader for and not worth
 * interrupting a typist for.
 */
const stir = (): void => toEveryPage({ stir: true });

// Everything the merchant side does arrives over a subscription rather than in
// an answer to something the page asked for, so the page has to be told.
feed.listen((entry) => {
  toEveryPage({ entry: renderEntry(entry) });
  if (entry.kind === "merchant" || entry.kind === "gateway") stir();
});

/* --- reading the gateway back ------------------------------------------- */

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

const asParams = (text: string): Record<string, unknown> => {
  const document = asJson(text, "Parameters");
  if (typeof document !== "object" || document === null || Array.isArray(document))
    throw new Error("Parameters must be a JSON object.");
  return document as Record<string, unknown>;
};

const requireConnection = (): { readonly address: string; readonly key: string } => {
  const address = merchant.connected();
  if (address === null || apiKey === null)
    throw new Error("Connect a merchant key and gateway address first.");
  return { address, key: apiKey };
};

const connectionIsCurrent = (generation: number): boolean => generation === connectionGeneration;

const dropThisConnection = (): void => {
  connectionGeneration += 1;
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
    cards: cards.length,
    selling: parsed.data.selling,
  });
};

const readReceipts = async (generation: number): Promise<void> => {
  const { address, key } = requireConnection();
  const answer = await listReceipts(address, key);
  if (!connectionIsCurrent(generation)) return;
  const parsed = ReceiptListSchema.safeParse(answer.body);
  if (!parsed.success) {
    feed.write("gateway", "The receipt list could not be parsed.", {
      status: answer.status,
      body: answer.body,
      issues: parsed.error.issues,
    });
    return;
  }
  receipts = parsed.data.receipts;
  receiptsRead = true;
  feed.write("gateway", "Read the merchant's receipts.", {
    status: answer.status,
    receipts: receipts.length,
  });
};

/* --- the agent's side --------------------------------------------------- */

const tracedFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  feed.write("agent", `${request.method} ${new URL(request.url).pathname}`, {
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
      // The response was still an answer. Keep its text, as a proxy page says
      // something about the proxy rather than disappearing as a parse error.
    }
    feed.write("agent", `Answered ${response.status}.`, {
      status: response.status,
      url: request.url,
      body,
    });
    return response;
  } catch (error) {
    feed.write("agent", "The call did not complete.", {
      url: request.url,
      error: wordsOf(error),
    });
    throw error;
  }
};

const buyerFor = (): StandBuyer => {
  const { address } = requireConnection();
  return makeStandBuyer({
    baseUrl: address,
    privateKey: TEST_BUYER_KEY,
    maxUsd: BUYER_CEILING_USD,
    fetch: tracedFetch,
  });
};

const titleOf = (itemId: string): string =>
  publicItems.find((one) => one.id === itemId)?.title ??
  cards.find((one) => one.id === itemId)?.card.title ??
  itemId;

const paramsDeclaredBy = (itemId: string): ParamSpec | undefined =>
  publicItems.find((one) => one.id === itemId)?.params ??
  cards.find((one) => one.id === itemId)?.card.params;

const openExchange = (itemId: string): Exchange => {
  const fresh: Exchange = {
    itemId,
    title: titleOf(itemId),
    beats: [],
    challenge: null,
    challengeView: null,
    orderId: null,
    waiting: false,
    closed: false,
  };
  exchange = fresh;
  feed.about(null);
  return fresh;
};

const beat = (
  on: Exchange,
  who: Beat["who"],
  words: string,
  fact = "",
  detail: unknown = undefined,
  tone: Beat["tone"] = "",
): void => {
  on.beats.push({ who, said: words, fact, detail, tone });
};

/** Reads an order identifier out of whatever the gateway answered with. */
const orderIn = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as Record<string, unknown>).order_id;
  return typeof id === "string" ? id : null;
};

const statusIn = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const word = (body as Record<string, unknown>).status;
  return typeof word === "string" ? word : null;
};

/** Puts what an answer turned out to be onto the exchange, in one place. */
const recordAnswer = (on: Exchange, answer: Answered): void => {
  const order = orderIn(answer.body);
  if (order !== null) {
    on.orderId = order;
    feed.about(order);
  }
  if (answer.challenge !== null) {
    const view = readChallenge(answer.challenge);
    on.challenge = answer.challenge;
    on.challengeView = view;
    if (view?.orderId != null) {
      on.orderId = view.orderId;
      feed.about(view.orderId);
    }
    beat(
      on,
      "gateway",
      view === null
        ? "Answered with a challenge this console could not read."
        : view.orderId === null
          ? "Answered with a challenge for the card alone. No order was opened."
          : "Opened an order and answered with a challenge.",
      view?.orderId ?? "",
      answer.challenge,
    );
    return;
  }
  const word = statusIn(answer.body);
  if (answer.status >= 400) {
    beat(on, "gateway", `Refused with ${answer.status}.`, "", answer.body, "bad");
    on.closed = true;
    return;
  }
  beat(
    on,
    "gateway",
    word === null ? `Answered ${answer.status}.` : `The order stands at ${word}.`,
    order ?? "",
    answer.body,
  );
  if (answer.settlement !== null) {
    beat(
      on,
      "gateway",
      "The payment layer signed a settlement onto the answer.",
      "",
      answer.settlement,
    );
  }
  on.closed = true;
};

/**
 * Starts an agent call and lets go of it.
 *
 * The console must stay usable while a purchase is unanswered — that is the
 * whole point of the Orders tab — so nothing here is awaited by the action that
 * began it.
 */
const agentCall = (on: Exchange, run: () => Promise<void>): void => {
  on.waiting = true;
  void run()
    .catch((error: unknown) => {
      beat(on, "agent", `The call did not complete: ${wordsOf(error)}`, "", null, "bad");
      on.closed = true;
    })
    .finally(() => {
      on.waiting = false;
      stir();
    });
};

/* --- what the page asks for --------------------------------------------- */

const ORDER_MOODS: readonly OrderMood[] = [
  "deliver",
  "accept_then_deliver",
  "accept_and_say_nothing",
  "refuse",
  "say_nothing",
  "answer_wrong_shape",
  "ask_me",
];
const QUOTE_MOODS: readonly QuoteMood[] = ["price", "unavailable", "say_nothing"];
const HELD_ANSWERS: readonly HeldAnswer[] = ["deliver", "accept", "refuse", "say_nothing"];

const setMoods = (form: URLSearchParams): void => {
  const order = form.get("order");
  const quote = form.get("quote");
  if (!ORDER_MOODS.includes(order as OrderMood) || !QUOTE_MOODS.includes(quote as QuoteMood)) {
    throw new Error("That standing answer is not one the stand knows.");
  }
  const delay = Number(form.get("deliver_after_ms"));
  if (!Number.isFinite(delay) || delay < 0)
    throw new Error("Deliver-after must be a non-negative number of milliseconds.");
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
  merchant.moods.price = {
    amount: form.get("price_amount") ?? "",
    currency: form.get("price_currency") ?? "",
  } as Money;
  merchant.moods.refusal = refusal;
};

const requireExchange = (): Exchange => {
  if (exchange === null) throw new Error("Choose a product on the Agent tab first.");
  return exchange;
};

const doAction = async (form: URLSearchParams): Promise<void> => {
  const action = form.get("action");
  switch (action) {
    case "connect": {
      const address = form.get("address") ?? "";
      const key = form.get("api_key") ?? "";
      if (address === "" || key === "")
        throw new Error("Gateway address and merchant key are both required.");
      dropThisConnection();
      const generation = connectionGeneration;
      // A new gateway is a new catalogue. Until its documents parse, the old
      // gateway's cards must not remain actionable on this page.
      cards = [];
      selling = null;
      receipts = [];
      receiptsRead = false;
      publicItems = [];
      publicItemsRead = false;
      exchange = null;
      chosen = null;
      apiKey = key;
      keyEnvironment = environmentOfKeyPrefix(key);
      await merchant.connect(address, key);
      if (!connectionIsCurrent(generation)) return;
      await readCards(generation);
      if (!connectionIsCurrent(generation)) return;
      say(`Connected to ${address}.`);
      return;
    }

    case "disconnect": {
      dropThisConnection();
      await merchant.disconnect();
      apiKey = null;
      keyEnvironment = null;
      cards = [];
      selling = null;
      receipts = [];
      receiptsRead = false;
      publicItems = [];
      publicItemsRead = false;
      exchange = null;
      chosen = null;
      say("Disconnected the stand merchant.");
      return;
    }

    /* --- the catalogue tab --- */

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
      const document = asJson(raw, "Card");
      if (typeof document !== "object" || document === null || Array.isArray(document))
        throw new Error("Card must be a JSON object.");
      const outcome = await merchant.publish(document as CardInput);
      if (!connectionIsCurrent(generation)) return;
      feed.write("merchant", "Publish call answered.", outcome);
      await readCards(generation);
      if (!connectionIsCurrent(generation)) return;
      publicItemsRead = false;
      // Publishing answers `{ ok }` or `{ errors }` under a clean status, so a
      // console that reported the call rather than its answer would say a card
      // went up when the gateway had just refused it.
      if ("errors" in outcome) {
        const first = outcome.errors[0];
        throw new Error(
          first === undefined
            ? "The gateway refused this card and named no reason."
            : `The gateway refused this card: ${first.code} — ${first.message}`,
        );
      }
      say(`Published ${(document as CardInput).merchant_item_id} as ${outcome.ok.id}.`);
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
      publicItemsRead = false;
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
      publicItemsRead = false;
      return;
    }

    /* --- the agent tab --- */

    case "read_catalog": {
      publicItems = await buyerFor().catalog();
      publicItemsRead = true;
      say(
        `The public catalog lists ${publicItems.length} product${publicItems.length === 1 ? "" : "s"}.`,
      );
      return;
    }

    case "choose": {
      const itemId = form.get("item_id") ?? "";
      if (itemId === "") throw new Error("Choose a product by its public item id.");
      chosen = itemId;
      paramsDraft = JSON.stringify(filledFrom(paramsDeclaredBy(itemId)), null, 2);
      openExchange(itemId);
      say(`Chose ${titleOf(itemId)}. Nothing has been sent yet.`);
      return;
    }

    case "ask_price": {
      const on = requireExchange();
      const buyer = buyerFor();
      beat(on, "agent", "Asked what this card costs, without opening anything.", "GET");
      agentCall(on, async () => {
        recordAnswer(on, await buyer.askPrice(on.itemId));
      });
      return;
    }

    case "start_purchase": {
      const itemId = form.get("item_id") ?? chosen ?? "";
      if (itemId === "") throw new Error("Choose a product first.");
      paramsDraft = form.get("params") ?? paramsDraft;
      const params = asParams(paramsDraft);
      const buyer = buyerFor();
      const on = openExchange(itemId);
      beat(on, "agent", "Started a purchase without paying.", "POST", { params });
      agentCall(on, async () => {
        recordAnswer(on, await buyer.startPurchase(itemId, params));
      });
      return;
    }

    case "sign_and_pay": {
      const on = requireExchange();
      const challenge = on.challenge;
      if (challenge === null) throw new Error("There is no challenge in hand to sign.");
      const params = asParams(paramsDraft);
      const buyer = buyerFor();
      on.challenge = null;
      beat(
        on,
        "agent",
        "Signed the challenge and sent the payment.",
        "PAYMENT-SIGNATURE",
        null,
        "now",
      );
      agentCall(on, async () => {
        recordAnswer(on, await buyer.payFor(on.itemId, params, challenge));
      });
      return;
    }

    case "pay_badly": {
      const on = requireExchange();
      const params = asParams(paramsDraft);
      const buyer = buyerFor();
      on.challenge = null;
      beat(
        on,
        "agent",
        "Sent a payment header nothing can decode.",
        "PAYMENT-SIGNATURE",
        null,
        "now",
      );
      agentCall(on, async () => {
        recordAnswer(on, await buyer.payBadly(on.itemId, params));
      });
      return;
    }

    case "walk_away": {
      const on = requireExchange();
      on.challenge = null;
      on.challengeView = null;
      on.closed = true;
      beat(
        on,
        "agent",
        "Walked away from the challenge. The order it opened will expire on its own.",
      );
      say("Left the challenge unpaid.");
      return;
    }

    case "buy_now": {
      const itemId = form.get("item_id") ?? chosen ?? "";
      if (itemId === "") throw new Error("Choose a product first.");
      paramsDraft = form.get("params") ?? paramsDraft;
      const params = asParams(paramsDraft);
      const buyer = buyerFor();
      const on = openExchange(itemId);
      beat(on, "agent", "Bought in one go: the unpaid call, then the signature.", "POST", {
        params,
      });
      agentCall(on, async () => {
        const opened = await buyer.startPurchase(itemId, params);
        recordAnswer(on, opened);
        if (opened.challenge === null) return;
        on.challenge = null;
        beat(
          on,
          "agent",
          "Signed the challenge and sent the payment.",
          "PAYMENT-SIGNATURE",
          null,
          "now",
        );
        stir();
        recordAnswer(on, await buyer.payFor(itemId, params, opened.challenge));
      });
      return;
    }

    case "order_status": {
      const orderId = form.get("order_id") ?? "";
      if (orderId === "") throw new Error("An order identifier is required.");
      const buyer = buyerFor();
      const on = exchange ?? openExchange(chosen ?? orderId);
      beat(on, "agent", `Asked what became of ${orderId}.`, "GET");
      agentCall(on, async () => {
        recordAnswer(on, await buyer.status(orderId));
      });
      return;
    }

    /* --- the orders tab --- */

    case "moods":
      goodsDraft = form.get("goods") ?? "";
      setMoods(form);
      say("Changed what the merchant's code does with what arrives next.");
      return;

    case "answer_held": {
      const orderId = form.get("order_id") ?? "";
      const answer = form.get("answer") ?? "";
      if (!HELD_ANSWERS.includes(answer as HeldAnswer))
        throw new Error("That is not one of the four answers a held order takes.");
      if (!merchant.answerHeld(orderId, answer as HeldAnswer))
        throw new Error("That order is no longer being held.");
      say(`Answered ${orderId}.`);
      return;
    }

    case "deliver_owed":
    case "refuse_owed": {
      const orderId = form.get("order_id") ?? "";
      const done =
        action === "deliver_owed"
          ? await merchant.deliverOwed(orderId)
          : await merchant.refuseOwed(orderId);
      if (!done) throw new Error("That order is no longer owed anything.");
      return;
    }

    case "read_cards": {
      const generation = connectionGeneration;
      await readCards(generation);
      if (!connectionIsCurrent(generation)) return;
      // A card list read again may be a different one — somebody else's key, or
      // the cabinet, can have published or paused since. What an agent finds is
      // read from the gateway rather than derived from this, so it is marked as
      // owing a fresh read rather than quietly left stale.
      publicItemsRead = false;
      say(
        `This merchant has ${cards.length} card${cards.length === 1 ? "" : "s"} on this gateway.`,
      );
      return;
    }

    case "read_receipts":
      await readReceipts(connectionGeneration);
      return;

    default:
      throw new Error("The submitted stand action is not known.");
  }
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

/* --- the files the product is drawn with -------------------------------- */

/*
 * ADR-0005 §6 asks for one visual language held in one stylesheet rather than
 * copied per surface. On the origin, Caddy serves that file to the landing, the
 * portal and the cabinet alike; here there is no Caddy, so the stand serves the
 * repository's own copy — which is the point. A second copy of the palette
 * living beside this console is exactly how one visual language becomes two
 * that look almost alike.
 */
const SHARED_STYLES = resolve(
  fileURLToPath(new URL("../../../apps/landing/public/styles/", import.meta.url)),
);
const OWN_STYLESHEET = fileURLToPath(new URL("./stand.css", import.meta.url));

const FILE_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

const notFound = (response: ServerResponse): void => {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.");
};

/** Answers with a file of a kind this page is allowed to ask for, or with nothing. */
const sendFile = async (response: ServerResponse, path: string): Promise<void> => {
  const type = FILE_TYPES[extname(path)];
  if (type === undefined) {
    notFound(response);
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(path);
  } catch {
    // A stand run outside the repository has no shared styles to serve, and the
    // fallback stacks in the tokens are what carry the page then.
    notFound(response);
    return;
  }
  response.writeHead(200, { "content-type": type, "cache-control": "no-cache" }).end(body);
};

/** Where under the shared styles a request points, or nothing if it points out of them. */
const sharedStyleAt = (pathname: string): string | null => {
  let asked: string;
  try {
    asked = resolve(SHARED_STYLES, `.${decodeURIComponent(pathname.slice("/styles".length))}`);
  } catch {
    return null;
  }
  return asked.startsWith(`${SHARED_STYLES}${sep}`) ? asked : null;
};

const sayUnavailable = (response: ServerResponse): void => {
  if (!response.writableEnded && !response.destroyed)
    response
      .writeHead(503, { "content-type": "text/plain; charset=utf-8" })
      .end("The stand is shutting down; this action was not run.");
};

/* --- the page ----------------------------------------------------------- */

const TABS: Readonly<Record<string, Tab>> = {
  "/": "catalogue",
  "/agent": "agent",
  "/orders": "orders",
};

const viewOf = (on: Exchange | null): ExchangeView | null =>
  on === null
    ? null
    : {
        itemId: on.itemId,
        title: on.title,
        beats: on.beats,
        challenge: on.challengeView,
        holdingChallenge: on.challenge !== null,
        orderId: on.orderId,
        waiting: on.waiting,
        closed: on.closed,
      };

const drawTab = (tab: Tab): string =>
  renderPage({
    tab,
    address: merchant.connected(),
    keyEnvironment,
    said,
    entries: feed.entries(),
    standing: {
      order: merchant.moods.order,
      quote: merchant.moods.quote,
      held: merchant.held.size,
    },
    cards,
    selling,
    cardDraft,
    publicItems,
    publicItemsRead,
    chosen,
    paramsDraft,
    exchange: viewOf(exchange),
    moods: merchant.moods,
    goodsDraft,
    held: [...merchant.held.values()],
    owed: [...merchant.taken.values()].map((one) => ({
      id: one.id,
      merchantItemId: one.merchant_item_id,
    })),
    receipts,
    receiptsRead,
  });

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

  if (request.method === "GET" && url.pathname === "/feed") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const closeFeed = (): void => {
      feedResponses.delete(response);
    };
    feedResponses.set(response, closeFeed);
    request.once("close", closeFeed);
    response.once("close", closeFeed);
    return;
  }

  if (request.method === "GET" && url.pathname === "/stand.css") {
    await sendFile(response, OWN_STYLESHEET);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/styles/")) {
    const asked = sharedStyleAt(url.pathname);
    if (asked === null) {
      notFound(response);
      return;
    }
    await sendFile(response, asked);
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
      response
        .writeHead(303, { location: TABS[url.pathname] === undefined ? "/" : url.pathname })
        .end();
    return;
  }

  const tab = request.method === "GET" ? TABS[url.pathname] : undefined;
  if (tab !== undefined) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(drawTab(tab));
    return;
  }

  notFound(response);
});

server.listen(port, "127.0.0.1", () => console.log(`Coinslot stand: http://127.0.0.1:${port}`));

const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  dropThisConnection();
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [response, closeFeed] of [...feedResponses]) {
    closeFeed();
    if (!response.writableEnded && !response.destroyed) response.end();
  }
  for (const response of postResponses) response.destroy();
  apiKey = null;
  keyEnvironment = null;
  cards = [];
  selling = null;
  await actionTail;
  await merchant.disconnect();
  await serverClosed;
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
