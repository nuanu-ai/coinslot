import type {
  HandlerAnswer,
  Order,
  OrderEvent,
  QuoteRequest,
  WorkerEnvelope,
} from "@coinslot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_RETRY_MS } from "./backoff.js";
import { createClient, type QuoteHandler } from "./client.js";
import { contractVersion } from "./contract.js";
import { type FakeGateway, type GatewayAnswer, startFakeGateway } from "./testing/fake-gateway.js";
import {
  POLL_WAIT_SECONDS,
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
    quote?: QuoteHandler;
  },
): Promise<Subscribed> => {
  gateway = await startFakeGateway({ apiKey: API_KEY, routes });

  const problems: WorkerProblem[] = [];
  const events: OrderEvent[] = [];
  const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

  const answering = handlers.order;

  if (answering !== undefined) {
    coinslot.on("order", (arrived) => answering(arrived));
    coinslot.on("event", (arrived) => {
      events.push(arrived);
    });
  }
  if (handlers.quote !== undefined) {
    coinslot.on("quote", handlers.quote);
  }

  coinslot.on("problem", (problem) => problems.push(problem));
  running = coinslot;
  await coinslot.start();

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

    // The order as the contract writes it, field for field. What the handler
    // is actually given carries the calls that close it too, so the comparison
    // is against the fields rather than against the whole object.
    const { id, merchant_item_id, params, price, test } = seen[0] as Order;

    expect({ id, merchant_item_id, params, price, test }).toStrictEqual(order);
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

    // The question as the contract writes it; what the handler is given also
    // carries the two answers it can be given, so the fields are compared.
    const { merchant_item_id, price_id, purpose, expires_at } = seen[0] as QuoteRequest;

    expect({ merchant_item_id, price_id, purpose, expires_at }).toStrictEqual(question);
    expect(gateway?.callsTo("answer_quote")[0]?.params).toStrictEqual({ price_id: "price-1" });
    expect(gateway?.callsTo("answer_quote")[0]?.body).toStrictEqual({
      available: true,
      price: { amount: "6.50", currency: "USD" },
      as_of: AT,
    });
  });

  it("holds the price handler's answer to the contract before sending it", async () => {
    // The same treatment the order handler's answer gets, and for the same
    // reason. An amount written as a number rather than as text is the easiest
    // mistake to make here; sent out, it comes back as the gateway complaining
    // about a document, which reads as our fault and buries the merchant's own
    // field inside a quoted blob.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.quote)),
        answer_quote: () => ({ body: { used: true } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        quote: () =>
          ({ available: true, price: { amount: 6.5, currency: "USD" }, as_of: AT }) as never,
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED);
    expect(problems[0]?.subject).toBe("price-1");
    expect(problems[0]?.message).toMatch(/price\.amount/);
    expect(gateway.callsTo("answer_quote")).toHaveLength(0);
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
  it("arrives with the identity of the message it travelled in", async () => {
    // An order is answered against its own identifier and a price question
    // against its price_id, so a repeat of either is harmless by
    // construction. An event has neither, and the contract gives every
    // envelope an identifier and a delivery time precisely so that a repeat
    // can be recognised. Withheld, the merchant has no way to recognise one.
    const delivered: { id: string; sent_at: string }[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: polling(batch(envelopes.event)) },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        event: (_arrived, identity) => {
          delivered.push(identity);
        },
        problem: () => {},
      },
    );

    await waitUntil(() => delivered.length === 1, "the event to arrive");
    expect(delivered[0]).toStrictEqual({
      id: envelopes.event.id,
      sent_at: envelopes.event.sent_at,
    });
  });

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

  it("passes on the version it saw in an answer it could not read, and keeps going", async () => {
    // A gateway of another version answers with a document this SDK refuses,
    // so the version it names is worth telling the merchant — and it is the
    // one thing here that was never held to a schema of ours. Acted on as a
    // verdict, a proxy's error envelope with a field of that name would stop
    // a merchant's worker for good over something that needed waiting out. So
    // it is a remark inside a retryable problem and nothing more.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: () => ({
          status: 503,
          text: JSON.stringify({ contract_version: "99", error: "no worker here" }),
        }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      recordingClock(),
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.POLL_FAILED);
    expect(problems[0]?.fatal).toBe(false);
    expect(problems[0]?.message).toContain("99");
    expect(problems[0]?.message).toContain("may mean");

    // And it went on asking, which is the half that matters.
    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) >= 3, "further polls");
  });

  it.each([
    ["a proxy's own page", { status: 502, text: "<html>bad gateway</html>" }],
    ["an error envelope somebody added", { text: JSON.stringify({ error: "no such worker" }) }],
    ["a version that is not a word", { text: JSON.stringify({ contract_version: 99 }) }],
  ])("still blames the transport for %s", async (_what, answer) => {
    // The other half of the same rule, and the more dangerous half. A proxy's
    // page, an error envelope, a field of the wrong type — none of them is a
    // dialect, and a worker stopped for good on one of those is a merchant
    // taken off the air by something that only needed waiting out.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: () => answer } });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      recordingClock(),
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.POLL_FAILED);
    expect(problems[0]?.fatal).toBe(false);
  });

  it("keeps the merchant's handlers and reporter when a loop is started again", async () => {
    // The loop ended and the client did not. Everything the merchant
    // registered is still registered, so starting again is one line and not a
    // rebuild — and a client that quietly dropped the order handler or the
    // reporter on the way would look exactly the same until an order arrived.
    const problems: WorkerProblem[] = [];
    const orders: string[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: (_call, index) =>
          index === 0
            ? { body: { contract_version: "99", envelopes: [] } }
            : batch(envelopes.order),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
    });

    const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    coinslot.on("order", (arrived) => {
      orders.push(arrived.id);
      return arrived.delivered({ access_url: "https://a.example" });
    });
    coinslot.on("problem", (problem) => problems.push(problem));

    await coinslot.start();

    await waitUntil(() => problems.length === 1, "the mismatch that ends the first loop");
    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH);

    // The loop died of its own accord, so nothing has to be stopped first.
    running = coinslot;
    await coinslot.start();

    await waitUntil(() => orders.length > 0, "the order handler to keep receiving");
    expect(orders[0]).toBe(order.id);

    // And stopping still stops what is running: after it, no further order
    // reaches the handler. Counting polls instead would count a request the
    // gateway records a moment after the caller has gone, which says nothing
    // about whether the loop is still working.
    await coinslot.stop();

    const deliveredWhenItStopped = orders.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(orders).toHaveLength(deliveredWhenItStopped);
  });

  it("meets a gateway of another dialect again rather than pretending to run", async () => {
    // A process whose loop died on a mismatch and which starts again. What it
    // must not get is a client that reports "started" over nothing: the reason
    // the first loop ended has not gone away, and hearing about it a second
    // time is the answer the merchant can act on.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: () => ({ body: { contract_version: "99", envelopes: [] } }) },
    });

    const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    coinslot.on("order", (arrived) => arrived.accepted());
    coinslot.on("problem", (problem) => problems.push(problem));
    running = coinslot;

    await coinslot.start();
    await waitUntil(() => problems.length === 1, "the first mismatch");

    await coinslot.start();
    await waitUntil(() => problems.length === 2, "a loop that ran again and reported");

    expect(problems[1]?.kind).toBe(WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH);
    expect(gateway.callsTo("poll_worker").length).toBeGreaterThanOrEqual(2);
  });
});

describe("a poll that goes quiet", () => {
  it("is given up on, rather than waited for as long as the runtime allows", async () => {
    // A connection dropped silently by something in the middle — a load
    // balancer that recycled it, a firewall that forgot it — leaves this side
    // waiting on an answer that will never come. Without a deadline of the
    // SDK's own, what eventually breaks that is whatever the runtime happens
    // to default to, which is a number nobody here chose and is measured in
    // minutes against a window measured in seconds.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: polling() } });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      recordingClock(),
      30,
    );

    await waitUntil(() => problems.length > 0, "the poll to be given up on");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.POLL_FAILED);
    expect(problems[0]?.fatal).toBe(false);

    // And it goes on asking, which is the point of giving up on one.
    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) >= 2, "a further poll");
  });
});

describe("what the worker asks of a poll", () => {
  it("names the wait window the decision gave it", async () => {
    // ADR-0004 §1 says the worker asks for a window of about twenty-five
    // seconds. Asking for nothing would leave the field the contract argues
    // over with no sender, and a gateway that wanted to answer sooner with no
    // way to see what we expected.
    gateway = await startFakeGateway({ apiKey: API_KEY, routes: { poll_worker: polling() } });

    running = startWorker({ apiKey: API_KEY, baseUrl: gateway.url }, { problem: () => {} });

    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) === 1, "the first poll");

    // The literal, not the constant the sender used: comparing a value
    // against the same constant that produced it is an assertion that cannot
    // fail, and the number is what the decision names.
    expect(gateway.callsTo("poll_worker")[0]?.body).toStrictEqual({ wait_seconds: 25 });
    expect(POLL_WAIT_SECONDS).toBe(25);
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
    // recorded number cannot show. The wait is a promise this test resolves,
    // so what is being observed is the loop's own ordering and not how fast
    // the machine happened to be.
    let waitIsOver: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      waitIsOver = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: () => ({ status: 502, text: "bad gateway" }) },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: () => {} },
      {
        now: () => 0,
        random: () => 1,
        sleep: () => waiting,
      },
    );

    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) === 1, "the first poll");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.callsTo("poll_worker")).toHaveLength(1);

    waitIsOver?.();
    await waitUntil(() => (gateway?.callsTo("poll_worker").length ?? 0) >= 2, "the second poll");
  });
});

describe("the clock the worker runs on by default", () => {
  it("waits the whole time it was given, and gives up the moment it is stopped", async () => {
    // The seam the tests above replace, tested once on its own so that
    // replacing it elsewhere does not mean the real one is never exercised.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      const controller = new AbortController();
      let over = false;

      void systemClock.sleep(FIRST_RETRY_MS, controller.signal).then(() => {
        over = true;
      });

      await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS - 1);
      expect(over).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(over).toBe(true);

      // Stopping cuts a wait short, which is what makes a parked worker shut
      // down at once instead of half a minute later.
      let cutShort = false;
      const second = new AbortController();

      void systemClock.sleep(FIRST_RETRY_MS, second.signal).then(() => {
        cutShort = true;
      });

      second.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(cutShort).toBe(true);

      // And a wait asked for after the stop does not happen at all.
      let afterwards = false;

      void systemClock.sleep(FIRST_RETRY_MS, second.signal).then(() => {
        afterwards = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(afterwards).toBe(true);
    } finally {
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

describe("an answer that could not be delivered", () => {
  it("promises the redelivery only where nothing was handed over", async () => {
    // The one positive claim in this design. An answer refused a connection
    // certainly left the order unanswered, so it comes back — and a merchant
    // is entitled to that sentence, because it is the difference between
    // waiting and reconciling by hand.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: polling(batch(envelopes.order)) },
    });

    const closing = gateway;

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        order: async () => {
          // The gateway goes away between the order arriving and the answer
          // being sent, so the answer is refused a connection outright.
          await closing.close();
          return { delivered: { access_url: "https://a.example" } };
        },
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(() => problems.length > 0, "the problem to be reported");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.ANSWER_FAILED);
    expect(problems[0]?.message).toMatch(/the order will be delivered again/);
    expect(problems[0]?.message).toMatch(/did not reach us/);

    await running.stop();
    running = undefined;
    gateway = undefined;
  });
});

describe("a delivery carrying the field this contract removes", () => {
  it("tells the merchant it will not reach the agent", async () => {
    // The one silent loss the contract documents, and this is the place it
    // named as where the loss would actually cost something. Removed before
    // any check runs, the field goes out of the merchant's handler and does
    // not arrive, and without this nobody is told.
    const problems: WorkerProblem[] = [];

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
    });

    running = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        order: () => ({
          delivered: JSON.parse('{"access_url": "https://a.example", "__proto__": "gone"}'),
        }),
        problem: (problem) => problems.push(problem),
      },
    );

    await waitUntil(() => (gateway?.callsTo("answer_order").length ?? 0) === 1, "the answer");

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.DELIVERY_FIELD_DROPPED);
    expect(problems[0]?.subject).toBe(order.id);
    expect(gateway.callsTo("answer_order")[0]?.body).toStrictEqual({
      delivered: { access_url: "https://a.example" },
    });
  });
});

describe("a merchant who passed no reporter at all", () => {
  it("is given the exception as well as the sentence", async () => {
    // The console is the only channel such a merchant has, and it is the one
    // every merchant following the documentation is on, because no page
    // mentions onProblem. The sentence already carries what the exception
    // says; what it cannot carry is the stack, which is the whole of what
    // somebody debugging their own handler is looking for.
    const written: unknown[][] = [];
    const console_error = console.error;

    console.error = (...given: unknown[]): void => {
      written.push(given);
    };

    try {
      gateway = await startFakeGateway({
        apiKey: API_KEY,
        routes: { poll_worker: polling(batch(envelopes.order)) },
      });

      const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });
      const thrown = new Error("the supplier timed out");

      coinslot.on("order", () => {
        throw thrown;
      });
      running = coinslot;
      await coinslot.start();

      await waitUntil(() => written.length > 0, "the problem to reach the console");

      expect(String(written[0]?.[0])).toMatch(/handler_failed/);
      expect(written[0]?.[1]).toBe(thrown);
    } finally {
      console.error = console_error;
    }
  });
});

describe("a reporter that itself fails", () => {
  it("does not take the worker, or the merchant's process, down with it", async () => {
    // The reporter is the merchant's code — a logger over a stream that
    // closed during shutdown, a client that was never configured. An
    // exception out of it would otherwise unwind the loop and escape as an
    // unhandled rejection, which under Node's default ends their process, so
    // this listens for exactly that rather than taking the loop's survival as
    // evidence of it.
    const escaped: unknown[] = [];
    const catchIt = (reason: unknown): void => {
      escaped.push(reason);
    };

    process.on("unhandledRejection", catchIt);

    try {
      gateway = await startFakeGateway({
        apiKey: API_KEY,
        routes: { poll_worker: polling(batch(envelopes.order), batch(envelopes.order)) },
      });

      let reported = 0;
      const worker = startWorker(
        { apiKey: API_KEY, baseUrl: gateway.url },
        {
          problem: () => {
            reported += 1;
            throw new Error("the merchant's logger was not configured");
          },
        },
      );

      await waitUntil(() => reported >= 2, "the worker to keep going past a failing reporter");
      await expect(worker.stop()).resolves.toBeUndefined();

      // Rejections are reported at the end of a turn, so give the loop one.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(escaped).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", catchIt);
    }
  });
});

describe("the loop failing in a way nothing in it anticipated", () => {
  it("hands the merchant the defect instead of ending in silence", async () => {
    // The channel that fires once everything else has already failed. Every
    // way the loop expects to go wrong has its own kind and its own place to
    // be caught: a poll that did not reach us, a handler that threw, an answer
    // the gateway would not take. Arriving here means none of those applied,
    // so the SDK has a defect and the merchant's worker is down until their
    // process is restarted — and that is the one problem a merchant cannot
    // learn about by waiting, because a loop that has stopped reports nothing
    // more. Unreported, the merchant hears about it from a buyer.
    //
    // A defect cannot be staged from outside the package, so it is injected at
    // the seam the loop already has for tests: the clock. This one answers the
    // first question and fails the second, which puts the failure after a
    // complete healthy poll rather than before the worker has done anything.
    const problems: WorkerProblem[] = [];
    const broken = new Error("the clock stopped");
    let asked = 0;

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: { poll_worker: polling(batch()) },
    });

    const worker = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      { problem: (problem) => problems.push(problem) },
      {
        ...recordingClock(),
        now: () => {
          asked += 1;
          if (asked > 1) throw broken;
          return 0;
        },
      },
    );

    await waitUntil(() => problems.length > 0, "the worker to report its own failure");

    const failed = problems.find((problem) => problem.kind === WORKER_PROBLEM_KINDS.WORKER_FAILED);

    // Fatal, because it is: nothing restarts the loop from here.
    expect(failed?.fatal).toBe(true);
    // The exception itself travels with it. The sentence says where the fault
    // lies and the cause is what a merchant sends us to have it fixed.
    expect(failed?.cause).toBe(broken);
    expect(failed?.message).toMatch(/defect in the Coinslot SDK/);
    expect(failed?.message).toContain(String(broken));
    // Not filed as a poll that failed, which is the kind a merchant waits out.
    expect(problems.map((problem) => problem.kind)).not.toContain(WORKER_PROBLEM_KINDS.POLL_FAILED);
    // It had been working: one poll went out and came back before this.
    expect(gateway.callsTo("poll_worker")).toHaveLength(1);
    // And `running()` agrees, so a process supervising its worker sees it is
    // down without waiting for a problem that will never come.
    await waitUntil(() => !worker.running(), "the loop to be over");
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});

describe("stopping", () => {
  it("says so when an answer the handler produced did not get through", async () => {
    // The handler has already run: goods may have been issued. Redelivery
    // makes the system right and leaves the merchant uninformed, and a
    // merchant reconciling a shutdown is owed the fact that an answer for
    // this order went nowhere.
    const problems: WorkerProblem[] = [];
    let answering: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      answering = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => {
          answering?.();
          return new Promise<never>(() => {});
        },
      },
    });

    const worker = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        order: () => ({ delivered: { access_url: "https://a.example" } }),
        problem: (problem) => problems.push(problem),
      },
    );

    await held;
    await worker.stop();

    expect(problems.map((problem) => problem.kind)).toContain(WORKER_PROBLEM_KINDS.ANSWER_FAILED);
    expect(problems[0]?.subject).toBe(order.id);
    // The answer was sent and then abandoned, so whether the gateway has it is
    // not something this side knows. Promising a redelivery here would have a
    // merchant waiting for an order that may already be closed.
    expect(problems[0]?.message).toMatch(/not known here/);
    expect(problems[0]?.message).not.toMatch(/will be delivered again/);
  });

  it("says how much of a batch it left unread", async () => {
    // Orders and price questions come back on their own; an event does not,
    // because nothing here can ask for one again. Either way a merchant who
    // stopped mid-batch should not have to guess what went unread.
    const problems: WorkerProblem[] = [];
    let handling: (() => void) | undefined;
    const inTheHandler = new Promise<void>((resolve) => {
      handling = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order, envelopes.quote, envelopes.event)),
        // Held open, so the loop is certainly still inside the first envelope
        // when the worker is stopped. Left to finish, whether the second
        // envelope had been reached would depend on how fast the machine was.
        answer_order: () => {
          handling?.();
          return new Promise<never>(() => {});
        },
      },
    });

    const worker = startWorker(
      { apiKey: API_KEY, baseUrl: gateway.url },
      {
        order: () => ({ delivered: { access_url: "https://a.example" } }),
        problem: (problem) => problems.push(problem),
      },
    );

    await inTheHandler;
    await worker.stop();

    const abandoned = problems.find(
      (problem) => problem.kind === WORKER_PROBLEM_KINDS.BATCH_ABANDONED,
    );

    expect(abandoned?.message).toMatch(/2 of this batch's 3/);
    expect(abandoned?.message).toMatch(/quote_request, order_event/);
  });

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

describe("shutting down a subscription the merchant built", () => {
  it("sends the last problems to the reporter that subscription was given", async () => {
    // The layer the worker's own tests cannot see. Everything the loop reports
    // while it is stopping — an answer that did not get through, a batch it
    // left unread — is reported through whatever reporter is registered at
    // that moment. Torn down before the loop has finished, that is the console,
    // and the merchant who asked to hear about it hears nothing at all.
    const problems: WorkerProblem[] = [];
    let answering: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      answering = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order, envelopes.quote)),
        answer_order: () => {
          answering?.();
          return new Promise<never>(() => {});
        },
      },
    });

    const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    coinslot.on("order", (arrived) => arrived.delivered({ access_url: "https://a.example" }));
    coinslot.on("problem", (problem) => problems.push(problem));
    await coinslot.start();

    await held;
    await coinslot.stop();

    const kinds = problems.map((problem) => problem.kind);

    expect(kinds).toContain(WORKER_PROBLEM_KINDS.ANSWER_FAILED);
    expect(kinds).toContain(WORKER_PROBLEM_KINDS.BATCH_ABANDONED);
  });

  it("waits for the loop however many callers ask it to stop", async () => {
    // A shutdown routine and a signal handler both calling stop() is ordinary.
    // A second caller that returned at once would let the process exit with a
    // delivery still in flight.
    let inTheHandler: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      inTheHandler = resolve;
    });
    let handlerFinished = false;
    let releaseHandler: (() => void) | undefined;
    const handlerMayFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
    });

    const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    coinslot.on("order", async (arrived) => {
      inTheHandler?.();
      await handlerMayFinish;
      // A turn of the event loop between being released and being done, so
      // that a stop() which returned without waiting would be observed
      // returning early rather than being saved by the order microtasks
      // happen to run in.
      await new Promise((resolve) => setTimeout(resolve, 0));
      handlerFinished = true;
      return arrived.delivered({ access_url: "https://a.example" });
    });
    await coinslot.start();

    await reached;

    const first = coinslot.stop();
    const second = coinslot.stop();

    releaseHandler?.();

    // The second caller is awaited on its own: waiting for both would pass
    // even if this one had returned at once, which is the failure being
    // looked for.
    await second;
    expect(handlerFinished).toBe(true);
    await first;
  });

  it("refuses to start again while a stop is still in flight", async () => {
    // Two loops for one merchant would open two long polls, and an envelope
    // handed to the one that is going away is an envelope the one that stays
    // never sees. Registering during a stop is a different matter and is
    // allowed: handlers belong to the client, not to the loop, so one
    // registered here is in place for the loop that comes next.
    let inTheHandler: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      inTheHandler = resolve;
    });
    let releaseHandler: (() => void) | undefined;
    const handlerMayFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    gateway = await startFakeGateway({
      apiKey: API_KEY,
      routes: {
        poll_worker: polling(batch(envelopes.order)),
        answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      },
    });

    const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

    coinslot.on("order", async (arrived) => {
      inTheHandler?.();
      await handlerMayFinish;
      return arrived.delivered({ access_url: "https://a.example" });
    });
    await coinslot.start();

    await reached;

    const stopping = coinslot.stop();

    await expect(coinslot.start()).rejects.toThrow(/being stopped/);
    coinslot.on("quote", (asked) => asked.unavailable(AT));

    releaseHandler?.();
    await stopping;

    // And once it has stopped, starting works again, on the handler registered
    // while the stop was in flight as well as the one from before it.
    running = coinslot;
    await coinslot.start();
  });
});

describe("one loop for one process", () => {
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

    coinslot.on("order", (arrived) => arrived.delivered({ access_url: "https://a.example" }));
    coinslot.on("quote", (asked) => asked.unavailable(AT));
    running = coinslot;
    await coinslot.start();

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
