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

import { ScriptedFacilitator } from "@coinslot/gateway";
import { WORKER_PROBLEM_KINDS } from "@nuanu-ai/coinslot";
import {
  AgentOrderStatusSchema,
  type Card,
  deliveryCheckFor,
  ReceiptSchema,
} from "@nuanu-ai/coinslot-contracts";
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

    // The agent is told what it was charged, in the same answer: the
    // merchant's quoted 3.50 and not the card's 3.00 snapshot. That difference
    // is the quote having happened, and the word beside it is what keeps this
    // from reading as proof of a payment that moved money.
    const answered = AgentOrderStatusSchema.parse(bought.body);
    expect(answered.status).toBe("delivered");
    expect(answered.price?.amount).toBe("3.50");
    expect(answered.test).toBe(true);

    // The receipt is the merchant's record of the same sale, read where a
    // receipt lives — behind the merchant's own key — and it agrees about the
    // price the money moved at.
    const receipt = ReceiptSchema.parse(
      await booted.gateway.runtime.store.receiptForOrder(answered.order_id),
    );
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

    // The agent is handed a running order and, honestly, no goods: the eSIM's
    // profile is issued later, and the answer says so in the word for a
    // purchase that has not finished. It carries the price the money moved at.
    const answered = AgentOrderStatusSchema.parse(bought.body);
    const orderId = answered.order_id;
    expect(answered.status).toBe("in_progress");
    expect(answered.delivered).toBeNull();
    expect(answered.price?.amount).toBe("8.00");

    // And no settlement rides back on this answer, though the money moved. The
    // payment layer signs its receipt onto the answer that follows the charge,
    // and here the charge happened while the order was being opened rather
    // than as the last step of the exchange. So what this agent is told about
    // its own money is the price and the test word, and nothing else — which
    // is what the buy command has to say rather than crediting a settlement
    // that only the synchronous sale gets.
    expect(bought.settlement).toBeNull();

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
    const orderId = AgentOrderStatusSchema.parse(bought.body).order_id;

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

  it("answers a purchase with the document its status door answers with, and no other", async () => {
    // One concept — where your order stands — and one shape for it, whichever
    // door an agent came through. Two shapes for one thing is two readers to
    // write and two chances to read the same sale two ways: an agent that
    // bought and an agent that came back later were being handed different
    // documents about the same order, and only one of them was published.
    //
    // Both cards are walked, and the synchronous one is the half that bites.
    // Its purchase answer carries the goods, so a fork that dropped the
    // delivered-goods rule from one of the two builders would show up here as
    // an order whose goods appear at one door and not at the other. Read on
    // the eSIM alone the comparison is between two documents that both say
    // null, and it would survive that fork without a word.
    const catalog = await buyer.catalog();
    const rented = catalog.find((card) => card.title === RENTED_NUMBER.title);
    const esim = catalog.find((card) => card.title === EUROPE_ESIM.title);
    if (rented === undefined || esim === undefined) {
      throw new Error("the catalog is missing one of the two cards");
    }

    const walked: { what: string; bought: unknown; collected: unknown }[] = [];

    for (const [what, itemId, params] of [
      ["a synchronous sale, delivered on the call", rented.id, { area_code: "415" }],
      ["an asynchronous sale, still running", esim.id, { email: "buyer@example.com" }],
    ] as const) {
      const bought = await buyer.buy(itemId, params);
      expect(bought.status, `${what}: ${JSON.stringify(bought.body)}`).toBe(200);

      const purchased = fields(bought.body);
      const orderId = purchased.order_id;
      if (typeof orderId !== "string") throw new Error(`${what}: the purchase named no order`);

      // Nothing moves either order between its two reads. The rented number is
      // finished by the time the purchase answers, and the eSIM is delivered by
      // an explicit call this test has not made — so both doors are describing
      // the same standing order and every field may be compared.
      const collected = await buyer.status(orderId);

      expect(() => AgentOrderStatusSchema.parse(bought.body), what).not.toThrow();
      expect(() => AgentOrderStatusSchema.parse(collected.body), what).not.toThrow();
      expect(purchased, what).toStrictEqual(fields(collected.body));

      walked.push({
        what,
        bought: purchased.delivered,
        collected: fields(collected.body).delivered,
      });
    }

    // The control on the comparison itself: one of the two orders really did
    // carry goods through both doors, and the other really did carry none. Two
    // orders with nothing in them would agree just as well and prove nothing.
    expect(walked.map((one) => one.bought !== null)).toStrictEqual([true, false]);
    expect(walked.map((one) => one.collected !== null)).toStrictEqual([true, false]);
  }, 30_000);

  it("hands the merchant's own key for the product and the buyer's answers through neither door", async () => {
    // The status door was already built by addition rather than by
    // subtraction, and the purchase was not: it answered with the merchant's
    // own document for the order, which carries their key for the product and
    // the parameters the buyer sent. Whoever holds an order's identifier can
    // read that order (ADR-0011), so an answer assembled from the merchant's
    // record hands all of it to whoever guessed one.
    const catalog = await buyer.catalog();
    const esim = catalog.find((card) => card.title === EUROPE_ESIM.title);
    if (esim === undefined) throw new Error("the eSIM is not in the catalog");

    const email = "buyer@example.com";
    const bought = await buyer.buy(esim.id, { email });
    const purchased = fields(bought.body);
    const orderId = purchased.order_id;
    if (typeof orderId !== "string") throw new Error("the purchase named no order");

    const collected = await buyer.status(orderId);
    const five = ["delivered", "order_id", "price", "status", "test"];

    expect(Object.keys(purchased).sort()).toStrictEqual(five);
    expect(Object.keys(fields(collected.body)).sort()).toStrictEqual(five);

    // Read off the whole body rather than off a field name, because the cost
    // is the value escaping and not the name it escaped under.
    for (const answer of [bought.body, collected.body]) {
      expect(JSON.stringify(answer)).not.toContain(EUROPE_ESIM.merchant_item_id);
      expect(JSON.stringify(answer)).not.toContain(email);
    }
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

  it("gives the merchant the gateway's own reason for an order it will not describe", async () => {
    // The whole road, with nothing stubbed on it: a real gateway refuses a
    // real SDK call in words of its own, and the merchant reads those words.
    //
    // The order is one that closed before anybody named a price for it — the
    // card is price-checked and this merchant's desk does not price it, so the
    // honest answer is "there is none" and the purchase ends there. The
    // merchant's own read of that order cannot come back in the shape it
    // promises, because that shape carries a sale price and this sale has
    // none. What the gateway sends instead is a refusal with a reason in it,
    // and a merchant told only that we could not parse something would go
    // reading our schemas about an order that is simply over.
    const unpriceable: Card = {
      ...EUROPE_ESIM,
      merchant_item_id: "esim-eu-no-desk-prices-it",
      title: "Europe eSIM, from a supplier this desk does not price",
      price_check: "handler",
    };
    const published = await merchant.client.catalog.publish(unpriceable);
    if (!("ok" in published)) {
      throw new Error(`publishing the unpriceable card was refused: ${JSON.stringify(published)}`);
    }

    const listed = (await buyer.catalog()).find((card) => card.title === unpriceable.title);
    if (listed === undefined) throw new Error("the unpriceable card is not in the catalog");

    const bought = await buyer.buy(listed.id, { email: "buyer@example.com" });

    // The purchase is over before any money moved, and it says so in the same
    // document a purchase that worked would have used.
    expect(bought.status).toBe(409);
    const refusedPurchase = AgentOrderStatusSchema.parse(bought.body);
    expect(refusedPurchase.status).toBe("rejected");
    expect(refusedPurchase.price).toBeNull();
    expect(facilitator.settles).toStrictEqual([]);

    const said = await merchant.client.orders.get(refusedPurchase.order_id).then(
      () => null,
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );

    expect(said).toContain("order_closed_before_it_was_priced");
    expect(said).toContain("no sale to describe");
    expect(said).not.toContain("is not the document it promises");
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
    // verified, the goods never came, and the charge was never executed. The
    // goods are null rather than absent, which is the honest way to say there
    // are none — a field left out is a silence a reader cannot tell from an
    // oversight.
    expect(bought.status).not.toBe(200);
    const ended = AgentOrderStatusSchema.parse(bought.body);
    expect(ended.status).not.toBe("delivered");
    expect(ended.delivered).toBeNull();
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

    expect(afterwards.status).toBe(200);
    const order = AgentOrderStatusSchema.parse(afterwards.body);
    await waitFor(() => merchant.acceptedOrders.has(order.order_id));
  }, 20_000);
});
