import type { Card, Order } from "@coinslot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWER_NOT_UNDERSTOOD, CALL_DID_NOT_REACH_US, createClient } from "./index.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";
import { REACH, reachOf } from "./transport.js";

const API_KEY = "merchant-key-for-the-tests";

const card: Card = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Что покупатель получает, для какой задачи это годится и что в это не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
  result: { access_url: { type: "string", title: "Ссылка для входа" } },
  fulfillment: "sync",
};

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  test: false,
};

let gateway: FakeGateway | undefined;

const gatewayServing = async (routes: Parameters<typeof startFakeGateway>[0]["routes"]) => {
  gateway = await startFakeGateway({ apiKey: API_KEY, routes });
  return createClient({ apiKey: API_KEY, baseUrl: gateway.url });
};

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe("creating a client", () => {
  it("refuses to be built without a key rather than failing on the first call", () => {
    // The promise: a merchant whose environment variable is not set is told
    // that, at the line that is wrong, instead of receiving an authorisation
    // failure from a call they made much later.
    expect(() => createClient({ apiKey: undefined, baseUrl: "https://gateway.invalid" })).toThrow(
      /api key/i,
    );
    expect(() => createClient({ apiKey: "  ", baseUrl: "https://gateway.invalid" })).toThrow(
      /api key/i,
    );
  });

  it("is built without an address, and says so at the first call that needs one", async () => {
    // The quickstart builds a client from a key alone and calls that step
    // done, so building one has to work. Where it cannot work is the call, and
    // the documentation says as much: the first call is what finds out whether
    // this side can reach us. Nothing in the contract or in any decision names
    // where the gateway lives, so the call says that rather than reaching for
    // a hostname nobody chose.
    const coinslot = createClient({ apiKey: API_KEY });

    await expect(coinslot.catalog.publish(card)).rejects.toThrow(/baseUrl/);
    await expect(coinslot.orders.get("order-1")).rejects.toThrow(/baseUrl/);
    await expect(
      coinslot.orders.deliver("order-1", { access_url: "https://a.example" }),
    ).rejects.toThrow(/baseUrl/);
    expect(() => coinslot.orders.subscribe(() => ({ accepted: {} }))).toThrow(/baseUrl/);
  });

  it("refuses an address that is not one", () => {
    expect(() => createClient({ apiKey: API_KEY, baseUrl: "gateway.invalid" })).toThrow(/address/i);
  });
});

describe("publishing a card", () => {
  it("hands back the catalog identifier", async () => {
    const coinslot = await gatewayServing({
      publish_card: () => ({ body: { ok: { id: "cat-1" } } }),
    });

    const published = await coinslot.catalog.publish(card);

    expect(published).toStrictEqual({ ok: { id: "cat-1" } });
    expect(gateway?.callsTo("publish_card")[0]?.body).toStrictEqual(card);
    expect(gateway?.callsTo("publish_card")[0]?.apiKey).toBe(API_KEY);
  });

  it("returns what is wrong with the card instead of throwing", async () => {
    // The portal's promise about the edit cycle: an invalid card does not
    // throw, it comes back as a list of findings the merchant can print.
    const errors = [{ path: ["price", "currency"], code: "unsupported", message: "not settled" }];
    const coinslot = await gatewayServing({
      publish_card: () => ({ status: 400, body: { errors } }),
    });

    const published = await coinslot.catalog.publish(card);

    expect("errors" in published && published.errors).toStrictEqual(errors);
  });

  it("throws when the answer is not an answer at all", async () => {
    // A card that was neither accepted nor faulted is a case a merchant
    // cannot branch on, so it arrives as an exception rather than as a third
    // shape nobody described.
    const coinslot = await gatewayServing({
      publish_card: () => ({ status: 502, text: "<html>gateway timeout</html>" }),
    });

    await expect(coinslot.catalog.publish(card)).rejects.toThrow(/publish_card/);
  });

  it("treats a well-formed answer that is not the document as no answer at all", async () => {
    // The dangerous shape is not the broken one: it is valid JSON, under a
    // 200, that is not what the route promises — a proxy's own body, a
    // gateway of another version, an error envelope somebody added. Read
    // without checking, it becomes a published card that was never published.
    const coinslot = await gatewayServing({
      publish_card: () => ({ status: 200, text: JSON.stringify({ accepted: true }) }),
    });

    await expect(coinslot.catalog.publish(card)).rejects.toThrow(/document it promises/);
  });
});

describe("reading orders back", () => {
  it("reads one order and the state it is in", async () => {
    const coinslot = await gatewayServing({
      get_order: () => ({ body: { ...order, status: "in_progress" } }),
    });

    const read = await coinslot.orders.get("order-1");

    expect(read.status).toBe("in_progress");
    expect(gateway?.callsTo("get_order")[0]?.params).toStrictEqual({ order_id: "order-1" });
  });

  it("encodes an identifier that carries a slash or a space", async () => {
    // The contract accepts "SKU 100/1" as an identifier, and pasted into an
    // address unencoded it becomes two segments and a different route.
    const coinslot = await gatewayServing({
      get_order: (call) => ({
        body: { ...order, id: call.params.order_id ?? "", status: "delivered" },
      }),
    });

    await coinslot.orders.get("SKU 100/1");

    expect(gateway?.callsTo("get_order")[0]?.params).toStrictEqual({ order_id: "SKU 100/1" });
  });

  it("asks for the open orders in the words the query string carries", async () => {
    // The merchant writes a boolean because that is what their language has;
    // the wire carries the two words the contract names. The translation is
    // the SDK's, and a merchant who wrote open=1 by hand would silently
    // receive every order and reconcile against the wrong list.
    const coinslot = await gatewayServing({ list_orders: () => ({ body: { orders: [] } }) });

    await coinslot.orders.list({ open: true });
    await coinslot.orders.list({ open: false });
    await coinslot.orders.list();

    expect(gateway?.callsTo("list_orders").map((call) => call.query)).toStrictEqual([
      { open: "true" },
      { open: "false" },
      {},
    ]);
  });
});

describe("closing an order the merchant took on", () => {
  it("delivers and hands back the word the gateway used", async () => {
    const coinslot = await gatewayServing({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    const result = await coinslot.orders.deliver("order-1", {
      access_url: "https://example.com/a",
    });

    expect(result).toStrictEqual({ ok: true, result: "delivered" });
    expect(gateway?.callsTo("deliver_order")[0]?.body).toStrictEqual({
      access_url: "https://example.com/a",
    });
  });

  it("returns a refusal of the call rather than throwing it", async () => {
    // The portal promises that these errors are returned and carry whether a
    // repeat could help. A merchant who had to catch them would write a retry
    // loop around a case that no repeat changes.
    const error = {
      code: "refund_already_settled",
      message: "the debt was paid back",
      retryable: false,
    };
    const coinslot = await gatewayServing({
      deliver_order: () => ({ status: 409, body: { ok: false, error } }),
    });

    const result = await coinslot.orders.deliver("order-1", {
      access_url: "https://example.com/a",
    });

    expect(result).toStrictEqual({ ok: false, error });
  });

  it("turns a gateway that did not answer into a retryable error, not an exception", async () => {
    // Same promise, one layer down: a dropped connection is the case the
    // retryable flag exists for, and it must reach the merchant through the
    // same branch as everything else these calls answer with.
    const coinslot = await gatewayServing({
      refuse_order: () => ({ status: 502, text: "bad gateway" }),
    });

    const result = await coinslot.orders.refuse("order-1", {
      code: "out_of_stock",
      message: "Поставщик не подтвердил номер",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.retryable).toBe(true);
    expect(result.ok === false && result.error.message).toMatch(/refuse_order/);
  });

  it("does not read an order call's answer out of a document that is not one", async () => {
    // The same trap on the branch that returns rather than throws: a body
    // that parses and is not the answer would otherwise become a delivery
    // the merchant believes went through.
    const coinslot = await gatewayServing({
      deliver_order: () => ({ text: JSON.stringify({ ok: "yes", result: "delivered" }) }),
    });

    const result = await coinslot.orders.deliver("order-1", { access_url: "https://a.example" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.retryable).toBe(true);
    // The gateway did answer — this is a body we cannot read, not a call that
    // never arrived, and the two are different facts about the merchant's books.
    expect(result.ok === false && result.error.code).toBe(ANSWER_NOT_UNDERSTOOD);
  });

  it("keeps three different facts about a failed call apart", async () => {
    // They are three different things to know about one's own books. A call
    // that was refused a connection certainly delivered nothing. A call
    // answered in words we cannot read reached us and may well have done its
    // work. A call sent into silence is neither, and telling a merchant it did
    // not arrive would be inventing the one fact they came here for.
    const answering = await gatewayServing({
      deliver_order: () => ({ text: "<html>gateway timeout</html>" }),
    });
    const answered = await answering.orders.deliver("order-1", { access_url: "https://a.example" });

    expect(answered.ok === false && answered.error.code).toBe(ANSWER_NOT_UNDERSTOOD);
    expect(answered.ok === false && answered.error.message).toMatch(/reached us/);

    // An address that was listening a moment ago and is not any more: the
    // connection is refused, so nothing was handed over.
    const closed = await startFakeGateway({ apiKey: API_KEY, routes: {} });
    await closed.close();

    const gone = createClient({ apiKey: API_KEY, baseUrl: closed.url });
    const never = await gone.orders.deliver("order-1", { access_url: "https://a.example" });

    expect(never.ok === false && never.error.code).toBe(CALL_DID_NOT_REACH_US);
    expect(never.ok === false && never.error.retryable).toBe(true);
    expect(never.ok === false && never.error.message).toMatch(/did not reach us/);
  });

  it("takes an order on, with and without an expected time", async () => {
    const coinslot = await gatewayServing({ accept_order: () => ({ body: { ok: true } }) });

    expect(await coinslot.orders.accept("order-1", { eta_seconds: 60 })).toStrictEqual({
      ok: true,
    });
    expect(await coinslot.orders.accept("order-1")).toStrictEqual({ ok: true });

    expect(gateway?.callsTo("accept_order").map((call) => call.body)).toStrictEqual([
      { eta_seconds: 60 },
      {},
    ]);
  });
});

describe("the door on every call", () => {
  it("presents the merchant's key on the calls that are behind it", async () => {
    // The fake gateway refuses a call behind the merchant's door that arrives
    // without the key, so this passing is the assertion.
    const coinslot = await gatewayServing({ list_orders: () => ({ body: { orders: [] } }) });

    await coinslot.orders.list();

    expect(gateway?.callsTo("list_orders")[0]?.apiKey).toBe(API_KEY);
  });
});

describe("what a failed call says about whether it arrived", () => {
  it("claims nothing was sent only when every address tried says so", () => {
    // A name that resolves to more than one address is tried at each of them,
    // and what comes back is one error holding the others. If one of those
    // attempts got as far as a connection, nothing was refused outright and
    // the honest answer is that we do not know — read the other way, a
    // merchant would be told their delivery certainly never arrived on the
    // strength of one address out of two.
    const failing = (...codes: string[]): unknown => ({
      cause: codes.length === 1 ? { code: codes[0] } : { errors: codes.map((code) => ({ code })) },
    });

    expect(reachOf(failing("ECONNREFUSED"))).toBe(REACH.NOT_RECEIVED);
    expect(reachOf(failing("ECONNREFUSED", "ENOTFOUND"))).toBe(REACH.NOT_RECEIVED);
    expect(reachOf(failing("ECONNREFUSED", "ECONNRESET"))).toBe(REACH.UNKNOWN);
    expect(reachOf(failing("ECONNRESET"))).toBe(REACH.UNKNOWN);
    expect(reachOf(failing())).toBe(REACH.UNKNOWN);
    expect(reachOf(new Error("something with no cause at all"))).toBe(REACH.UNKNOWN);
    expect(reachOf(undefined)).toBe(REACH.UNKNOWN);
  });
});
