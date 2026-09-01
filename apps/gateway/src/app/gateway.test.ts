import type { Card } from "@nuanu-ai/coinslot-contracts";
import {
  CARD_REJECTED,
  CatalogPageSchema,
  PublishResultSchema,
  WorkerPollResponseSchema,
} from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asTimestamp } from "../ports/clock.js";
import {
  authorisation,
  type Harness,
  harness,
  paymentNamingNoPayer,
  workOnce,
  workUntilStopped,
} from "../testing/harness.js";
import { orderDocumentOf } from "./runner.js";

/** Two wallets, for the tests that turn on which of them signed. */
const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** Alice's own address as another client would write it. One wallet, not two. */
const ALICE_SHOUTED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  params: { nights: { type: "integer", required: true } },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const asyncCard: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

const livePriced = (card: Card): Card => ({ ...card, price_check: "handler" });

let open: Harness | null = null;
const started = async (overrides: Record<string, string> = {}) => {
  open = await harness(overrides);
  return open;
};

afterEach(async () => {
  await open?.stop();
  open = null;
});

const published = async (harnessed: Harness, card: Card): Promise<string> => {
  const result = await harnessed.gateway.publishCard(harnessed.merchant.id, card);
  expect(PublishResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok) throw new Error(`publishing failed: ${JSON.stringify(result.error.problems)}`);
  return result.id;
};

describe("the catalog", () => {
  it("answers a card that will not do with everything wrong with it at once", async () => {
    // A merchant fixing one field per round trip is the experience the list of
    // findings exists to prevent.
    const harnessed = await started();

    const result = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "",
      title: "",
    });

    expect(PublishResultSchema.safeParse(result).success).toBe(true);
    if (result.ok) throw new Error("a broken card was published");
    expect(result.error.code).toBe(CARD_REJECTED);
    expect(result.error.retryable).toBe(false);
    expect(result.error.problems.length).toBeGreaterThan(1);
    // The sentence is not the list said again: it names the first finding and
    // counts the rest, which is what a person reading one line of a log needs.
    // That it is not blank is the schema's business and is checked there.
    expect(result.error.message).toContain(String(result.error.problems.length));
  });

  it("shows an agent the card as a card, and never the merchant's own key", async () => {
    // The projection is the whole reason a public card exists: our catalog
    // identifier travels, the merchant's internal key does not.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);

    const page = await harnessed.gateway.catalog();

    expect(CatalogPageSchema.safeParse(page).success).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(itemId);
    expect(JSON.stringify(page)).not.toContain("room-101");
  });
});

describe("a synchronous purchase", () => {
  it("goes from the catalog to the goods, with the charge last", async () => {
    // The whole promise of the synchronous mode: the agent is answered with the
    // goods themselves, and the buyer's money moves only after the merchant has
    // actually produced them.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    expect(offered.step).toBe("pay");
    if (offered.step !== "pay") throw new Error("no price was offered");
    expect(offered.order.order.price?.amount).toBe("80.00");
    expect(harnessed.facilitator.settles).toHaveLength(0);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();

    expect(bought.step).toBe("settled");
    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.order.order.state).toBe("delivered");
    expect(bought.delivery).toStrictEqual({ access_code: "SESAME" });

    // Verified before the merchant saw it, executed after he answered.
    expect(harnessed.facilitator.verifies).toHaveLength(1);
    expect(harnessed.facilitator.settles).toHaveLength(1);

    const receipt = await harnessed.store.receiptForOrder(offered.order.order.id);
    expect(receipt?.outcome).toBe("delivered");
    expect(receipt?.price.amount).toBe("80.00");
  });

  it("charges nothing when the merchant refuses", async () => {
    // "A refusal before the charge" is the literal reading of the mode, and the
    // one thing a merchant is promised about refusing.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "the room is taken" } }),
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();

    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.order.order.state).toBe("failed");
    expect(harnessed.facilitator.settles).toHaveLength(0);
    expect(await harnessed.store.receiptForOrder(offered.order.order.id)).toBeNull();
  });

  it("takes nothing, and leaves the order open, when a payment does not check out", async () => {
    // A payment the payment layer will not vouch for closes nothing and claims
    // nothing: the order stays exactly where it was and ends on its own
    // deadline, so a stranger's junk cannot spend the life of an order somebody
    // else was issued a challenge for. Nothing is charged, and the buyer may
    // present a corrected payment while the quote still stands.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willRefuseVerification("insufficient_funds", "the wallet is empty");

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );

    expect(bought.step).toBe("payment_not_verified");
    if (bought.step !== "payment_not_verified") throw new Error("a bad payment was taken");
    expect(bought.why).toContain("the wallet is empty");
    expect(bought.retryable).toBe(false);

    const stillOpen = await harnessed.store.orderById(offered.order.order.id);
    expect(stillOpen?.order.state).toBe("quoted");
    expect(stillOpen?.paidBy).toBeNull();
    expect(harnessed.facilitator.settles).toHaveLength(0);
    // The junk payment never even claimed its fingerprint against the order.
    expect(harnessed.facilitator.verifies).toHaveLength(1);
  });

  it("leaves the goods with the merchant and the money with the buyer when the charge fails last", async () => {
    // The rare one the machine has a whole state for: the goods exist and the
    // charge did not go through. The buyer is not told he bought nothing, and
    // the merchant is told he is holding something nobody paid for.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: false, reason: "the transfer reverted" });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();

    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.order.order.state).toBe("delivered_unpaid");

    const told = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);
    expect(told.envelopes.map((e) => e.kind === "order_event" && e.payload.type)).toContain(
      "order.payment_failed_after_delivery",
    );
  });

  it("says nobody knows when the charge goes quiet, rather than saying it failed", async () => {
    // The fifth gate, in the one place it costs money: an agent told his
    // purchase did not happen goes and buys the same thing elsewhere without
    // looking at his wallet.
    // The budget is wide on purpose: the header on `brisk` in deadlines.test.ts.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    await worker.stop();

    // The clock on the charge ran out and declared the silence — in the word
    // that keeps "nobody knows" apart from "it did not go through". The goods
    // exist, so the order is the one the portal calls unclosed rather than a
    // refusal, and the agent is told the answer is not in yet.
    const parked = await harnessed.store.orderById(offered.order.order.id);
    expect(parked?.order.state).toBe("delivered_unpaid");
    expect(parked?.order.payment).toBe("outcome_unknown");
    // And no second charge went out on top of the one nobody has heard from.
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });
});

describe("an asynchronous purchase", () => {
  it("takes the money first and answers with an order and a receipt", async () => {
    // The other half of the model: the merchant is not asked before the charge,
    // so the agent is answered with an order rather than with goods.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );

    expect(bought.step).toBe("under_way");
    if (bought.step !== "under_way") throw new Error("the agent was made to wait");
    expect(bought.order.order.state).toBe("paid");
    expect(bought.order.order.payment).toBe("settled");
    expect(await harnessed.store.receiptForOrder(offered.order.order.id)).toBeNull();

    // And the merchant then does the work, on his own clock.
    const worked = await workOnce(harnessed, {
      onOrder: () => ({ accepted: { eta_seconds: 60 } }),
    });
    expect(worked).toBe(1);

    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        activation_code: "LPA:1$X",
      },
    );
    expect(answered).toStrictEqual({ ok: true, result: "delivered" });

    const closed = await harnessed.store.orderById(offered.order.order.id);
    expect(closed?.order.state).toBe("delivered");
    expect((await harnessed.store.receiptForOrder(offered.order.order.id))?.outcome).toBe(
      "delivered",
    );
  });

  it("stamps the receipt with the moment the money moved, not the moment it was written", async () => {
    // The charge goes through at the purchase and the goods come hours later.
    // A receipt stamped with the delivery would tell the merchant their buyer
    // was charged at a moment when nothing had happened yet, and reconciling
    // against it would come out wrong by exactly that gap.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    const whenTheMoneyMoved = harnessed.now();

    harnessed.advance(6 * 60 * 60 * 1_000);
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, { activation_code: "A" });

    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.paid_at).toBe(new Date(whenTheMoneyMoved).toISOString());
  });

  it("will not let one payment buy two orders", async () => {
    // A signed payment says how much, to whom and on which chain, and nothing
    // about which purchase it is for. Two orders at the same price would
    // otherwise both verify, both go to a merchant and both be delivered, and
    // only the second charge would fail — leaving a merchant who handed over
    // goods for nothing.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const first = await harnessed.gateway.beginPurchase(itemId, {});
    const second = await harnessed.gateway.beginPurchase(itemId, {});
    if (first.step !== "pay" || second.step !== "pay") throw new Error("no price was offered");

    const bought = await harnessed.gateway.payPurchase(first.order.order.id, "SIGNED", "SIGNED");
    expect(bought.step).toBe("under_way");

    const replayed = await harnessed.gateway.payPurchase(second.order.order.id, "SIGNED", "SIGNED");

    expect(replayed.step).toBe("payment_already_spent");
    if (replayed.step !== "payment_already_spent") throw new Error("the replay was taken");
    expect(replayed.heldBy).toBe(first.order.order.id);
    // The replay is checked with the payment layer — the claim guard comes after
    // verification, so a payment that fails to check out never burns a claim —
    // but the claim stops it before it can own a second order or be charged.
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect((await harnessed.store.orderById(second.order.order.id))?.order.state).toBe("quoted");
    expect((await harnessed.store.orderById(second.order.order.id))?.paidBy).toBeNull();
  });

  it("lets the same order present the same payment again", async () => {
    // A dropped connection and a retry is the ordinary case, and the order that
    // owns a payment still owns it on the second try.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    await harnessed.gateway.payPurchase(orderId, "SIGNED", "SIGNED");
    const again = await harnessed.gateway.payPurchase(orderId, "SIGNED", "SIGNED");

    expect(again.step).not.toBe("payment_already_spent");
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("closes a purchase whose charge failed after delivery when the agent pays again", async () => {
    // The portal's promise to both sides: the goods the merchant already made
    // are not thrown away, and a repeat carries the payment through against
    // them without asking him to produce anything a second time.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle(
      { settled: false, reason: "the transfer reverted" },
      { settled: true, transaction: "0xsecond" },
    );

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // Both payments are signed from one wallet, so the repeat comes from the
    // buyer who bought — carrying a fresh authorisation, which is a different
    // signed thing and a different fingerprint. The second spells the address
    // in capitals, which is a thing clients differ on and the chain does not:
    // a buyer refused their own repeat over the shift key would be this whole
    // defect again, in miniature.
    const first = authorisation(harnessed, ALICE, "0x01");
    const second = authorisation(harnessed, ALICE_SHOUTED, "0x02");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await harnessed.gateway.payPurchase(orderId, first.payment, first.fingerprint);
    await worker.stop();
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("delivered_unpaid");

    const repeated = await harnessed.gateway.payPurchase(
      orderId,
      second.payment,
      second.fingerprint,
    );

    expect(repeated.step).toBe("settled");
    if (repeated.step !== "settled") throw new Error("the repeat did not settle");
    expect(repeated.order.order.state).toBe("delivered");
    expect(repeated.delivery).toStrictEqual({ access_code: "SESAME" });
    // The merchant was asked for nothing the second time round.
    expect(harnessed.facilitator.settles).toHaveLength(2);
    // And the charge that closed it was the payment the agent actually
    // presented. Counting the charges says nothing about this: the first
    // authorisation had already failed, and charging it again would have taken
    // nothing while the one the agent sent was thrown away.
    expect(harnessed.facilitator.settles.map((charge) => charge.payment)).toStrictEqual([
      first.payment,
      second.payment,
    ]);
    expect(harnessed.facilitator.verifies.at(-1)?.payment).toBe(second.payment);
  });

  it("keeps the last few things the payment layer said, and counts what it dropped", async () => {
    // They are what an operator reconciles a silent charge from, and they
    // arrive on a route that takes no key — so the list is bounded, and a
    // reader of the last one needs to know whether there was one or twenty.
    // A whole synchronous purchase says two things: the verification, and the
    // charge. With room for one, the charge is kept and the verification is
    // counted among what fell off.
    const harnessed = await started({ PAYMENT_WORDS_KEPT: "1" });
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "X" } }),
    });
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await worker.stop();

    const record = await harnessed.store.orderById(orderId);
    expect(record?.paymentWords).toHaveLength(1);
    expect(record?.paymentWords[0]?.about).toBe("settle");
    expect(record?.paymentWordsDropped).toBe(1);
  });

  it("does not take a second payment on an order whose first charge went quiet", async () => {
    // The machine refuses a repeat there, because a second charge would be the
    // buyer's money spent on a guess about the first. What must not happen is
    // the refusal being ignored and the new payment written down anyway: the
    // record of which authorisation is unaccounted for is the only thing
    // anybody could ever reconcile that order from.
    // The budget is wide on purpose: the header on `brisk` in deadlines.test.ts.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    // The purchase comes back when the promised ceiling runs out. Both payments
    // are signed from the same wallet, so the second reaches the repeat the
    // machine refuses rather than being turned away as a stranger's.
    const first = authorisation(harnessed, ALICE, "0x01");
    const second = authorisation(harnessed, ALICE, "0x02");
    await harnessed.gateway.payPurchase(orderId, first.payment, first.fingerprint);
    await worker.stop();

    const stuck = await harnessed.store.orderById(orderId);
    expect(stuck?.order.payment).toBe("outcome_unknown");

    const refused = await harnessed.gateway.payPurchase(
      orderId,
      second.payment,
      second.fingerprint,
    );

    expect(refused.step).toBe("payment_not_taken");
    if (refused.step !== "payment_not_taken") throw new Error("the second payment was taken");
    expect(refused.retryable).toBe(true);

    // Nothing was charged, and the record of the charge that went quiet is
    // exactly as it was.
    const after = await harnessed.store.orderById(orderId);
    expect(after?.payment).toBe(first.payment);
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("answers a second delivery the same way as the first", async () => {
    // The portal's promise: called again after a dropped connection, deliver
    // delivers nothing twice and charges nothing twice.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const first = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        activation_code: "A",
      },
    );
    const again = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        activation_code: "A",
      },
    );

    expect(first).toStrictEqual({ ok: true, result: "delivered" });
    expect(again).toStrictEqual({ ok: true, result: "already_delivered" });
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("owes a refund when the merchant refuses after the money moved", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) });

    const answered = await harnessed.gateway.refuseOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        code: "out_of_stock",
        message: "the supplier has none",
      },
    );

    expect(answered).toStrictEqual({ ok: true, result: "refused" });
    const owing = await harnessed.store.orderById(offered.order.order.id);
    expect(owing?.order.state).toBe("refund_due");

    // No receipt, and that is a gap rather than a decision. The receipt
    // vocabulary has a word for an order that owes money back, and receipts are
    // only written when goods are released — so an order that took money and
    // never released any has none to carry that word.
    expect(await harnessed.store.receiptForOrder(offered.order.order.id)).toBeNull();

    const told = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);
    const events = told.envelopes.flatMap((e) => (e.kind === "order_event" ? [e.payload] : []));
    expect(events.map((e) => e.type)).toContain("order.refund_due");
  });

  it("refuses a delivery once the refund has been paid back", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "none",
    });
    await harnessed.gateway.runner.apply(orderId, {
      kind: "refund_settled",
      at: harnessed.now(),
    });

    const late = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "A",
    });

    expect(late).toStrictEqual({
      ok: false,
      error: {
        code: "refund_already_settled",
        message:
          "the buyer has his money back for this order, so there is nothing left to deliver against",
        retryable: false,
      },
    });
  });

  it("closes the debt when late goods arrive before the refund does", async () => {
    // To a buyer, late goods are better than a refund — as long as the refund
    // has not gone through yet.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "cannot_fulfill",
      message: "late",
    });

    const late = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "A",
    });

    expect(late).toStrictEqual({ ok: true, result: "debt_closed_by_delivery" });
    const closed = await harnessed.store.orderById(orderId);
    expect(closed?.order.state).toBe("delivered");
    expect(closed?.order.closure).toBeNull();
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("delivered");
  });
});

describe("the goods against the card that sold them", () => {
  // Every assertion here reads the order back out of the store rather than
  // believing the answer the call gave. The two failures this describes were
  // both invisible from the answer alone: an order marked delivered with
  // nothing behind it answered "delivered", and goods quietly replaced by a
  // later call answered "already_delivered" exactly as they should have.

  it("does not close an order on goods the card never promised", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const answered = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {});

    if (answered?.ok !== false) throw new Error("an empty delivery closed the order");
    expect(answered.error.code).toBe("delivery_does_not_match_card");
    expect(answered.error.message).toContain("activation_code");
    // The sentence is for the person reading a log; the findings are for the
    // handler that has to be fixed, and they name the field rather than leaving
    // his code to pick it back out of a sentence.
    expect(answered.error.problems?.map((problem) => problem.path.join("."))).toStrictEqual([
      "activation_code",
    ]);
    // He can fix his handler and call again; the order is still his to finish.
    expect(answered.error.retryable).toBe(true);

    // And the order itself is untouched: no goods written, no receipt, and the
    // buyer's purchase still under way rather than closed against nothing.
    const record = await harnessed.store.orderById(orderId);
    expect(record?.delivery).toBeNull();
    expect(record?.order.state).not.toBe("delivered");
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
  });

  it("names the first few misfits and counts the rest, rather than writing a paragraph", async () => {
    // A card may declare a dozen fields and a broken handler can miss all of
    // them. The answer has one line for the reason, so the ones it does not
    // name have to be counted: a merchant reading a log needs to tell "these
    // are the problems" from "these are some of them".
    const harnessed = await started();
    const wide: Card = {
      ...asyncCard,
      merchant_item_id: "esim-wide",
      result: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`field_${index}`, { type: "string" }] as const),
      ),
    };
    const itemId = await published(harnessed, wide);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {},
    );

    if (answered?.ok !== false) throw new Error("an empty delivery closed the order");
    const named = Array.from({ length: 9 }, (_, index) => `field_${index}`).filter((field) =>
      answered.error.message.includes(field),
    );
    expect(named).toHaveLength(5);
    expect(answered.error.message).toContain("and 4 more");
  });

  it("stays a line a person can read however much the merchant sends", async () => {
    // Counting the findings is not enough, and this is the case that shows it.
    // Every field the card never declared arrives as one finding whose own text
    // lists all of them, so a cap on the number of findings never fires and the
    // length of what the merchant is told is set by what the merchant sent. A
    // handler looping over the wrong object put fourteen thousand characters
    // into the one line somebody has to read in a log.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const flooded: Record<string, unknown> = { activation_code: "LPA:1$OK" };
    for (let index = 0; index < 300; index += 1) {
      flooded[`undeclared_field_number_${index}`] = "x";
    }
    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      flooded,
    );

    if (answered?.ok !== false) throw new Error("three hundred undeclared fields were delivered");
    // The bound the constants actually promise is five findings of a hundred
    // and sixty letters each, plus a bounded card name and the fixed prose —
    // about twelve hundred. This case makes one enormous finding rather than
    // five, so it lands far inside that; the number to read as the guarantee
    // is the wider one, and it is asserted at the end.
    expect(answered.error.message.length).toBeLessThan(400);
    // Cut short, and saying so — a reader must not mistake what is left for
    // the whole of the complaint.
    expect(answered.error.message).toContain("cut short");
    // And still useful: the first of the offending names is in there.
    expect(answered.error.message).toContain("undeclared_field_number_0");
  });

  it("does not carry a card's own identifier into the answer at whatever length it is", async () => {
    // The card names itself in that message, and the contract puts no maximum
    // on what a merchant may call his own product — so the one bounded thing
    // was quoting an unbounded one. His own card, his own refusal, but the
    // line still has to be readable.
    const harnessed = await started();
    const itemId = await published(harnessed, {
      ...asyncCard,
      merchant_item_id: `esim-${"7".repeat(5_000)}`,
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {},
    );

    if (answered?.ok !== false) throw new Error("an empty delivery closed the order");
    expect(answered.error.message.length).toBeLessThan(400);
    expect(answered.error.message).toContain("activation_code");
  });

  it("stays inside its bound with every long thing at once", async () => {
    // The three things a refusal quotes that have no length of their own, all
    // at their worst in one message: a card naming itself at five thousand
    // characters, nine declared fields every one of them missing, and three
    // hundred undeclared ones arriving. This is the number to read as the
    // promise — the other two tests are cases that land well inside it.
    const harnessed = await started();
    const itemId = await published(harnessed, {
      ...asyncCard,
      merchant_item_id: `esim-${"7".repeat(5_000)}`,
      result: Object.fromEntries(
        Array.from(
          { length: 9 },
          (_, index) => [`declared_field_with_a_long_name_${index}`, { type: "string" }] as const,
        ),
      ),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const everything: Record<string, unknown> = {};
    for (let index = 0; index < 300; index += 1) {
      everything[`undeclared_field_with_a_long_name_${index}`] = "x";
    }
    const answered = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      everything,
    );

    if (answered?.ok !== false) throw new Error("the worst delivery was taken");
    expect(answered.error.message.length).toBeLessThan(1_400);
    expect(answered.error.message).toContain("declared_field_with_a_long_name_0");
  });

  it("refuses a declared field of the wrong type, and a field the card never declared", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);

    const wrongType = await harnessed.gateway.beginPurchase(itemId, {});
    if (wrongType.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(wrongType.order.order.id, "ONE", "ONE");
    const numeric = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      wrongType.order.order.id,
      { activation_code: 7 },
    );
    if (numeric?.ok !== false) throw new Error("a number passed for a declared string");
    expect(numeric.error.code).toBe("delivery_does_not_match_card");
    expect(numeric.error.message).toContain("activation_code");
    expect((await harnessed.store.orderById(wrongType.order.order.id))?.delivery).toBeNull();

    // An undeclared field is refused too. The agent read this card before it
    // paid, and a delivery carrying something the card never described is a
    // delivery it cannot have been expecting.
    const extra = await harnessed.gateway.beginPurchase(itemId, {});
    if (extra.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(extra.order.order.id, "TWO", "TWO");
    const surprised = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      extra.order.order.id,
      { activation_code: "A", puk: "9999" },
    );
    if (surprised?.ok !== false) throw new Error("an undeclared field was delivered");
    expect(surprised.error.code).toBe("delivery_does_not_match_card");
    expect(surprised.error.message).toContain("puk");
    expect((await harnessed.store.orderById(extra.order.order.id))?.delivery).toBeNull();
  });

  it("holds a synchronous handler's own answer to the same card", async () => {
    // The handler's return is the delivery in this mode, so the check has to
    // stand on that road too — otherwise the whole promise is one call away
    // from being unenforced.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 10, 200)).envelopes).toHaveLength(
      1,
    );

    const answered = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: {},
    });

    if (answered?.ok !== false) throw new Error("an empty handler answer closed the purchase");
    expect(answered.error.code).toBe("delivery_does_not_match_card");
    expect(answered.error.message).toContain("access_code");

    // Nothing was written and nothing was charged. The goods can still arrive.
    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
    expect(harnessed.facilitator.settles).toHaveLength(0);

    await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "X" },
    });
    const bought = await buying;
    expect(bought.step).toBe("settled");
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual({
      access_code: "X",
    });

    // And what the buyer was handed is the same thing — measured at his own
    // door rather than in the record, because that is where it matters.
    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.delivery).toStrictEqual({ access_code: "X" });

    // A later answer to the same order, carrying something else, leaves what he
    // holds exactly as it is.
    const again = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "SOMETHING ELSE" },
    });
    expect(again).toStrictEqual({ ok: true, result: "already_delivered" });
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual({
      access_code: "X",
    });
  });

  it("keeps the goods the buyer was first given, whatever a later call carries", async () => {
    // Delivery is at least once by design: a worker restarting, a redelivery
    // and a merchant's own retry all land the same order twice. The repeat is
    // answered as a repeat and must change nothing — a second call carrying
    // different goods used to replace what the agent had already been handed,
    // and the answer looked exactly the same either way.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const first = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$FIRST",
    });
    const again = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$SECOND",
    });

    expect(first).toStrictEqual({ ok: true, result: "delivered" });
    expect(again).toStrictEqual({ ok: true, result: "already_delivered" });

    const kept = await harnessed.store.orderById(orderId);
    expect(kept?.delivery).toStrictEqual({ activation_code: "LPA:1$FIRST" });
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("answers a repeat as a repeat even when what it carries is nothing like the card", async () => {
    // The order already has its goods, so this call could not have written
    // anything whatever it carried, and that is what the merchant is told. A
    // refusal here would be marked worth calling again — on an order that can
    // never take another delivery — and would turn a retry the system asks him
    // to make into a failure against a sale that went through.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$FIRST",
    });

    const junk = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      nothing_the_card_declared: true,
    });

    expect(junk).toStrictEqual({ ok: true, result: "already_delivered" });
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual({
      activation_code: "LPA:1$FIRST",
    });
  });

  it("tells a merchant about his goods before it tells him the order is over", async () => {
    // The order of two true things, pinned because it is a choice. This order
    // is closed and its refund is paid out, and the goods do not fit the card
    // either. The card is what he is told about, because that is the fault in
    // his code; the state of the order arrives on his next call, under the
    // code the contract promises for it. Asking the machine first would mean
    // keeping a copy of its table of what a delivery does in each state.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "none",
    });
    await harnessed.gateway.runner.apply(orderId, { kind: "refund_settled", at: harnessed.now() });

    const wrongGoods = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {});
    if (wrongGoods?.ok !== false) throw new Error("an empty delivery was taken");
    expect(wrongGoods.error.code).toBe("delivery_does_not_match_card");
    // The order has ended, so there is nothing to send again — and what he sent
    // is still his to know, in the same shape as on an order that still stands.
    expect(wrongGoods.error.retryable).toBe(false);
    expect(wrongGoods.error.problems?.map((problem) => problem.path.join("."))).toStrictEqual([
      "activation_code",
    ]);

    // And once his handler is fixed, the order's own answer reaches him.
    const rightGoods = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$LATE",
    });
    if (rightGoods?.ok !== false) throw new Error("a settled refund took a delivery");
    expect(rightGoods.error.code).toBe("refund_already_settled");
    expect(rightGoods.error.retryable).toBe(false);
    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
  });

  it("leaves a delivered order alone when the repeat is the merchant's handler", async () => {
    // The other road into the same order: the worker takes it on again after
    // it closed, and its handler produces goods a second time.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "LPA:1$FIRST",
    });
    const delivered = await harnessed.store.orderById(orderId);
    const receipt = await harnessed.store.receiptForOrder(orderId);

    const again = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { activation_code: "LPA:1$SECOND" },
    });

    expect(again).toStrictEqual({ ok: true, result: "already_delivered" });
    const kept = await harnessed.store.orderById(orderId);
    expect(kept?.delivery).toStrictEqual({ activation_code: "LPA:1$FIRST" });
    // Nothing else moved either — not the state, not the instants on it, and
    // not the receipt the buyer already holds.
    expect(kept?.order).toStrictEqual(delivered?.order);
    expect(await harnessed.store.receiptForOrder(orderId)).toStrictEqual(receipt);
  });
});

describe("two payments racing one order", () => {
  it("gives a losing buyer their authorisation back, so it can buy something else", async () => {
    // The promise: an agent that lost a race for an order still holds a usable
    // signature. Two agents reaching for the last unit is the ordinary shape of
    // this market, and the one that arrives second has done nothing wrong.
    //
    // The claim is taken before the ownership decision on purpose — it is what
    // stops one signature being spent on two orders, and it has to be in place
    // before anything is dispatched. But a presentation refused for ownership
    // never spent anything, so holding the claim afterwards binds a live
    // authorisation to an order it can never pay for, and the agent's next
    // attempt is answered "already spent" and pointed at somebody else's order.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);

    const first = await harnessed.gateway.beginPurchase(itemId, {});
    if (first.step !== "pay") throw new Error("the first purchase did not reach a payment");
    const firstOrder = first.order.order.id;

    // Alice pays and owns it.
    const hers = authorisation(harnessed, ALICE, "0x01");
    const won = await harnessed.gateway.payPurchase(firstOrder, hers.payment, hers.fingerprint);
    expect(won.step).toBe("under_way");

    // Bob arrives second with his own signature and is turned away.
    const his = authorisation(harnessed, BOB, "0x01");
    const lost = await harnessed.gateway.payPurchase(firstOrder, his.payment, his.fingerprint);
    expect(lost.step).toBe("not_this_purchase");

    // The same signature, on an order of his own, buys. Without the release it
    // is answered "already spent" and pointed at Alice's order.
    const second = await harnessed.gateway.beginPurchase(itemId, {});
    if (second.step !== "pay") throw new Error("the second purchase did not reach a payment");
    const again = await harnessed.gateway.payPurchase(
      second.order.order.id,
      his.payment,
      his.fingerprint,
    );

    expect(again.step).toBe("under_way");
  });

  it("lets exactly one own it, charges exactly one, and hands the goods to the winner alone", async () => {
    // The blocker the ownership rule exists for. Two verified payments for one
    // order both pass the payment layer and reach the decision at the same
    // instant; if each read a stale "nobody owns it yet" they would both take
    // it — two buyers, two merchants asked to deliver, one charge that succeeds
    // and one that fails on a merchant who handed over goods for nothing. The
    // decision is made under the store's lock, reading the order there, so the
    // first arrival becomes the owner and the second is turned away.
    // The budget is wide on purpose: the header on `brisk` in deadlines.test.ts.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "300",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "2000",
    });
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    // Hold both verifications so the two calls reach the ownership decision at
    // the same instant. Released together, what decides between them is the
    // in-lock guard — not the order they happened to verify in.
    const hers = authorisation(harnessed, ALICE, "0x01");
    const his = authorisation(harnessed, BOB, "0x01");
    const release = harnessed.facilitator.holdVerification();
    const race = Promise.all([
      harnessed.gateway.payPurchase(orderId, hers.payment, hers.fingerprint),
      harnessed.gateway.payPurchase(orderId, his.payment, his.fingerprint),
    ]);
    for (let i = 0; i < 2_000 && harnessed.facilitator.verifies.length < 2; i += 1) {
      await Promise.resolve();
    }
    expect(harnessed.facilitator.verifies).toHaveLength(2);
    release();

    const [a, b] = await race;
    await worker.stop();

    // Exactly one is handed the goods; the other is turned away as not its
    // purchase. This is the assertion the stale-read defect fails: without the
    // in-lock guard both are treated as the owner and both come away with the
    // goods.
    const winners = [a, b].filter((result) => result.step === "settled");
    const refused = [a, b].filter((result) => result.step === "not_this_purchase");
    expect(winners).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const winner = winners[0];
    if (winner?.step !== "settled") throw new Error("nobody won the race");
    expect(winner.delivery).toStrictEqual({ access_code: "SESAME" });

    // One owner, one charge, and the charge was the owner's payment. The owner
    // is a wallet — the address the winning authorisation was signed from — and
    // the charge carries that authorisation itself.
    const owned = await harnessed.store.orderById(orderId);
    expect(owned?.order.state).toBe("delivered");
    expect([ALICE, BOB]).toContain(owned?.paidBy);
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect(harnessed.facilitator.settles[0]?.payment).toBe(
      owned?.paidBy === ALICE ? hers.payment : his.payment,
    );
  });

  it("does not let a stranger's failed payment stop the buyer who was issued the challenge", async () => {
    // The finding-four answer, made a rule: an anonymous first payment that
    // does not check out closes nothing and claims nothing, so the order stays
    // there for the buyer it was priced for — a stranger cannot spend its life
    // by getting there first with junk.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    harnessed.facilitator.willVerify(
      { verified: false, reason: "signature", message: "not a signature at all" },
      { verified: true, payer: "buyer" },
    );

    const junk = await harnessed.gateway.payPurchase(orderId, "stranger", "stranger-auth");
    expect(junk.step).toBe("payment_not_verified");
    // Untouched: still open, still nobody's, and the junk claimed no fingerprint.
    const afterJunk = await harnessed.store.orderById(orderId);
    expect(afterJunk?.order.state).toBe("quoted");
    expect(afterJunk?.paidBy).toBeNull();

    const bought = await harnessed.gateway.payPurchase(orderId, "buyer", "buyer-auth");
    expect(bought.step).toBe("under_way");
    expect((await harnessed.store.orderById(orderId))?.paidBy).toBe("buyer");
    // The stranger was never charged; the buyer was, once.
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect(harnessed.facilitator.settles[0]?.payment).toBe("buyer");
  });

  it("does not make two payments that name no payer into one buyer", async () => {
    // A payment can decode perfectly and still say nothing about who signed it:
    // a scheme that does not sign an EIP-3009 authorisation sends a signature
    // and no more, which is what an agent's client sends over HTTP today. It
    // passes the route's decode and reaches the flows with no payer in it, so
    // this is a wire case and not a malformed-input case.
    //
    // What has to hold then is that the fingerprint of what was signed carries
    // the whole weight of telling buyers apart. A stand-in payer invented for
    // the unnamed would be the same stand-in every time, and the second sender
    // would be handed the first one's purchase — the defect this rule exists to
    // stop, moved one branch over.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const mine = paymentNamingNoPayer(harnessed);
    const theirs = paymentNamingNoPayer(harnessed);

    const bought = await harnessed.gateway.payPurchase(orderId, mine.payment, mine.fingerprint);
    expect(bought.step).toBe("under_way");

    // Somebody else's payment, equally anonymous, is not this order's.
    const meddling = await harnessed.gateway.payPurchase(
      orderId,
      theirs.payment,
      theirs.fingerprint,
    );
    expect(meddling.step).toBe("not_this_purchase");
    expect((await harnessed.store.orderById(orderId))?.paidBy).toBe(mine.fingerprint);

    // And the other half, or the rule above would be a way of locking a buyer
    // out of their own order: the same anonymous payment presented again is the
    // same buyer, because it fingerprints the same.
    const again = await harnessed.gateway.payPurchase(orderId, mine.payment, mine.fingerprint);
    expect(again.step).not.toBe("not_this_purchase");
  });

  it("does not make two payments naming a blank signer into one buyer", async () => {
    // The same promise where the authorisation is there and its signer is an
    // empty string. It reaches a different line — the payer arrives as `""`
    // rather than as nothing — and an empty string is an identity that every
    // such payment would share. `walletThatPaid` turns it into nobody so the
    // fingerprint stands in, which the `??` on its own would not do.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const nameless = authorisation(harnessed, "", "0x01");
    const alsoNameless = authorisation(harnessed, "", "0x02");

    const took = await harnessed.gateway.payPurchase(
      orderId,
      nameless.payment,
      nameless.fingerprint,
    );
    expect(took.step).toBe("under_way");

    const meddling = await harnessed.gateway.payPurchase(
      orderId,
      alsoNameless.payment,
      alsoNameless.fingerprint,
    );
    expect(meddling.step).toBe("not_this_purchase");
  });
});

describe("the price question", () => {
  it("sells at the price the merchant names, not at the one on the card", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({
        available: true,
        price: { amount: "95.00", currency: "USD" },
        as_of: "2026-08-26T12:00:00.000Z",
      }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();

    if (offered.step !== "pay") throw new Error("no price was offered");
    expect(offered.order.order.price?.amount).toBe("95.00");
    expect(offered.order.order.quoteSource).toBe("merchant_answer");
  });

  it("stamps the sale price when the price was struck, not when the money moved", async () => {
    // The order carries a price so the handler can write the sale down without
    // looking the card up, and `at` is the moment we fixed that price for this
    // sale — here, the moment the merchant's answer came back. It is not the
    // moment of payment: on a card with a price check the agent can spend as
    // long as it likes deciding in between, and a handler that filed the sale
    // under `at` as though it were the charge would have the two records
    // disagree by exactly that thinking time. When the money moved is on the
    // receipt, under its own name.
    const harnessed = await started({ QUOTE_TTL_MS: "600000" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({
        available: true,
        price: { amount: "14.00", currency: "USD" },
        // The merchant answers out of a list published an hour before he was
        // asked, which is what keeps `as_of` a third moment rather than a copy.
        as_of: "2026-08-26T11:00:00.000Z",
      }),
    });
    const struck = harnessed.now();
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    await worker.stop();
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // The agent thinks it over for a minute and a half, and then pays.
    harnessed.advance(90_000);
    const paid = harnessed.now();
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const record = await harnessed.store.orderById(orderId);
    if (record === null) throw new Error("the order went missing");
    const document = orderDocumentOf(record);
    expect(document.price.amount).toBe("14.00");
    expect(document.price.at).toBe(asTimestamp(struck));
    expect(document.price.as_of).toBe("2026-08-26T11:00:00.000Z");

    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      activation_code: "A",
    });
    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.price.at).toBe(asTimestamp(struck));
    expect(receipt?.paid_at).toBe(asTimestamp(paid));
  });

  it("does not sell what the merchant says is gone", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({ available: false, as_of: "2026-08-26T12:00:00.000Z" }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();

    expect(offered.step).toBe("settled");
    if (offered.step !== "settled") throw new Error("the order was not closed");
    expect(offered.order.order.state).toBe("rejected");
    expect(offered.order.order.closure).toStrictEqual({ cause: "unavailable" });
  });

  it("sells a silent synchronous card off its own snapshot", async () => {
    // ADR-0002 §3: where the merchant's live answer still stands between the
    // price and the charge, his silence is an open failure and the card's own
    // number sells. Nobody answers the question here, and our patience for it
    // is one millisecond.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "1" });
    const itemId = await published(harnessed, livePriced(syncCard));

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });

    if (offered.step !== "pay") throw new Error("the silent card did not sell");
    expect(offered.order.order.price?.amount).toBe("80.00");
    expect(offered.order.order.quoteSource).toBe("card_snapshot");
  });

  it("will not start an asynchronous purchase the merchant went silent on", async () => {
    // The other half of the same decision: where the money moves at the
    // purchase, selling at an unknown stock level manufactures debts to buyers,
    // and a lost sale is cheaper than a debt.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "1" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const offered = await harnessed.gateway.beginPurchase(itemId, {});

    expect(offered.step).toBe("settled");
    if (offered.step !== "settled") throw new Error("the order was not closed");
    expect(offered.order.order.state).toBe("rejected");
    expect(offered.order.order.closure).toStrictEqual({ cause: "quote_silent" });
  });

  it("tells a merchant whether his answer arrived in time to price the purchase", async () => {
    // A merchant who set stock aside against the question needs to know whether
    // to release it.
    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    let asked: string | null = null;
    const worker = workUntilStopped(harnessed, {
      onQuote: (question) => {
        asked = question.price_id;
        return {
          available: true,
          price: { amount: "95.00", currency: "USD" },
          as_of: "2026-08-26T12:00:00.000Z",
        };
      },
    });
    await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    await worker.stop();

    if (asked === null) throw new Error("nobody was asked the price");
    const late = await harnessed.gateway.answerQuote(harnessed.merchant.id, asked, {
      available: true,
      price: { amount: "10.00", currency: "USD" },
      as_of: "2026-08-26T12:00:00.000Z",
    });
    expect(late).toStrictEqual({ used: false });
  });

  it("reports the silence itself when there is no reminder to fall back on", async () => {
    // Two things notice that a price never came: the wait inside the purchase,
    // and the clock the machine armed when the order was created. They carry
    // the same fact and normally race, so this test takes the second one away
    // — the queue is told to forget its reminders — and holds the first one to
    // the same answer on its own.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "10" });
    harnessed.queue.remind = async () => undefined;
    const itemId = await published(harnessed, livePriced(asyncCard));

    const offered = await harnessed.gateway.beginPurchase(itemId, {});

    expect(offered.step).toBe("settled");
    if (offered.step !== "settled") throw new Error("the order was not closed");
    expect(offered.order.order.closure).toStrictEqual({ cause: "quote_silent" });
  });

  it("tells a merchant his answer priced nothing when the order had already moved on", async () => {
    // The acknowledgement is his cue to release stock he set aside, so it has to
    // mean what it says. It used to mean only that somebody was still listening,
    // which is a different thing and wrong in exactly the case that matters: the
    // clock on our own patience closes the question a moment before his answer
    // lands, the sale goes through at another price, and he is told his was
    // taken.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "10" });
    const itemId = await published(harnessed, livePriced(syncCard));

    // Nobody answers in time, so the card's own number sells.
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("the silent card did not sell");
    expect(offered.order.order.quoteSource).toBe("card_snapshot");

    // The question is still on the stream. The merchant draws it and answers,
    // too late to have priced anything.
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    if (question?.kind !== "quote_request") throw new Error("nobody was asked the price");

    const acknowledged = await harnessed.gateway.answerQuote(
      harnessed.merchant.id,
      question.payload.price_id,
      {
        available: true,
        price: { amount: "95.00", currency: "USD" },
        as_of: "2026-08-26T12:00:00.000Z",
      },
    );

    expect(acknowledged).toStrictEqual({ used: false });
    // And the sale really did go through at the other price.
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.price?.amount).toBe(
      "80.00",
    );
  });

  it("tells a merchant how long his price will be honoured, not how long we will wait", async () => {
    // The promise, and it is a merchant's stock: `expires_at` on a price
    // question means "until when the price you name will be honoured, so a
    // merchant holding stock against it knows when to stop" (quote.ts). That is
    // not the same number as our own patience for an answer — the gateway sells
    // at a quoted price for the whole of the price's life, which begins when the
    // answer lands and not when the question went out.
    //
    // Told the shorter number, a merchant who set a unit aside releases it while
    // we are still selling against it, which is the oversell the price question
    // exists to prevent.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "500", QUOTE_TTL_MS: "60000" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const buying = harnessed.gateway.beginPurchase(itemId, {});
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 10, 200);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    if (question?.kind !== "quote_request") throw new Error("nobody was asked the price");

    const askedAt = Date.parse(question.sent_at);
    const promised = Date.parse(question.payload.expires_at) - askedAt;

    // An answer later than our patience is refused, so the latest a price can
    // still be alive is that patience plus the price's own life. Erring long
    // makes a merchant hold stock a little too long; erring short makes them
    // release stock we are still selling against.
    expect(promised).toBe(500 + 60_000);

    await harnessed.gateway.answerQuote(harnessed.merchant.id, question.payload.price_id, {
      available: true,
      price: { amount: "95.00", currency: "USD" },
      as_of: new Date(askedAt).toISOString(),
    });
    await buying;
  });

  it("tells a merchant his answer priced nothing when the machine would not take it", async () => {
    // The other half of the same promise, and the one the wording exists for.
    // Somebody is still parked on the question, so an acknowledgement built out
    // of "was anybody listening" would say yes — while the order was closed a
    // moment earlier and his price bought nothing.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "500" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const buying = harnessed.gateway.beginPurchase(itemId, {});
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 10, 200);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    if (question?.kind !== "quote_request") throw new Error("nobody was asked the price");

    // The clock on our own patience gets there first and closes the order.
    const orders = await harnessed.store.orders(harnessed.merchant.id);
    const orderId = orders[0]?.order.id ?? "";
    await harnessed.gateway.runner.apply(orderId, {
      kind: "quote_silent",
      at: harnessed.now(),
    });

    const acknowledged = await harnessed.gateway.answerQuote(
      harnessed.merchant.id,
      question.payload.price_id,
      {
        available: true,
        price: { amount: "9.00", currency: "USD" },
        as_of: "2026-08-26T12:00:00.000Z",
      },
    );

    expect(acknowledged).toStrictEqual({ used: false });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("rejected");
    await buying;
  });

  it("treats a price check it cannot make as a merchant who did not answer", async () => {
    // A card whose price lives at an address of the merchant's own asks over a
    // transport this stage does not serve. Saying so as a silence is honest —
    // nobody told us what this costs — and the mode then decides, which for a
    // synchronous card means the snapshot sells.
    const harnessed = await started();
    const itemId = await published(harnessed, {
      ...syncCard,
      price_check: { url: "https://merchant.example/price" },
    });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });

    if (offered.step !== "pay") throw new Error("the card did not sell");
    expect(offered.order.order.quoteSource).toBe("card_snapshot");
  });

  it("carries the merchant's own `as_of` into the sale price, not the gateway's clock", async () => {
    // The fifth gate on price freshness. `as_of` is the moment the price behind
    // the sale was true; on a live-priced card that moment is the merchant's to
    // state, and it reaches the buyer in the receipt and the merchant's worker
    // in the order. Stamping the gateway's own clock there would claim the price
    // was fresh at the sale when the merchant had priced it earlier. `at` — the
    // moment of purchase — is the gateway's clock, and the two are distinct
    // claims that must not be folded together.
    const merchantPricedAt = "2026-08-26T10:15:00.000Z";

    const harnessed = await started();
    const itemId = await published(harnessed, livePriced(syncCard));

    const worker = workUntilStopped(harnessed, {
      onQuote: () => ({
        available: true,
        price: { amount: "95.00", currency: "USD" },
        as_of: merchantPricedAt,
      }),
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const bought = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await worker.stop();
    if (bought.step !== "settled") throw new Error("the purchase did not settle");

    // The purchase happened at the gateway's clock; the price behind it did not.
    const purchasedAt = asTimestamp(harnessed.now());
    expect(purchasedAt).not.toBe(merchantPricedAt);

    // The order the merchant's worker reads, and the receipt the buyer keeps,
    // both carry the merchant's instant as `as_of` and the gateway's clock as
    // `at`.
    const document = orderDocumentOf(bought.order);
    expect(document.price.as_of).toBe(merchantPricedAt);
    expect(document.price.at).toBe(purchasedAt);

    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.price.as_of).toBe(merchantPricedAt);
    expect(receipt?.price.at).toBe(purchasedAt);

    // Not conflated: here freshness and purchase-time are different moments, and
    // a receipt that reported one for the other would lose the freshness claim.
    expect(receipt?.price.at).not.toBe(receipt?.price.as_of);
  });

  it("stamps a snapshot sale with the price's publish time, not the purchase clock", async () => {
    // The sibling claim on the same gate. A card sold from its own price and
    // never checked live still carries `as_of`: the moment that card price was
    // last published (per the sale-price contract). That is a fact about the
    // price, not about this purchase, so it stays pinned to the publish even as
    // the gateway's clock moves on to the moment of sale — here the two are
    // deliberately an hour and a half apart. Stamping the gateway's own clock
    // for `as_of` would claim the price was published at the sale.
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const publishedAt = asTimestamp(harnessed.now());

    harnessed.advance(90 * 60_000);
    const purchasedAt = asTimestamp(harnessed.now());
    expect(purchasedAt).not.toBe(publishedAt);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    expect(offered.order.order.quoteSource).toBe("card_snapshot");

    const bought = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await worker.stop();
    if (bought.step !== "settled") throw new Error("the purchase did not settle");

    const document = orderDocumentOf(bought.order);
    expect(document.price.as_of).toBe(publishedAt);
    expect(document.price.at).toBe(purchasedAt);

    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.price.as_of).toBe(publishedAt);
    expect(receipt?.price.at).toBe(purchasedAt);

    expect(receipt?.price.at).not.toBe(receipt?.price.as_of);
  });
});

describe("the purchase parameters", () => {
  it("refuses what does not fit this card, and says what did not fit", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);

    const refused = await harnessed.gateway.beginPurchase(itemId, { nights: "one" });

    expect(refused.step).toBe("params_rejected");
    if (refused.step !== "params_rejected") throw new Error("bad parameters were accepted");
    expect(refused.problems[0]?.path).toStrictEqual(["nights"]);
  });

  it("has nothing to sell under an identifier nobody published", async () => {
    const harnessed = await started();
    expect((await harnessed.gateway.beginPurchase("item_nope", {})).step).toBe("no_such_item");
  });
});

describe("the worker's stream", () => {
  it("answers a poll in the shape the contract publishes, and names the dialect", async () => {
    // The version rides on the call every worker makes first and then forever,
    // which is the difference between failing at startup and failing on
    // somebody's first order.
    const harnessed = await started();
    const answered = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);

    expect(WorkerPollResponseSchema.safeParse(answered).success).toBe(true);
    expect(answered.envelopes).toStrictEqual([]);
  });

  it("hands an order over and records that it went out", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);

    expect(drawn.envelopes).toHaveLength(1);
    const record = await harnessed.store.orderById(offered.order.order.id);
    expect(record?.order.state).toBe("dispatched");
    expect(record?.order.dispatch.attempts).toBe(1);
  });

  it("does not hand out an order whose purchase is already over", async () => {
    // Queued, then closed before anybody drew it. Handing it to a handler would
    // ask a merchant to work on a purchase that no longer exists.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "none",
    });
    await harnessed.gateway.runner.apply(orderId, { kind: "refund_settled", at: harnessed.now() });

    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);

    expect(drawn.envelopes.filter((e) => e.kind === "order")).toStrictEqual([]);
  });

  it("holds a poll open until something arrives", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const parked = harnessed.gateway.poll(harnessed.merchant.id, 10, 1_000);

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    expect((await parked).envelopes).toHaveLength(1);
  });

  it("hands an event over once, and never again if the batch it went in is lost", async () => {
    // The portal tells a merchant two different rules for one subscription, and
    // this is the half that costs money when it is read as the other one. An
    // event is finished the moment it is handed into a batch: nothing answers
    // it, nothing takes it back after a window, and a batch that never reached
    // the process that asked for it takes the event with it. So the merchant is
    // never told what it carried, and the thing it carried here is a debt to a
    // buyer who has paid and has no goods.
    //
    // The second half is the recovery the page now points at: the debt is on
    // the order, and the order is on the list of open ones whether the event
    // arrived or not.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "the supplier has none",
    });

    // This batch stands for the poll response that was drawn and never
    // arrived — it is answered by nobody, which is all an event ever gets.
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);
    expect(
      drawn.envelopes.flatMap((each) => (each.kind === "order_event" ? [each.payload.type] : [])),
    ).toStrictEqual(["order.refund_due"]);

    harnessed.advance(60_000);
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 10, 50)).envelopes).toStrictEqual(
      [],
    );

    // What the merchant can still find out for himself.
    const owing = await harnessed.gateway.orders(harnessed.merchant.id, true);
    expect(owing.map((held) => held.order.id)).toStrictEqual([orderId]);
    expect(owing[0]?.order.state).toBe("refund_due");
  });

  it("never hands out more than the gateway's own batch, whatever is asked for", async () => {
    const harnessed = await started({ WORKER_POLL_MAX_ENVELOPES: "1" });
    const itemId = await published(harnessed, asyncCard);
    for (const nth of [0, 1, 2]) {
      const offered = await harnessed.gateway.beginPurchase(itemId, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      // Three purchases means three payments. One payment buys one order, so
      // reusing a fingerprint here would leave two of them unpaid and this test
      // would pass for a reason that has nothing to do with batch size.
      const bought = await harnessed.gateway.payPurchase(
        offered.order.order.id,
        `PAYMENT-${nth}`,
        `PAYMENT-${nth}`,
      );
      expect(bought.step).toBe("under_way");
    }

    expect((await harnessed.gateway.poll(harnessed.merchant.id, 1_000, 0)).envelopes).toHaveLength(
      1,
    );
  });
});

describe("the merchant's calls", () => {
  it("tells a synchronous merchant that delivering separately is not his call", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // The purchase is left open on purpose: the separate call only means
    // anything while the order is still with the merchant.
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 10, 200)).envelopes).toHaveLength(
      1,
    );

    const refused = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      access_code: "X",
    });
    expect(refused?.ok).toBe(false);
    if (refused?.ok !== false) throw new Error("the call was taken");
    expect(refused.error.code).toBe("not_applicable_in_mode");
    expect(refused.error.retryable).toBe(false);

    // The handler's own answer is the delivery here, and it closes the purchase.
    await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "X" },
    });
    expect((await buying).step).toBe("settled");
  });

  it("does not tell a merchant a live order is closed", async () => {
    // The contract promises "order_already_closed" means the order reached an
    // ending that no call reopens. A merchant walking their own list of open
    // orders and calling deliver on one in the wrong state used to be told,
    // under that promised code, that a live order was dead.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const refused = await harnessed.gateway.deliverOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        activation_code: "A",
      },
    );

    expect(refused?.ok).toBe(false);
    if (refused?.ok !== false) throw new Error("the call was taken");
    expect(refused.error.code).toBe("event_not_applicable");
    expect(refused.error.message).toContain("quoted");

    // And an order that really is closed still says so, under the code the
    // contract promises means exactly that.
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, offered.order.order.id, {
      activation_code: "A",
    });
    const closed = await harnessed.gateway.refuseOrder(
      harnessed.merchant.id,
      offered.order.order.id,
      {
        code: "out_of_stock",
        message: "too late",
      },
    );
    if (closed?.ok !== false) throw new Error("a closed order took the call");
    expect(closed.error.code).toBe("order_already_closed");
  });

  it("has nothing to answer about an order that does not exist", async () => {
    const harnessed = await started();
    expect(
      await harnessed.gateway.deliverOrder(harnessed.merchant.id, "ord_nope", { a: "b" }),
    ).toBeNull();
    expect(await harnessed.gateway.acceptOrder(harnessed.merchant.id, "ord_nope", {})).toBeNull();
  });

  it("answers an acceptance on the answer route with the word for a successful one", async () => {
    // The promise: taking an order on is a success and reads as one. The SDK
    // posts every handler answer to this route without the merchant asking,
    // and relays anything that is not ok:true to him as a problem — so an
    // acceptance answered with a failure writes "something went wrong" against
    // an order that is going through and will deliver normally.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);

    const answered = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      accepted: { eta_seconds: 30 },
    });

    expect(answered).toStrictEqual({ ok: true, result: "accepted" });
    // And the acceptance itself landed.
    expect((await harnessed.store.orderById(orderId))?.order.dispatch.accepted).toBe(true);

    // The call written for acceptances keeps its wordless success: it can only
    // ever mean the one thing, so there is nothing for a word to tell apart.
    expect(await harnessed.gateway.acceptOrder(harnessed.merchant.id, orderId, {})).toStrictEqual({
      ok: true,
    });
  });

  it("answers an acceptance of a delivered order with the state it is in", async () => {
    // Deliveries are at least once, so a worker takes an order on again after
    // it has closed as a matter of course. "Accepted" would be a lie about the
    // work: it means the goods are owed and the order is under way, and this
    // merchant already handed them over. He is told what he can act on — there
    // is nothing left to deliver — and no second fulfillment is asked of him.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);
    await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, { accepted: {} });
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, { activation_code: "A" });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("delivered");

    expect(
      await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, { accepted: {} }),
    ).toStrictEqual({
      ok: true,
      result: "already_delivered",
    });
  });

  it("still takes an order on that is owed a refund, because the goods still close it", async () => {
    // The other order an acceptance can arrive for late. This fixture reaches
    // the debt the short way — the merchant refuses out of stock after the
    // charge, which is one of the paths into it, not the expiry one — and the
    // promise is the same either way: goods that arrive before the refund does
    // close the debt instead, so a merchant taking the order on afterwards is
    // taking on work that still exists, and is told his acceptance landed.
    // Odd-looking on the face of it, since he is the one who refused; it is
    // the honest answer, because until the refund is executed his goods are
    // still the cheaper way out for everybody.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) });
    await harnessed.gateway.refuseOrder(harnessed.merchant.id, orderId, {
      code: "out_of_stock",
      message: "none",
    });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("refund_due");

    expect(
      await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, { accepted: {} }),
    ).toStrictEqual({
      ok: true,
      result: "accepted",
    });
  });
});

describe("the claims on payments", () => {
  it("forgets the ones too old to be guarding anything, and keeps the rest", async () => {
    // A claim covers the window between a payment being verified and the charge
    // being executed; after that the token itself refuses the same
    // authorisation. They cannot be kept forever — the route that makes them
    // takes no key — and they cannot be thrown away early either, or the guard
    // is off for every payment presented since the last sweep.
    const harnessed = await started({ CLAIM_RETENTION_MS: "60000" });
    const itemId = await published(harnessed, asyncCard);

    const old = await harnessed.gateway.beginPurchase(itemId, {});
    if (old.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(old.order.order.id, "OLD", "OLD");

    harnessed.advance(90_000);

    const fresh = await harnessed.gateway.beginPurchase(itemId, {});
    if (fresh.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(fresh.order.order.id, "FRESH", "FRESH");

    expect(await harnessed.gateway.forgetOldClaims()).toBe(1);

    // The old payment is nobody's again; the fresh one is still spoken for.
    const takingOld = await harnessed.gateway.beginPurchase(itemId, {});
    const takingFresh = await harnessed.gateway.beginPurchase(itemId, {});
    if (takingOld.step !== "pay" || takingFresh.step !== "pay") {
      throw new Error("no price was offered");
    }
    expect(
      (await harnessed.gateway.payPurchase(takingOld.order.order.id, "OLD", "OLD")).step,
    ).not.toBe("payment_already_spent");
    expect(
      (await harnessed.gateway.payPurchase(takingFresh.order.order.id, "FRESH", "FRESH")).step,
    ).toBe("payment_already_spent");
  });
});

describe("an order sent out again", () => {
  it("carries the instant of this delivery, under the identifier of the same message", async () => {
    // This is the one path where an envelope goes back on the stream with its
    // identifier untouched: it was drawn and handed to nobody, so no worker has
    // seen that identifier and none will see it twice. The stamp still has to
    // move — put back with its original one, it would name a moment that has
    // passed. What this is not is how a worker recognises a repeat: an order
    // the gateway decides to send again is wrapped in a fresh envelope with a
    // fresh identifier, and the only thing two attempts have in common is the
    // order they carry (`envelope.ts`).
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "400",
      SETTLE_RESPONSE_MS: "300",
      SYNC_BUDGET_MS: "700",
      SETTLE_IN_FLIGHT_RETRY_MS: "5",
    });
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "still asking" });

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // The handler answers, which sends the order into its charge — and the
    // charge does not report back, so the order sits there mid-settle. The
    // machine answers nothing else while that is true.
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await vi.waitFor(
      async () =>
        expect((await harnessed.store.orderById(orderId))?.order.payment).toBe("settling"),
      { timeout: 2_000, interval: 5 },
    );
    await worker.stop();

    // The same order comes round again while the charge is in flight.
    const stale = "2020-01-01T00:00:00.000Z";
    const record = await harnessed.store.orderById(orderId);
    if (record === null) throw new Error("the order went missing");
    await harnessed.queue.publish(harnessed.merchant.id, {
      kind: "order",
      id: "env_the_same_message",
      sent_at: stale,
      payload: orderDocumentOf(record),
    });

    // The poll hands it to nobody — the machine will not take the hand-over
    // yet — and puts it back on the stream instead of dropping it.
    expect((await harnessed.gateway.poll(harnessed.merchant.id, 10, 0)).envelopes).toStrictEqual(
      [],
    );

    harnessed.advance(60_000);
    const back = await harnessed.queue.draw(harnessed.merchant.id, 10, 500);

    expect(back).toHaveLength(1);
    expect(back[0]?.envelope.id).toBe("env_the_same_message");
    expect(back[0]?.envelope.sent_at).not.toBe(stale);

    await buying;
  });
});

describe("the merchant's list of orders", () => {
  it("shows the ones still owed something apart from everything", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const first = await harnessed.gateway.beginPurchase(itemId, {});
    const second = await harnessed.gateway.beginPurchase(itemId, {});
    if (first.step !== "pay" || second.step !== "pay") throw new Error("no price was offered");

    await harnessed.gateway.payPurchase(first.order.order.id, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, first.order.order.id, {
      activation_code: "A",
    });
    await harnessed.gateway.payPurchase(second.order.order.id, "PAYMENT", "PAYMENT");

    expect(await harnessed.gateway.orders(harnessed.merchant.id, undefined)).toHaveLength(2);
    expect(
      (await harnessed.gateway.orders(harnessed.merchant.id, true)).map((o) => o.order.id),
    ).toStrictEqual([second.order.order.id]);
  });
});

describe("the test mark on an order and its receipt", () => {
  /** One whole synchronous sale on a gateway configured this way. */
  const soldOn = async (overrides: Record<string, string>) => {
    const harnessed = await started(overrides);
    const itemId = await published(harnessed, syncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await harnessed.gateway.payPurchase(
      offered.order.order.id,
      "PAYMENT",
      "PAYMENT",
    );
    await worker.stop();
    if (bought.step !== "settled") throw new Error("the purchase did not settle");

    return {
      order: bought.order.order,
      receipt: await harnessed.store.receiptForOrder(offered.order.order.id),
    };
  };

  it("is true on a test environment", async () => {
    const sold = await soldOn({ PAYMENT_NETWORK: "eip155:84532" });

    expect(sold.order.test).toBe(true);
    expect(sold.receipt?.test).toBe(true);
  });

  it("is false on a live one", async () => {
    // The claim this test protects is the one we make to somebody else's agent
    // about somebody else's money: `test: false` says the money moved. The
    // harness wires the scripted facilitator whatever the configuration names,
    // so this buys the derivation and settles nothing.
    const sold = await soldOn({
      PAYMENT_NETWORK: "eip155:8453",
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      CDP_API_KEY_ID: "key-id",
      CDP_API_KEY_SECRET: "secret",
    });

    expect(sold.order.test).toBe(false);
    expect(sold.receipt?.test).toBe(false);
  });
});
