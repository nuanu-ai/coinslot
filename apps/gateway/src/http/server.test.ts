import type { AddressInfo } from "node:net";
import type { Card, MerchantCardList, Receipt } from "@coinslot/contracts";
import { API_ROUTES, mountableRoutes } from "@coinslot/contracts";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Harness, harness, type Served, serve, workUntilStopped } from "../testing/harness.js";
import { buildApp } from "./server.js";
import { ORDER_ID_IN_EXTRA, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402.js";

const KEY = "a-merchant-key-long-enough";
const PAY_TO = "0x0000000000000000000000000000000000000001";

const syncCard: Card = {
  merchant_item_id: "SKU 100/1",
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

const asMerchant = { authorization: `Bearer ${KEY}` };

const publish = async (served: Served, card: Card): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: asMerchant,
  });
  expect(answered.status).toBe(200);
  return (answered.body as { ok: { id: string } }).ok.id;
};

describe("the surface is the table", () => {
  it("serves every call the contract says may be served", async () => {
    // If this fails, one of two things happened: a call was agreed and never
    // implemented, or one was implemented under an address nobody agreed to.
    // The poll window is a millisecond here so that the one call in the table
    // designed to be held open does not hold this test open with it.
    const { served } = await started({ WORKER_POLL_WAIT_MS: "1" });

    for (const [, route] of mountableRoutes()) {
      const path = route.path.replaceAll(/:([a-z_]+)/g, "placeholder");
      const answered = await served.call(route.method, path, {
        headers: asMerchant,
        ...(route.request === undefined ? {} : { body: {} }),
      });
      // A route that is mounted may perfectly well answer "no such order"; what
      // it must never answer is that there is no call at this address.
      expect(
        (answered.body as { error?: { code?: string } })?.error?.code,
        `${route.method} ${route.path}`,
      ).not.toBe("no_such_route");
    }
  });

  it("does not serve the route whose door nobody has chosen", async () => {
    // The agent's status route is the only one under the merchant's prefix that
    // is not the merchant's. Left mounted with no scheme it would let anyone
    // read anyone's purchase.
    const { served } = await started();
    expect(API_ROUTES.get_order_status.auth).toBe("undecided");

    const answered = await served.call("GET", "/v0/orders/ord_1/status", { headers: asMerchant });

    expect(answered.status).toBe(404);
  });

  it("will not start when the table names a call nothing serves", async () => {
    // The loop mounts from the table, so a call added to the contract and never
    // implemented has to stop the process rather than quietly answer nothing.
    // The route below stands in for that call; the guard it trips is the one
    // that runs over the real table on every start.
    const { harnessed } = await started();

    expect(() =>
      buildApp(harnessed.gateway, [["get_order_status" as never, API_ROUTES.get_order_status]]),
    ).toThrow(/nothing to serve it with/);
  });
});

describe("what a call answers with", () => {
  it("refuses to send a document the contract would not recognise", async () => {
    // The answer goes out held to the same schema the SDK holds it to. A
    // response that does not match is a lie the other side would reject anyway,
    // and failing here is how it is found before somebody's integration finds
    // it. The route below is the catalog with a different document named
    // against it, which is what a drift between the two sides would look like.
    const { harnessed } = await started();

    const app = buildApp(harnessed.gateway, [
      [
        "list_catalog" as never,
        {
          ...API_ROUTES.list_catalog,
          response: { document: z.strictObject({ nothing_like_a_catalog: z.string() }) },
        },
      ],
    ]);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const answered = await fetch(`http://127.0.0.1:${port}/v0/catalog`);
      expect(answered.status).toBe(500);
      expect((await answered.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "gateway_failed" },
      });
    } finally {
      server.close();
    }
  });
});

describe("the merchant's door", () => {
  it("turns away a call with no key, a wrong key and a key of the wrong length alike", async () => {
    const { served } = await started();

    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong-key-of-the-right-length" },
      { authorization: "Bearer x" },
      // The key with no scheme in front of it, which is the mistake a merchant
      // actually makes.
      { authorization: KEY },
    ];

    for (const headers of attempts) {
      const answered = await served.call("GET", "/v0/orders", { headers });
      expect(answered.status).toBe(401);
      // Nothing about which part was wrong, or whether a key arrived at all.
      expect(JSON.stringify(answered.body)).not.toContain(KEY);
    }
  });

  it("lets the merchant's own key through, however the scheme is spelled", async () => {
    const { served } = await started();

    expect((await served.call("GET", "/v0/orders", { headers: asMerchant })).status).toBe(200);
    expect(
      (await served.call("GET", "/v0/orders", { headers: { authorization: `bearer ${KEY}` } }))
        .status,
    ).toBe(200);
  });

  it("asks nobody for a key on the calls an agent makes", async () => {
    const { served } = await started();
    expect((await served.call("GET", "/v0/catalog")).status).toBe(200);
  });
});

describe("what a call may carry", () => {
  it("refuses a body that is not the document the table names, and says what is wrong", async () => {
    // The mounting loop holds every body to the schema the table names for its
    // route, so a merchant sending the wrong document learns it here rather
    // than by watching a flow behave strangely further in.
    const { served } = await started();

    const answered = await served.call("POST", "/v0/quotes/prc_1/answer", {
      body: { available: true },
      headers: asMerchant,
    });

    expect(answered.status).toBe(400);
    const { error } = answered.body as { error: { code: string; problems: { path: string[] }[] } };
    expect(error.code).toBe("malformed_body");
    expect(error.problems.length).toBeGreaterThan(0);
  });

  it("lets a card's own findings come back in the shape the contract designed for them", async () => {
    // Publishing is the one call whose answer has a place for what is wrong
    // with what arrived. A generic refusal would put the findings in the
    // gateway's own shape and the merchant would never see the branch the
    // contract wrote for them.
    const { served } = await started();

    const answered = await served.call("POST", "/v0/catalog/publish", {
      body: { merchant_item_id: 7 },
      headers: asMerchant,
    });

    expect(answered.status).toBe(422);
    const { errors } = answered.body as { errors: { path: string[]; message: string }[] };
    expect(errors.length).toBeGreaterThan(1);
    expect(errors.map((finding) => finding.path.join("."))).toContain("merchant_item_id");
  });

  it("refuses a query the table does not describe", async () => {
    const { served } = await started();

    const answered = await served.call("GET", "/v0/orders?open=1", { headers: asMerchant });

    expect(answered.status).toBe(400);
    expect((answered.body as { error: { code: string } }).error.code).toBe("malformed_query");
  });

  it("answers a card that will not do with the contract's own findings", async () => {
    const { served } = await started();

    const answered = await served.call("POST", "/v0/catalog/publish", {
      body: { ...syncCard, fulfillment: "confirm" },
      headers: asMerchant,
    });

    expect(answered.status).toBe(422);
    expect(JSON.stringify(answered.body)).toContain("no shape on the wire yet");
  });

  it("carries an identifier with a slash in it through the address unharmed", async () => {
    // The contract accepts "SKU 100/1" as an identifier. Pasted into an address
    // unencoded it becomes two path segments and a different route.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const answered = await served.call("GET", `/v0/orders/${encodeURIComponent(orderId)}`, {
      headers: asMerchant,
    });

    expect(answered.status).toBe(200);
    expect((answered.body as { merchant_item_id: string }).merchant_item_id).toBe("SKU 100/1");
  });
});

describe("the payment challenge", () => {
  it("answers a GET with a price and never with a purchase", async () => {
    // The validators and crawlers that list a paid resource ask for it with
    // GET. A paywall bound to one method makes the resource invisible to them,
    // and a GET carries no body, so it can produce a challenge and nothing else.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("GET", `/v0/items/${itemId}/purchase`);

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts[0]?.amount).toBe("80000000");
    expect(challenge.accepts[0]?.payTo).toBe(PAY_TO);
    expect(challenge.accepts[0]?.network).toBe("eip155:84532");
    // No order was opened by a call that cannot be a purchase.
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("prices a POST against an order it opened, and says which order", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    const named = challenge.accepts[0]?.extra?.[ORDER_ID_IN_EXTRA];
    const orders = await harnessed.store.orders(harnessed.merchant.id);
    expect(orders).toHaveLength(1);
    expect(named).toBe(orders[0]?.order.id);
  });

  it("prices a fresh order when a payment names one this gateway is not holding", async () => {
    // An agent that built its own requirements rather than accepting ours gets
    // a price we issued, which is the only kind we can check a payment against.
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    const invented = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "1",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { [ORDER_ID_IN_EXTRA]: "ord_from_nowhere" },
      },
      payload: {},
    });

    const answered = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: invented },
    });

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.error).toMatch(/did not name an order this gateway is holding/);
  });

  it("reads a payment that is not one without falling over", async () => {
    // The decoder is a base64 JSON parse with no schema behind it, so a header
    // naming a real order and carrying nothing else reaches every line that
    // reads a payment. It used to reach one that assumed a payload was there
    // and answered "something here is broken" — which tells an agent to give up
    // on a route that works. What it gets now is the ordinary answer to a
    // payment the payment layer will not have: the purchase did not happen.
    const { served, harnessed } = await started();
    harnessed.facilitator.willRefuseVerification("signature", "that is not a payment");
    const itemId = await publish(served, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const nonsense = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: { extra: { order_id: offered.order.order.id } },
      }),
      "utf8",
    ).toString("base64");

    const answered = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: nonsense },
    });

    expect(answered.status).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("payment_not_verified");
    // The order it named was not closed by a payment that could not be read.
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.state).toBe("quoted");
  });

  it("has nothing to sell under an identifier nobody published", async () => {
    const { served } = await started();
    expect((await served.call("GET", "/v0/items/item_nope/purchase")).status).toBe(404);
    expect(
      (await served.call("POST", "/v0/items/item_nope/purchase", { body: { params: {} } })).status,
    ).toBe(404);
  });
});

describe("a purchase over HTTP, from the catalog to the goods", () => {
  it("walks a synchronous sale end to end", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const listed = await served.call("GET", "/v0/catalog");
    expect((listed.body as { items: { id: string }[] }).items.map((item) => item.id)).toStrictEqual(
      [itemId],
    );

    const priced = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
    });
    expect(priced.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    const requirements = challenge.accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ delivered: { access_code: "SESAME" } });
    expect(bought.headers.get("payment-response")).toBeTruthy();

    const orderId = (bought.body as { order: { id: string } }).order.id;
    const read = await served.call("GET", `/v0/orders/${orderId}`, { headers: asMerchant });
    expect(read.body).toMatchObject({ id: orderId, status: "delivered" });

    const listedOrders = await served.call("GET", "/v0/orders?open=true", { headers: asMerchant });
    expect((listedOrders.body as { orders: unknown[] }).orders).toStrictEqual([]);
  });

  it("tells the agent the purchase is over when the merchant refuses", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    const priced = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
    });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "the room is taken" } }),
    });
    const refused = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ status: "rejected" });
    expect(harnessed.facilitator.settles).toHaveLength(0);
  });
});

describe("what an agent is told when the money is not settled", () => {
  it("does not answer a synchronous purchase with a success it has no goods for", async () => {
    // The one way here is the case that most needs saying: a charge that went
    // out and never reported back. Answered 200, an agent reads "your purchase
    // is being worked on" for an order nothing is working on, while holding
    // nothing and not knowing whether it was charged.
    const { served, harnessed } = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "300",
    });
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });
    const itemId = await publish(served, syncCard);

    const priced = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
    });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const answered = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    expect(answered.status).toBe(409);
    expect(answered.body).toMatchObject({ status: "in_progress" });
  });

  it("says an order closed before it was priced is closed, not still waiting", async () => {
    // The document this call answers in carries a sale price, and an order the
    // merchant said was out of stock never got one. Saying it is "still waiting
    // for its price" would be a positive false statement about a purchase that
    // is over.
    const { served, harnessed } = await started({ QUOTE_RESPONSE_MS: "10" });
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "gone",
      fulfillment: "async",
      price_check: "handler",
    });

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "settled") throw new Error("the silent async card sold anyway");

    const read = await served.call(
      "GET",
      `/v0/orders/${encodeURIComponent(offered.order.order.id)}`,
      { headers: asMerchant },
    );

    expect(read.status).toBe(409);
    expect(read.body).toMatchObject({
      error: { code: "order_closed_before_it_was_priced", status: "rejected" },
    });
  });
});

describe("whose purchase it is", () => {
  /** A payment signed by one address, against a challenge that was issued. */
  const paidBy = (challenge: string, from: string, nonce: string) => {
    const accepted = decodePaymentRequiredHeader(challenge).accepts[0];
    if (accepted === undefined) throw new Error("no payment option was offered");
    return encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: {
        signature: "0xsigned",
        authorization: { from, to: PAY_TO, value: "80000000", nonce },
      },
    });
  };

  const challengeFor = async (served: Served, itemId: string) => {
    const priced = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
    });
    expect(priced.status).toBe(402);
    return priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "";
  };

  const BUYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  // Two payments for one order, presented over HTTP and released into the
  // ownership decision at the same instant, so what settles it is the in-lock
  // guard and not which request the runtime happened to schedule first. Held
  // verifications keep both calls at the decision until each has reached it;
  // asserting a fixed winner instead would pass or fail on the machine's
  // timing, which is how these two once went green locally and red on a
  // faster runner. The larger sync budget keeps the parked calls alive across
  // the hold.
  const RACE_TIMING = {
    QUOTE_RESPONSE_MS: "50",
    SYNC_RESPONSE_MS: "300",
    SETTLE_RESPONSE_MS: "100",
    SYNC_BUDGET_MS: "500",
  };

  const raceTwoPayments = async (served: Served, harnessed: Harness, itemId: string) => {
    const challenge = await challengeFor(served, itemId);
    const buyerHeader = paidBy(challenge, BUYER, "0x01");
    const strangerHeader = paidBy(challenge, STRANGER, "0x02");

    const release = harnessed.facilitator.holdVerification();
    const race = Promise.all([
      served.call("POST", `/v0/items/${itemId}/purchase`, {
        body: { params: {} },
        headers: { [PAYMENT_SIGNATURE_HEADER]: buyerHeader },
      }),
      served.call("POST", `/v0/items/${itemId}/purchase`, {
        body: { params: {} },
        headers: { [PAYMENT_SIGNATURE_HEADER]: strangerHeader },
      }),
    ]);
    // Yield to the event loop, not just the microtask queue: the two
    // presentations travel over a real socket, so their verifications only
    // arrive on I/O ticks. A microtask spin would never let them land.
    for (let i = 0; i < 2_000 && harnessed.facilitator.verifies.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(harnessed.facilitator.verifies).toHaveLength(2);
    release();
    return { race, buyerHeader, strangerHeader };
  };

  it("hands the goods to exactly one of two racing payments and refuses the other", async () => {
    // An order's identifier is not a secret the way a password is: this gateway
    // puts it in the challenge itself. In the synchronous mode the goods reach
    // an agent through the call it is parked on and nowhere else, so a second
    // call under the same order must not take the first one's place — exactly
    // one wins, the other is told this order is already somebody's.
    const { served, harnessed } = await started(RACE_TIMING);
    const itemId = await publish(served, syncCard);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const { race } = await raceTwoPayments(served, harnessed, itemId);
    const [a, b] = await race;
    await worker.stop();

    const won = [a, b].filter((r) => r.status === 200);
    const refused = [a, b].filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const winner = won[0];
    const loser = refused[0];
    if (winner === undefined || loser === undefined)
      throw new Error("the race had no single winner");
    expect(winner.body).toMatchObject({ delivered: { access_code: "SESAME" } });
    expect((loser.body as { error: { code: string } }).error.code).toBe("not_this_purchase");
    expect(JSON.stringify(loser.body)).not.toContain("SESAME");
  });

  it("charges exactly one payment, the one the winner owns", async () => {
    // Between a verification and a charge the order sits waiting, and a
    // presentation landing in that window used to replace the authorisation
    // that would be executed. The merchant then produced the goods and was paid
    // with somebody else's payment, while the winner's own was never charged.
    // Whichever of the two wins, the single charge is that one's payment.
    const { served, harnessed } = await started(RACE_TIMING);
    const itemId = await publish(served, syncCard);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const { race, buyerHeader, strangerHeader } = await raceTwoPayments(served, harnessed, itemId);
    const [buyerResult, strangerResult] = await race;
    await worker.stop();

    // Promise.all keeps the call order, so the first result is the buyer's call
    // and the second the stranger's; the winner's header is whichever returned
    // the goods.
    const winnerHeader = buyerResult.status === 200 ? buyerHeader : strangerHeader;
    expect([buyerResult.status, strangerResult.status].filter((s) => s === 200)).toHaveLength(1);

    const charged = harnessed.facilitator.settles.map((charge) => charge.payment);
    expect(charged).toHaveLength(1);
    expect(charged[0]).toBe(winnerHeader);
  });

  it("does not let a stranger close somebody else's open purchase", async () => {
    // A payment that fails its check closes the order it was presented for. A
    // stranger's payment is not that order's payment, so it closes nothing —
    // and the buyer is not told their purchase was refused for a payment they
    // never made.
    const { served, harnessed } = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "150",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "300",
      QUOTE_TTL_MS: "60000",
    });
    const itemId = await publish(served, syncCard);
    const challenge = await challengeFor(served, itemId);

    // The buyer takes the order first, and their own payment cannot be checked
    // yet because nothing is answering.
    harnessed.facilitator.willVerify({ verified: "unknown", message: "not asked yet" });
    await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, BUYER, "0x01") },
    });

    harnessed.facilitator.willRefuseVerification("signature", "not a signature at all");
    const meddling = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, STRANGER, "0x02") },
    });

    expect(meddling.status).toBe(409);
    const orders = await harnessed.store.orders(harnessed.merchant.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.order.state).toBe("quoted");
    expect(orders[0]?.order.closure).toBeNull();
  });
});

describe("the worker's calls over HTTP", () => {
  it("draws the stream and answers an order through the routes the SDK uses", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim",
      fulfillment: "async",
    });

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const drawn = await served.call("POST", "/v0/worker/poll", {
      body: { wait_seconds: 0 },
      headers: asMerchant,
    });
    expect(drawn.status).toBe(200);
    const { envelopes, contract_version } = drawn.body as {
      envelopes: { kind: string; payload: { id: string } }[];
      contract_version: string;
    };
    expect(contract_version).toBe("0");
    expect(envelopes.map((envelope) => envelope.kind)).toStrictEqual(["order"]);

    const answered = await served.call(`POST`, `/v0/orders/${orderId}/answer`, {
      body: { delivered: { access_code: "A" } },
      headers: asMerchant,
    });

    expect(answered.status).toBe(200);
    expect(answered.body).toStrictEqual({ ok: true, result: "delivered" });
  });

  it("answers a recorded acceptance as a success, in the body and in the status", async () => {
    // Both halves matter and they have to agree. An SDK reads the body and
    // reports anything but a success to the merchant; a client library reads
    // the status and retries what looks like a failure. A landed acceptance
    // that says no in either place turns an order going through into a problem
    // in the merchant's log, or into a retry loop.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim-accept",
      fulfillment: "async",
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const answered = await served.call("POST", `/v0/orders/${orderId}/answer`, {
      body: { accepted: { eta_seconds: 30 } },
      headers: asMerchant,
    });

    expect(answered.status).toBe(200);
    expect(answered.body).toStrictEqual({ ok: true, result: "accepted" });
    expect((await harnessed.store.orderById(orderId))?.order.dispatch.accepted).toBe(true);
  });

  it("still says no in the status when the answer route refuses one", async () => {
    // The other half of the promise above, and what makes it mean anything: a
    // success reads as one because a refusal does not. Nothing has been paid
    // for this order, so there is no work to take on and the machine turns the
    // answer away — and a client library that reads the status rather than the
    // body has to see that, or it records an order as under way that the
    // gateway never accepted.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim-unpaid",
      fulfillment: "async",
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const early = await served.call("POST", `/v0/orders/${offered.order.order.id}/answer`, {
      body: { accepted: {} },
      headers: asMerchant,
    });

    expect(early.status).toBe(409);
    // Refused, and the order was not taken on — that is what this pins. The
    // code itself is deliberately not pinned: it is the machine's own word
    // rather than one of the three the contract promises, and `results.ts`
    // calls that set open and free to change, so asserting it here would
    // certify a stability the contract declines to offer. Nor is `retryable`
    // pinned, because on this fixture it is not true in the sense the field
    // promises: the order is merely unpaid, and the identical call succeeds
    // once the buyer pays. The flag has two values where the truth has three.
    expect(early.body).toMatchObject({ ok: false });
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.dispatch.accepted).toBe(
      false,
    );
  });

  it("refuses a body that is not JSON in the shape everything else refuses in", async () => {
    // The parser turns it away before any route runs, so without an answer of
    // our own it comes back as express's HTML page — from a surface whose every
    // other refusal is a document, to a client that only reads documents.
    const { served } = await started();

    const answered = await served.call("POST", "/v0/quotes/prc_1/answer", {
      headers: { ...asMerchant, "content-type": "application/json" },
      body: undefined,
    });
    const raw = await fetch(`${served.url}/v0/quotes/prc_1/answer`, {
      method: "POST",
      headers: { ...asMerchant, "content-type": "application/json" },
      body: "{ this is not json",
    });

    expect(raw.status).toBe(400);
    expect((await raw.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "malformed_body" },
    });
    expect(answered.status).toBe(400);
  });

  it("answers a call about an order nobody made with a plain not found", async () => {
    const { served } = await started();

    const answered = await served.call("POST", "/v0/orders/ord_nope/deliver", {
      body: { access_code: "A" },
      headers: asMerchant,
    });

    expect(answered.status).toBe(404);
    expect((answered.body as { error: { code: string } }).error.code).toBe("no_such_order");
  });
});

describe("the merchant's own catalog and the pause switch", () => {
  // The promise: a merchant can see their cards, stop selling one or all of
  // them, and start again — and a pause stops new orders without touching the
  // orders already open. The words come back the way the machine keeps them,
  // because a screen and a machine that disagree about whether a product is on
  // sale is the one thing a switch like this must never do.
  const vpnCard: Card = {
    merchant_item_id: "vpn-monthly",
    title: "VPN, one month",
    description: "Thirty days from the moment it is delivered",
    price: { amount: "5.00", currency: "USD" },
    result: { access_url: { type: "string" } },
    fulfillment: "sync",
  };

  const cardsOf = (body: unknown) => (body as MerchantCardList).cards;

  const stateOf = (body: unknown, id: string) => cardsOf(body).find((card) => card.id === id);

  const buy = (served: Served, itemId: string) =>
    served.call("POST", `/v0/items/${itemId}/purchase`, { body: { params: {} } });

  it("shows the merchant the cards they published, whole, and refuses a caller with no key", async () => {
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const mine = await served.call("GET", "/v0/cards", { headers: asMerchant });
    const stranger = await served.call("GET", "/v0/cards");

    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ selling: "open" });
    expect(stateOf(mine.body, itemId)).toMatchObject({ selling: "open", paused: false });
    // The card itself, not a projection of it: the merchant's own key is here,
    // which the public catalog deliberately never carries.
    expect(cardsOf(mine.body)[0]?.card).toStrictEqual(syncCard);
    expect(stranger.status).toBe(401);
  });

  it("stops new orders for a paused card and leaves the others selling", async () => {
    const { served } = await started();
    const paused = await publish(served, syncCard);
    const selling = await publish(served, vpnCard);

    const answered = await served.call("POST", `/v0/cards/${paused}/pause`, {
      headers: asMerchant,
    });

    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ id: paused, selling: "paused", paused: true });
    expect((await buy(served, paused)).status).toBe(409);
    expect((await buy(served, paused)).body).toMatchObject({ error: { code: "not_selling" } });
    // The negative control: the switch is per card, so the other one is
    // untouched and still answers a purchase with a price.
    expect((await buy(served, selling)).status).toBe(402);
  });

  it("takes a paused card out of the catalog rather than offering what it will refuse", async () => {
    // A catalog is an offer. An entry every purchase of which comes back
    // "not selling" is an offer we would not honour, and the agent finds out
    // after it has chosen this product over somebody else's.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });
    const listed = await served.call("GET", "/v0/catalog");

    expect((listed.body as { items: unknown[] }).items).toStrictEqual([]);
  });

  it("does not touch an order that was already open when the pause began", async () => {
    // The whole shape of a pause, and the thing a merchant most needs to be
    // true: the guard is at the birth of an order and nowhere else, so a sale
    // already under way completes exactly as it would have.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    const priced = await buy(served, itemId);
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ delivered: { access_code: "SESAME" } });
  });

  it("stops every card at once and says which pause each one is under", async () => {
    const { served } = await started();
    const ownPause = await publish(served, syncCard);
    const swept = await publish(served, vpnCard);
    await served.call("POST", `/v0/cards/${ownPause}/pause`, { headers: asMerchant });

    const stopped = await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    expect(stopped.body).toMatchObject({ selling: "paused" });
    // Both refuse a purchase, and the two are still told apart: one is paused
    // in its own right and one is only swept up by the merchant's switch.
    expect(stateOf(stopped.body, ownPause)).toMatchObject({ selling: "paused", paused: true });
    expect(stateOf(stopped.body, swept)).toMatchObject({ selling: "paused", paused: false });
    expect((await buy(served, swept)).status).toBe(409);
  });

  it("puts back only the cards the merchant did not take off themselves", async () => {
    // Resuming everything must not sell a product its merchant took off sale.
    // The card that was paused in its own right is still paused, and the one
    // that was only swept up is selling again.
    const { served } = await started();
    const ownPause = await publish(served, syncCard);
    const swept = await publish(served, vpnCard);
    await served.call("POST", `/v0/cards/${ownPause}/pause`, { headers: asMerchant });
    await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    const resumed = await served.call("POST", "/v0/selling/resume", { headers: asMerchant });

    expect(resumed.body).toMatchObject({ selling: "open" });
    expect(stateOf(resumed.body, ownPause)).toMatchObject({ selling: "paused", paused: true });
    expect(stateOf(resumed.body, swept)).toMatchObject({ selling: "open", paused: false });
    expect((await buy(served, ownPause)).status).toBe(409);
    expect((await buy(served, swept)).status).toBe(402);
  });

  it("tells a merchant resuming one card that the catalog is still stopped", async () => {
    // The case a merchant is most likely to misread: they press resume on a
    // card while all selling is stopped, and nothing appears to happen. The
    // answer says both facts, so the screen can say which switch is holding it.
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });
    await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    const answered = await served.call("POST", `/v0/cards/${itemId}/resume`, {
      headers: asMerchant,
    });

    expect(answered.body).toMatchObject({ selling: "paused", paused: false });
    expect((await buy(served, itemId)).status).toBe(409);
  });

  it("leaves a card paused when its merchant republishes it", async () => {
    // Republishing is how a card is changed. A merchant editing a price is not
    // asking for a product they took off sale to go back on it, and a pause
    // that evaporated on the next publish would put stock they do not have in
    // front of an agent.
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });

    await publish(served, { ...syncCard, price: { amount: "90.00", currency: "USD" } });
    const mine = await served.call("GET", "/v0/cards", { headers: asMerchant });

    expect(stateOf(mine.body, itemId)).toMatchObject({ selling: "paused", paused: true });
    expect(cardsOf(mine.body)[0]?.card.price).toStrictEqual({ amount: "90.00", currency: "USD" });
  });

  it("answers the same way when the same switch is pressed twice", async () => {
    // The call says what the merchant wants to be true rather than asking for a
    // change, so a retry after a dropped connection is safe.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const first = await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });
    const again = await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });

    expect(again.status).toBe(200);
    expect(again.body).toStrictEqual(first.body);
  });

  it("does not put a merchant who has left back on sale", async () => {
    // Leaving is not a heavier pause, and this switch does not undo one: a
    // departure closed the orders that were open and left refunds owed, and
    // resuming would return the merchant to the catalog with none of it
    // unwound. Nothing in the pilot sets "departed", so the guard is reached
    // through the store rather than through a route — the same reason
    // `sellingFor`'s departed branch is tested directly.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const resumed = await served.call("POST", "/v0/selling/resume", { headers: asMerchant });

    expect(resumed.status).toBe(409);
    expect((resumed.body as { error: { code: string } }).error.code).toBe("merchant_departed");
    expect(await harnessed.store.selling(harnessed.merchant.id)).toBe("departed");
    // And the merchant is still gone as far as an agent is concerned.
    expect(
      (await served.call("POST", `/v0/items/${itemId}/purchase`, { body: { params: {} } })).status,
    ).toBe(409);
  });

  it("does not describe a departure as a pause either", async () => {
    // The other direction of the same rule. Pausing a merchant who has left
    // would say their open orders are playing out, which they are not.
    const { served, harnessed } = await started();
    await publish(served, syncCard);
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const paused = await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    expect(paused.status).toBe(409);
    expect(await harnessed.store.selling(harnessed.merchant.id)).toBe("departed");
  });

  it("says there is no such product rather than pausing nothing quietly", async () => {
    const { served } = await started();

    const answered = await served.call("POST", "/v0/cards/itm_nope/pause", {
      headers: asMerchant,
    });

    expect(answered.status).toBe(404);
    expect((answered.body as { error: { code: string } }).error.code).toBe("no_such_item");
  });
});

describe("the merchant's receipts", () => {
  it("lists the receipt of a sale that went through, and nothing before one does", async () => {
    // The promise: a merchant reconciles their wallet against this list. A
    // receipt exists from the moment the money moves, so an empty list before
    // any sale is the true answer and not a broken call.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const before = await served.call("GET", "/v0/receipts", { headers: asMerchant });
    expect(before.body).toStrictEqual({ receipts: [] });

    const priced = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
    });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    const after = await served.call("GET", "/v0/receipts", { headers: asMerchant });
    const receipts = (after.body as { receipts: Receipt[] }).receipts;

    expect(after.status).toBe(200);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      order_id: (bought.body as { order: { id: string } }).order.id,
      outcome: "delivered",
      item_id: itemId,
    });
    // Both moments, which is what the price on a receipt is for: when the
    // purchase happened, and the instant the price behind it was true.
    expect(receipts[0]?.price).toMatchObject({ amount: "80.00", currency: "USD" });
    expect(receipts[0]?.price.at).toBeTruthy();
    expect(receipts[0]?.price.as_of).toBeTruthy();
  });

  it("refuses a caller with no key", async () => {
    const { served } = await started();

    expect((await served.call("GET", "/v0/receipts")).status).toBe(401);
  });
});

describe("a product that is declared and a product that is not", () => {
  // The promise: everything a challenge tells a catalog about is something an
  // agent can then buy. A declared resource that answers every purchase with a
  // refusal is worse than an unlisted one — the agent budgets for it, picks it
  // over a competitor, and finds out at the till.
  const paused = async (served: Served, itemId: string) => {
    const answered = await served.call("POST", `/v0/cards/${itemId}/pause`, {
      headers: asMerchant,
    });
    expect(answered.status).toBe(200);
  };

  it("declares a card that is for sale", async () => {
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("GET", `/v0/items/${itemId}/purchase`);

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.extensions?.bazaar).toBeTypeOf("object");
    expect(challenge.resource.url).toBe(`http://localhost:3000/v0/items/${itemId}/purchase`);
  });

  it("stops answering a challenge for a card its merchant took off sale", async () => {
    // The catalog lists a resource that answers 402 and drops one that stops.
    // A paused card that kept answering would stay listed and refuse every
    // purchase behind the listing.
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    await paused(served, itemId);

    const answered = await served.call("GET", `/v0/items/${itemId}/purchase`);

    expect(answered.status).toBe(409);
    expect(answered.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
  });

  it("stops answering a challenge when the merchant stopped selling everything", async () => {
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    const stopped = await served.call("POST", "/v0/selling/pause", { headers: asMerchant });
    expect(stopped.status).toBe(200);

    const answered = await served.call("GET", `/v0/items/${itemId}/purchase`);

    expect(answered.status).toBe(409);
    expect(answered.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
  });

  it("answers again once the card is back on sale", async () => {
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    await paused(served, itemId);
    const resumed = await served.call("POST", `/v0/cards/${itemId}/resume`, {
      headers: asMerchant,
    });
    expect(resumed.status).toBe(200);

    expect((await served.call("GET", `/v0/items/${itemId}/purchase`)).status).toBe(402);
  });

  it("names the same resource however the address was typed", async () => {
    // The resource identity is what a listing is keyed on, and a query string
    // or a second method must not change it. Read off the request it would:
    // the address the process sees is not the address an agent called.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const urlOf = async (method: "GET" | "POST", path: string) =>
      decodePaymentRequiredHeader(
        (
          await served.call(method, path, method === "POST" ? { body: { params: {} } } : {})
        ).headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
      ).resource.url;

    const plain = await urlOf("GET", `/v0/items/${itemId}/purchase`);

    expect(await urlOf("GET", `/v0/items/${itemId}/purchase?utm=abc`)).toBe(plain);
    expect(await urlOf("POST", `/v0/items/${itemId}/purchase`)).toBe(plain);
  });
});
