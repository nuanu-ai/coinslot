/**
 * The stage-one gate: a sandbox purchase, green from catalog to receipt.
 *
 * Two cycles, each walked end to end by the real parts and nothing stubbed
 * between them. The gateway is the real gateway, booted in this process on the
 * real HTTP surface with its own in-memory store and queue and a scripted
 * facilitator, so the suite stays free, offline and the same every time. The
 * merchant is the real SDK — `createClient`, `on('order')`, `on('quote')` and
 * `start` — answering as a merchant's own process would. The buyer is
 * the official x402 client, signing with a throwaway key and walking the
 * offer → pay → settle exchange against the surface an agent actually calls.
 *
 * What each test asserts is the promise, not the mechanism: that an agent
 * holding only the catalog can buy a product and receive what the card said it
 * would, that the money moves the way the card's mode says it does and never
 * more than once, and that the receipt and the order status tell the truth at
 * each step. If either test goes red, a purchase that a merchant was told would
 * work does not.
 */

import { type Card, deliveryCheckFor, ReceiptSchema } from "@coinslot/contracts";
import { ScriptedFacilitator } from "@coinslot/gateway";
import { WORKER_PROBLEM_KINDS } from "@coinslot/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeBuyer } from "./buyer.js";
import { EUROPE_ESIM, RENTED_NUMBER } from "./cards.js";
import { type Booted, bootGateway, SLICE_MERCHANT_KEY, sliceEnv } from "./gateway-harness.js";
import { type MockMerchant, startMerchant } from "./merchant.js";

/**
 * A public, valueless test key (the first well-known local-devnet account). It
 * signs the buyer's authorisations offline; against the scripted facilitator no
 * money moves, so nothing here depends on it holding anything.
 */
const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Reads a JSON body into a shape the assertions can index without `any`. */
const fields = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null) {
    throw new Error(`expected a JSON object body, got ${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
};

/** Polls until the predicate holds or the deadline passes, without busy-waiting. */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 10_000, everyMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(`waited ${timeoutMs}ms and the condition never held`);
}

describe("the stage-one gate: a sandbox purchase, green from catalog to receipt", () => {
  let booted: Booted;
  let facilitator: ScriptedFacilitator;
  let merchant: MockMerchant;
  let buyer: ReturnType<typeof makeBuyer>;

  beforeEach(async () => {
    facilitator = new ScriptedFacilitator();
    booted = await bootGateway(() => facilitator);
    merchant = startMerchant(booted.baseUrl, SLICE_MERCHANT_KEY);
    await merchant.start();
    await merchant.publishCatalog();
    buyer = makeBuyer({ baseUrl: booted.baseUrl, privateKey: TEST_BUYER_KEY, maxUsd: 50 });
  });

  afterEach(async () => {
    // The server is closed even if stopping the merchant throws, so a failed
    // teardown of one test does not leak a listener into the next.
    try {
      await merchant.stop();
    } finally {
      await booted.stop();
    }
  });

  it("sells a synchronous rented number: catalog → quote → verify → deliver → settle → receipt", async () => {
    // The agent reads the catalog and finds both products projected from the
    // cards the merchant published.
    const catalog = await buyer.catalog();
    expect(catalog.map((card) => card.title).sort()).toStrictEqual(
      [RENTED_NUMBER.title, EUROPE_ESIM.title].sort(),
    );

    const rented = catalog.find((card) => card.title === RENTED_NUMBER.title);
    if (rented === undefined) throw new Error("the rented number is not in the catalog");
    // The card tells the agent, before it pays, that this price is checked at
    // the purchase — the quote step is advertised, not a surprise.
    expect(rented.fulfillment).toBe("sync");
    expect(rented.price_checked_at_purchase).toBe(true);
    expect(rented.price.amount).toBe("3.00");

    // The buyer walks the whole exchange: unpaid → 402 with the challenge →
    // signed payment → the goods themselves.
    const bought = await buyer.buy(rented.id, { area_code: "415" });

    expect(bought.status).toBe(200);

    // The goods are the card's declared result and nothing else, so an agent
    // holding only the card can read them.
    const delivered = fields(bought.body).delivered;
    expect(() => deliveryCheckFor(RENTED_NUMBER).parse(delivered)).not.toThrow();
    expect(fields(delivered).phone_number).toMatch(/^\+1415/);

    // The receipt is proof of a delivered purchase in test money, and it
    // carries the price the sale actually went through at — the merchant's
    // quoted 3.50, not the card's 3.00 snapshot. That difference is the quote
    // having happened.
    const receipt = ReceiptSchema.parse(fields(bought.body).receipt);
    expect(receipt.outcome).toBe("delivered");
    expect(receipt.test).toBe(true);
    expect(receipt.price.amount).toBe("3.50");

    // The money was verified once and executed once, and — this is the
    // synchronous promise — the settle came after the goods, not before.
    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toHaveLength(1);
    expect(bought.settlement?.success).toBe(true);
    expect(bought.settlement?.transaction).toMatch(/^0x/);

    // A clean run: the merchant's worker reported nothing it could not do.
    expect(merchant.problems).toStrictEqual([]);
  }, 20_000);

  it("sells an asynchronous eSIM: pay-now settles at purchase, merchant accepts, then delivers later", async () => {
    const catalog = await buyer.catalog();
    const esim = catalog.find((card) => card.title === EUROPE_ESIM.title);
    if (esim === undefined) throw new Error("the eSIM is not in the catalog");
    expect(esim.fulfillment).toBe("async");
    // This one is sold at its published price: no quote, so the number the
    // agent compares is the number it pays.
    expect(esim.price_checked_at_purchase).toBe(false);
    expect(esim.price.amount).toBe("8.00");

    // The purchase: the money moves at the buy, buyer → merchant, once.
    const bought = await buyer.buy(esim.id, { email: "buyer@example.com" });

    expect(bought.status).toBe(200);
    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toHaveLength(1);

    // The agent is handed an order and, honestly, no receipt yet: the receipt
    // is written when the order reaches an ending, and this one has only just
    // been paid for. The order carries the price the money moved at.
    const order = fields(fields(bought.body).order);
    const orderId = order.id;
    if (typeof orderId !== "string") throw new Error("the purchase returned no order id");
    expect(fields(order.price).amount).toBe("8.00");
    expect(fields(bought.body).receipt).toBeNull();

    // The merchant's own worker takes the order on. Its status to the agent is
    // "in progress" — taken on is not delivered, and the fifth gate says an
    // unfinished order must not read as a refused one.
    await waitFor(async () => {
      const stored = await booted.gateway.runtime.store.orderById(orderId);
      return (
        stored !== null && stored.order.state === "dispatched" && stored.order.dispatch.accepted
      );
    });
    expect(merchant.acceptedOrders.has(orderId)).toBe(true);
    expect((await merchant.client.orders.get(orderId)).status).toBe("in_progress");

    // Later, the merchant issues the profile through the explicit deliver
    // call — the asynchronous mode's closure verb, the merchant's to make.
    const delivered = await merchant.deliverAccepted(orderId);
    expect(delivered).toStrictEqual({ ok: true, result: "delivered" });

    // The order is delivered now, to the agent and in the record.
    expect((await merchant.client.orders.get(orderId)).status).toBe("delivered");

    const finalOrder = await booted.gateway.runtime.store.orderById(orderId);
    if (finalOrder === null) throw new Error("the delivered order vanished");
    expect(() => deliveryCheckFor(EUROPE_ESIM).parse(finalOrder.delivery)).not.toThrow();
    expect(fields(finalOrder.delivery).activation_code).toMatch(/^LPA:/);

    // The receipt now exists and says delivered, in test money, at the price
    // the money moved at.
    const receipt = await booted.gateway.runtime.store.receiptForOrder(orderId);
    const parsedReceipt = ReceiptSchema.parse(receipt);
    expect(parsedReceipt.outcome).toBe("delivered");
    expect(parsedReceipt.test).toBe(true);
    expect(parsedReceipt.price.amount).toBe("8.00");

    // The happy asynchronous path carries no wire event: the event channel is
    // for the things a merchant would otherwise only find by reconciling by
    // hand — a refund owed, a confirmation left unpaid — and none of those
    // happened here.
    expect(merchant.events).toStrictEqual([]);

    // And a clean run: the merchant's worker reported nothing at all. This is
    // the assertion the seam between the gateway and the SDK is checked at.
    // Accepting from inside the handler posts the acceptance to the answer
    // route like any other answer, and the worker reports to the merchant
    // anything that route does not call a success — so a route with no word
    // for a successful acceptance writes a problem against every asynchronous
    // order that goes through perfectly well. An empty list is the only
    // assertion that keeps saying so; a tolerated entry would let the next one
    // through with it.
    expect(merchant.problems).toStrictEqual([]);
  }, 20_000);

  it("a refused payment moves no money and hands over no goods: the synchronous refusal is free", async () => {
    // The negative control for the money-safety promise. In the synchronous
    // mode the payment is verified before the merchant is asked and executed
    // only after the goods come back, so a payment the layer will not vouch
    // for must cost the buyer nothing: no charge, no goods, the order left to
    // end on its own deadline.
    facilitator.willRefuseVerification("signature", "scripted refusal for the negative control");

    const catalog = await buyer.catalog();
    const rented = catalog.find((card) => card.title === RENTED_NUMBER.title);
    if (rented === undefined) throw new Error("the rented number is not in the catalog");

    const bought = await buyer.buy(rented.id, { area_code: "415" });

    // No goods, no settlement receipt, and not the success status.
    expect(bought.status).not.toBe(200);
    expect(fields(bought.body).delivered).toBeUndefined();
    expect(bought.settlement).toBeNull();

    // The payment was put to the layer once and turned away, and — the point
    // of the control — nothing was ever charged.
    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toStrictEqual([]);
  }, 20_000);
});

/**
 * A card the merchant sells and cannot fill.
 *
 * A second rented number, correct in every way an agent can see and published
 * like any other, for which nothing in the merchant's handler branches: their
 * code knows `rented-number-us-30d` and this is the UK one. That is the
 * ordinary shape of the mistake — a product added to the catalog and not to
 * the code, or taken out of the code and left in the catalog — and it is the
 * one the merchant's own handler already calls a defect worth surfacing.
 */
const UNSTAFFED_NUMBER: Card = {
  merchant_item_id: "rented-number-uk-30d",
  title: "Rented UK phone number, 30 days",
  description:
    "A UK phone number rented for 30 days, for receiving SMS one-time codes. The number is released at the end of the term; renewal is not included.",
  price: { amount: "4.00", currency: "USD" },
  result: {
    phone_number: { type: "string", title: "The rented number, in E.164 form" },
    valid_until: { type: "string", title: "When the rental ends (ISO 8601)" },
  },
  fulfillment: "sync",
};

describe("the same slice when the merchant's own code cannot fill the order", () => {
  let booted: Booted;
  let facilitator: ScriptedFacilitator;
  let merchant: MockMerchant;
  let buyer: ReturnType<typeof makeBuyer>;

  beforeEach(async () => {
    facilitator = new ScriptedFacilitator();
    // The synchronous deadlines, shortened together so they still satisfy the
    // gateway's own rule that the price wait fits inside the answer wait and
    // both fit inside the budget. This is the one test here that runs a
    // deadline out on purpose, and at the shipped numbers it would sit for ten
    // seconds waiting for goods that are never coming.
    booted = await bootGateway(
      () => facilitator,
      sliceEnv({
        QUOTE_RESPONSE_MS: "500",
        SYNC_RESPONSE_MS: "1000",
        SETTLE_RESPONSE_MS: "500",
        SYNC_BUDGET_MS: "1500",
      }),
    );
    merchant = startMerchant(booted.baseUrl, SLICE_MERCHANT_KEY);
    await merchant.start();
    await merchant.publishCatalog();
    buyer = makeBuyer({ baseUrl: booted.baseUrl, privateKey: TEST_BUYER_KEY, maxUsd: 50 });
  });

  afterEach(async () => {
    try {
      await merchant.stop();
    } finally {
      await booted.stop();
    }
  });

  it("tells the merchant which order went unfilled, and charges the buyer nothing", async () => {
    // The failure side of the seam the two tests above check by asserting an
    // empty problem list. An empty list says the gateway and the SDK agree
    // about a purchase that worked; it says nothing about whether anything can
    // come the other way. This is the other direction: something the merchant
    // has to act on, from the gateway, through the SDK, onto the list — and if
    // it does not arrive, a merchant whose catalog has outgrown their handler
    // sells a product silently, forever, and hears about it from a buyer.
    //
    // The money half is the same promise the refused-payment control makes,
    // from the other end. There the payment layer said no; here the payment is
    // good and the merchant is the one who cannot deliver, and in the
    // synchronous mode the charge is executed only after the goods come back.
    // No goods, no charge.
    const published = await merchant.client.catalog.publish(UNSTAFFED_NUMBER);
    if (!("ok" in published)) {
      throw new Error(`publishing the unstaffed card was refused: ${JSON.stringify(published)}`);
    }

    const catalog = await buyer.catalog();
    const unstaffed = catalog.find((card) => card.title === UNSTAFFED_NUMBER.title);
    if (unstaffed === undefined) throw new Error("the unstaffed card is not in the catalog");

    const bought = await buyer.buy(unstaffed.id, {});

    // The buyer paid for nothing and was charged for nothing: the payment was
    // verified, the goods never came, and the charge was never executed.
    expect(bought.status).not.toBe(200);
    expect(fields(bought.body).delivered).toBeUndefined();
    expect(bought.settlement).toBeNull();
    expect(facilitator.verifies.length).toBeGreaterThanOrEqual(1);
    expect(facilitator.settles).toStrictEqual([]);

    // And the merchant was told. Not eventually and not in a log nobody reads:
    // on the problem channel their own `on('problem')` subscribes to.
    await waitFor(() => merchant.problems.length > 0);

    const dropped = merchant.problems.find(
      (problem) => problem.kind === WORKER_PROBLEM_KINDS.HANDLER_FAILED,
    );

    if (dropped === undefined) {
      throw new Error(
        `no handler failure reached the merchant; what did: ${JSON.stringify(
          merchant.problems.map((problem) => problem.kind),
        )}`,
      );
    }

    // Intelligible means three things at once. It names the order, so the
    // merchant can look it up rather than guess which sale this was.
    const subject = dropped.subject;
    expect(typeof subject).toBe("string");
    const stored = await booted.gateway.runtime.store.orderById(String(subject));
    expect(stored?.merchantItemId).toBe(UNSTAFFED_NUMBER.merchant_item_id);

    // It carries what their own code said, so they can find the line.
    expect(dropped.message).toContain(UNSTAFFED_NUMBER.merchant_item_id);
    expect(dropped.message).toContain("no handler for");

    // And it is not fatal, which is checked by selling something rather than
    // by reading a flag: one product the merchant cannot fill must not take
    // down the worker that is still selling the two they can.
    expect(merchant.problems.filter((problem) => problem.fatal)).toStrictEqual([]);

    const esim = (await buyer.catalog()).find((card) => card.title === EUROPE_ESIM.title);
    if (esim === undefined) throw new Error("the eSIM is not in the catalog");

    const afterwards = await buyer.buy(esim.id, { email: "buyer@example.com" });
    const order = fields(fields(afterwards.body).order);

    expect(afterwards.status).toBe(200);
    await waitFor(() => merchant.acceptedOrders.has(String(order.id)));
  }, 20_000);
});
