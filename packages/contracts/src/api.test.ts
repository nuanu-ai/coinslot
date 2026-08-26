import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  AgentOrderStatusSchema,
  API_ROUTES,
  AUTH_MODES,
  CatalogPageSchema,
  expandPath,
  HTTP_METHODS,
  MAX_POLL_ENVELOPES,
  MAX_POLL_WAIT_SECONDS,
  OrderAcceptResponseSchema,
  OrderCallResponseSchema,
  OrderListQuerySchema,
  OrderListSchema,
  OrderWithStatusSchema,
  PurchaseRequestSchema,
  pathParamsOf,
  QuoteAnswerAckSchema,
  type RouteDefinition,
  WorkerPollRequestSchema,
  WorkerPollResponseSchema,
} from "./api.js";
import { CardSchema, publicCardOf } from "./card.js";
import { schemas } from "./index.js";
import { ORDER_CALL_RESULTS } from "./results.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const order = {
  id: "ord_7c1e05",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  price_id: "prc_31a8c0",
  test: false,
};

const openOrder = { ...order, status: "in_progress" };

const publicCard = publicCardOf(
  CardSchema.parse({
    merchant_item_id: "access-monthly",
    title: "Доступ к сервису на один месяц",
    description: "Доступ на 30 дней с момента выдачи, продление не входит.",
    price: { amount: "5.00", currency: "USD" },
    params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
    result: { access_url: { type: "string", title: "Ссылка для входа" } },
    fulfillment: "sync",
  }),
  { id: "itm_4d21bb", as_of: "2026-08-26T09:00:00Z" },
);

const orderEnvelope = {
  kind: "order",
  id: "msg_4a19be",
  sent_at: "2026-08-26T10:20:01Z",
  payload: order,
};

const callError = {
  code: "order_already_closed",
  message: "Заказ уже закрыт, выдавать по нему нечего",
  retryable: false,
};

describe("an order read back with its state", () => {
  // The promise: a worker that restarted can find out what it still owes
  // without trusting its own database alone. That means one document carrying
  // both the order it has to deliver and the word for where it stands.

  it("accepts an order with the state it is in", () => {
    expect(OrderWithStatusSchema.parse(openOrder)).toStrictEqual(openOrder);
  });

  for (const field of ["id", "merchant_item_id", "params", "price", "test", "status"]) {
    it(`refuses an order read back without ${field} and names it`, () => {
      expectMissingFieldRejected(OrderWithStatusSchema, openOrder, field);
    });
  }

  it("refuses a word that is not one of the endings the agent and merchant share", () => {
    // The vocabulary is the state machine's own. A state read back under a word
    // nobody publishes would be a second answer to "what became of it".
    expect(errorOf(OrderWithStatusSchema, { ...order, status: "dispatched" })).toContain("status");
    expect(OrderWithStatusSchema.safeParse({ ...order, status: "delivered" }).success).toBe(true);
    expect(OrderWithStatusSchema.safeParse({ ...order, status: "refund_due" }).success).toBe(true);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(OrderWithStatusSchema, { ...openOrder, attempts: 2 })).toContain("attempts");
  });
});

describe("the list of orders", () => {
  it("accepts a merchant with nothing open", () => {
    // An empty list is a real answer and the common one. A schema that refused
    // it would make "you owe nothing" indistinguishable from a broken call.
    expect(OrderListSchema.parse({ orders: [] })).toStrictEqual({ orders: [] });
  });

  it("accepts a list of orders read back with their states", () => {
    expect(
      OrderListSchema.safeParse({ orders: [openOrder, { ...order, status: "refund_due" }] })
        .success,
    ).toBe(true);
  });

  it("is an object rather than a bare array", () => {
    // A bare array cannot grow a cursor or a count without breaking every
    // reader that already parses it as the whole answer.
    expect(OrderListSchema.safeParse([openOrder]).success).toBe(false);
    expect(errorOf(OrderListSchema, {})).toContain("orders");
  });

  it("holds every order in the list to the same document", () => {
    expect(OrderListSchema.safeParse({ orders: [order] }).success).toBe(false);
  });
});

describe("asking for only the open orders", () => {
  it("accepts the question with and without the filter", () => {
    expect(OrderListQuerySchema.parse({})).toStrictEqual({});
    expect(OrderListQuerySchema.parse({ open: "true" })).toStrictEqual({ open: "true" });
    expect(OrderListQuerySchema.safeParse({ open: "false" }).success).toBe(true);
  });

  it("takes the two words a query string can carry and nothing else", () => {
    // A query string carries text, and this document says so. Written as a
    // boolean it would export as one, and an engineer generating a client from
    // that would build a request nobody can send. `?open=1` is refused rather
    // than guessed at: a merchant who meant "only the open ones" and silently
    // got all of them would reconcile against the wrong list.
    expect(OrderListQuerySchema.safeParse({ open: true }).success).toBe(false);
    expect(OrderListQuerySchema.safeParse({ open: "1" }).success).toBe(false);
    expect(OrderListQuerySchema.safeParse({ open: "yes" }).success).toBe(false);
    expect(OrderListQuerySchema.safeParse({ open: "" }).success).toBe(false);
  });

  it("refuses a filter it does not have", () => {
    expect(errorOf(OrderListQuerySchema, { since: "2026-08-26T00:00:00Z" })).toContain("since");
  });
});

describe("the poll a worker makes", () => {
  it("accepts a poll that names nothing and takes our defaults", () => {
    expect(WorkerPollRequestSchema.parse({})).toStrictEqual({});
  });

  it("accepts a wait window and a batch size", () => {
    const asked = { wait_seconds: 25, max: 10 };
    expect(WorkerPollRequestSchema.parse(asked)).toStrictEqual(asked);
  });

  it("accepts a poll that asks for no wait at all", () => {
    // A drain: answer with whatever is queued right now and come straight
    // back. It is a real request, and a worker shutting down makes it.
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: 0 }).success).toBe(true);
  });

  it("refuses a wait that is not a wait", () => {
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: -1 }).success).toBe(false);
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: 2.5 }).success).toBe(false);
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: MAX_POLL_WAIT_SECONDS }).success).toBe(
      true,
    );
    expect(
      WorkerPollRequestSchema.safeParse({ wait_seconds: MAX_POLL_WAIT_SECONDS + 1 }).success,
    ).toBe(false);
  });

  it("refuses a batch of no envelopes and a batch that is a queue dump", () => {
    // Asking for at most zero is asking for nothing, and the answer would look
    // exactly like a quiet queue forever.
    expect(WorkerPollRequestSchema.safeParse({ max: 0 }).success).toBe(false);
    expect(WorkerPollRequestSchema.safeParse({ max: 1 }).success).toBe(true);
    expect(WorkerPollRequestSchema.safeParse({ max: MAX_POLL_ENVELOPES }).success).toBe(true);
    expect(WorkerPollRequestSchema.safeParse({ max: MAX_POLL_ENVELOPES + 1 }).success).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(WorkerPollRequestSchema, { cursor: "abc" })).toContain("cursor");
  });

  it("says in the exported document what those two bounds are and are not", () => {
    // They bound the format and not the policy: the gateway's own ceiling is
    // lower and is the gateway's. A reader of the document alone would
    // otherwise take our outer bound for the number they may ask for.
    const description = JSON.stringify(schemas.worker_poll_request.meta() ?? {});

    expect(description).toContain("gateway");
  });
});

describe("what a poll answers with", () => {
  it("accepts an empty batch, which is the answer to a quiet window", () => {
    // ADR-0004 makes this the ordinary case, not a failure. A worker that read
    // it as an error would restart its subscription every idle window.
    expect(WorkerPollResponseSchema.parse({ envelopes: [] })).toStrictEqual({ envelopes: [] });
  });

  it("accepts a batch of envelopes of different kinds on one stream", () => {
    const batch = {
      envelopes: [
        orderEnvelope,
        {
          kind: "order_event",
          id: "msg_1f77a0",
          sent_at: "2026-08-27T10:20:00Z",
          payload: {
            type: "order.refund_due",
            order_id: "ord_7c1e05",
            at: "2026-08-27T10:20:00Z",
            price: { amount: "5.00", currency: "USD" },
            reason: "deadline_passed",
          },
        },
      ],
    };

    expect(WorkerPollResponseSchema.safeParse(batch).success).toBe(true);
  });

  it("refuses a batch with an envelope nobody can read", () => {
    expect(
      WorkerPollResponseSchema.safeParse({ envelopes: [{ ...orderEnvelope, kind: "invoice" }] })
        .success,
    ).toBe(false);
  });

  it("is an object rather than a bare array", () => {
    expect(WorkerPollResponseSchema.safeParse([orderEnvelope]).success).toBe(false);
    expect(errorOf(WorkerPollResponseSchema, {})).toContain("envelopes");
  });
});

describe("what answering for an order comes back as", () => {
  // The promise the shape keeps: a merchant tells success from failure by one
  // test, and the word inside a success is something to write down rather than
  // to branch on. The portal says a repeated delivery is a success with a
  // different word; a merchant who wrote `if (result === 'delivered')` would
  // have turned their own safe retry into a failure branch.

  for (const result of ORDER_CALL_RESULTS) {
    it(`carries "${result}" under the same marker of success as every other`, () => {
      const answer = OrderCallResponseSchema.parse({ ok: { result } });

      expect("ok" in answer).toBe(true);
      expect(answer).toStrictEqual({ ok: { result } });
    });
  }

  it("carries a failure that says whether calling again could change anything", () => {
    expect(OrderCallResponseSchema.parse({ error: callError })).toStrictEqual({ error: callError });
  });

  it("refuses an answer that is both, or neither", () => {
    // Both would be two answers at once, and whichever a merchant read first
    // would look like the whole truth.
    expect(
      OrderCallResponseSchema.safeParse({ ok: { result: "delivered" }, error: callError }).success,
    ).toBe(false);
    expect(OrderCallResponseSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a success word that is not one of the five", () => {
    expect(OrderCallResponseSchema.safeParse({ ok: { result: "accepted" } }).success).toBe(false);
    expect(OrderCallResponseSchema.safeParse({ ok: { result: "ok" } }).success).toBe(false);
  });

  it("refuses a failure with no flag about retrying", () => {
    const { retryable, ...withoutFlag } = callError;
    expect(retryable).toBeDefined();
    expect(OrderCallResponseSchema.safeParse({ error: withoutFlag }).success).toBe(false);
  });
});

describe("what taking an order on comes back as", () => {
  it("succeeds without a word for what happened", () => {
    // None of the five published results names a successful acceptance, and
    // inventing one here would be a wire value nobody decided. An empty
    // success is also the only answer that cannot be got wrong when the same
    // order is redelivered and taken on again.
    expect(OrderAcceptResponseSchema.parse({ ok: {} })).toStrictEqual({ ok: {} });
  });

  it("refuses a word smuggled into the success", () => {
    expect(OrderAcceptResponseSchema.safeParse({ ok: { result: "delivered" } }).success).toBe(
      false,
    );
    expect(OrderAcceptResponseSchema.safeParse({ ok: { result: "accepted" } }).success).toBe(false);
  });

  it("fails the same way the other order calls do", () => {
    expect(OrderAcceptResponseSchema.parse({ error: callError })).toStrictEqual({
      error: callError,
    });
    expect(OrderAcceptResponseSchema.safeParse({}).success).toBe(false);
    expect(OrderAcceptResponseSchema.safeParse({ ok: {}, error: callError }).success).toBe(false);
  });
});

describe("what answering a price question comes back as", () => {
  it("says whether the answer was in time to price the purchase", () => {
    expect(QuoteAnswerAckSchema.parse({ used: true })).toStrictEqual({ used: true });
    expect(QuoteAnswerAckSchema.parse({ used: false })).toStrictEqual({ used: false });
  });

  it("refuses an acknowledgement that does not say", () => {
    // The merchant may be holding stock against the question. Read as used, a
    // silent flag leaves that stock held; read as unused, it releases stock
    // for a sale that is going through.
    expectMissingFieldRejected(QuoteAnswerAckSchema, { used: true }, "used");
    expect(QuoteAnswerAckSchema.safeParse({ used: "true" }).success).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(QuoteAnswerAckSchema, { used: true, reason: "expired" })).toContain("reason");
  });
});

describe("the purchase an agent sends", () => {
  it("always carries the parameters, empty for a product that needs none", () => {
    // The same rule the order keeps: nobody downstream should have to tell "no
    // parameters" from "the field did not arrive".
    expect(PurchaseRequestSchema.parse({ params: {} })).toStrictEqual({ params: {} });
    expect(
      PurchaseRequestSchema.safeParse({ params: { email: "buyer@example.com" } }).success,
    ).toBe(true);
    expectMissingFieldRejected(PurchaseRequestSchema, { params: {} }, "params");
  });

  it("refuses a parameter name no card could have declared", () => {
    expect(PurchaseRequestSchema.safeParse({ params: { "not ok": 1 } }).success).toBe(false);
  });

  it("refuses a field it does not know", () => {
    // What the parameters have to be for this particular card is checked
    // against that card, at the moment of purchase. This document carries the
    // envelope and does not pretend to check the contents.
    expect(errorOf(PurchaseRequestSchema, { params: {}, price: "5.00" })).toContain("price");
  });
});

describe("the status an agent reads", () => {
  const status = { order_id: "ord_7c1e05", status: "in_progress" };

  it("names the order it is about", () => {
    // A status with no order on it is a sentence an agent cannot file against
    // anything once it has more than one purchase running.
    expect(AgentOrderStatusSchema.parse(status)).toStrictEqual(status);
  });

  for (const field of ["order_id", "status"]) {
    it(`refuses a status without ${field} and names it`, () => {
      expectMissingFieldRejected(AgentOrderStatusSchema, status, field);
    });
  }

  it("answers in the words both sides read, and refuses the machine's own", () => {
    expect(
      AgentOrderStatusSchema.safeParse({ ...status, status: "payment_unresolved" }).success,
    ).toBe(true);
    expect(AgentOrderStatusSchema.safeParse({ ...status, status: "paid" }).success).toBe(false);
  });
});

describe("the catalog an agent reads", () => {
  it("accepts a catalog with cards in it and one with none", () => {
    expect(CatalogPageSchema.safeParse({ items: [publicCard] }).success).toBe(true);
    expect(CatalogPageSchema.parse({ items: [] })).toStrictEqual({ items: [] });
  });

  it("is an object rather than a bare array, so it can grow a way of saying there is more", () => {
    expect(CatalogPageSchema.safeParse([publicCard]).success).toBe(false);
    expect(errorOf(CatalogPageSchema, {})).toContain("items");
  });

  it("holds every card in it to the projection an agent may see", () => {
    // The merchant's published card is not this document. Handing one straight
    // out would publish their own key and the address of their pricing service.
    expect(
      CatalogPageSchema.safeParse({ items: [{ ...publicCard, price_check: "handler" }] }).success,
    ).toBe(false);
  });

  it("says in the exported document that it does not claim to be the whole catalog", () => {
    // The fifth gate on the one artifact an agent reads first: what has been
    // truncated, and is that said. Paging is not designed, and a reader must
    // not take the absence of a field about it for a promise that there is no
    // more.
    const description = JSON.stringify(schemas.catalog_page.meta() ?? {});

    expect(description).toContain("whole catalog");
  });
});

describe("the route table", () => {
  // The promise: the gateway that serves these calls and the SDK that makes
  // them read one description of them. Two dialects of the same surface is
  // what this table exists to prevent, and every check below is about a way
  // the two could come apart.

  /** The route table as it stands, so a change to the surface is a change here. */
  const surface: [string, string, string, string][] = [
    ["publish_card", "POST", "/v0/catalog/publish", "merchant_key"],
    ["get_order", "GET", "/v0/orders/:order_id", "merchant_key"],
    ["list_orders", "GET", "/v0/orders", "merchant_key"],
    ["poll_worker", "POST", "/v0/worker/poll", "merchant_key"],
    ["deliver_order", "POST", "/v0/orders/:order_id/deliver", "merchant_key"],
    ["refuse_order", "POST", "/v0/orders/:order_id/refuse", "merchant_key"],
    ["accept_order", "POST", "/v0/orders/:order_id/accept", "merchant_key"],
    ["answer_quote", "POST", "/v0/quotes/:price_id/answer", "merchant_key"],
    ["list_catalog", "GET", "/v0/catalog", "none"],
    ["purchase_item", "POST", "/v0/items/:item_id/purchase", "none"],
    ["get_order_status", "GET", "/v0/orders/:order_id/status", "undecided"],
  ];

  it("carries exactly these calls, at these addresses, behind these doors", () => {
    expect(
      Object.entries(API_ROUTES).map(([name, route]) => [
        name,
        route.method,
        route.path,
        route.auth,
      ]),
    ).toStrictEqual(surface);
  });

  it("names every route the way the wire is written", () => {
    // The same rule the schema registry keeps. A table that mixed conventions
    // would read like two surfaces.
    for (const name of Object.keys(API_ROUTES)) expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("puts no two routes at one address under one method", () => {
    // Two routes at one address is one of them never being reached, and which
    // one depends on the order a router happened to mount them in.
    const addresses = Object.values(API_ROUTES).map((route) => `${route.method} ${route.path}`);

    expect([...new Set(addresses)]).toHaveLength(addresses.length);
  });

  it("uses only the methods and the doors it declares", () => {
    for (const [name, route] of Object.entries(API_ROUTES)) {
      expect(HTTP_METHODS, name).toContain(route.method);
      expect(AUTH_MODES, name).toContain(route.auth);
    }
  });

  it("refers to no schema the contract does not publish", () => {
    // The reader furthest from us has the JSON Schema export and this table. A
    // route pointing at a schema the registry does not carry is a call they
    // cannot generate a client for.
    const published = new Set<ZodType>(Object.values(schemas));
    const unpublished: string[] = [];

    for (const [name, route] of Object.entries(API_ROUTES) as [string, RouteDefinition][]) {
      const referenced: [string, ZodType | undefined][] = [
        ["query", route.query],
        ["request", route.request],
        ["response", "document" in route.response ? route.response.document : undefined],
      ];

      for (const [what, schema] of referenced) {
        if (schema !== undefined && !published.has(schema)) unpublished.push(`${name}.${what}`);
      }
    }

    expect(unpublished).toStrictEqual([]);
  });

  it("explains itself where a call answers with something other than one document", () => {
    // The one place the table cannot hold the whole contract is the purchase,
    // which is a payment exchange before it is a document. An absent field
    // would be a silence; this is a sentence.
    for (const [name, route] of Object.entries(API_ROUTES) as [string, RouteDefinition][]) {
      if ("document" in route.response) continue;
      expect(route.response.not_one_document.length, name).toBeGreaterThan(0);
    }

    expect("document" in API_ROUTES.purchase_item.response).toBe(false);
  });

  it("says what every call is for, in words", () => {
    for (const [name, route] of Object.entries(API_ROUTES)) {
      expect(route.description.trim().length, name).toBeGreaterThan(0);
    }
  });

  it("says out loud that it does not know who may read an order's status", () => {
    // Not `none`: a route open to everyone would let anyone read anyone's
    // purchase. Not a scheme invented here either. "I do not know" and "I know
    // there is no door" have to be different words, and this is the one route
    // where the first is the true one.
    expect(API_ROUTES.get_order_status.auth).toBe("undecided");
    expect(API_ROUTES.get_order_status.description).toContain("open question");
  });

  it("warns that the paid route has to answer a challenge on any method", () => {
    // A lesson already paid for: validators and crawlers ask for a listed
    // resource with GET, and a paywall bound to one method made most of a
    // catalog invisible. A table keyed by method is exactly where that would
    // be reproduced.
    expect(API_ROUTES.purchase_item.description).toContain("GET");
  });
});

describe("the addresses in the table, expanded and read back", () => {
  it("names the parameters of a path, and none where there are none", () => {
    expect(pathParamsOf("/v0/orders/:order_id/deliver")).toStrictEqual(["order_id"]);
    expect(pathParamsOf("/v0/catalog")).toStrictEqual([]);
  });

  it("round-trips every route in the table", () => {
    // The promise: an SDK holding this table can build the address of any call
    // without a parser of its own, and what it builds has nothing left to
    // substitute.
    for (const [name, route] of Object.entries(API_ROUTES)) {
      const parameters = pathParamsOf(route.path);
      const values = Object.fromEntries(parameters.map((parameter) => [parameter, "ord_7c1e05"]));
      const address = expandPath(route.path, values);

      expect(pathParamsOf(address), name).toStrictEqual([]);
      expect(address, name).not.toContain(":");
      for (const parameter of parameters) expect(address, name).not.toContain(parameter);
    }
  });

  it("encodes a value the way a path segment has to be encoded", () => {
    // An identifier may carry a slash and a space — "SKU 100/1" is one this
    // contract accepts. Pasted into an address unencoded it becomes two
    // segments and a different route.
    expect(expandPath("/v0/orders/:order_id", { order_id: "SKU 100/1" })).toBe(
      "/v0/orders/SKU%20100%2F1",
    );
  });

  it("refuses to build an address with a hole in it", () => {
    // The failure this prevents is a request to a literal ":order_id", which
    // reads in a log as a route that exists and answers 404 for everyone.
    expect(() => expandPath("/v0/orders/:order_id", {})).toThrow(/order_id/);
    expect(() => expandPath("/v0/orders/:order_id", { order_id: "" })).toThrow(/order_id/);
  });

  it("refuses a value for something the address does not take", () => {
    // A caller passing `orderId` to a path that wants `order_id` has a bug,
    // and dropping it silently would send a request that does something else.
    expect(() =>
      expandPath("/v0/orders/:order_id", { order_id: "ord_1", orderId: "ord_2" }),
    ).toThrow(/orderId/);
    expect(() => expandPath("/v0/catalog", { order_id: "ord_1" })).toThrow(/order_id/);
  });
});
