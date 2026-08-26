import type {
  HandlerAnswer,
  Order,
  OrderEvent,
  QuoteRequest,
  WorkerEnvelope,
} from "@coinslot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_RETRY_MS } from "./backoff.js";
import { createClient } from "./client.js";
import { contractVersion } from "./contract.js";
import { type FakeGateway, type GatewayAnswer, startFakeGateway } from "./testing/fake-gateway.js";
import {
  QUIET_POLL_FLOOR_MS,
  startWorker,
  systemClock,
  WORKER_PROBLEM_KINDS,
  type WorkerClock,
  type WorkerProblem,
} from "./worker.js";

const API_KEY = "merchant-key-for-the-tests";
const AT = "2026-08-26T10:20:00Z";

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: { amount: "5.00", currency: "USD", at: AT, as_of: AT },
  test: false,
};

const question: QuoteRequest = {
  merchant_item_id: "access-monthly",
  price_id: "price-1",
  purpose: "purchase",
  expires_at: "2026-08-26T10:25:00Z",
};

const event: OrderEvent = {
  type: "order.refund_due",
  order_id: "order-1",
  at: AT,
  price: { amount: "5.00", currency: "USD" },
  reason: "deadline_passed",
};

const envelopes = {
  order: { kind: "order", id: "env-1", sent_at: AT, payload: order },
  quote: { kind: "quote_request", id: "env-2", sent_at: AT, payload: question },
  event: { kind: "order_event", id: "env-3", sent_at: AT, payload: event },
} satisfies Record<string, WorkerEnvelope>;

const batch = (...carried: WorkerEnvelope[]): GatewayAnswer => ({
  body: { contract_version: contractVersion, envelopes: carried },
});

/**
 * A poll route that answers the scripted batches and then never answers at
 * all, which is what a gateway holding a long poll open looks like. Without
 * the parked ending, a loop whose sleeps a test has made instant would keep
 * asking for as long as the test ran.
 */
const polling = (...script: GatewayAnswer[]) => {
  const parked = new Promise<GatewayAnswer>(() => {});
  return (_call: unknown, index: number) => script[index] ?? parked;
};

/** A clock that records what it was asked to wait for and waits for none of it. */
const recordingClock = (): WorkerClock & { readonly waits: number[]; elapse(ms: number): void } => {
  const waits: number[] = [];
  let clock = 0;

  return {
    waits,
    elapse: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    random: () => 1,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
};

const waitUntil = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`waited for ${what} and it never happened`);
};

let gateway: FakeGateway | undefined;
let running: { stop(): Promise<void> } | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await gateway?.close();
  gateway = undefined;
});

interface Subscribed {
  readonly problems: WorkerProblem[];
  readonly events: OrderEvent[];
}

const workerOver = async (
  routes: Parameters<typeof startFakeGateway>[0]["routes"],
  handlers: {
    order?: (given: Order) => HandlerAnswer | Promise<HandlerAnswer>;
    quote?: Parameters<ReturnType<typeof createClient>["pricing"]["onQuote"]>[0];
  },
): Promise<Subscribed> => {
  gateway = await startFakeGateway({ apiKey: API_KEY, routes });

  const problems: WorkerProblem[] = [];
  const events: OrderEvent[] = [];
  const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

  if (handlers.order !== undefined) {
    running = coinslot.orders.subscribe(handlers.order, {
      onEvent: (arrived) => {
        events.push(arrived);
      },
      onProblem: (problem) => problems.push(problem),
    });
  }
  if (handlers.quote !== undefined) {
    running = coinslot.pricing.onQuote(handlers.quote);
  }

  return { problems, events };
};

describe("an order off the worker stream", () => {
  it("reaches the handler as an order, not as the envelope it travelled in", async () => {
    // The promise of ADR-0004 §5: the merchant's code never learns what the
    // transport is, so switching it later does not touch their handler.
    const seen: Order[] = [];

    await workerOver(
      {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
      {
        order: (given) => {
          seen.push(given);
          return { delivered: { access_url: "https://example.com/a" } };
        },
      },
    );

    await waitUntil(() => seen.length === 1, "the order to reach the handler");
    expect(seen[0]).toStrictEqual(order);
  });

  it.each([
    ["the goods", { delivered: { access_url: "https://example.com/a" } }],
    ["a refusal", { refused: { code: "out_of_stock", message: "Мест на тарифе нет" } }],
    ["an acceptance", { accepted: { eta_seconds: 60 } }],
  ])(
    "sends what the handler returned — %s — to the order's answer route",
    async (_what, answer) => {
      // The addendum to ADR-0004: the handler's return has an address of its
      // own, and the SDK posts it in every mode. Without it a synchronous
      // handler's answer reaches nobody.
      await workerOver(
        {
          poll_worker: polling(batch(envelopes.order)),
          answer_order: () => ({ body: { ok: true, result: "delivered" } }),
        },
        { order: () => answer as HandlerAnswer },
      );

      await waitUntil(() => (gateway?.callsTo("answer_order").length ?? 0) === 1, "the answer");

      const sent = gateway?.callsTo("answer_order")[0];
      expect(sent?.params).toStrictEqual({ order_id: order.id });
      expect(sent?.body).toStrictEqual(answer);
    },
  );

  it("answers nothing when the handler throws, and handles the redelivery", async () => {
    // A temporary failure is an exception, and an exception means the order
    // was not delivered: it comes back on the gateway's own timer, and the
    // handler runs again. A retry written on this side would be a second
    // opinion about how many times a merchant's code may run.
    let attempts = 0;

    await workerOver(
      {
        poll_worker: polling(batch(envelopes.order), batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
      {
        order: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("the supplier timed out");
          return { delivered: { access_url: "https://example.com/a" } };
        },
      },
    );

    await waitUntil(
      () => (gateway?.callsTo("answer_order").length ?? 0) === 1,
      "the second answer",
    );
    expect(attempts).toBe(2);
    expect(gateway?.callsTo("answer_order")).toHaveLength(1);
  });

  it("says so when the handler threw, naming the order", async () => {
    const { problems } = await workerOver(
      { poll_worker: polling(batch(envelopes.order)) },
      {
        order: () => {
          throw new Error("the supplier timed out");
        },
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.HANDLER_FAILED);
    expect(problems[0]?.subject).toBe(order.id);
    expect(problems[0]?.message).toMatch(/the supplier timed out/);
    expect(problems[0]?.fatal).toBe(false);
  });

  it("sends nothing when the handler answers with something the contract refuses", async () => {
    // "Not right now" is not one of the three answers, and sent as one it
    // would be read as something. Held back, the order is redelivered — which
    // is what a temporary failure means — and the merchant is told why.
    const { problems } = await workerOver(
      { poll_worker: polling(batch(envelopes.order)) },
      {
        order: () => ({ later: true }) as unknown as HandlerAnswer,
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED);
    expect(gateway?.callsTo("answer_order")).toHaveLength(0);
  });

  it("says so when the gateway would not take the answer", async () => {
    // An order that closed while the handler was working: the merchant needs
    // to know their delivery landed nowhere, because on their side it happened.
    const { problems } = await workerOver(
      {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({
          status: 409,
          body: {
            ok: false,
            error: { code: "order_already_closed", message: "it expired", retryable: false },
          },
        }),
      },
      { order: () => ({ delivered: { access_url: "https://example.com/a" } }) },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.ANSWER_REFUSED);
    expect(problems[0]?.message).toMatch(/order_already_closed/);
  });

  it("leaves an order unanswered when nobody subscribed, and says so", async () => {
    // A process that registered only a price handler still receives orders,
    // and swallowing them silently would look exactly like a gateway fault.
    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: polling(batch(envelopes.order)) },
    });

    const problems: WorkerProblem[] = [];
    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.NO_HANDLER);
    expect(gateway.callsTo("answer_order")).toHaveLength(0);
  });
});

describe("a price question off the same stream", () => {
  it("goes to the price handler and is answered against its own identifier", async () => {
    const seen: QuoteRequest[] = [];

    await workerOver(
      {
        poll_worker: polling(batch(envelopes.quote)),
        answer_quote: () => ({ body: { used: true } }),
      },
      {
        quote: (asked) => {
          seen.push(asked);
          return { available: true, price: { amount: "6.50", currency: "USD" }, as_of: AT };
        },
      },
    );

    await waitUntil(() => (gateway?.callsTo("answer_quote").length ?? 0) === 1, "the price answer");

    expect(seen[0]).toStrictEqual(question);
    expect(gateway?.callsTo("answer_quote")[0]?.params).toStrictEqual({ price_id: "price-1" });
    expect(gateway?.callsTo("answer_quote")[0]?.body).toStrictEqual({
      available: true,
      price: { amount: "6.50", currency: "USD" },
      as_of: AT,
    });
  });

  it("tells the merchant when their price arrived too late to be used", async () => {
    // A merchant who set stock aside against the question can release it, and
    // the acknowledgement is the only notice they get.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.quote)),
        answer_quote: () => ({ body: { used: false } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        quote: () => ({ available: false, as_of: AT }),
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.QUOTE_ANSWER_UNUSED);
    expect(problems[0]?.subject).toBe("price-1");
  });
});

describe("an event off the same stream", () => {
  it("is handed over and acknowledged with nothing", async () => {
    // An event notifies, it does not ask for work. A call back to the gateway
    // would be a fourth way of naming a message three surfaces already name.
    const { events } = await workerOver(
      { poll_worker: polling(batch(envelopes.event)) },
      {
        order: () => ({ delivered: { access_url: "https://example.com/a" } }),
      },
    );

    await waitUntil(() => events.length === 1, "the event to arrive");

    expect(events[0]).toStrictEqual(event);
    expect(gateway?.calls.filter((call) => call.route !== "poll_worker")).toStrictEqual([]);
  });
});

describe("a gateway speaking another dialect", () => {
  it("stops the worker and names both versions", async () => {
    // The difference between failing at startup and failing on somebody's
    // first order, where a divergence of dialects costs the buyer money.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: () => ({ body: { contract_version: "99", envelopes: [] } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
    );

    await waitUntil(() => problems.length > 0, "the mismatch to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH);
    expect(problems[0]?.fatal).toBe(true);
    expect(problems[0]?.message).toContain("99");
    expect(problems[0]?.message).toContain(contractVersion);

    const pollsWhenItStopped = gateway.callsTo("poll_worker").length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.callsTo("poll_worker")).toHaveLength(pollsWhenItStopped);
  });
});

describe("a gateway that is not answering", () => {
  it("waits longer after each failure in a row and starts over after a success", async () => {
    // The promise: an outage does not become a flood of requests, and the
    // worker comes back on its own when the gateway does.
    const clock = recordingClock();
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: (_call, index) =>
          index < 3
            ? { status: 502, text: "bad gateway" }
            : index === 3
              ? batch()
              : { status: 502, text: "bad gateway" },
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      clock,
    );

    await waitUntil(() => clock.waits.length >= 5, "five waits");
    await running.stop();

    expect(problems.every((problem) => problem.kind === WORKER_PROBLEM_KINDS.POLL_FAILED)).toBe(
      true,
    );
    expect(clock.waits.slice(0, 3)).toStrictEqual([
      FIRST_RETRY_MS,
      FIRST_RETRY_MS * 2,
      FIRST_RETRY_MS * 4,
    ]);
    // The fourth poll succeeded with an empty batch, so what follows is the
    // quiet floor and not a retry; the failure after it starts from the top.
    expect(clock.waits[3]).toBe(QUIET_POLL_FLOOR_MS);
    expect(clock.waits[4]).toBe(FIRST_RETRY_MS);
  });

  it("does not go on to the next poll until the wait is over", async () => {
    // The recording clock above asserts which delays are asked for; this one
    // asserts that the loop actually waits for them, which is the half a
    // recorded number cannot show.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      gateway = await startFakeGateway({
        apiKey: API_KEY,
        routes: { poll_worker: () => ({ status: 502, text: "bad gateway" }) },
      });

      running = startWorker(
        { apiKey: API_KEY, baseUrl: gateway.url },
        { problem: () => {} },
        {
          ...systemClock,
          random: () => 1,
        },
      );

      await vi.waitFor(() => expect(gateway?.callsTo("poll_worker").length).toBe(1));

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS - 1);
      expect(gateway.callsTo("poll_worker")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(gateway?.callsTo("poll_worker").length).toBe(2));
    } finally {
      await running?.stop();
      running = undefined;
      vi.useRealTimers();
    }
  });
});

describe("a quiet stream", () => {
  it("asks again at once when the gateway held the request, and paces itself when it did not", async () => {
    // The long poll is parked server-side, so a batch that took the window to
    // come back is followed by another poll immediately — that is what keeps a
    // waiting agent's price question free of polling lag. A gateway that
    // answers empty the instant it is asked is a gateway that is not holding
    // anything, and the floor is what keeps that from becoming a busy loop.
    const clock = recordingClock();

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: (_call, index) => {
          clock.elapse(index === 0 ? 0 : QUIET_POLL_FLOOR_MS * 25);
          return batch();
        },
      },
    });

    running = startWorker({ apiKey: API_KEY, baseUrl: gateway.url }, { problem: () => {} }, clock);

    await waitUntil(() => clock.waits.length >= 1, "the floor after the first empty batch");
    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) >= 3, "three polls");
    await running.stop();

    // One wait in total, after the batch that came back instantly. Had the
    // loop paced every quiet poll, three polls would have cost three waits.
    expect(clock.waits).toStrictEqual([QUIET_POLL_FLOOR_MS]);
  });
});

describe("stopping", () => {
  it("abandons the parked poll and asks for nothing more", async () => {
    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: polling() } });

    const worker = startWorker({ apiKey: API_KEY, baseUrl: gateway.url }, { problem: () => {} });

    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) === 1, "the first poll");
    await worker.stop();
    await worker.stop();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.callsTo("poll_worker")).toHaveLength(1);
  });
});

describe("registering twice", () => {
  it("refuses a second order handler rather than replacing the first in silence", async () => {
    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: polling() } });
    const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    running = coinslot.orders.subscribe(() => ({ accepted: {} }));

    expect(() => coinslot.orders.subscribe(() => ({ accepted: {} }))).toThrow(/twice/);
  });

  it("refuses a second price handler for the same reason", async () => {
    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: polling() } });
    const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    running = coinslot.pricing.onQuote(() => ({ available: false, as_of: AT }));

    expect(() => coinslot.pricing.onQuote(() => ({ available: false, as_of: AT }))).toThrow(
      /twice/,
    );
  });

  it("carries the orders and the prices of one process on one subscription", async () => {
    // The portal promises one subscription for all three kinds. Two loops
    // would mean two long polls open at once per merchant, and two places for
    // an envelope to be lost — so what is counted here is how many polls were
    // in flight together, not how many were made.
    const script = polling(batch(envelopes.order, envelopes.quote));
    let inFlight = 0;
    let mostAtOnce = 0;

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: async (call, index) => {
          inFlight += 1;
          mostAtOnce = Math.max(mostAtOnce, inFlight);
          try {
            return await script(call, index);
          } finally {
            inFlight -= 1;
          }
        },
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
        answer_quote: () => ({ body: { used: true } }),
      },
    });

    const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    running = coinslot.orders.subscribe(() => ({ delivered: { access_url: "https://a.example" } }));
    coinslot.pricing.onQuote(() => ({ available: false, as_of: AT }));

    await waitUntil(
      () =>
        (gateway?.callsTo("answer_order").length ?? 0) === 1 &&
        (gateway?.callsTo("answer_quote").length ?? 0) === 1,
      "both answers",
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mostAtOnce).toBe(1);
  });
});
