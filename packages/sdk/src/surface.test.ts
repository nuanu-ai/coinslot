/**
 * The surface a merchant registers on, and the objects it hands them.
 *
 * What is checked here is not the loop — that is `worker.test.ts` — but the
 * shape a merchant's engineer actually types: one `on` for every kind that
 * arrives, one `start` and one `stop`, and an order that carries the calls
 * which close it so that no identifier is ever an argument they have to keep.
 *
 * The identifier is the reason most of these tests exist. An asynchronous
 * merchant delivers hours later, from another part of their code and often
 * from another process life, and every one of those places used to be a place
 * where the wrong string could be passed back to us.
 */

import type { Card, Order, OrderEvent, OrderWithStatus, QuoteRequest } from "@coinslot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrderCalls } from "./client.js";
import { contractVersion } from "./contract.js";
import { createClient } from "./index.js";
import { type FakeGateway, type GatewayAnswer, startFakeGateway } from "./testing/fake-gateway.js";
import type { WorkerProblem } from "./worker.js";

const API_KEY = "merchant-key-for-the-tests";
const AT = "2026-08-26T10:20:00Z";

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: { amount: "5.00", currency: "USD", at: AT, as_of: AT },
  test: false,
};

const openOrder: OrderWithStatus = { ...order, status: "in_progress" };

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
};

const batch = (...carried: object[]): GatewayAnswer => ({
  body: { contract_version: contractVersion, envelopes: carried },
});

/** Answers the scripted batches and then holds the poll open, as a gateway does. */
const polling = (...script: GatewayAnswer[]) => {
  const parked = new Promise<GatewayAnswer>(() => {});
  return (_call: unknown, index: number) => script[index] ?? parked;
};

const waitUntil = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
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
  vi.restoreAllMocks();
});

const clientOver = async (routes: Parameters<typeof startFakeGateway>[0]["routes"]) => {
  gateway = await startFakeGateway({ apiKey: API_KEY, routes });
  return createClient({ apiKey: API_KEY, baseUrl: gateway.url });
};

describe("registering what a process answers", () => {
  it("carries all three kinds of one stream through one registration surface", async () => {
    // The promise: a merchant writes one kind of line for every kind that can
    // arrive, and does not have to learn that two of them live under one
    // namespace and the third under another.
    const seen: string[] = [];

    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.order, envelopes.quote, envelopes.event)),
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      answer_quote: () => ({ body: { used: true } }),
    });

    coinslot.on("order", (arrived) => {
      seen.push(`order ${arrived.id}`);
      return arrived.delivered({ access_url: "https://a.example" });
    });
    coinslot.on("quote", (asked) => {
      seen.push(`quote ${asked.price_id}`);
      return asked.unavailable(AT);
    });
    coinslot.on("event", (arrived) => {
      seen.push(`event ${arrived.type}`);
    });

    running = coinslot;
    await coinslot.start();

    await waitUntil(() => seen.length === 3, "all three kinds to reach their handlers");
    expect(seen).toStrictEqual(["order order-1", "quote price-1", "event order.refund_due"]);
  });

  it("refuses a second handler for a kind rather than replacing the first in silence", async () => {
    const coinslot = await clientOver({ poll_worker: polling() });

    coinslot.on("order", (arrived) => arrived.accepted());
    expect(() => coinslot.on("order", (arrived) => arrived.accepted())).toThrow(/twice/);

    coinslot.on("quote", (asked) => asked.unavailable());
    expect(() => coinslot.on("quote", (asked) => asked.unavailable())).toThrow(/twice/);

    coinslot.on("event", () => {});
    expect(() => coinslot.on("event", () => {})).toThrow(/twice/);

    coinslot.on("problem", () => {});
    expect(() => coinslot.on("problem", () => {})).toThrow(/twice/);
  });

  it("refuses a kind nothing will ever deliver, and says which ones there are", async () => {
    // A merchant who is not in TypeScript, or who typed `orders`, would
    // otherwise register a handler that is never called and be told nothing.
    // Being told the four words they may use is what turns the refusal into a
    // fix rather than a search.
    const coinslot = await clientOver({ poll_worker: polling() });
    const on = (coinslot as unknown as { on(kind: string, handler: () => void): void }).on;

    let complaint = "";

    try {
      on.call(coinslot, "orders", () => {});
    } catch (refused) {
      complaint = String(refused);
    }

    expect(complaint).toMatch(/orders/);
    for (const kind of ["order", "quote", "event", "problem"]) {
      expect(complaint).toContain(`'${kind}'`);
    }
  });
});

describe("the lifecycle a merchant drives", () => {
  it("says the address is missing at the call that needs one, not before", async () => {
    const coinslot = createClient({ apiKey: API_KEY });

    // Registering needs no gateway: nothing has been asked of it yet.
    coinslot.on("order", (arrived) => arrived.accepted());

    await expect(coinslot.start()).rejects.toThrow(/baseUrl/);
  });

  it("refuses to start a worker that would answer nothing", async () => {
    // A process that starts with no handler drains its own queue: every order
    // arrives, nothing answers it, and a delivery attempt is spent each time.
    const coinslot = await clientOver({ poll_worker: polling() });

    await expect(coinslot.start()).rejects.toThrow(/on\(/);

    // A reporter alone is not an answer to anything on the stream.
    coinslot.on("problem", () => {});
    await expect(coinslot.start()).rejects.toThrow(/on\(/);
  });

  it("refuses a second start rather than running two loops for one client", async () => {
    const coinslot = await clientOver({ poll_worker: polling() });

    coinslot.on("order", (arrived) => arrived.accepted());
    running = coinslot;
    await coinslot.start();

    await expect(coinslot.start()).rejects.toThrow(/already/);
  });

  it("stops before it has started, so a shutdown routine needs no flag of its own", async () => {
    const coinslot = await clientOver({ poll_worker: polling() });

    coinslot.on("order", (arrived) => arrived.accepted());

    await expect(coinslot.stop()).resolves.toBeUndefined();
  });

  it("runs again on the handlers it already has after a stop", async () => {
    // A supervisor that restarts a worker must not have to rebuild the client
    // and register everything a second time.
    let arrived = 0;

    const coinslot = await clientOver({
      poll_worker: () => batch(envelopes.order),
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    coinslot.on("order", (given) => {
      arrived += 1;
      return given.delivered({ access_url: "https://a.example" });
    });

    await coinslot.start();
    await waitUntil(() => arrived > 0, "the first loop to receive an order");
    await coinslot.stop();

    const whenItStopped = arrived;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(arrived).toBe(whenItStopped);

    running = coinslot;
    await coinslot.start();
    await waitUntil(() => arrived > whenItStopped, "the second loop to receive an order");
  });
});

describe("an order that carries the calls which close it", () => {
  it("builds the handler's answer without the merchant writing the wire's words", async () => {
    const answers: unknown[] = [];

    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: (call) => {
        answers.push(call.body);
        return { body: { ok: true, result: "delivered" } };
      },
    });

    coinslot.on("order", (arrived) => arrived.delivered({ access_url: "https://a.example" }));
    running = coinslot;
    await coinslot.start();

    await waitUntil(() => answers.length === 1, "the answer to reach the gateway");
    expect(answers[0]).toStrictEqual({ delivered: { access_url: "https://a.example" } });
  });

  it("builds a refusal and an acceptance in the same words the contract carries", async () => {
    // The builders are conveniences and nothing more: they produce the answer
    // and send nothing, so a handler that builds three and returns one has
    // answered once.
    const built: unknown[] = [];
    const answers: unknown[] = [];

    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: (call) => {
        answers.push(call.body);
        return { body: { ok: true, result: "accepted" } };
      },
      // Mounted so that a call made to one of them would be recorded rather
      // than lost against an address the fake gateway does not serve.
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
      accept_order: () => ({ body: { ok: true } }),
    });

    coinslot.on("order", (arrived) => {
      built.push(arrived.delivered({ access_url: "https://a.example" }));
      built.push(arrived.refused({ code: "out_of_stock", message: "Мест на тарифе нет" }));
      built.push(arrived.accepted({ eta_seconds: 60 }));
      built.push(arrived.accepted());
      return arrived.accepted({ eta_seconds: 60 });
    });

    running = coinslot;
    await coinslot.start();
    await waitUntil(() => answers.length === 1, "the one answer the handler returned");

    expect(built).toStrictEqual([
      { delivered: { access_url: "https://a.example" } },
      { refused: { code: "out_of_stock", message: "Мест на тарифе нет" } },
      { accepted: { eta_seconds: 60 } },
      { accepted: {} },
    ]);
    expect(answers).toStrictEqual([{ accepted: { eta_seconds: 60 } }]);

    // The load-bearing half: four answers were built and none of them was
    // sent. A builder that also sent would close an order the handler was only
    // considering, and the handler's own return would then be a second answer
    // to an order that already had one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway?.callsTo("deliver_order")).toStrictEqual([]);
    expect(gateway?.callsTo("refuse_order")).toStrictEqual([]);
    expect(gateway?.callsTo("accept_order")).toStrictEqual([]);
  });

  it("delivers later, off the retained order, without the merchant holding an identifier", async () => {
    // The asynchronous merchant's whole day: take the order on now, deliver
    // when the supplier answers. The only thing they kept is the order.
    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: () => ({ body: { ok: true, result: "accepted" } }),
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    let taken: OrderCalls | undefined;

    coinslot.on("order", (arrived) => {
      taken = arrived;
      return arrived.accepted({ eta_seconds: 60 });
    });

    running = coinslot;
    await coinslot.start();
    await waitUntil(() => taken !== undefined, "the order to reach the handler");

    const closed = await taken?.deliver({ access_url: "https://a.example" });

    expect(closed).toStrictEqual({ ok: true, result: "delivered" });
    expect(gateway?.callsTo("deliver_order")[0]?.params).toStrictEqual({ order_id: order.id });
    expect(gateway?.callsTo("deliver_order")[0]?.body).toStrictEqual({
      access_url: "https://a.example",
    });
  });

  it("refuses and accepts later off the same object", async () => {
    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: () => ({ body: { ok: true, result: "accepted" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
      accept_order: () => ({ body: { ok: true } }),
    });

    let taken: OrderCalls | undefined;

    coinslot.on("order", (arrived) => {
      taken = arrived;
      return arrived.accepted();
    });

    running = coinslot;
    await coinslot.start();
    await waitUntil(() => taken !== undefined, "the order to reach the handler");

    expect(
      await taken?.refuse({ code: "out_of_stock", message: "the supplier had none" }),
    ).toStrictEqual({ ok: true, result: "refused" });
    expect(await taken?.accept({ eta_seconds: 30 })).toStrictEqual({ ok: true });

    expect(gateway?.callsTo("refuse_order")[0]?.params).toStrictEqual({ order_id: order.id });
    expect(gateway?.callsTo("accept_order")[0]?.body).toStrictEqual({ eta_seconds: 30 });
  });

  it("names the order the merchant asked for when they have only its identifier", async () => {
    // The one place an identifier of ours is written by a merchant, and so the
    // one place a delivery could be sent against the wrong order. It reaches
    // no gateway to build, which is what makes it the call to use while the
    // gateway is unreachable and a delivery still has to be retried.
    const coinslot = await clientOver({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
      accept_order: () => ({ body: { ok: true } }),
    });

    const held = coinslot.orders.forId("SKU 100/1");

    expect(held.id).toBe("SKU 100/1");
    expect(gateway?.calls).toStrictEqual([]);

    await held.deliver({ access_url: "https://a.example" });
    await held.refuse({ code: "out_of_stock", message: "gone" });
    await held.accept();

    for (const route of ["deliver_order", "refuse_order", "accept_order"] as const) {
      expect(gateway?.callsTo(route)[0]?.params, route).toStrictEqual({ order_id: "SKU 100/1" });
    }
  });

  it("hands the same calls to an order read back after a restart", async () => {
    // The process that took the order on is gone. What the merchant has is our
    // record of it, and an order off that record has to be the same thing the
    // handler received — otherwise a restart puts them back to carrying
    // identifiers, which is the whole of what this surface removes.
    const coinslot = await clientOver({
      list_orders: () => ({ body: { orders: [openOrder] } }),
      get_order: () => ({ body: openOrder }),
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
    });

    const listed = await coinslot.orders.list({ open: true });

    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("in_progress");
    expect(await listed[0]?.deliver({ access_url: "https://a.example" })).toStrictEqual({
      ok: true,
      result: "delivered",
    });

    const read = await coinslot.orders.get(order.id);

    expect(await read.refuse({ code: "out_of_stock", message: "gone" })).toStrictEqual({
      ok: true,
      result: "refused",
    });

    expect(gateway?.callsTo("deliver_order")[0]?.params).toStrictEqual({ order_id: order.id });
    expect(gateway?.callsTo("refuse_order")[0]?.params).toStrictEqual({ order_id: order.id });
  });

  it("makes an order off a list indistinguishable from one off the stream", async () => {
    // Said as one assertion rather than left to be inferred from two tests
    // passing: every call the handler's order has, the listed one has, and
    // both send the same request for the same delivery.
    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.order)),
      answer_order: () => ({ body: { ok: true, result: "accepted" } }),
      list_orders: () => ({ body: { orders: [openOrder] } }),
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    let fromStream: OrderCalls | undefined;

    coinslot.on("order", (arrived) => {
      fromStream = arrived;
      return arrived.accepted();
    });

    running = coinslot;
    await coinslot.start();
    await waitUntil(() => fromStream !== undefined, "the order to reach the handler");

    const [fromList] = await coinslot.orders.list({ open: true });

    // Both are asked for the same thing, and what leaves for the gateway has
    // to be the same request. Comparing the objects would compare closures;
    // comparing what they send compares what a merchant is promised.
    await fromStream?.deliver({ access_url: "https://a.example" });
    await fromList?.deliver({ access_url: "https://a.example" });

    const [first, second] = gateway?.callsTo("deliver_order") ?? [];

    expect(first?.params).toStrictEqual({ order_id: order.id });
    expect(second?.params).toStrictEqual(first?.params);
    expect(second?.body).toStrictEqual(first?.body);

    // And every call one of them answers to, the other answers to as well.
    for (const call of [
      "delivered",
      "refused",
      "accepted",
      "deliver",
      "refuse",
      "accept",
    ] as const) {
      expect(typeof fromStream?.[call]).toBe("function");
      expect(typeof fromList?.[call]).toBe("function");
    }
  });
});

describe("a price question that carries its own answer", () => {
  it("answers with a price, stamped with the moment unless the merchant names one", async () => {
    const bodies: unknown[] = [];

    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.quote)),
      answer_quote: (call) => {
        bodies.push(call.body);
        return { body: { used: true } };
      },
    });

    coinslot.on("quote", (asked) =>
      asked.available({ amount: "3.50", currency: "USD" }, "2026-08-26T10:19:00Z"),
    );
    running = coinslot;
    await coinslot.start();

    await waitUntil(() => bodies.length === 1, "the price to reach the gateway");
    expect(bodies[0]).toStrictEqual({
      available: true,
      price: { amount: "3.50", currency: "USD" },
      as_of: "2026-08-26T10:19:00Z",
    });
  });

  it("stamps an answer the merchant did not date with the moment they gave it", async () => {
    // A merchant who computed the price just now has looked just now, and the
    // gateway reads `as_of` to decide how fresh the answer is — so the one
    // thing that must not happen is a moment taken from somewhere else. It is
    // bracketed by real time rather than compared to a constant: what is being
    // promised is "when you answered", and only the bracket says that.
    const bodies: Record<string, unknown>[] = [];

    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.quote)),
      answer_quote: (call) => {
        bodies.push(call.body as Record<string, unknown>);
        return { body: { used: true } };
      },
    });

    coinslot.on("quote", (asked) => asked.available({ amount: "3.50", currency: "USD" }));
    running = coinslot;

    const before = Date.now();
    await coinslot.start();
    await waitUntil(() => bodies.length === 1, "the price to reach the gateway");
    const after = Date.now();

    const stamped = Date.parse(String(bodies[0]?.as_of));

    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);

    // And not the one moment the question itself was carrying, which is the
    // nearest wrong answer there is.
    expect(bodies[0]?.as_of).not.toBe(question.expires_at);
  });

  it("answers that there is none, and carries no price when it does", async () => {
    const bodies: unknown[] = [];

    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.quote)),
      answer_quote: (call) => {
        bodies.push(call.body);
        return { body: { used: true } };
      },
    });

    coinslot.on("quote", (asked) => asked.unavailable(AT));
    running = coinslot;
    await coinslot.start();

    await waitUntil(() => bodies.length === 1, "the answer to reach the gateway");
    expect(bodies[0]).toStrictEqual({ available: false, as_of: AT });
  });
});

describe("where problems go", () => {
  it("reaches the reporter the client was given", async () => {
    const problems: WorkerProblem[] = [];

    const coinslot = await clientOver({ poll_worker: polling(batch(envelopes.order)) });

    coinslot.on("quote", (asked) => asked.unavailable(AT));
    coinslot.on("problem", (problem) => problems.push(problem));
    running = coinslot;
    await coinslot.start();

    await waitUntil(() => problems.length > 0, "the problem to reach the reporter");
    expect(problems[0]?.kind).toBe("no_handler");
    expect(problems[0]?.message).toMatch(/on\('order'\)/);
  });

  it("names the registration that is missing, and not another one", async () => {
    // The sentence is the whole of what the merchant acts on: it tells them
    // which line to write. Naming the wrong kind sends them to add a handler
    // they already have while the one that is missing stays missing.
    const problems: WorkerProblem[] = [];

    const coinslot = await clientOver({
      poll_worker: polling(batch(envelopes.quote, envelopes.event)),
    });

    coinslot.on("order", (arrived) => arrived.accepted());
    coinslot.on("problem", (problem) => problems.push(problem));
    running = coinslot;
    await coinslot.start();

    await waitUntil(() => problems.length === 2, "both kinds to go unhandled");

    const said = problems.map((problem) => problem.message);

    expect(said[0]).toMatch(/on\('quote'\)/);
    expect(said[0]).not.toMatch(/on\('order'\)|on\('event'\)/);
    expect(said[1]).toMatch(/on\('event'\)/);
    expect(said[1]).not.toMatch(/on\('order'\)|on\('quote'\)/);
  });

  it("goes to the error console when the merchant registered none", async () => {
    // A worker that stopped in silence is a merchant who hears about it from a
    // buyer, and a library writing to the console is the cheaper rudeness.
    const written = vi.spyOn(console, "error").mockImplementation(() => {});

    const coinslot = await clientOver({ poll_worker: polling(batch(envelopes.order)) });

    coinslot.on("quote", (asked) => asked.unavailable(AT));
    running = coinslot;
    await coinslot.start();

    await waitUntil(() => written.mock.calls.length > 0, "the problem to reach the console");
    expect(String(written.mock.calls[0]?.[0])).toMatch(/no_handler/);
  });
});

describe("what the surface still does without a stream", () => {
  it("publishes a card and reads orders back", async () => {
    const card: Card = {
      merchant_item_id: "access-monthly",
      title: "Доступ к сервису на один месяц",
      description: "Что покупатель получает и что в это не входит.",
      price: { amount: "5.00", currency: "USD" },
      params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
      result: { access_url: { type: "string", title: "Ссылка для входа" } },
      fulfillment: "sync",
    };

    const coinslot = await clientOver({
      publish_card: () => ({ body: { ok: { id: "cat-1" } } }),
      list_orders: () => ({ body: { orders: [] } }),
    });

    expect(await coinslot.catalog.publish(card)).toStrictEqual({ ok: { id: "cat-1" } });
    expect(await coinslot.orders.list()).toStrictEqual([]);
  });
});
