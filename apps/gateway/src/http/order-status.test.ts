/**
 * The one door in this gateway that is the agent's.
 *
 * An agent that buys a product whose goods come later pays, and the answer it
 * gets carries an order and no goods, because the goods do not exist yet. This
 * route is how it comes back for them. ADR-0011 settles who may ask: knowing
 * the order's identifier is the proof, so the call takes no key and answers
 * about that order and no other.
 *
 * Three things are being held here and each of them is a way the route goes
 * wrong quietly. It must ask for no key — the merchant's door attached to the
 * `/v0/orders` prefix, where every other route is the merchant's, would shut
 * the agent out of the one route that is its own. It must read an order
 * whoever sold it, without that becoming a way of learning who the merchants
 * are. And it must carry what the buyer is owed and nothing else: an answer
 * assembled from the merchant's own view of the order would hand a stranger the
 * merchant's key for the product and the buyer's own parameters back.
 */

import type { AgentOrderStatus, Card, Delivery } from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buyOverHttp,
  type Harness,
  harness,
  type SeededMerchant,
  type Served,
  serve,
  THE_MERCHANT_KEY,
} from "../testing/harness.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

/** A card whose goods come later: the money moves at the purchase, the eSIM does not. */
const laterCard: Card = {
  merchant_item_id: "esim-30d",
  title: "An eSIM for thirty days",
  description: "Thirty days of data, delivered to the address given at purchase",
  price: { amount: "80.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

/** A card delivered on the call itself, which is what makes an unpaid delivery possible. */
const nowCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

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

const publish = async (
  served: Served,
  card: Card,
  headers: Record<string, string> = { authorization: `Bearer ${THE_MERCHANT_KEY}` },
): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", { body: card, headers });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { ok: { id: string } }).ok.id;
};

/** An order of a card whose goods come later, taken on by its merchant and not yet delivered. */
const orderTakenOn = async (
  harnessed: Harness,
  served: Served,
  itemId: string,
  merchantId?: string,
): Promise<string> => {
  const bought = await buyOverHttp(harnessed, served, itemId, {
    ...(merchantId === undefined ? {} : { merchantId }),
    onOrder: () => ({ accepted: {} }),
  });
  expect(bought.status, JSON.stringify(bought.body)).toBe(200);
  // The purchase answers in the same document this route does, so the
  // identifier to come back with is read off the answer the same way here as
  // an agent would read it there.
  return (bought.body as AgentOrderStatus).order_id;
};

const statusOf = async (served: Served, orderId: string, headers?: Record<string, string>) =>
  served.call("GET", `/v0/orders/${orderId}/status`, headers === undefined ? {} : { headers });

describe("coming back for goods that were not ready", () => {
  it("tells the buyer where an order stands before the merchant has issued anything", async () => {
    // The gap this route closes. The purchase answered with an order and no
    // goods, and until now there was nothing an agent could ask afterwards.
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const answered = await statusOf(served, orderId);

    expect(answered.status).toBe(200);
    const status = answered.body as AgentOrderStatus;
    expect(status.order_id).toBe(orderId);
    // Not a refusal and not a promise: the purchase is running. An agent that
    // had to read this as an ending would write off a sale still going through.
    expect(status.status).toBe("in_progress");
    expect(status.delivered).toBeNull();
    // The money moved at the purchase, so what it cost is a fact already.
    expect(status.price?.amount).toBe("80.00");
    expect(status.price?.currency).toBe("USD");
  });

  it("hands over the goods once the merchant has issued them", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const delivered = await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: { activation_code: "LPA:1$example.com$ACTIVATE" },
      headers: keyOf(harnessed.merchant),
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);

    const answered = await statusOf(served, orderId);

    expect(answered.status).toBe(200);
    const status = answered.body as AgentOrderStatus;
    expect(status.status).toBe("delivered");
    expect(status.delivered).toStrictEqual({ activation_code: "LPA:1$example.com$ACTIVATE" });
  });

  it("will not hand over goods the buyer has not paid for", async () => {
    // A synchronous delivery whose charge failed. The goods exist and the
    // purchase itself refused to hand them over, because nothing was paid; the
    // order stays open until a repeat purchase carries the payment through.
    // Answering this door with them would be a way of collecting for free
    // anything a failed charge left behind.
    const { served, harnessed } = await started();
    harnessed.facilitator.willSettle({ settled: false, reason: "the transfer reverted" });
    const itemId = await publish(served, nowCard);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const orderId = (bought.body as { order_id: string }).order_id;
    expect(orderId, JSON.stringify(bought.body)).toBeTypeOf("string");

    const answered = await statusOf(served, orderId);

    const status = answered.body as AgentOrderStatus;
    expect(status.status).toBe("delivered_unpaid");
    expect(status.delivered).toBeNull();
    expect(JSON.stringify(answered.body)).not.toContain("SESAME");
  });
});

describe("the door on the agent's route", () => {
  it("answers the same to a key, to somebody else's key, and to no key", async () => {
    // An agent has no key, no account and no registration, and the product
    // exists so that it needs none: the call with nothing in the header is
    // answered, which is what the last line here says. The rest is the half
    // that catches a door attached to the `/v0/orders` prefix — whatever
    // travels in the authorization header, this route neither opens nor closes
    // on it. A junk key is refused everywhere else in this gateway and is
    // ignored here.
    const { served, harnessed } = await started();
    const other = await harnessed.addMerchant("Another merchant");
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const withNone = await statusOf(served, orderId);
    const withOwn = await statusOf(served, orderId, keyOf(harnessed.merchant));
    const withStranger = await statusOf(served, orderId, keyOf(other));
    const withJunk = await statusOf(served, orderId, {
      authorization: "Bearer a-key-that-was-never-issued",
    });

    for (const answered of [withOwn, withStranger, withJunk]) {
      expect(answered.status).toBe(withNone.status);
      expect(answered.body).toStrictEqual(withNone.body);
    }
    expect(withNone.status).toBe(200);
  });
});

describe("what the answer carries", () => {
  it("reads an order whichever merchant sold it, and names none of them", async () => {
    // The route has no key, so it has no merchant to be scoped to, and it must
    // not become a way of learning who the merchants are or what they call
    // their products. What comes back is the buyer's own purchase: where it
    // stands, what it cost, and the goods.
    const { served, harnessed } = await started();
    const seller = await harnessed.addMerchant("Not the harness's own seller");
    const itemId = await publish(served, laterCard, keyOf(seller));
    const orderId = await orderTakenOn(harnessed, served, itemId, seller.id);

    const answered = await statusOf(served, orderId);

    expect(answered.status).toBe(200);
    expect(Object.keys(answered.body as object).sort()).toStrictEqual([
      "delivered",
      "order_id",
      "price",
      "status",
      "test",
    ]);
    const written = JSON.stringify(answered.body);
    // Whose sale it is, what they call the product, and which card it came from
    // are all things a stranger holding an identifier learns nothing about.
    expect(written).not.toContain(seller.id);
    expect(written).not.toContain("A seller who is not the harness's own");
    expect(written).not.toContain("esim-30d");
    expect(written).not.toContain(itemId);
  });
});

describe("an identifier that names nothing", () => {
  it("answers it exactly as it answers any other, saying only that there is no such order", async () => {
    // The route tells nobody apart, so it must not tell identifiers apart
    // either: two guesses come back byte for byte the same, and neither says
    // whether the string was ever an order of anybody's.
    const { served } = await started();

    const first = await statusOf(served, "ord_nothing_here");
    const second = await statusOf(served, "ord_nor_here");

    expect(first.status).toBe(404);
    expect(first.body).toStrictEqual({
      error: { code: "no_such_order", message: "there is no such order" },
    });
    expect(second.body).toStrictEqual(first.body);
  });

  it("has one refusal and not two, so an unknown identifier is never told from a forbidden one", async () => {
    // What this route can and cannot hide, said plainly, because the two are
    // easy to run together.
    //
    // It cannot hide that an identifier names an order. The identifier is the
    // proof, so a real one has to be answered, and the answer is visibly not
    // the refusal — that is the door working, and no arrangement of codes
    // changes it. What the decision leans on instead is that the identifier is
    // long and random, so walking them finds nothing.
    //
    // What it can hide, and does, is the second refusal: there is no "this
    // order exists and is not yours" anywhere on this route, because there is
    // no such thing here — nothing is scoped to a caller. So the one refusal
    // covers every identifier that does not resolve, and the test above holds
    // that two of those are answered byte for byte alike.
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const real = await statusOf(served, orderId);
    const invented = await statusOf(served, `${orderId}_no`);
    const nothingLikeOne = await statusOf(served, "not-an-order-at-all");

    expect(real.status).toBe(200);
    // Every identifier that resolves to nothing gets the one refusal, whatever
    // it looks like: a near-miss of a real order and a string that was never
    // shaped like one are not told apart either.
    expect(invented.status).toBe(404);
    expect(nothingLikeOne.body).toStrictEqual(invented.body);
    expect((invented.body as { error: { code: string } }).error.code).toBe("no_such_order");
  });
});

describe("the goods as the merchant wrote them", () => {
  it("hands the delivery back unchanged", async () => {
    // What the merchant handed over is what the buyer collects. A delivery
    // reshaped on the way out is the one thing an agent cannot check against
    // anything, because it holds nothing else about the order.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...laterCard,
      result: {
        activation_code: { type: "string" },
        valid_until: { type: "string" },
      },
    });
    const orderId = await orderTakenOn(harnessed, served, itemId);
    const goods: Delivery = {
      activation_code: "LPA:1$example.com$ACTIVATE",
      valid_until: "2026-09-26",
    };

    await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: goods,
      headers: keyOf(harnessed.merchant),
    });

    expect((await statusOf(served, orderId)).body).toStrictEqual({
      order_id: orderId,
      status: "delivered",
      price: {
        amount: "80.00",
        currency: "USD",
        at: "2026-08-26T12:00:00.000Z",
        as_of: "2026-08-26T12:00:00.000Z",
      },
      delivered: goods,
      // Every order the pilot writes is a test order, and the buyer's own view
      // of a purchase says so — every other field here reads the same whether
      // the charge was real or not.
      test: true,
    });
  });
});
