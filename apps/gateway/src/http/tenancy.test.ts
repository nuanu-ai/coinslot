/**
 * Two merchants, over the real HTTP surface.
 *
 * This file exists because of the one failure ADR-0010 names: one merchant
 * seeing another's money. Every test below therefore seeds two merchants and
 * asserts about both of them, and that is not a stylistic preference — a
 * scoping test that seeds one merchant proves nothing at all, because the
 * unscoped implementation this change replaces passes it. If a test here can
 * still pass with a `where merchant_id = ...` taken out of the store, it is
 * theatre and belongs deleted rather than kept.
 *
 * Everything goes through `serve`, so the door, the mounting loop and the flows
 * all run. What is being checked is the answer a merchant's own client would
 * receive, not the shape of a query.
 */

import type { Card, MerchantCardList, Receipt } from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buyOverHttp,
  type Harness,
  harness,
  type SeededMerchant,
  type Served,
  serve,
  workOnce,
} from "../testing/harness.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

/** An instant a quote answer can be stamped with; nothing here reads it back. */
const NOW = "2026-08-26T12:00:00.000Z";

const cardFor = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: `${title}, sold by whoever published this card`,
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

/**
 * A card whose goods come later, which is what leaves an order open.
 *
 * The tests about answering somebody else's order need one that is still
 * waiting for an answer while the assertion runs. On a synchronous card the
 * agent is held on the call until the goods or the budget arrive, so a merchant
 * who only takes the order on would have the test waiting out that budget; here
 * the money moves at the purchase and the call comes straight back.
 */
const laterCardFor = (merchantItemId: string, title: string): Card => ({
  ...cardFor(merchantItemId, title),
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
});

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...overrides });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const keyOf = (merchant: SeededMerchant): Record<string, string> => ({
  authorization: `Bearer ${merchant.key}`,
});

const publish = async (served: Served, merchant: SeededMerchant, card: Card): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: keyOf(merchant),
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { ok: { id: string } }).ok.id;
};

/** Two merchants with a key each and one card each, which is the whole setup. */
async function twoMerchants(served: Served, harnessed: Harness) {
  const a = await harnessed.addMerchant("Merchant A");
  const b = await harnessed.addMerchant("Merchant B");
  const cardA = await publish(served, a, cardFor("a-room", "A's room"));
  const cardB = await publish(served, b, cardFor("b-room", "B's room"));
  return { a, b, cardA, cardB };
}

/** One whole purchase of one card, with that card's own merchant answering. */
const buyFrom = async (
  harnessed: Harness,
  served: Served,
  merchant: SeededMerchant,
  itemId: string,
) =>
  buyOverHttp(harnessed, served, itemId, {
    merchantId: merchant.id,
    onOrder: () => ({ delivered: { access_code: "let-me-in" } }),
  });

describe("what a key can see", () => {
  it("shows each merchant their own cards and none of the other's", async () => {
    const { served, harnessed } = await started();
    const { a, b, cardA, cardB } = await twoMerchants(served, harnessed);

    const seenByA = await served.call("GET", "/v0/cards", { headers: keyOf(a) });
    const seenByB = await served.call("GET", "/v0/cards", { headers: keyOf(b) });

    const idsFor = (answered: { body: unknown }) =>
      (answered.body as MerchantCardList).cards.map((card) => card.id);
    expect(idsFor(seenByA)).toStrictEqual([cardA]);
    expect(idsFor(seenByB)).toStrictEqual([cardB]);
  });

  it("shows each merchant their own orders and none of the other's", async () => {
    const { served, harnessed } = await started();
    const { a, b, cardA, cardB } = await twoMerchants(served, harnessed);

    await buyFrom(harnessed, served, a, cardA);
    await buyFrom(harnessed, served, b, cardB);

    const ordersOf = async (merchant: SeededMerchant) => {
      const answered = await served.call("GET", "/v0/orders", { headers: keyOf(merchant) });
      expect(answered.status).toBe(200);
      return (answered.body as { orders: { merchant_item_id: string }[] }).orders;
    };

    const forA = await ordersOf(a);
    const forB = await ordersOf(b);
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]?.merchant_item_id).toBe("a-room");
    expect(forB[0]?.merchant_item_id).toBe("b-room");
  });

  it("shows each merchant their own receipts and none of the other's", async () => {
    const { served, harnessed } = await started();
    const { a, b, cardA, cardB } = await twoMerchants(served, harnessed);

    await buyFrom(harnessed, served, a, cardA);
    await buyFrom(harnessed, served, b, cardB);

    const receiptsOf = async (merchant: SeededMerchant) => {
      const answered = await served.call("GET", "/v0/receipts", { headers: keyOf(merchant) });
      expect(answered.status).toBe(200);
      return (answered.body as { receipts: Receipt[] }).receipts;
    };

    const forA = await receiptsOf(a);
    const forB = await receiptsOf(b);
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]?.item_id).toBe(cardA);
    expect(forB[0]?.item_id).toBe(cardB);
    // The whole point, said once as a claim rather than inferred from counts.
    expect(forA.map((receipt) => receipt.id)).not.toContain(forB[0]?.id);
  });

  it("answers one merchant's order to the other as though it were not there", async () => {
    const { served, harnessed } = await started();
    const { a, b, cardB } = await twoMerchants(served, harnessed);

    await buyFrom(harnessed, served, b, cardB);
    const ofB = await served.call("GET", "/v0/orders", { headers: keyOf(b) });
    const orderId = (ofB.body as { orders: { id: string }[] }).orders[0]?.id ?? "";
    expect(orderId).not.toBe("");

    const asA = await served.call("GET", `/v0/orders/${orderId}`, { headers: keyOf(a) });

    // The same answer a nonexistent order gets: a stranger learns nothing about
    // whether the identifier they are guessing at names anything.
    expect(asA.status).toBe(404);
    expect((asA.body as { error: { code: string } }).error.code).toBe("no_such_order");
    expect((await served.call("GET", `/v0/orders/${orderId}`, { headers: keyOf(b) })).status).toBe(
      200,
    );
  });

  it("carries both merchants' cards in the one public catalog", async () => {
    // Tenancy is not a split of the buying surface. One catalog across
    // merchants is the product, and a purchase finds its merchant by the card.
    const { served, harnessed } = await started();
    const { cardA, cardB } = await twoMerchants(served, harnessed);

    const answered = await served.call("GET", "/v0/catalog");

    const ids = (answered.body as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).toContain(cardA);
    expect(ids).toContain(cardB);
  });
});

describe("what a key can do", () => {
  it("will not let one merchant pause the other's card", async () => {
    const { served, harnessed } = await started();
    const { a, b, cardB } = await twoMerchants(served, harnessed);

    const asA = await served.call("POST", `/v0/cards/${cardB}/pause`, { headers: keyOf(a) });

    expect(asA.status).toBe(404);
    const stillB = await served.call("GET", "/v0/cards", { headers: keyOf(b) });
    expect((stillB.body as MerchantCardList).cards[0]?.selling).toBe("open");
  });

  it("will not let one merchant answer the other's order", async () => {
    const { served, harnessed } = await started();
    const a = await harnessed.addMerchant("Merchant A");
    const b = await harnessed.addMerchant("Merchant B");
    const cardB = await publish(served, b, laterCardFor("b-later", "B's eSIM"));

    // B's card is bought and B's worker takes the order on rather than
    // delivering it, so there is a live order waiting for an answer.
    await buyOverHttp(harnessed, served, cardB, {
      merchantId: b.id,
      onOrder: () => ({ accepted: {} }),
    });

    const ofB = await served.call("GET", "/v0/orders", { headers: keyOf(b) });
    const orderId = (ofB.body as { orders: { id: string }[] }).orders[0]?.id ?? "";
    expect(orderId).not.toBe("");

    const stolen = await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: { access_code: "not-yours" },
      headers: keyOf(a),
    });

    expect(stolen.status).toBe(404);
    expect((stolen.body as { error: { code: string } }).error.code).toBe("no_such_order");
    // And the goods A tried to hand over are nowhere on B's order.
    const stillB = await served.call("GET", `/v0/orders/${orderId}`, { headers: keyOf(b) });
    expect(JSON.stringify(stillB.body)).not.toContain("not-yours");

    // The same call with goods that do not fit B's card is answered exactly
    // the same way, and this is the half that has to be said out loud. The
    // goods are now weighed against the card that sold the order, and the
    // card is B's — so a check that ran before the order was found to be
    // somebody else's would answer 409 and quote B's own declaration back to
    // A: the order exists, and here is what it was sold as. Whose the order is
    // is settled first, and A learns nothing either way.
    const probed = await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: { nothing_bs_card_declares: "x" },
      headers: keyOf(a),
    });

    expect(probed.status).toBe(404);
    expect((probed.body as { error: { code: string } }).error.code).toBe("no_such_order");
    expect(JSON.stringify(probed.body)).not.toContain("access_code");
    expect(JSON.stringify(probed.body)).not.toContain("b-later");
  });

  it("will not let one merchant refuse or accept the other's order", async () => {
    const { served, harnessed } = await started();
    const a = await harnessed.addMerchant("Merchant A");
    const b = await harnessed.addMerchant("Merchant B");
    const cardB = await publish(served, b, laterCardFor("b-later", "B's eSIM"));

    await buyOverHttp(harnessed, served, cardB, {
      merchantId: b.id,
      onOrder: () => ({ accepted: {} }),
    });
    const ofB = await served.call("GET", "/v0/orders", { headers: keyOf(b) });
    const orderId = (ofB.body as { orders: { id: string }[] }).orders[0]?.id ?? "";

    const refused = await served.call("POST", `/v0/orders/${orderId}/refuse`, {
      body: { code: "out_of_stock", message: "not mine to refuse" },
      headers: keyOf(a),
    });
    const accepted = await served.call("POST", `/v0/orders/${orderId}/accept`, {
      body: {},
      headers: keyOf(a),
    });

    expect(refused.status).toBe(404);
    expect(accepted.status).toBe(404);
    const stillB = await served.call("GET", `/v0/orders/${orderId}`, { headers: keyOf(b) });
    expect((stillB.body as { status: string }).status).toBe("in_progress");
  });

  it("will not let one merchant price the other's purchase while it is still open", async () => {
    // A card that asks its merchant what it costs. The question is B's, and it
    // has to be live when A answers it — a question already answered prices
    // nothing whoever sends it, so answering after the fact would be a test
    // that passes with the ownership check taken out.
    //
    // So B's worker draws the question and does not answer it. A answers it
    // instead, with a price of its own, and then B answers the same question
    // properly: the sale settles at B's number and never at A's.
    const { served, harnessed } = await started({ QUOTE_RESPONSE_MS: "4000" });
    const a = await harnessed.addMerchant("Merchant A");
    const b = await harnessed.addMerchant("Merchant B");
    const asked: Card = { ...cardFor("b-asks", "B's priced room"), price_check: "handler" };
    const cardB = await publish(served, b, asked);

    // Not awaited: this call is parked on the answer to the price question.
    const purchase = served.call("POST", `/v0/items/${cardB}/purchase`, { body: { params: {} } });

    const drawn = await harnessed.gateway.poll(b.id, 10, 2_000);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    const priceId = question?.kind === "quote_request" ? question.payload.price_id : "";
    expect(priceId).not.toBe("");

    const asA = await served.call("POST", `/v0/quotes/${priceId}/answer`, {
      body: { available: true, price: { amount: "1.00", currency: "USD" }, as_of: NOW },
      headers: keyOf(a),
    });
    // Answered in the words a question nobody is holding gets: A learns nothing
    // about whether the identifier names a live sale of somebody else's.
    expect(asA.status).toBe(200);
    expect((asA.body as { used: boolean }).used).toBe(false);

    const asB = await served.call("POST", `/v0/quotes/${priceId}/answer`, {
      body: { available: true, price: { amount: "90.00", currency: "USD" }, as_of: NOW },
      headers: keyOf(b),
    });
    expect((asB.body as { used: boolean }).used).toBe(true);

    const challenged = await purchase;
    expect(challenged.status).toBe(402);
    const orders = await served.call("GET", "/v0/orders", { headers: keyOf(b) });
    expect(
      (orders.body as { orders: { price: { amount: string } }[] }).orders[0]?.price.amount,
    ).toBe("90.00");
  });

  it("keeps one merchant's stop-selling off the other's catalog", async () => {
    const { served, harnessed } = await started();
    const { a, cardA, cardB } = await twoMerchants(served, harnessed);

    const paused = await served.call("POST", "/v0/selling/pause", { headers: keyOf(a) });
    expect(paused.status).toBe(200);

    const catalog = await served.call("GET", "/v0/catalog");
    const ids = (catalog.body as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).not.toContain(cardA);
    expect(ids).toContain(cardB);
  });

  it("keeps one merchant's stop-selling out of the other's purchases", async () => {
    // The catalog is a listing; this is the money. What the order machine is
    // given at the birth of an order is one word for whether the merchant is
    // selling, and whose word it is comes off the card the purchase was made
    // against. Read from the wrong merchant, A pausing would refuse B's sales
    // — or, the other way round, sell A's stock while A had stopped.
    const { served, harnessed } = await started();
    const { a, cardA, cardB } = await twoMerchants(served, harnessed);
    await served.call("POST", "/v0/selling/pause", { headers: keyOf(a) });

    const ofA = await served.call("POST", `/v0/items/${cardA}/purchase`, { body: { params: {} } });
    const ofB = await served.call("POST", `/v0/items/${cardB}/purchase`, { body: { params: {} } });

    expect(ofA.status).toBe(409);
    expect((ofA.body as { error: { code: string } }).error.code).toBe("not_selling");
    // And B, who paused nothing, is still open for business.
    expect(ofB.status).toBe(402);
  });

  it("lets two merchants use the same identifier for different products", async () => {
    // A merchant's own identifier means something only inside their catalog.
    // Held unique across the gateway, the second merchant to publish "sku-1"
    // would edit the first merchant's card.
    const { served, harnessed } = await started();
    const a = await harnessed.addMerchant("Merchant A");
    const b = await harnessed.addMerchant("Merchant B");

    const cardA = await publish(served, a, cardFor("sku-1", "A's product"));
    const cardB = await publish(served, b, cardFor("sku-1", "B's product"));

    expect(cardA).not.toBe(cardB);
    const seenByA = await served.call("GET", "/v0/cards", { headers: keyOf(a) });
    const cards = (seenByA.body as MerchantCardList).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.card.title).toBe("A's product");
  });
});

describe("whose envelope a worker draws", () => {
  it("never hands one merchant's order to the other's worker", async () => {
    // Nobody answers the purchase, which is the point: an order delivered
    // before the other merchant polls leaves an empty stream either way, and
    // an empty draw off an empty stream proves nothing. So the card is one
    // whose goods come later, the money moves at the purchase, and the envelope
    // is still sitting there unanswered when A turns.
    const { served, harnessed } = await started();
    const a = await harnessed.addMerchant("Merchant A");
    const b = await harnessed.addMerchant("Merchant B");
    const cardB = await publish(served, b, laterCardFor("b-later", "B's eSIM"));
    // The worker turning through the purchase is A's, and it draws nothing —
    // its own stream is empty. B's worker never runs, so B's envelope is still
    // waiting when the assertions below are made.
    await buyOverHttp(harnessed, served, cardB, {
      merchantId: a.id,
      onOrder: () => ({ refused: { code: "out_of_stock", message: "not mine" } }),
    });

    const drawnByA = await harnessed.gateway.poll(a.id, 10, 1);
    const drawnByB = await harnessed.gateway.poll(b.id, 10, 1_000);

    expect(drawnByA.envelopes).toStrictEqual([]);
    // And it was there to be drawn the whole time, so A came back empty from a
    // stream that was not.
    expect(drawnByB.envelopes.map((envelope) => envelope.kind)).toStrictEqual(["order"]);
  });

  it("holds an envelope for its own merchant while another's worker polls", async () => {
    // The other half of the same promise: A polling must not consume B's
    // envelope, so B's worker still finds it afterwards.
    const { served, harnessed } = await started();
    const { a, b, cardB } = await twoMerchants(served, harnessed);

    const priced = await served.call("POST", `/v0/items/${cardB}/purchase`, {
      body: { params: {} },
    });
    expect(priced.status).toBe(402);

    // Nothing is dispatched before the payment, so the envelope B is owed comes
    // from the purchase being paid. A worker of A's turns in between.
    const paid = buyOverHttp(harnessed, served, cardB, {
      merchantId: a.id,
      // A's worker would answer if it were ever handed anything, which is what
      // makes this fail loudly rather than by timing out.
      onOrder: () => ({ refused: { code: "out_of_stock", message: "not mine" } }),
    });

    const drawn = await workOnce(
      harnessed,
      { merchantId: b.id, onOrder: () => ({ delivered: { access_code: "let-me-in" } }) },
      2_000,
    );
    await paid;

    expect(drawn).toBeGreaterThan(0);
    const receipts = await served.call("GET", "/v0/receipts", { headers: keyOf(b) });
    expect((receipts.body as { receipts: Receipt[] }).receipts).toHaveLength(1);
  });
});

describe("the merchant's door", () => {
  it("turns away a key nobody was issued", async () => {
    const { served, harnessed } = await started();
    await harnessed.addMerchant("Merchant A");

    const answered = await served.call("GET", "/v0/orders", {
      headers: { authorization: "Bearer a-key-that-was-never-issued" },
    });

    expect(answered.status).toBe(401);
  });

  it("turns away a key that has been disabled, in the words a wrong key gets", async () => {
    // No oracle: "this key exists and is off" and "this key was never a key"
    // are answered identically, or a disabled key becomes a way of confirming
    // that a key was real.
    const { served, harnessed } = await started();
    const a = await harnessed.addMerchant("Merchant A");

    const working = await served.call("GET", "/v0/orders", { headers: keyOf(a) });
    expect(working.status).toBe(200);

    await harnessed.disableKey(a.keyId);

    const refused = await served.call("GET", "/v0/orders", { headers: keyOf(a) });
    const never = await served.call("GET", "/v0/orders", {
      headers: { authorization: "Bearer a-key-that-was-never-issued" },
    });

    expect(refused.status).toBe(401);
    expect(refused.body).toStrictEqual(never.body);
  });

  it("leaves a merchant's other keys working when one of them is disabled", async () => {
    // The whole reason a key is a row rather than a variable: one is revoked
    // without touching any other.
    const { served, harnessed } = await started();
    const a = await harnessed.addMerchant("Merchant A");
    const second = await harnessed.addKey(a.id, "a second key");

    await harnessed.disableKey(a.keyId);

    expect(
      (await served.call("GET", "/v0/orders", { headers: { authorization: `Bearer ${second}` } }))
        .status,
    ).toBe(200);
  });

  it("resolves every one of a merchant's keys to that merchant and none to another", async () => {
    // That A's own key answers with A's cards is the first test in this file.
    // What is here instead is the part it cannot reach: a merchant with more
    // than one key. Each of them is a separate row and each has to name the
    // same merchant, or a merchant issuing a second key for a second worker
    // would find that worker looking at somebody else's catalog.
    const { served, harnessed } = await started();
    const { a, b, cardA, cardB } = await twoMerchants(served, harnessed);
    const secondOfA = await harnessed.addKey(a.id, "a second worker of A's");
    const secondOfB = await harnessed.addKey(b.id, "a second worker of B's");

    const idsSeenWith = async (key: string) => {
      const answered = await served.call("GET", "/v0/cards", {
        headers: { authorization: `Bearer ${key}` },
      });
      expect(answered.status).toBe(200);
      return (answered.body as MerchantCardList).cards.map((card) => card.id);
    };

    expect(await idsSeenWith(secondOfA)).toStrictEqual([cardA]);
    expect(await idsSeenWith(secondOfB)).toStrictEqual([cardB]);
    // And the first keys still answer the same way, so this is two keys naming
    // one merchant rather than the second having replaced the first.
    expect(await idsSeenWith(a.key)).toStrictEqual([cardA]);
    expect(await idsSeenWith(b.key)).toStrictEqual([cardB]);
  });
});
