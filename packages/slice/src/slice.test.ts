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

import { deliveryCheckFor, ReceiptSchema } from "@coinslot/contracts";
import { ScriptedFacilitator } from "@coinslot/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeBuyer } from "./buyer.js";
import { EUROPE_ESIM, RENTED_NUMBER } from "./cards.js";
import { type Booted, bootGateway, SLICE_MERCHANT_KEY } from "./gateway-harness.js";
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

  it("hands the goods to the agent through its own door, on the order identifier alone", async () => {
    // ADR-0011's door, walked by the kind of code it exists for. The test
    // above collects the same sale through the merchant's own routes, which is
    // the merchant's view of it; this one is the buyer's, and it is the only
    // view an agent has.
    //
    // The merchant still has to deliver, and that call below is this test
    // driving the world rather than the agent reading it — an agent cannot
    // make a merchant issue anything. What is asserted is the other half:
    // where the order stands and what the buyer ended up holding are read from
    // `buyer.status` alone, with no key and no look inside the store.
    const catalog = await buyer.catalog();
    const esim = catalog.find((card) => card.title === EUROPE_ESIM.title);
    if (esim === undefined) throw new Error("the eSIM is not in the catalog");

    const bought = await buyer.buy(esim.id, { email: "buyer@example.com" });
    expect(bought.status).toBe(200);
    const orderId = fields(fields(bought.body).order).id;
    if (typeof orderId !== "string") throw new Error("the purchase returned no order id");

    // Paid for and not delivered. The word for a purchase still running exists
    // so that an agent does not read a running sale as a refused one.
    const waiting = await buyer.status(orderId);
    expect(waiting.status).toBe(200);
    expect(waiting.state).toBe("in_progress");
    expect(waiting.delivered).toBeNull();

    // The merchant issues the profile in its own time — nothing the agent does
    // or can hurry.
    await waitFor(() => merchant.acceptedOrders.has(orderId));
    expect(await merchant.deliverAccepted(orderId)).toStrictEqual({
      ok: true,
      result: "delivered",
    });

    // The agent comes back the only way it can, and the goods are there.
    let collected = await buyer.status(orderId);
    const deadline = Date.now() + 10_000;
    while (collected.state === "in_progress" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      collected = await buyer.status(orderId);
    }

    expect(collected.state).toBe("delivered");
    expect(() => deliveryCheckFor(EUROPE_ESIM).parse(collected.delivered)).not.toThrow();
    expect(fields(collected.delivered).activation_code).toMatch(/^LPA:/);

    // The answer is the buyer's own and not the merchant's: the five fields an
    // agent is owed and nothing beside them. A door that handed over more
    // would be a way of reading somebody else's business off an identifier.
    expect(Object.keys(fields(collected.body)).sort()).toStrictEqual([
      "delivered",
      "order_id",
      "price",
      "status",
      "test",
    ]);
    expect(fields(fields(collected.body).price).amount).toBe("8.00");
    // The word that keeps this from reading as proof of a payment that moved
    // money. On the scripted facilitator none did.
    expect(fields(collected.body).test).toBe(true);
  }, 20_000);

  it("refuses an order identifier that names nothing, in the words the contract promises", async () => {
    // The negative control for the agent's door. An identifier that resolves
    // to no order is answered with one refusal and no detail — and a second
    // guess is answered identically, so nobody counts the orders behind it by
    // asking. If this ever answered two different ways, the door would be a
    // way of telling a real order from an invented one.
    const invented = await buyer.status("ord_never_issued");

    expect(invented.status).toBe(404);
    expect(invented.state).toBeNull();
    expect(invented.delivered).toBeNull();
    expect(invented.body).toStrictEqual({
      error: { code: "no_such_order", message: "there is no such order" },
    });

    const another = await buyer.status("ord_nor_this_one");
    expect(another.status).toBe(invented.status);
    expect(another.body).toStrictEqual(invented.body);
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
