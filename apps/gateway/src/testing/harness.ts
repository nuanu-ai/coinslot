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
import type { PaymentPayload } from "@x402/core/types";
import { ScriptedFacilitator } from "../adapters/memory/facilitator.js";
import { MemoryQueue } from "../adapters/memory/queue.js";
import { MemoryStore } from "../adapters/memory/store.js";
import { Gateway } from "../app/gateway.js";
import { issueKey, keyDigest, makeMerchant } from "../app/merchants.js";
import type { Runtime } from "../app/runtime.js";
import { type GatewayConfig, loadConfig } from "../config.js";
import { buildApp } from "../http/server.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PaymentEdge,
  paymentFingerprint,
  X402_VERSION,
} from "../http/x402.js";
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
    ...overrides,
  });

/** A merchant the harness made, with one key of theirs, readable once here. */
export interface SeededMerchant {
  readonly id: string;
  readonly name: string;
  /** The secret itself. Only a test ever holds one of these. */
  readonly key: string;
  /** The row the key is, so a test can disable it. */
  readonly keyId: string;
}

export interface Harness {
  readonly gateway: Gateway;
  readonly runtime: Runtime;
  readonly store: MemoryStore;
  readonly queue: MemoryQueue;
  readonly facilitator: ScriptedFacilitator;
  readonly now: () => number;
  /** Moves the clock the flows read. Nothing fires from this on its own. */
  readonly advance: (ms: number) => void;
  /**
   * A merchant with one key, made the way the command-line verb makes one.
   *
   * Every test that is about scoping seeds two of these, because one proves
   * nothing: an unscoped gateway passes every assertion a single merchant can
   * make about their own cards.
   */
  readonly addMerchant: (name?: string) => Promise<SeededMerchant>;
  /** A second key for a merchant who already has one. The secret, once. */
  readonly addKey: (merchantId: string, label?: string) => Promise<string>;
  /** Stops one key working, touching no other. */
  readonly disableKey: (keyId: string) => Promise<void>;
  /**
   * The merchant a test gets without asking for one.
   *
   * Almost every test here is about something else — a deadline, a refusal, the
   * shape of a receipt — and has a merchant only because a sale needs one. So
   * the harness seeds one, and those tests read the way they did before
   * merchants existed. The tests that are about tenancy ignore this one and
   * seed two of their own.
   */
  readonly merchant: SeededMerchant;
  stop(): Promise<void>;
}

/** The key the merchant every ordinary test sells as opens the door with. */
export const THE_MERCHANT_KEY = "a-merchant-key-long-enough";

export async function harness(overrides: Record<string, string> = {}): Promise<Harness> {
  // A clock that starts at a readable instant and only moves when a test says
  // so, so an order's deadlines are arithmetic a reader can check by eye. It is
  // declared first because everything that keeps time reads it — the store
  // stamps its claims on payments from here too, or a test that moves the clock
  // would move everything except the one thing it was moving it for.
  let now = Date.parse("2026-08-26T12:00:00.000Z");

  const config = testConfig(overrides);
  // The queue's patience with a failing reminder comes from the configuration,
  // not from a default beside it — or a test that sets the number would be
  // asserting against something else entirely.
  const queue = new MemoryQueue({
    attempts: config.reminderAttempts,
    retryDelayMs: config.reminderRetryDelayMs,
  });
  // The queue is made first because the store writes through it: an envelope
  // that must not be lost is written where the order is (ADR-0013). It is
  // `stage` rather than `publish` because the store needs the two halves apart
  // — take it before the order is written, make it visible after — and the call
  // is made through the queue rather than bound to its method, so a test that
  // replaces `queue.stage` replaces the one the store uses too.
  const store = new MemoryStore(
    countedIds(),
    () => now,
    (merchantId, envelope, afterMs) => queue.stage(merchantId, envelope, afterMs),
  );
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

  // Made through the same two functions the command-line verb and the sandbox
  // seed use, so a key that works here is a key that works there: a second way
  // of turning a secret into a digest would be a key that opens one door and
  // not the other, and the failure would look like a wrong key rather than like
  // two hashes.
  const seed = async (name: string, secret?: string): Promise<SeededMerchant> => {
    const made = await makeMerchant(store, ids, name, now);
    if (made === null) {
      throw new Error(`the harness could not make the merchant ${name}`);
    }
    const issued =
      secret === undefined
        ? await issueKey(store, ids, made.id, "the harness", now)
        : await addKnownKey(store, ids, made.id, secret, now);
    return { id: made.id, name: made.name, key: issued.secret, keyId: issued.key.id };
  };

  const merchant = await seed("The merchant", THE_MERCHANT_KEY);

  return {
    gateway,
    runtime,
    store,
    queue,
    facilitator,
    merchant,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    addMerchant: (name = `Merchant ${countedName()}`) => seed(name),
    addKey: async (merchantId, label = "another of the harness's") =>
      (await issueKey(store, ids, merchantId, label, now)).secret,
    disableKey: async (keyId) => {
      const disabled = await store.disableKey(keyId, now);
      if (disabled === null) {
        throw new Error(`the harness was asked to disable ${keyId}, and there is no such key`);
      }
    },
    stop: () => gateway.stop(),
  };
}

/**
 * A key whose secret the caller chose, which is the one thing `issueKey` will
 * not do.
 *
 * It has one caller, and it is here rather than in `merchants.ts` for that
 * reason: the harness's own merchant, whose key a test writes into a header by
 * hand. Everywhere a merchant is real the secret is generated, because a key
 * somebody chooses is a key somebody reuses; the sandbox's key is the other
 * chosen one, and `seedSandboxKey` writes that one itself.
 */
async function addKnownKey(
  store: MemoryStore,
  ids: Ids,
  merchantId: string,
  secret: string,
  at: number,
): Promise<{ key: { id: string }; secret: string }> {
  const key = await store.addKey(
    { id: ids("mk"), merchantId, label: "the harness's known key", digest: keyDigest(secret) },
    at,
  );
  return { key, secret };
}

/** A, B, C… so two merchants in one test are told apart at a glance. */
const countedName = (() => {
  let issued = 0;
  return () => {
    issued += 1;
    return String.fromCharCode(65 + ((issued - 1) % 26));
  };
})();

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
  /**
   * Whose worker this is. Left out, it is the harness's own merchant, which is
   * what every test that is about something other than tenancy wants; a test
   * with two merchants says which one each worker belongs to, because that is
   * the whole thing being checked.
   */
  readonly merchantId?: string;
}

/** A gateway to work against, and the merchant a worker belongs to by default. */
export type Worked = Harness | { readonly gateway: Gateway; readonly merchant: SeededMerchant };

/**
 * One turn of a merchant's worker: draw the stream, answer what came, come
 * back. It is written the way ADR-0004 says the SDK's loop is — the handler's
 * return value is posted to the answer route in every mode — so that a test
 * exercises the same path a merchant's code will.
 *
 * Every call it makes names the merchant, exactly as the routes behind them do
 * once a key has been resolved: a worker draws its own merchant's stream and
 * answers its own merchant's orders, and neither is a filter over somebody
 * else's.
 */
export async function workOnce(
  worked: Worked,
  behaviour: WorkerBehaviour,
  waitMs = 1_000,
): Promise<number> {
  const { gateway } = worked;
  const merchantId = behaviour.merchantId ?? worked.merchant.id;
  const { envelopes } = await gateway.poll(merchantId, 10, waitMs);

  for (const envelope of envelopes) {
    if (envelope.kind === "order" && behaviour.onOrder !== undefined) {
      const answer = await behaviour.onOrder(envelope.payload);
      await gateway.answerOrder(merchantId, envelope.payload.id, answer);
    }
    if (envelope.kind === "quote_request" && behaviour.onQuote !== undefined) {
      const answer = await behaviour.onQuote(envelope.payload);
      await gateway.answerQuote(merchantId, envelope.payload.price_id, answer);
    }
  }

  return envelopes.length;
}

/** Keeps a worker turning until `stop` is called, the way a subscription does. */
export function workUntilStopped(worked: Worked, behaviour: WorkerBehaviour) {
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
 *
 * The worker is started before the first call and not between the two, because
 * the first call is where a card with a price check asks its merchant what the
 * product costs. Started afterwards, that question would go to nobody and the
 * purchase would sit out the gateway's whole patience before pricing itself
 * from the card.
 */
export async function buyOverHttp(
  worked: Worked,
  served: Served,
  itemId: string,
  behaviour: WorkerBehaviour,
): Promise<Call> {
  const worker = workUntilStopped(worked, behaviour);
  try {
    const priced = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
    });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) {
      throw new Error(`no payment option was offered for ${itemId}`);
    }

    return await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: aFreshSignature() },
        }),
      },
    });
  } finally {
    await worker.stop();
  }
}

/**
 * A signature no other purchase has presented.
 *
 * One authorisation buys one order, and the gateway means it: the fingerprint
 * of what was signed is claimed by the first order to present it, and the same
 * string presented for a second order is refused before anything is verified.
 * Two purchases in one test are two buyers, so they sign two different things —
 * a shared constant here would have the second sale refused as a replay, which
 * is the gateway being right and the fixture being wrong.
 */
const aFreshSignature = (() => {
  let signed = 0;
  return () => {
    signed += 1;
    return `0xsigned${signed}`;
  };
})();

/**
 * One wallet's authorisation, as it arrives on the wire, together with the
 * fingerprint the purchase route takes of it.
 *
 * A test about whose purchase an order is cannot spell a payment however it
 * likes. What the payment layer answers with is the address that actually
 * signed, and it reads that address out of the payment — so a payment here is a
 * real header, written by the protocol's own encoder, carrying the signer where
 * the exact-EVM scheme puts one. Two authorisations from one wallet differ in
 * their nonce, and so in their fingerprint, while agreeing on their payer: that
 * is what a repeat is, and it is the one thing about a payment these tests
 * cannot invent a shorthand for.
 *
 * The offer inside names no order and is priced at nothing, and that is not an
 * oversight. Every caller drives the flows with the order already in hand, and
 * nothing on that path reads the agent's own copy of what it was asked to pay;
 * the route that does read it is exercised over HTTP, against a challenge this
 * gateway issued itself. It is still built by the edge rather than written out
 * here, so a payment from this helper is shaped the way a real one is even
 * where its contents say nothing.
 */
export function authorisation(
  worked: { readonly runtime: Runtime },
  wallet: string,
  nonce: string,
): { readonly payment: string; readonly fingerprint: string } {
  const { config } = worked.runtime;
  // An address to be paid at, where the harness was given none: an offer has to
  // name one, and nowhere is the honest answer for an offer nobody reads.
  const edge = new PaymentEdge(
    { ...config.payment, payTo: config.payment.payTo ?? NOWHERE },
    config.publicBaseUrl,
    config.payment.timeoutSeconds,
  );
  const signed: PaymentPayload = {
    x402Version: X402_VERSION,
    accepted: edge.requirementsFor({ amount: "0.00", currency: "USD" }, null),
    payload: {
      signature: aFreshSignature(),
      authorization: { from: wallet, to: NOWHERE, nonce },
    },
  };

  return {
    payment: encodePaymentSignatureHeader(signed),
    fingerprint: paymentFingerprint(signed, edge.token()),
  };
}

/** The zero address: an offer made out to nobody, in a payment nobody checks. */
const NOWHERE = "0x0000000000000000000000000000000000000000";

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
export async function serve(harnessed: { readonly gateway: Gateway }): Promise<Served> {
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
