/**
 * The SDK driven by a merchant that is not the documentation's.
 *
 * Every other test in this package works from the portal's own example — one
 * card, one order, one delivery field — which is exactly the way a client
 * library can look finished and still not fit anything real. The products
 * below are the pilot merchant's, as recorded in
 * `docs/research/11-freeland-api-facts.md`: a rented phone number sold
 * synchronously at a price computed per sale, and an eSIM plan whose profile
 * arrives after the money has moved.
 *
 * What comes from that record and what does not is worth separating, because
 * this file's whole argument is that it is not working from invented material.
 *
 * From the record: the two products and their modes; the number's price of
 * $8.75, reached from the supplier's $7.00 by the markup that record works
 * through, and the fact that it is computed per sale rather than fixed; the
 * eSIM delivery fields —
 * the ICCID, the LPA string and the iOS link — and the supplier answering that
 * no profile is available, which is the documented shape of a product that has
 * run out; and the idempotency key that merchant's own purchase API already
 * requires.
 *
 * Constructed, because the record does not carry them, and this list is the
 * whole of it: the eSIM plan's price of $18.90, both identifiers, both titles
 * and both descriptions, the eSIM's delivery deadline of 900 seconds, the
 * number's `phone_number` result field, and every timestamp on this page.
 *
 * The point of the run is that nothing here is a fixture of the SDK's. One
 * merchant publishes two cards, answers a price question, delivers one order
 * inside the handler and another by a call made later, refuses a third when
 * the supplier has nothing left, receives an event, and handles the same order
 * twice without provisioning it twice — over one subscription, against a
 * gateway that is nothing but the route table.
 */

import type { Card, HandlerAnswer, Order, OrderEvent, QuoteRequest } from "@coinslot/contracts";
import { afterEach, expect, it } from "vitest";
import { checkCard } from "./check-card.js";
import { createClient } from "./client.js";
import { contractVersion } from "./contract.js";
import { type FakeGateway, type GatewayAnswer, startFakeGateway } from "./testing/fake-gateway.js";
import type { Subscription, WorkerProblem } from "./worker.js";

const API_KEY = "freeland-merchant-key";
const AT = "2026-08-26T11:00:00Z";

const numberCard: Card = {
  merchant_item_id: "virtual-number-monthly-nl",
  title: "Virtual phone number, the Netherlands, one month",
  description:
    "A rented number for one month, incoming SMS only. One-time codes are read out of the message automatically. Whether a given sender's code arrives depends on that sender.",
  price: { amount: "8.75", currency: "USD" },
  params: { country: { type: "string", required: true, title: "Country of the number" } },
  result: { phone_number: { type: "string", title: "The number itself" } },
  fulfillment: "sync",
  price_check: "handler",
};

const esimCard: Card = {
  merchant_item_id: "esim-europe-7d",
  title: "eSIM, Europe, seven days",
  description:
    "A data plan for seven days across Europe. The profile is issued after the purchase and is installed from the link or the code below; it cannot be moved to another device afterwards.",
  price: { amount: "18.90", currency: "USD" },
  result: {
    iccid: { type: "string", title: "The profile's ICCID" },
    lpa_string: { type: "string", title: "The activation string" },
    ios_tap_link: { type: "string", title: "One-tap installation on iOS" },
  },
  fulfillment: "async",
  fulfill_deadline_seconds: 900,
};

const orderFor = (id: string, item: string, amount: string, params: Order["params"]): Order => ({
  id,
  merchant_item_id: item,
  params,
  price: { amount, currency: "USD", at: AT, as_of: AT },
  test: false,
});

const numberOrder = orderFor("ord-nl-1", numberCard.merchant_item_id, "8.75", {
  country: "NL",
});
const esimOrder = orderFor("ord-esim-1", esimCard.merchant_item_id, "18.90", {});
const soldOutOrder = orderFor("ord-esim-2", esimCard.merchant_item_id, "18.90", {});

const numberQuestion: QuoteRequest = {
  merchant_item_id: numberCard.merchant_item_id,
  price_id: "price-nl-1",
  purpose: "purchase",
  expires_at: "2026-08-26T11:05:00Z",
};

const refundDue: OrderEvent = {
  type: "order.refund_due",
  order_id: soldOutOrder.id,
  at: AT,
  price: { amount: "18.90", currency: "USD" },
  reason: "refused",
};

const carrying = (...payloads: object[]): GatewayAnswer => ({
  body: { contract_version: contractVersion, envelopes: payloads },
});

const envelope = (kind: string, id: string, payload: unknown): object => ({
  kind,
  id,
  sent_at: AT,
  payload,
});

let gateway: FakeGateway | undefined;
let running: Subscription | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await gateway?.close();
  gateway = undefined;
});

const waitUntil = async (ready: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`waited for ${what} and it never happened`);
};

it("carries one merchant's two products from publishing to the last refusal", async () => {
  // What breaks if this fails: the SDK works for the documentation's one
  // example and not for a catalog anybody actually sells.
  expect(checkCard(numberCard).problems).toStrictEqual([]);
  expect(checkCard(esimCard).problems).toStrictEqual([]);

  // The merchant's own systems, standing in for their API. Their purchase
  // endpoint takes an idempotency key, which is what makes the repeated
  // delivery below safe on their side as well as ours.
  const supplierCostUsd = "7.00";
  const provisioned = new Map<string, { iccid: string; lpa: string; ios: string }>();
  let profilesLeft = 1;

  const provision = (idempotencyKey: string): boolean => {
    if (provisioned.has(idempotencyKey)) return true;
    if (profilesLeft === 0) return false;

    profilesLeft -= 1;
    provisioned.set(idempotencyKey, {
      iccid: "8931080000000000001",
      lpa: "LPA:1$rsp.example.net$K2-9QF-0A1",
      ios: "https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA:1$rsp.example.net$K2-9QF-0A1",
    });

    return true;
  };

  const polls: GatewayAnswer[] = [
    carrying(envelope("quote_request", "env-q1", numberQuestion)),
    carrying(envelope("order", "env-o1", numberOrder)),
    carrying(envelope("order", "env-o2", esimOrder)),
    // The same eSIM order again: delivery is at least once, and a restart or a
    // dropped answer brings it back under the same identifier.
    carrying(envelope("order", "env-o2", esimOrder)),
    carrying(envelope("order", "env-o3", soldOutOrder)),
    carrying(envelope("order_event", "env-e1", refundDue)),
  ];

  const parked = new Promise<GatewayAnswer>(() => {});
  const published: string[] = [];

  gateway = await startFakeGateway({
    apiKey: API_KEY,
    routes: {
      publish_card: (call) => {
        const key = (call.body as Card).merchant_item_id;
        published.push(key);
        return { body: { ok: { id: `cat-${published.length}` } } };
      },
      poll_worker: (_call, index) => polls[index] ?? parked,
      answer_quote: () => ({ body: { used: true } }),
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
    },
  });

  const coinslot = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

  const forNumber = await coinslot.catalog.publish(numberCard);
  const forEsim = await coinslot.catalog.publish(esimCard);

  expect(forNumber).toStrictEqual({ ok: { id: "cat-1" } });
  expect(forEsim).toStrictEqual({ ok: { id: "cat-2" } });

  const problems: WorkerProblem[] = [];
  const events: OrderEvent[] = [];
  const accepted: string[] = [];

  running = coinslot.orders.subscribe(
    (order): HandlerAnswer => {
      if (order.merchant_item_id === numberCard.merchant_item_id) {
        return { delivered: { phone_number: "+31 970 1020 3040" } };
      }

      // The asynchronous product: say it is taken on, provision behind the
      // answer, and close it with a call made later. The idempotency key is
      // the order's identifier, so the redelivery below provisions nothing
      // twice.
      accepted.push(order.id);
      provision(order.id);

      return { accepted: { eta_seconds: 120 } };
    },
    {
      onEvent: (arrived) => {
        events.push(arrived);
      },
      onProblem: (problem) => problems.push(problem),
    },
  );

  coinslot.pricing.onQuote((question) => {
    if (question.merchant_item_id !== numberCard.merchant_item_id) {
      return { available: false, as_of: AT };
    }

    // The markup comes from the worked example in the record — $7.00 becomes
    // $8.75 — rather than from the sentence beside it, which calls the same
    // markup a fifth. The two do not agree, and a pair of real numbers is the
    // firmer of the two facts.
    const cost = Number(supplierCostUsd);

    return {
      available: true,
      price: { amount: (cost * (8.75 / 7)).toFixed(2), currency: "USD" },
      as_of: AT,
    };
  });

  await waitUntil(() => events.length === 1, "everything through the subscription");

  // The price question was answered against its own identifier, at the price
  // the merchant computed and not the one on the card.
  expect(gateway.callsTo("answer_quote")).toHaveLength(1);
  expect(gateway.callsTo("answer_quote")[0]?.params).toStrictEqual({ price_id: "price-nl-1" });
  expect(gateway.callsTo("answer_quote")[0]?.body).toStrictEqual({
    available: true,
    price: { amount: "8.75", currency: "USD" },
    as_of: AT,
  });

  // The synchronous order was answered by the handler's return, and the
  // asynchronous ones were taken on — the second time as well as the first,
  // which is what a redelivery is meant to look like.
  const answers = gateway.callsTo("answer_order");
  expect(answers.map((call) => call.params.order_id)).toStrictEqual([
    numberOrder.id,
    esimOrder.id,
    esimOrder.id,
    soldOutOrder.id,
  ]);
  expect(answers[0]?.body).toStrictEqual({ delivered: { phone_number: "+31 970 1020 3040" } });
  expect(answers[1]?.body).toStrictEqual({ accepted: { eta_seconds: 120 } });

  // The handler ran on every delivery and the merchant's own system issued one
  // profile: the idempotency the portal asks of them, kept by them.
  expect(accepted).toStrictEqual([esimOrder.id, esimOrder.id, soldOutOrder.id]);
  expect(provisioned.size).toBe(1);
  expect(profilesLeft).toBe(0);

  // The profile that was issued is closed by a call made later, out of the
  // handler entirely.
  const issued = provisioned.get(esimOrder.id);
  const delivered = await coinslot.orders.deliver(esimOrder.id, {
    iccid: issued?.iccid,
    lpa_string: issued?.lpa,
    ios_tap_link: issued?.ios,
  });

  expect(delivered).toStrictEqual({ ok: true, result: "delivered" });

  // The one the supplier had nothing left for is refused, without waiting for
  // the delivery deadline to arrive at the same place by silence.
  const refused = await coinslot.orders.refuse(soldOutOrder.id, {
    code: "out_of_stock",
    message: "the supplier has no profile available for this plan",
  });

  expect(refused).toStrictEqual({ ok: true, result: "refused" });

  // And the debt that refusal created came back as an event, with nothing
  // sent in reply to it.
  expect(events).toStrictEqual([refundDue]);
  expect(problems).toStrictEqual([]);
});
