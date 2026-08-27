import { describe, expect, it } from "vitest";
import { type ZodType, z } from "zod";
import {
  AgentOrderStatusSchema,
  API_ROUTES,
  AUTH_MODES,
  CatalogPageSchema,
  expandPath,
  HTTP_METHODS,
  MERCHANT_KEY_HEADER,
  merchantKeyFrom,
  merchantKeyHeaderValue,
  mountableRoutes,
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
import { CONTRACT_VERSION, type SchemaName, schemas } from "./index.js";
import { ORDER_CALL_ERROR_CODES, ORDER_CALL_RESULTS } from "./results.js";
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

/**
 * Whether a schema accepts a value — and, when it does not, why.
 *
 * A bare boolean reports "expected false to be true" and leaves the reader to
 * find the field themselves.
 */
const verdictOf = (schema: ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  return result.success ? "accepted" : `refused: ${z.prettifyError(result.error)}`;
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
  });

  it("refuses a batch of no envelopes", () => {
    // Asking for at most zero is asking for nothing, and the answer would look
    // exactly like a quiet queue forever.
    expect(WorkerPollRequestSchema.safeParse({ max: 0 }).success).toBe(false);
    expect(WorkerPollRequestSchema.safeParse({ max: 1 }).success).toBe(true);
  });

  it("puts no ceiling on either, because a ceiling would be the gateway's", () => {
    // A first draft capped both and called the caps bounds on the format. They
    // were policy numbers with no anchor outside this file, and a card is held
    // to the opposite rule for the same kind of value — it takes any whole
    // positive number of seconds rather than inventing a limit. Whatever is
    // asked for, the gateway answers with its own window and its own batch.
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: 86_400 }).success).toBe(true);
    expect(WorkerPollRequestSchema.safeParse({ max: 1_000_000 }).success).toBe(true);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(WorkerPollRequestSchema, { cursor: "abc" })).toContain("cursor");
  });

  it("tells the reader of the document alone whose the limits are", () => {
    // A reader with the export and no TypeScript would otherwise take the
    // absence of a ceiling for a promise that any number will be honoured.
    const description = schemas.worker_poll_request.meta()?.description ?? "";

    expect(description).toContain("the policy is the gateway's");
    expect(description).toContain("its own window and its own batch size whatever is asked for");
  });
});

describe("what a poll answers with", () => {
  it("accepts an empty batch, which is the answer to a quiet window", () => {
    // ADR-0004 makes this the ordinary case, not a failure. A worker that read
    // it as an error would restart its subscription every idle window.
    const quiet = { contract_version: CONTRACT_VERSION, envelopes: [] };

    expect(WorkerPollResponseSchema.parse(quiet)).toStrictEqual(quiet);
  });

  it("names the contract version the gateway speaks, on every answer", () => {
    // The SDK has a function for checking this and had nothing to feed it. A
    // worker that starts against a gateway speaking another dialect should
    // fail at startup, not on somebody's first order.
    expectMissingFieldRejected(
      WorkerPollResponseSchema,
      { contract_version: CONTRACT_VERSION, envelopes: [] },
      "contract_version",
    );
    expect(
      WorkerPollResponseSchema.safeParse({ contract_version: "", envelopes: [] }).success,
    ).toBe(false);
  });

  it("accepts a batch of envelopes of different kinds on one stream", () => {
    const batch = {
      contract_version: CONTRACT_VERSION,
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
      WorkerPollResponseSchema.safeParse({
        contract_version: CONTRACT_VERSION,
        envelopes: [{ ...orderEnvelope, kind: "invoice" }],
      }).success,
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
      const answer = OrderCallResponseSchema.parse({ ok: true, result });

      expect(answer.ok).toBe(true);
      expect(answer).toStrictEqual({ ok: true, result });
    });
  }

  it("marks success with something every language reads the same way", () => {
    // The marker is a value and not a key, because a key whose payload can be
    // empty reads as false in some of the languages a merchant writes in — and
    // the export exists for exactly the engineer working outside TypeScript.
    // Both answers of this family are truthy on `ok` and falsy on failure.
    const delivered = OrderCallResponseSchema.parse({ ok: true, result: "delivered" });
    const accepted = OrderAcceptResponseSchema.parse({ ok: true });
    const failed = OrderCallResponseSchema.parse({ ok: false, error: callError });

    expect([delivered.ok, accepted.ok, failed.ok]).toStrictEqual([true, true, false]);
  });

  it("carries a failure that says whether calling again could change anything", () => {
    expect(OrderCallResponseSchema.parse({ ok: false, error: callError })).toStrictEqual({
      ok: false,
      error: callError,
    });
  });

  it("refuses an answer that is both, or neither", () => {
    // Both would be two answers at once, and whichever a merchant read first
    // would look like the whole truth.
    expect(
      OrderCallResponseSchema.safeParse({ ok: true, result: "delivered", error: callError })
        .success,
    ).toBe(false);
    expect(OrderCallResponseSchema.safeParse({ ok: false, result: "delivered" }).success).toBe(
      false,
    );
    expect(OrderCallResponseSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a success with no word for which success it was", () => {
    // Unlike taking an order on, delivering and refusing have words, and the
    // merchant has to write down which one happened.
    expect(OrderCallResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("refuses a success word the vocabulary does not carry", () => {
    // The published list is the whole of it. A merchant branching on a word we
    // never promised is branching on something the next release can rename.
    expect(OrderCallResponseSchema.safeParse({ ok: true, result: "ok" }).success).toBe(false);
    expect(OrderCallResponseSchema.safeParse({ ok: true, result: "taken_on" }).success).toBe(false);
    expect(OrderCallResponseSchema.safeParse({ ok: true, result: "" }).success).toBe(false);
  });

  it("refuses a failure with no flag about retrying", () => {
    const { retryable, ...withoutFlag } = callError;
    expect(retryable).toBeDefined();
    expect(OrderCallResponseSchema.safeParse({ ok: false, error: withoutFlag }).success).toBe(
      false,
    );
  });
});

describe("what taking an order on comes back as", () => {
  it("succeeds without a word for what happened", () => {
    // This route reports every success the same bare way, including taking on
    // an order that was already delivered — it declines to tell those apart.
    // The answer route is where a word earns its place, because it carries
    // whichever of the three things a handler returned. An answer with no word
    // in it also has nothing to get wrong when the same order is redelivered
    // and taken on again, which is ordinary here.
    expect(OrderAcceptResponseSchema.parse({ ok: true })).toStrictEqual({ ok: true });
  });

  it("refuses a word smuggled into the success", () => {
    expect(OrderAcceptResponseSchema.safeParse({ ok: true, result: "delivered" }).success).toBe(
      false,
    );
    expect(OrderAcceptResponseSchema.safeParse({ ok: true, result: "accepted" }).success).toBe(
      false,
    );
  });

  it("fails the same way the other order calls do", () => {
    expect(OrderAcceptResponseSchema.parse({ ok: false, error: callError })).toStrictEqual({
      ok: false,
      error: callError,
    });
    expect(OrderAcceptResponseSchema.safeParse({}).success).toBe(false);
    expect(OrderAcceptResponseSchema.safeParse({ ok: true, error: callError }).success).toBe(false);
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

  it("admits in the exported document what one of its words folds together", () => {
    // The vocabulary defends folding three endings into "rejected" on the
    // grounds that the reason travels separately. It does not, yet — no shape
    // in this contract carries a refusal's reason to an agent — and the reader
    // who has only the document is the one who would plan around the claim.
    const description = schemas.agent_order_status.meta()?.description ?? "";

    expect(description).toContain("rejected");
    expect(description).toContain("nothing in this contract yet carries that reason to an agent");
  });

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

describe("the answer a handler returned, on its way back", () => {
  // The promise: whatever a merchant's handler returns has an address, in
  // every mode. Before the addendum of 2026-08-26 to ADR-0004 it did not — the
  // explicit deliver and refuse calls do not apply in the synchronous mode by
  // the machine's own design, and there the returned answer is the only thing
  // there is, so a synchronous refusal had nowhere to go.

  const answerRoute: RouteDefinition = API_ROUTES.answer_order;

  /** The body and the answer as the table names them, not as we import them. */
  const body = (): ZodType => {
    expect(answerRoute.request, "the answer route carries no request body").toBeDefined();
    return answerRoute.request ?? z.never();
  };

  const answer = (): ZodType => {
    expect("document" in answerRoute.response).toBe(true);
    return "document" in answerRoute.response ? answerRoute.response.document : z.never();
  };

  it("carries each of the three things a handler can return", () => {
    expect(verdictOf(body(), { delivered: { access_url: "https://example.com/a/9f2c4a" } })).toBe(
      "accepted",
    );
    expect(
      verdictOf(body(), { refused: { code: "out_of_stock", message: "Мест на тарифе нет" } }),
    ).toBe("accepted");
    expect(verdictOf(body(), { accepted: { eta_seconds: 60 } })).toBe("accepted");
    expect(verdictOf(body(), { accepted: {} })).toBe("accepted");
  });

  it("refuses an answer that says two things at once, or nothing", () => {
    // A handler answers with exactly one of the three. Two would be two
    // answers, and whichever we acted on the merchant could say was the wrong
    // one; none is silence, and silence is a deadline, not an answer.
    expect(
      verdictOf(body(), {
        delivered: { access_url: "https://example.com/a" },
        refused: { code: "out_of_stock", message: "нет" },
      }),
    ).not.toBe("accepted");
    expect(verdictOf(body(), {})).not.toBe("accepted");
  });

  it("refuses a refusal nobody can count or read", () => {
    // The code feeds the share of purchases that ran into a missing product,
    // and the message is for the person who picks the case up afterwards.
    expect(verdictOf(body(), { refused: { message: "нет" } })).not.toBe("accepted");
    expect(verdictOf(body(), { refused: { code: "out_of_stock" } })).not.toBe("accepted");
    expect(verdictOf(body(), { refused: { code: "", message: "нет" } })).not.toBe("accepted");
    expect(verdictOf(body(), { refused: { code: "out_of_stock", message: " " } })).not.toBe(
      "accepted",
    );
  });

  it("refuses an acceptance that promises a delivery in no time at all", () => {
    expect(verdictOf(body(), { accepted: { eta_seconds: 0 } })).not.toBe("accepted");
    expect(verdictOf(body(), { accepted: { eta_seconds: -60 } })).not.toBe("accepted");
  });

  it("refuses a fourth kind of answer", () => {
    // "Not right now" would blur the line a refusal draws: a supplier who
    // timed out once would look like a product that cannot be sold at all. A
    // temporary failure is an exception, and it comes back as another delivery.
    expect(verdictOf(body(), { deferred: { retry_after_seconds: 30 } })).not.toBe("accepted");
    expect(verdictOf(body(), { delivered: { access_url: "https://x" }, extra: 1 })).not.toBe(
      "accepted",
    );
  });

  it("tells a late synchronous handler that the work was not wasted", () => {
    // The case the addendum names. The merchant started before the deadline
    // and finished after it: nothing went wrong on their side, the goods
    // exist, and a repeat purchase collects them. Told this was an error, they
    // would go looking for a fault that is not there — and the word is a
    // success in the published vocabulary, not a failure code.
    const late = answer().safeParse({ ok: true, result: "purchase_already_closed" });

    expect(late.success ? "accepted" : "refused").toBe("accepted");
    expect((late.data as { ok: boolean }).ok).toBe(true);
    expect(ORDER_CALL_RESULTS).toContain("purchase_already_closed");
    expect(ORDER_CALL_ERROR_CODES).not.toContain("purchase_already_closed");
  });

  it("answers in the same family as the explicit closure calls", () => {
    // One vocabulary of successes and one of failures across all four calls. A
    // second family here would be a second thing for a merchant to learn about
    // the same order.
    expect(answer()).toBe(OrderCallResponseSchema);
    expect(
      verdictOf(answer(), {
        ok: false,
        error: {
          code: "order_already_closed",
          message: "Заказ уже закрыт",
          retryable: false,
        },
      }),
    ).toBe("accepted");
  });

  it("is reachable from the registry the way every other document is", () => {
    // The gap this route closed: `handler_answer` was a document the contract
    // published and the table referred to from nowhere, so the one shape a
    // synchronous merchant needs was exported and unreachable through the API.
    expect(body()).toBe(schemas.handler_answer);
    expect(Object.keys(schemas)).toContain("handler_answer");
  });
});

describe("the route table", () => {
  // The promise: the gateway that serves these calls and the SDK that makes
  // them read one description of them. Two dialects of the same surface is
  // what this table exists to prevent, and every check below is about a way
  // the two could come apart.

  /** The registry name of a schema, which is how the table is read back below. */
  const nameOf = (schema: ZodType | undefined): string => {
    if (schema === undefined) return "-";
    const found = (Object.entries(schemas) as [SchemaName, ZodType][]).find(
      ([, registered]) => registered === schema,
    );
    return found?.[0] ?? "NOT IN THE REGISTRY";
  };

  const responseOf = (route: RouteDefinition): string =>
    "document" in route.response ? nameOf(route.response.document) : "not one document";

  /**
   * The whole surface as it stands, so a change to any of it is a change here.
   *
   * The documents are in the row and not merely checked for membership in the
   * registry, because that is the half the table exists for. With only the
   * addresses pinned, `get_order` could quietly answer with a plain order and
   * lose the state a restarting worker reads it for, and nothing would say so.
   */
  const surface: [string, string, string, string, string, string, string][] = [
    // name, method, path, auth, query, request, response
    ["publish_card", "POST", "/v0/catalog/publish", "merchant_key", "-", "card", "publish_result"],
    ["get_order", "GET", "/v0/orders/:order_id", "merchant_key", "-", "-", "order_with_status"],
    ["list_orders", "GET", "/v0/orders", "merchant_key", "order_list_query", "-", "order_list"],
    [
      "poll_worker",
      "POST",
      "/v0/worker/poll",
      "merchant_key",
      "-",
      "worker_poll_request",
      "worker_poll_response",
    ],
    [
      "answer_order",
      "POST",
      "/v0/orders/:order_id/answer",
      "merchant_key",
      "-",
      "handler_answer",
      "order_call_response",
    ],
    [
      "deliver_order",
      "POST",
      "/v0/orders/:order_id/deliver",
      "merchant_key",
      "-",
      "delivery",
      "order_call_response",
    ],
    [
      "refuse_order",
      "POST",
      "/v0/orders/:order_id/refuse",
      "merchant_key",
      "-",
      "refusal",
      "order_call_response",
    ],
    [
      "accept_order",
      "POST",
      "/v0/orders/:order_id/accept",
      "merchant_key",
      "-",
      "acceptance",
      "order_accept_response",
    ],
    [
      "answer_quote",
      "POST",
      "/v0/quotes/:price_id/answer",
      "merchant_key",
      "-",
      "quote_response",
      "quote_answer_ack",
    ],
    ["list_catalog", "GET", "/v0/catalog", "none", "-", "-", "catalog_page"],
    [
      "purchase_item",
      "POST",
      "/v0/items/:item_id/purchase",
      "none",
      "-",
      "purchase_request",
      "not one document",
    ],
    [
      "get_order_status",
      "GET",
      "/v0/orders/:order_id/status",
      "undecided",
      "-",
      "-",
      "agent_order_status",
    ],
  ];

  it("carries exactly these calls, at these addresses, with these documents", () => {
    expect(
      (Object.entries(API_ROUTES) as [string, RouteDefinition][]).map(([name, route]) => [
        name,
        route.method,
        route.path,
        route.auth,
        nameOf(route.query),
        nameOf(route.request),
        responseOf(route),
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

  it("holds every path parameter to a name its own reader can recover", () => {
    // The reader is a regular expression with a grammar, and a name outside
    // that grammar is not refused, it is truncated: a router would read
    // ":productKey" as one parameter and this reads it as "product", leaving
    // "Key" as a literal in the address. Every purchase would then go to the
    // wrong URL. Comparing against a plain split of the path is what makes a
    // name the parser cannot hold fail at our build instead of in a log.
    for (const [name, route] of Object.entries(API_ROUTES)) {
      const written = route.path
        .split("/")
        .filter((segment) => segment.startsWith(":"))
        .map((segment) => segment.slice(1));

      expect(pathParamsOf(route.path), name).toStrictEqual(written);
    }
  });

  it("declares the extra methods an address must answer on as data, not as prose", () => {
    // A gateway mounts from the table. The purchase address has to answer the
    // payment challenge on GET as well, because the validators and crawlers
    // that list a paid resource ask for it that way — a lesson already paid for
    // once, when a paywall bound to one method made most of a catalog
    // invisible. Written only in the description it would be mounted by nobody.
    const purchase: RouteDefinition = API_ROUTES.purchase_item;
    expect(purchase.also_answers_on).toStrictEqual(["GET"]);

    for (const [name, route] of Object.entries(API_ROUTES) as [string, RouteDefinition][]) {
      for (const method of route.also_answers_on ?? []) {
        expect(HTTP_METHODS, name).toContain(method);
        expect(method, name).not.toBe(route.method);
      }
    }
  });

  it("leaves a route whose door nobody has chosen out of what a gateway may serve", () => {
    // The natural way to mount a table is to ask whether a route needs the key
    // and treat the rest as open, which serves the undecided route to the whole
    // world. Mounting from this list makes the safe reading the easy one.
    const mountable = mountableRoutes().map(([name]) => name);

    expect(mountable).not.toContain("get_order_status");
    expect(mountable).toHaveLength(Object.keys(API_ROUTES).length - 1);
    for (const [, route] of mountableRoutes()) expect(route.auth).not.toBe("undecided");
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

  it("finds a value only where the caller actually put one", () => {
    // `constructor` is the one name on Object.prototype that fits the grammar
    // of a path parameter. Looked up without asking whether the caller owns
    // the key, it expands into the source of a function.
    expect(() => expandPath("/v0/x/:constructor", {})).toThrow(/constructor/);

    // And the case a check on the type alone cannot see: an inherited value
    // that is a perfectly good string. Whatever built this object did not put
    // an order id in it, and an address built from one goes to an order the
    // caller never named.
    const inherited = Object.create({ order_id: "ord_somebody_elses" }) as Record<string, string>;

    expect(Object.hasOwn(inherited, "order_id")).toBe(false);
    expect(inherited.order_id).toBe("ord_somebody_elses");
    expect(() => expandPath("/v0/orders/:order_id", inherited)).toThrow(/order_id/);
  });

  it("refuses a value that is a step through the path rather than a value in it", () => {
    // ".." survives encoding untouched and a relative-URL resolver walks it,
    // so the request lands at an address nobody asked for. An identifier in
    // this contract is allowed to be "..".
    expect(() => expandPath("/v0/orders/:order_id", { order_id: ".." })).toThrow(/order_id/);
    expect(() => expandPath("/v0/orders/:order_id", { order_id: "." })).toThrow(/order_id/);
  });

  it("refuses a value that is not text, rather than spelling it out", () => {
    // The SDK has the types; whatever calls the SDK may not. Stringified,
    // `null` becomes the four letters that spell it and the request goes to a
    // real-looking address for an order that never existed.
    const wrong = { order_id: null } as unknown as Record<string, string>;
    const alsoWrong = { order_id: 5 } as unknown as Record<string, string>;

    expect(() => expandPath("/v0/orders/:order_id", wrong)).toThrow(/order_id/);
    expect(() => expandPath("/v0/orders/:order_id", alsoWrong)).toThrow(/order_id/);
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

/**
 * The merchant key's header: the one part of the surface the route table
 * deliberately does not carry, and the one both sides used to agree on only by
 * each writing the same two strings down apart from the other. The gateway
 * parsed `Authorization: Bearer` and the SDK sent it, and nothing tied the two
 * together — the failure of which is a call that fails with an authorisation
 * error while both repositories look correct. These four hold the agreement in
 * one place, so a change to it breaks a test rather than a merchant's worker.
 */
describe("the merchant key's header, held in one place so both sides cannot drift", () => {
  it("names the header the key travels in and the value that carries it", () => {
    expect(MERCHANT_KEY_HEADER).toBe("authorization");
    expect(merchantKeyHeaderValue("a-merchant-key-long-enough")).toBe(
      "Bearer a-merchant-key-long-enough",
    );
  });

  it("takes back out exactly the key the value was built around", () => {
    // The property that matters: whatever the SDK put in, the gateway reads the
    // same key out. A key travels as a bearer token, so it carries no
    // whitespace — but every other character a key is likely to hold survives
    // the round trip untouched.
    for (const key of ["k", "a-merchant-key-long-enough", "sk.live_9-1/ABCxyz+42="]) {
      expect(merchantKeyFrom(merchantKeyHeaderValue(key))).toBe(key);
    }
  });

  it("reads the scheme however it is cased, because an auth scheme is case-insensitive", () => {
    // A merchant whose client wrote "bearer" holds a key that is perfectly
    // correct; matching the scheme case-sensitively would cost them an
    // afternoon on it (RFC 7235 §2.1).
    expect(merchantKeyFrom("Bearer abc")).toBe("abc");
    expect(merchantKeyFrom("bearer abc")).toBe("abc");
    expect(merchantKeyFrom("  Bearer\tabc  ")).toBe("abc");
  });

  it("returns null for anything that is not one of our bearer tokens", () => {
    // Negative control: every way the value is not a key this contract issued
    // reads as "no key", never as a key that happens to match. A half-parsed
    // string that slipped through here would be compared against the real key
    // and, now and then, would match a prefix of it.
    expect(merchantKeyFrom(undefined)).toBeNull(); // no header at all
    expect(merchantKeyFrom("")).toBeNull(); // an empty value
    expect(merchantKeyFrom("abc")).toBeNull(); // no scheme, just a token
    expect(merchantKeyFrom("Basic abc")).toBeNull(); // another scheme entirely
    expect(merchantKeyFrom("Bearer")).toBeNull(); // the scheme with no token
    expect(merchantKeyFrom("Bearer   ")).toBeNull(); // the scheme and only spaces
  });
});
