import type { Card, Order } from "@coinslot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "./index.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";

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

  it("says the gateway address is not decided rather than guessing one", () => {
    // "I do not know" has to be distinguishable from "there is none". Nothing
    // in the contract or in any decision names where the gateway lives, so a
    // client built without an address says exactly that.
    expect(() => createClient({ apiKey: API_KEY })).toThrow(/baseUrl/);
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
