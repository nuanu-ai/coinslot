/**
 * Purchases walked the whole way through, with nothing borrowed.
 *
 * Everything the other tests reach for — the harness, the counted identifiers,
 * the worker loop, the cards — is built here from scratch instead. A fixture
 * that quietly supplies a field, a default or a step is exactly what would let
 * a gateway pass its own suite and fail the first real purchase, so this file
 * takes nothing from one. It publishes a card the way a merchant's SDK would,
 * reads the catalog the way an agent would, pays the way an x402 client does,
 * answers the way a handler does, and reads the receipt at the end.
 *
 * The last walk borrows less again: it begins with no merchant at all, registers
 * one over the same route a person would, and sells on the key that registration
 * generated and showed once. Nothing in it chooses a key, a digest or a
 * merchant, so a registration that wrote down the digest of something other than
 * what it printed leaves the sale not happening at all.
 *
 * The only things swapped are the three that would need a database, a queue
 * server and a payment network. Everything between the socket and the order
 * machine is what runs in production.
 */

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { ScriptedFacilitator } from "./adapters/memory/facilitator.js";
import { MemoryQueue } from "./adapters/memory/queue.js";
import { MemoryStore } from "./adapters/memory/store.js";
import { Gateway } from "./app/gateway.js";
import { keyDigest, setPayoutWallet, setServiceName } from "./app/merchants.js";
import { loadConfig } from "./config.js";
import { buildApp } from "./http/server.js";

/**
 * The key this walk carries. It is prefixed because the door reads the prefix
 * before it looks a digest up, and the gateway below is configured with the
 * default chain, which is a test one.
 */
const MERCHANT_KEY = "csk_test_the-merchant-key-for-this-walk";

/** The address this gateway itself is configured with: the operator's. */
const PAY_TO = "0x00000000000000000000000000000000000000aa";

/** The address the merchant of this walk is paid at, which is not that one. */
const THE_WALKS_WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

/** The code the gateway below takes registrations behind. */
const INVITATION = "the-code-this-walk-was-given";

/** A whole gateway and a socket to talk to it over, built from nothing. */
async function aGatewayOnAPort() {
  const ids = () => randomUUID();
  const queue = new MemoryQueue();
  // The queue is made first because the store publishes through it: an envelope
  // that must not be lost is written where the order is (ADR-0013).
  const store = new MemoryStore(
    ids,
    () => Date.now(),
    (merchantId, envelope, afterMs) => queue.stage(merchantId, envelope, afterMs),
  );
  const facilitator = new ScriptedFacilitator();

  // A merchant and a key, written the way anything that makes one writes one:
  // a row for the merchant, a name for the merchant to be sold under, an address
  // for them to be paid at, and a row holding the digest of the key rather than
  // the key. Nothing else in this file knows the merchant's identifier — the key
  // is the only thing the calls below carry, and the door is what turns one into
  // the other.
  //
  // Neither the name nor the address is scaffolding. A merchant listed under
  // nothing publishes nothing, and on a gateway that settles for real neither
  // does one with nowhere to be paid, so a walk that skipped either would be
  // refused at its first card; the walk that registers, further down, is where
  // being made to choose both is the subject rather than a precondition.
  await store.addMerchant({ id: "mch_the_walk", name: "The merchant of this walk" }, Date.now());
  await setServiceName(store, "mch_the_walk", "The walk's own shop", Date.now());
  await setPayoutWallet(store, "mch_the_walk", THE_WALKS_WALLET, Date.now());
  await store.addKey(
    {
      id: "mk_the_walk",
      merchantId: "mch_the_walk",
      label: "the key this walk carries",
      digest: keyDigest(MERCHANT_KEY),
      purpose: "merchant_code",
    },
    Date.now(),
  );

  const gateway = new Gateway({
    config: loadConfig({
      DATABASE_URL: "postgres://coinslot@localhost:5432/coinslot",
      PAY_TO_ADDRESS: PAY_TO,
      REGISTRATION_INVITATION: INVITATION,
    }),
    store,
    queue,
    facilitator,
    clock: () => Date.now(),
    ids,
  });
  await gateway.start();

  // On the address it is called at; `serve` in the harness says why.
  const server = buildApp(gateway).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text === "" ? null : JSON.parse(text)) as never,
    };
  };

  return {
    call,
    facilitator,
    store,
    async close() {
      server.close();
      await gateway.stop();
    },
  };
}

/**
 * The merchant's worker, written the way a merchant's would be: draw the
 * stream, do the work, post what the handler returned. It runs until it is
 * stopped, because an order arrives while the agent is waiting rather than
 * before.
 */
function aMerchantsWorker(
  call: Awaited<ReturnType<typeof aGatewayOnAPort>>["call"],
  handle: (order: { id: string; merchant_item_id: string }) => Record<string, unknown>,
  // Whichever key this merchant holds. The walk that registers gets its key
  // from the registration itself and nothing here knows it in advance.
  key: string = MERCHANT_KEY,
) {
  let running = true;
  const seen: string[] = [];

  const loop = (async () => {
    while (running) {
      const drawn = await call("POST", "/v0/worker/poll", {
        body: { wait_seconds: 0, max: 10 },
        headers: { authorization: `Bearer ${key}` },
      });
      const { envelopes } = drawn.body as {
        envelopes: { kind: string; payload: { id: string; merchant_item_id: string } }[];
      };

      for (const envelope of envelopes) {
        if (envelope.kind !== "order") continue;
        seen.push(envelope.payload.id);
        await call("POST", `/v0/orders/${encodeURIComponent(envelope.payload.id)}/answer`, {
          body: { delivered: handle(envelope.payload) },
          headers: { authorization: `Bearer ${key}` },
        });
      }

      if (envelopes.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  })();

  return {
    seen,
    async stop() {
      running = false;
      await loop;
    },
  };
}

/** What an x402 client does with a challenge: accept an option and sign it. */
function payFor(challengeHeader: string): string {
  const challenge = decodePaymentRequiredHeader(challengeHeader);
  const accepted = challenge.accepts[0];
  if (accepted === undefined) {
    throw new Error("the challenge offered no way to pay");
  }
  return encodePaymentSignatureHeader({
    x402Version: challenge.x402Version,
    accepted,
    payload: { signature: "0xsigned-by-the-agent" },
  });
}

describe("a purchase from the outside", () => {
  it("walks a synchronous sale from the catalog to the receipt", async () => {
    const gateway = await aGatewayOnAPort();
    try {
      // The merchant publishes, the way their SDK would.
      const published = await gateway.call("POST", "/v0/catalog/publish", {
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
        body: {
          merchant_item_id: "night-in-101",
          title: "A room for the night",
          description: "One night in room 101, key by code",
          price: { amount: "80.00", currency: "USD" },
          params: { nights: { type: "integer", required: true } },
          result: { access_code: { type: "string" } },
          fulfillment: "sync",
        },
      });
      expect(published.status).toBe(200);
      const itemId = (published.body as { id: string }).id;

      // The agent finds it. Nothing here needs a key.
      const catalog = await gateway.call("GET", "/x402/catalog");
      expect(catalog.status).toBe(200);
      const offered = (catalog.body as { items: { id: string; price: { amount: string } }[] })
        .items;
      expect(offered).toHaveLength(1);
      expect(offered[0]?.id).toBe(itemId);
      expect(offered[0]?.price.amount).toBe("80.00");

      // It asks to buy and is told what to pay.
      const challenged = await gateway.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: { nights: 1 } },
      });
      expect(challenged.status).toBe(402);
      const challenge = challenged.headers.get("payment-required");
      expect(challenge).toBeTruthy();

      // Nothing has been charged for a purchase nobody has paid for.
      expect(gateway.facilitator.verifies).toHaveLength(0);
      expect(gateway.facilitator.settles).toHaveLength(0);

      // The merchant's worker is running, and the agent pays.
      const worker = aMerchantsWorker(gateway.call, () => ({ access_code: "4417" }));
      const bought = await gateway.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: { nights: 1 } },
        headers: { "payment-signature": payFor(challenge ?? "") },
      });
      await worker.stop();

      // The goods themselves come back in the answer to the purchase, inside
      // the document the agent's own door answers with — where the order
      // stands, what it was priced at, and the goods.
      expect(bought.status).toBe(200);
      const answer = bought.body as {
        order_id: string;
        status: string;
        delivered: { access_code: string };
        price: { amount: string };
        test: boolean;
      };
      expect(answer.status).toBe("delivered");
      expect(answer.delivered).toStrictEqual({ access_code: "4417" });
      expect(answer.price.amount).toBe("80.00");
      expect(bought.headers.get("payment-response")).toBeTruthy();

      // The receipt is the merchant's record and is read through the
      // merchant's own door, which is the only place it exists.
      const receipts = await gateway.call("GET", "/v0/receipts", {
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
      });
      expect(receipts.status).toBe(200);
      const written = (
        receipts.body as {
          receipts: { order_id: string; outcome: string; price: { amount: string } }[];
        }
      ).receipts;
      expect(written.map((receipt) => receipt.order_id)).toStrictEqual([answer.order_id]);
      expect(written[0]?.outcome).toBe("delivered");
      expect(written[0]?.price.amount).toBe("80.00");

      // Verified before the merchant was asked, charged after they answered,
      // and each of those happened exactly once.
      expect(gateway.facilitator.verifies).toHaveLength(1);
      expect(gateway.facilitator.settles).toHaveLength(1);
      expect(worker.seen).toStrictEqual([answer.order_id]);

      // And the merchant can read it back: one order, closed, nothing open.
      const read = await gateway.call("GET", `/v0/orders/${encodeURIComponent(answer.order_id)}`, {
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
      });
      expect(read.body).toMatchObject({ id: answer.order_id, status: "delivered" });

      const open = await gateway.call("GET", "/v0/orders?open=true", {
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
      });
      expect((open.body as { orders: unknown[] }).orders).toStrictEqual([]);
    } finally {
      await gateway.close();
    }
  });

  it("walks an asynchronous sale from the catalog to the receipt", async () => {
    const gateway = await aGatewayOnAPort();
    try {
      const published = await gateway.call("POST", "/v0/catalog/publish", {
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
        body: {
          merchant_item_id: "esim-7-days",
          title: "A seven day eSIM",
          description: "Seven days of data, activated by code",
          price: { amount: "12.50", currency: "USD" },
          result: { activation_code: { type: "string" } },
          fulfillment: "async",
          fulfill_deadline_seconds: 86_400,
        },
      });
      expect(published.status).toBe(200);
      const itemId = (published.body as { id: string }).id;

      const catalog = await gateway.call("GET", "/x402/catalog");
      expect(
        (catalog.body as { items: { fulfillment: string; fulfill_deadline_seconds: number }[] })
          .items[0],
      ).toMatchObject({ fulfillment: "async", fulfill_deadline_seconds: 86_400 });

      const challenged = await gateway.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });
      expect(challenged.status).toBe(402);

      // The money moves at the purchase here, so the agent is answered with a
      // running order rather than with goods — and told plainly that there are
      // none yet, which is not the same as there being no field for them.
      const bought = await gateway.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
        headers: { "payment-signature": payFor(challenged.headers.get("payment-required") ?? "") },
      });
      expect(bought.status).toBe(200);
      const started = bought.body as { order_id: string; status: string; delivered: null };
      expect(started.status).toBe("in_progress");
      expect(started.delivered).toBeNull();
      expect(gateway.facilitator.settles).toHaveLength(1);

      const orderId = started.order_id;

      // The merchant draws the order and takes it on.
      const drawn = await gateway.call("POST", "/v0/worker/poll", {
        body: { wait_seconds: 0 },
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
      });
      const { envelopes } = drawn.body as {
        envelopes: { kind: string; payload: { id: string } }[];
      };
      expect(envelopes.map((envelope) => envelope.payload.id)).toStrictEqual([orderId]);

      const accepted = await gateway.call(
        "POST",
        `/v0/orders/${encodeURIComponent(orderId)}/accept`,
        { body: { eta_seconds: 120 }, headers: { authorization: `Bearer ${MERCHANT_KEY}` } },
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body).toStrictEqual({ ok: true });

      // Until they deliver, the order is one of the merchant's open ones.
      const open = await gateway.call("GET", "/v0/orders?open=true", {
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
      });
      expect((open.body as { orders: { id: string; status: string }[] }).orders).toMatchObject([
        { id: orderId, status: "in_progress" },
      ]);

      // A delivery that is not what the card declares closes nothing. The card
      // above promises an activation code, and a merchant whose handler had a
      // bad day sends an empty object; without this check the order would be
      // marked delivered, a receipt written, and the buyer handed nothing.
      const empty = await gateway.call(
        "POST",
        `/v0/orders/${encodeURIComponent(orderId)}/deliver`,
        { body: {}, headers: { authorization: `Bearer ${MERCHANT_KEY}` } },
      );
      expect(empty.status).toBe(409);
      expect(empty.body).toMatchObject({
        ok: false,
        error: { code: "delivery_does_not_match_card", retryable: true },
      });
      expect((empty.body as { error: { message: string } }).error.message).toContain(
        "activation_code",
      );
      expect(await gateway.store.receiptForOrder(orderId)).toBeNull();

      // And the order is still one of the merchant's open ones: he can fix his
      // handler and deliver, which is the whole reason that refusal is not an
      // ending.
      const stillOpen = await gateway.call("GET", "/v0/orders?open=true", {
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
      });
      expect((stillOpen.body as { orders: { id: string }[] }).orders).toMatchObject([
        { id: orderId },
      ]);

      // Later, they deliver by the call the asynchronous mode is closed with.
      const delivered = await gateway.call(
        "POST",
        `/v0/orders/${encodeURIComponent(orderId)}/deliver`,
        {
          body: { activation_code: "LPA:1$rsp.example$AB12" },
          headers: { authorization: `Bearer ${MERCHANT_KEY}` },
        },
      );
      expect(delivered.status).toBe(200);
      expect(delivered.body).toStrictEqual({ ok: true, result: "delivered" });

      // A repeat of that call is safe, and charges nothing a second time. This
      // one carries a different code from the first, which is the case the
      // buyer's copy of the goods depends on: the answer is the same either
      // way, so nothing but the stored order can tell whether it was honoured.
      const again = await gateway.call(
        "POST",
        `/v0/orders/${encodeURIComponent(orderId)}/deliver`,
        {
          body: { activation_code: "LPA:1$rsp.example$SOMETHINGELSE" },
          headers: { authorization: `Bearer ${MERCHANT_KEY}` },
        },
      );
      expect(again.body).toStrictEqual({ ok: true, result: "already_delivered" });
      expect(gateway.facilitator.settles).toHaveLength(1);
      expect((await gateway.store.orderById(orderId))?.delivery).toStrictEqual({
        activation_code: "LPA:1$rsp.example$AB12",
      });

      // The receipt is written and the order is closed.
      const receipt = await gateway.store.receiptForOrder(orderId);
      expect(receipt).toMatchObject({
        order_id: orderId,
        outcome: "delivered",
        price: { amount: "12.50", currency: "USD" },
      });

      const closed = await gateway.call("GET", "/v0/orders?open=true", {
        headers: { authorization: `Bearer ${MERCHANT_KEY}` },
      });
      expect((closed.body as { orders: unknown[] }).orders).toStrictEqual([]);
    } finally {
      await gateway.close();
    }
  });

  it("walks a merchant from registering to a sale, on a key nothing here chose", async () => {
    // The walk with the least borrowed of all. Every other test in this file
    // starts from a merchant and a key written into the store by hand; this one
    // starts from nothing but the invitation code, and the key it sells with is
    // the one the gateway generated and showed once. If registration wrote a
    // digest of anything but the string it printed, or hung the key on a
    // merchant other than the one it made, the sale below simply does not
    // happen — and that failure looks like a wrong key rather than like the
    // defect it is, which is why it is worth walking rather than asserting on.
    //
    // It is also the whole road a new merchant walks: register, choose the name
    // buyers will read, say where the money goes, publish, sell. Neither middle
    // step is optional and this is where that is shown rather than asserted — a
    // card published before them is refused, and the sale below never happens.
    const gateway = await aGatewayOnAPort();
    try {
      const registered = await gateway.call("POST", "/v0/merchants", {
        body: { invitation: INVITATION },
      });
      expect(registered.status).toBe(200);
      const made = registered.body as { merchant_id: string; secret: string };
      expect(made.merchant_id).not.toBe("");

      const theirKey = made.secret;
      const card = {
        merchant_item_id: "desk-for-a-day",
        title: "A desk for a day",
        description: "One desk, one day, coffee included",
        price: { amount: "20.00", currency: "USD" },
        result: { door_code: { type: "string" } },
        fulfillment: "sync",
      };

      // Nothing of theirs goes on sale before they have a name and somewhere to
      // be paid. Published now, this card would be offered to a buyer's agent
      // through a payment request naming no seller at all, with nowhere for the
      // money to go — and the refusal names both, in one answer, rather than
      // sending them round the loop twice.
      const early = await gateway.call("POST", "/v0/catalog/publish", {
        headers: { authorization: `Bearer ${theirKey}` },
        body: card,
      });
      expect(early.status).toBe(422);
      expect(
        (early.body as { error: { problems: { code: string }[] } }).error.problems
          .map((finding) => finding.code)
          .sort(),
      ).toStrictEqual(["no_payout_wallet", "no_seller_name"]);

      const named = await gateway.call("POST", "/v0/seller-name", {
        headers: { authorization: `Bearer ${theirKey}` },
        body: { seller_name: "The registered shop" },
      });
      expect(named.status).toBe(200);

      // And the address their sales are paid into, which is theirs: the
      // challenge below names it, and the gateway's own configured address is a
      // different string, so a card offered against ours would show up here.
      //
      // Sent in the lower-case spelling and read back in the one their wallet
      // shows, which is what everything from here on holds. An address of all
      // digits would read back the same whichever the canon was and would pin
      // nothing, so this one has letters in it.
      const theirWallet = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
      const paidAt = await gateway.call("POST", "/v0/payout-wallet", {
        headers: { authorization: `Bearer ${theirKey}` },
        body: { payout_wallet: theirWallet.toLowerCase() },
      });
      expect(paidAt.status, JSON.stringify(paidAt.body)).toBe(200);
      expect(paidAt.body).toStrictEqual({ payout_wallet: theirWallet });

      const published = await gateway.call("POST", "/v0/catalog/publish", {
        headers: { authorization: `Bearer ${theirKey}` },
        body: card,
      });
      expect(published.status).toBe(200);
      const itemId = (published.body as { id: string }).id;

      // What a crawler asks for, and what it is told about the seller. This is
      // the whole reason a merchant is made to choose a name: without one the
      // challenge carries no seller at all, and the merchant is absent from
      // every catalogue built from these with nothing anywhere saying why.
      const probed = await gateway.call("GET", `/x402/${itemId}/purchase`);
      expect(probed.status).toBe(402);
      const declared = decodePaymentRequiredHeader(probed.headers.get("payment-required") ?? "");
      expect(
        (declared as unknown as { resource: { serviceName?: string } }).resource.serviceName,
      ).toBe("The registered shop");
      expect(declared.extensions?.bazaar).toBeDefined();
      // And who the agent is told to pay: this merchant, at the address they
      // set a moment ago, and not the one the gateway itself was configured
      // with.
      expect(declared.accepts[0]?.payTo).toBe(theirWallet);
      expect(declared.accepts[0]?.payTo).not.toBe(PAY_TO);

      // And the sale itself, on their key and their worker.
      const challenged = await gateway.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });
      expect(challenged.status).toBe(402);

      const worker = aMerchantsWorker(gateway.call, () => ({ door_code: "8812" }), theirKey);
      const bought = await gateway.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
        headers: {
          "payment-signature": payFor(challenged.headers.get("payment-required") ?? ""),
        },
      });
      await worker.stop();

      expect(bought.status).toBe(200);
      expect((bought.body as { delivered: unknown }).delivered).toStrictEqual({
        door_code: "8812",
      });

      // Their keys, as their own cabinet would read them: none at all. This
      // merchant has written no code and asked for no key of their own, and
      // the key registering handed over is the one their cabinet calls with,
      // which this list does not carry. `this_call` names it all the same, and
      // that identifier reaches this walk through no answer at all — it is
      // simply what the field says.
      const listed = await gateway.call("GET", "/v0/keys", {
        headers: { authorization: `Bearer ${theirKey}` },
      });
      const theKeys = listed.body as { keys: unknown[]; this_call: string };
      expect(theKeys.keys).toStrictEqual([]);
      expect(theKeys.this_call).not.toBe("");

      // Two keys for two workers, and the second retires the first — which is
      // what a merchant does when a box is decommissioned, and the ordinary use
      // of the call.
      const first = await gateway.call("POST", "/v0/keys", {
        body: { label: "the first worker" },
        headers: { authorization: `Bearer ${theirKey}` },
      });
      const second = await gateway.call("POST", "/v0/keys", {
        body: { label: "the second worker" },
        headers: { authorization: `Bearer ${theirKey}` },
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const retiring = first.body as { key: { id: string }; secret: string };
      const other = second.body as { key: { id: string }; secret: string };

      // A key cannot retire itself: that one click is the whole of what the
      // rule covers, and the key still works after the refusal, because a
      // refusal that had already written the revocation would be worse than no
      // rule at all.
      const itself = await gateway.call(
        "POST",
        `/v0/keys/${encodeURIComponent(other.key.id)}/disable`,
        { headers: { authorization: `Bearer ${other.secret}` } },
      );
      expect(itself.status).toBe(409);

      // And the key their cabinet is signed in with is not this call's to
      // touch, whichever key asks. The identifier comes from the field above,
      // which is the only place on this surface it appears at all.
      const theCabinets = await gateway.call(
        "POST",
        `/v0/keys/${encodeURIComponent(theKeys.this_call)}/disable`,
        { headers: { authorization: `Bearer ${other.secret}` } },
      );
      expect(theCabinets.status).toBe(409);
      expect((theCabinets.body as { error: { code: string } }).error.code).toBe(
        "key_made_for_a_cabinet",
      );

      const revoked = await gateway.call(
        "POST",
        `/v0/keys/${encodeURIComponent(retiring.key.id)}/disable`,
        { headers: { authorization: `Bearer ${other.secret}` } },
      );
      expect(revoked.status).toBe(200);

      const withTheRetired = await gateway.call("GET", "/v0/cards", {
        headers: { authorization: `Bearer ${retiring.secret}` },
      });
      const withTheirOwn = await gateway.call("GET", "/v0/cards", {
        headers: { authorization: `Bearer ${theirKey}` },
      });
      expect(withTheRetired.status).toBe(401);
      expect(withTheirOwn.status).toBe(200);
      expect(
        (withTheirOwn.body as { cards: { id: string }[] }).cards.map((card) => card.id),
      ).toEqual([itemId]);
    } finally {
      await gateway.close();
    }
  });
});
