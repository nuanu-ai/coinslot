import type { AddressInfo } from "node:net";
import type { Card } from "@coinslot/contracts";
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
    expect(await harnessed.store.orders()).toStrictEqual([]);
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
    const orders = await harnessed.store.orders();
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

  it("does not give a stranger the goods the buyer paid for", async () => {
    // An order's identifier is not a secret the way a password is: this gateway
    // puts it in the challenge itself. In the synchronous mode the goods reach
    // an agent through the call it is parked on and nowhere else, so a second
    // call under the same order would have taken the first one's place — and
    // the buyer, who paid, would have been told nothing happened.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    const challenge = await challengeFor(served, itemId);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const buying = served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, BUYER, "0x01") },
    });
    const stealing = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, STRANGER, "0x02") },
    });
    const bought = await buying;
    await worker.stop();

    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ delivered: { access_code: "SESAME" } });

    expect(stealing.status).toBe(409);
    expect((stealing.body as { error: { code: string } }).error.code).toBe("not_this_purchase");
    expect(JSON.stringify(stealing.body)).not.toContain("SESAME");
  });

  it("does not charge a payment the order was not bought with", async () => {
    // Between a verification and a charge the order sits waiting, and a
    // presentation landing in that window used to replace the authorisation
    // that would be executed. The merchant then produced the goods and was paid
    // with somebody else's failing payment, while the buyer's good one was
    // never charged.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    const challenge = await challengeFor(served, itemId);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const buying = served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, BUYER, "0x01") },
    });
    await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, STRANGER, "0x02") },
    });
    await buying;
    await worker.stop();

    const charged = harnessed.facilitator.settles.map((charge) => charge.payment);
    expect(charged).toHaveLength(1);
    expect(charged[0]).toBe(paidBy(challenge, BUYER, "0x01"));
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
    const orders = await harnessed.store.orders();
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

  it("does not answer a recorded acceptance under a status meaning the call failed", async () => {
    // The body says ok:false because the contract has no word for a successful
    // acceptance. An SDK branching on the status as well would turn a landed
    // acceptance into a retry loop, which is what the message inside is trying
    // to talk it out of.
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
    expect(answered.body).toMatchObject({
      ok: false,
      error: { code: "acceptance_has_no_word_in_this_contract" },
    });
    expect((await harnessed.store.orderById(orderId))?.order.dispatch.accepted).toBe(true);
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
