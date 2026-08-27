/**
 * A whole gateway on in-memory adapters, and a worker that behaves the way a
 * merchant's one does.
 *
 * This is test scaffolding and it is deliberately thin: it wires the real
 * flows to the real interpreter and the real order machine, and swaps only the
 * three things that would otherwise need a database, a queue server and a
 * payment network. What is being tested through it is the product, not this.
 *
 * The clock it hands out is the real one. Everything the flows do in memory is
 * microtasks, so nothing here waits for wall time unless a test asks it to; the
 * numbers a test passes in are what decide how long anything takes.
 */

import type { AddressInfo } from "node:net";
import type { HandlerAnswer, Order, QuoteResponse } from "@coinslot/contracts";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { ScriptedFacilitator } from "../adapters/memory/facilitator.js";
import { MemoryQueue } from "../adapters/memory/queue.js";
import { MemoryStore } from "../adapters/memory/store.js";
import { Gateway } from "../app/gateway.js";
import type { Runtime } from "../app/runtime.js";
import { type GatewayConfig, loadConfig } from "../config.js";
import { buildApp } from "../http/server.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "../http/x402.js";
import type { Ids } from "../ports/clock.js";

/** Identifiers a test can read: ord_1, item_1, env_3. */
export const countedIds = (): Ids => {
  const issued = new Map<string, number>();
  return (kind) => {
    const next = (issued.get(kind) ?? 0) + 1;
    issued.set(kind, next);
    return `${kind}_${next}`;
  };
};

export const testConfig = (overrides: Record<string, string> = {}): GatewayConfig =>
  loadConfig({
    DATABASE_URL: "postgres://coinslot@localhost:5432/coinslot",
    MERCHANT_API_KEY: "a-merchant-key-long-enough",
    ...overrides,
  });

export interface Harness {
  readonly gateway: Gateway;
  readonly runtime: Runtime;
  readonly store: MemoryStore;
  readonly queue: MemoryQueue;
  readonly facilitator: ScriptedFacilitator;
  readonly now: () => number;
  /** Moves the clock the flows read. Nothing fires from this on its own. */
  readonly advance: (ms: number) => void;
  stop(): Promise<void>;
}

export async function harness(overrides: Record<string, string> = {}): Promise<Harness> {
  // A clock that starts at a readable instant and only moves when a test says
  // so, so an order's deadlines are arithmetic a reader can check by eye. It is
  // declared first because everything that keeps time reads it — the store
  // stamps its claims on payments from here too, or a test that moves the clock
  // would move everything except the one thing it was moving it for.
  let now = Date.parse("2026-08-26T12:00:00.000Z");

  const config = testConfig(overrides);
  const store = new MemoryStore(countedIds(), () => now);
  // The queue's patience with a failing reminder comes from the configuration,
  // not from a default beside it — or a test that sets the number would be
  // asserting against something else entirely.
  const queue = new MemoryQueue({
    attempts: config.reminderAttempts,
    retryDelayMs: config.reminderRetryDelayMs,
  });
  const facilitator = new ScriptedFacilitator();
  const ids = countedIds();

  const runtime: Runtime = {
    config,
    store,
    queue,
    facilitator,
    clock: () => now,
    ids,
  };

  const gateway = new Gateway(runtime);
  await gateway.start();

  return {
    gateway,
    runtime,
    store,
    queue,
    facilitator,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    stop: () => gateway.stop(),
  };
}

/** What a merchant's handler does with one order. */
export type OrderHandler = (order: Order) => HandlerAnswer | Promise<HandlerAnswer>;
/** What a merchant's pricing does with one question. */
export type PriceHandler = (question: {
  readonly merchant_item_id: string;
  readonly price_id: string;
}) => QuoteResponse | Promise<QuoteResponse>;

export interface WorkerBehaviour {
  readonly onOrder?: OrderHandler;
  readonly onQuote?: PriceHandler;
}

/**
 * One turn of a merchant's worker: draw the stream, answer what came, come
 * back. It is written the way ADR-0004 says the SDK's loop is — the handler's
 * return value is posted to the answer route in every mode — so that a test
 * exercises the same path a merchant's code will.
 */
export async function workOnce(
  worked: Harness | { readonly gateway: Gateway },
  behaviour: WorkerBehaviour,
  waitMs = 1_000,
): Promise<number> {
  const { gateway } = worked;
  const { envelopes } = await gateway.poll(10, waitMs);

  for (const envelope of envelopes) {
    if (envelope.kind === "order" && behaviour.onOrder !== undefined) {
      const answer = await behaviour.onOrder(envelope.payload);
      await gateway.answerOrder(envelope.payload.id, answer);
    }
    if (envelope.kind === "quote_request" && behaviour.onQuote !== undefined) {
      const answer = await behaviour.onQuote(envelope.payload);
      await gateway.answerQuote(envelope.payload.price_id, answer);
    }
  }

  return envelopes.length;
}

/** Keeps a worker turning until `stop` is called, the way a subscription does. */
export function workUntilStopped(
  worked: Harness | { readonly gateway: Gateway },
  behaviour: WorkerBehaviour,
) {
  let running = true;
  const loop = (async () => {
    while (running) {
      await workOnce(worked, behaviour, 50);
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}

/**
 * One purchase over HTTP, from the challenge to whatever the order came to.
 *
 * It exists so that a test whose subject is not the payment exchange can get an
 * order into a state without transcribing the x402 headers. The cabinet's tests
 * are the case in point: they need a delivered sale to draw a screen from, and
 * a second copy of the header names over there is a second place for them to
 * drift from the ones the gateway actually sets.
 *
 * Everything it does is what an agent's client does — ask for the price, sign
 * against the challenge, present it — with a worker turning alongside so the
 * merchant's side answers.
 */
export async function buyOverHttp(
  worked: Harness,
  served: Served,
  itemId: string,
  behaviour: WorkerBehaviour,
): Promise<Call> {
  const priced = await served.call("POST", `/v0/items/${itemId}/purchase`, {
    body: { params: {} },
  });
  const requirements = decodePaymentRequiredHeader(
    priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
  ).accepts[0];
  if (requirements === undefined) {
    throw new Error(`no payment option was offered for ${itemId}`);
  }

  const worker = workUntilStopped(worked, behaviour);
  try {
    return await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
  } finally {
    await worker.stop();
  }
}

/** One call against a gateway actually listening on a port. */
export interface Call {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface Served {
  readonly url: string;
  call(
    method: string,
    path: string,
    options?: { readonly body?: unknown; readonly headers?: Record<string, string> },
  ): Promise<Call>;
  close(): Promise<void>;
}

/**
 * Puts the whole surface on a real port and calls it over real HTTP.
 *
 * Nothing is stubbed between the request and the flows: the mounting loop, the
 * body checks, the door and the payment exchange all run. A test that went
 * through a fake request object would be testing the fake.
 */
export async function serve(harnessed: Harness): Promise<Served> {
  const app = buildApp(harnessed.gateway);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    async call(method, path, options = {}) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        // Left as text: a test asserting on a non-JSON answer wants to see it.
      }
      return { status: response.status, headers: response.headers, body };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
