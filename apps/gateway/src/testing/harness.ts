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

import type { HandlerAnswer, Order, QuoteResponse } from "@coinslot/contracts";
import { ScriptedFacilitator } from "../adapters/memory/facilitator.js";
import { MemoryQueue } from "../adapters/memory/queue.js";
import { MemoryStore } from "../adapters/memory/store.js";
import { Gateway } from "../app/gateway.js";
import type { Runtime } from "../app/runtime.js";
import { type GatewayConfig, loadConfig } from "../config.js";
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
  const store = new MemoryStore(countedIds());
  const queue = new MemoryQueue();
  const facilitator = new ScriptedFacilitator();
  const ids = countedIds();

  // A clock that starts at a readable instant and only moves when a test says
  // so, so an order's deadlines are arithmetic a reader can check by eye.
  let now = Date.parse("2026-08-26T12:00:00.000Z");

  const runtime: Runtime = {
    config: testConfig(overrides),
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
  harnessed: Harness,
  behaviour: WorkerBehaviour,
  waitMs = 1_000,
): Promise<number> {
  const { envelopes } = await harnessed.gateway.poll(10, waitMs);

  for (const envelope of envelopes) {
    if (envelope.kind === "order" && behaviour.onOrder !== undefined) {
      const answer = await behaviour.onOrder(envelope.payload);
      await harnessed.gateway.answerOrder(envelope.payload.id, answer);
    }
    if (envelope.kind === "quote_request" && behaviour.onQuote !== undefined) {
      const answer = await behaviour.onQuote(envelope.payload);
      await harnessed.gateway.answerQuote(envelope.payload.price_id, answer);
    }
  }

  return envelopes.length;
}

/** Keeps a worker turning until `stop` is called, the way a subscription does. */
export function workUntilStopped(harnessed: Harness, behaviour: WorkerBehaviour) {
  let running = true;
  const loop = (async () => {
    while (running) {
      await workOnce(harnessed, behaviour, 50);
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}
