import type { Card } from "@coinslot/contracts";
import {
  CatalogPageSchema,
  PublishResultSchema,
  WorkerPollResponseSchema,
} from "@coinslot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness, workOnce, workUntilStopped } from "../testing/harness.js";
import { orderDocumentOf } from "./runner.js";

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
  const result = await harnessed.gateway.publishCard(card);
  expect(PublishResultSchema.safeParse(result).success).toBe(true);
  if (!("ok" in result)) throw new Error(`publishing failed: ${JSON.stringify(result.errors)}`);
  return result.ok.id;
};

describe("the catalog", () => {
  it("answers a card that will not do with everything wrong with it at once", async () => {
    // A merchant fixing one field per round trip is the experience the plural
    // errors exist to prevent.
    const { gateway } = await started();

    const result = await gateway.publishCard({ merchant_item_id: "", title: "" });

    expect(PublishResultSchema.safeParse(result).success).toBe(true);
    if (!("errors" in result)) throw new Error("a broken card was published");
    expect(result.errors.length).toBeGreaterThan(1);
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

    const told = await harnessed.gateway.poll(10, 0);
    expect(told.envelopes.map((e) => e.kind === "order_event" && e.payload.type)).toContain(
      "order.payment_failed_after_delivery",
    );
  });

  it("says nobody knows when the charge goes quiet, rather than saying it failed", async () => {
    // The fifth gate, in the one place it costs money: an agent told his
    // purchase did not happen goes and buys the same thing elsewhere without
    // looking at his wallet.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "300",
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

    const answered = await harnessed.gateway.deliverOrder(offered.order.order.id, {
      activation_code: "LPA:1$X",
    });
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
    await harnessed.gateway.deliverOrder(orderId, { activation_code: "A" });

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

    // Both payments are from the same wallet — "alice" before the "#" — so the
    // repeat comes from the buyer who bought, carrying a fresh authorisation.
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await harnessed.gateway.payPurchase(orderId, "alice#first", "alice#first");
    await worker.stop();
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("delivered_unpaid");

    const repeated = await harnessed.gateway.payPurchase(orderId, "alice#second", "alice#second");

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
      "alice#first",
      "alice#second",
    ]);
    expect(harnessed.facilitator.verifies.at(-1)?.payment).toBe("alice#second");
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
    await harnessed.gateway.payPurchase(orderId, "alice", "alice");
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
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "300",
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
    // are from the same wallet, so the second reaches the repeat the machine
    // refuses rather than being turned away as a stranger's.
    await harnessed.gateway.payPurchase(orderId, "alice#first", "alice#first");
    await worker.stop();

    const stuck = await harnessed.store.orderById(orderId);
    expect(stuck?.order.payment).toBe("outcome_unknown");

    const refused = await harnessed.gateway.payPurchase(orderId, "alice#second", "alice#second");

    expect(refused.step).toBe("payment_not_taken");
    if (refused.step !== "payment_not_taken") throw new Error("the second payment was taken");
    expect(refused.retryable).toBe(true);

    // Nothing was charged, and the record of the charge that went quiet is
    // exactly as it was.
    const after = await harnessed.store.orderById(orderId);
    expect(after?.payment).toBe("alice#first");
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

    const first = await harnessed.gateway.deliverOrder(offered.order.order.id, {
      activation_code: "A",
    });
    const again = await harnessed.gateway.deliverOrder(offered.order.order.id, {
      activation_code: "A",
    });

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

    const answered = await harnessed.gateway.refuseOrder(offered.order.order.id, {
      code: "out_of_stock",
      message: "the supplier has none",
    });

    expect(answered).toStrictEqual({ ok: true, result: "refused" });
    const owing = await harnessed.store.orderById(offered.order.order.id);
    expect(owing?.order.state).toBe("refund_due");

    // No receipt, and that is a gap rather than a decision. The receipt
    // vocabulary has a word for an order that owes money back, and receipts are
    // only written when goods are released — so an order that took money and
    // never released any has none to carry that word.
    expect(await harnessed.store.receiptForOrder(offered.order.order.id)).toBeNull();

    const told = await harnessed.gateway.poll(10, 0);
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
    await harnessed.gateway.refuseOrder(orderId, { code: "out_of_stock", message: "none" });
    await harnessed.gateway.runner.apply(orderId, {
      kind: "refund_settled",
      at: harnessed.now(),
    });

    const late = await harnessed.gateway.deliverOrder(orderId, { activation_code: "A" });

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
    await harnessed.gateway.refuseOrder(orderId, { code: "cannot_fulfill", message: "late" });

    const late = await harnessed.gateway.deliverOrder(orderId, { activation_code: "A" });

    expect(late).toStrictEqual({ ok: true, result: "debt_closed_by_delivery" });
    const closed = await harnessed.store.orderById(orderId);
    expect(closed?.order.state).toBe("delivered");
    expect(closed?.order.closure).toBeNull();
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("delivered");
  });
});

describe("two payments racing one order", () => {
  it("lets exactly one own it, charges exactly one, and hands the goods to the winner alone", async () => {
    // The blocker the ownership rule exists for. Two verified payments for one
    // order both pass the payment layer and reach the decision at the same
    // instant; if each read a stale "nobody owns it yet" they would both take
    // it — two buyers, two merchants asked to deliver, one charge that succeeds
    // and one that fails on a merchant who handed over goods for nothing. The
    // decision is made under the store's lock, reading the order there, so the
    // first arrival becomes the owner and the second is turned away.
    const harnessed = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "300",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "500",
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
    const release = harnessed.facilitator.holdVerification();
    const race = Promise.all([
      harnessed.gateway.payPurchase(orderId, "alice", "alice-auth"),
      harnessed.gateway.payPurchase(orderId, "bob", "bob-auth"),
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

    // One owner, one charge, and the charge was the owner's payment.
    const owned = await harnessed.store.orderById(orderId);
    expect(owned?.order.state).toBe("delivered");
    expect(["alice", "bob"]).toContain(owned?.paidBy);
    expect(harnessed.facilitator.settles).toHaveLength(1);
    expect(harnessed.facilitator.settles[0]?.payment).toBe(owned?.paidBy);
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
    const late = await harnessed.gateway.answerQuote(asked, {
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
    const drawn = await harnessed.gateway.poll(10, 0);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    if (question?.kind !== "quote_request") throw new Error("nobody was asked the price");

    const acknowledged = await harnessed.gateway.answerQuote(question.payload.price_id, {
      available: true,
      price: { amount: "95.00", currency: "USD" },
      as_of: "2026-08-26T12:00:00.000Z",
    });

    expect(acknowledged).toStrictEqual({ used: false });
    // And the sale really did go through at the other price.
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.price?.amount).toBe(
      "80.00",
    );
  });

  it("tells a merchant his answer priced nothing when the machine would not take it", async () => {
    // The other half of the same promise, and the one the wording exists for.
    // Somebody is still parked on the question, so an acknowledgement built out
    // of "was anybody listening" would say yes — while the order was closed a
    // moment earlier and his price bought nothing.
    const harnessed = await started({ QUOTE_RESPONSE_MS: "500" });
    const itemId = await published(harnessed, livePriced(asyncCard));

    const buying = harnessed.gateway.beginPurchase(itemId, {});
    const drawn = await harnessed.gateway.poll(10, 200);
    const question = drawn.envelopes.find((envelope) => envelope.kind === "quote_request");
    if (question?.kind !== "quote_request") throw new Error("nobody was asked the price");

    // The clock on our own patience gets there first and closes the order.
    const orders = await harnessed.store.orders();
    const orderId = orders[0]?.order.id ?? "";
    await harnessed.gateway.runner.apply(orderId, {
      kind: "quote_silent",
      at: harnessed.now(),
    });

    const acknowledged = await harnessed.gateway.answerQuote(question.payload.price_id, {
      available: true,
      price: { amount: "9.00", currency: "USD" },
      as_of: "2026-08-26T12:00:00.000Z",
    });

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
    const answered = await harnessed.gateway.poll(10, 0);

    expect(WorkerPollResponseSchema.safeParse(answered).success).toBe(true);
    expect(answered.envelopes).toStrictEqual([]);
  });

  it("hands an order over and records that it went out", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const drawn = await harnessed.gateway.poll(10, 0);

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
    await harnessed.gateway.refuseOrder(orderId, { code: "out_of_stock", message: "none" });
    await harnessed.gateway.runner.apply(orderId, { kind: "refund_settled", at: harnessed.now() });

    const drawn = await harnessed.gateway.poll(10, 0);

    expect(drawn.envelopes.filter((e) => e.kind === "order")).toStrictEqual([]);
  });

  it("holds a poll open until something arrives", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const parked = harnessed.gateway.poll(10, 1_000);

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    expect((await parked).envelopes).toHaveLength(1);
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

    expect((await harnessed.gateway.poll(1_000, 0)).envelopes).toHaveLength(1);
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
    expect((await harnessed.gateway.poll(10, 200)).envelopes).toHaveLength(1);

    const refused = await harnessed.gateway.deliverOrder(orderId, { access_code: "X" });
    expect(refused?.ok).toBe(false);
    if (refused?.ok !== false) throw new Error("the call was taken");
    expect(refused.error.code).toBe("not_applicable_in_mode");
    expect(refused.error.retryable).toBe(false);

    // The handler's own answer is the delivery here, and it closes the purchase.
    await harnessed.gateway.answerOrder(orderId, { delivered: { access_code: "X" } });
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

    const refused = await harnessed.gateway.deliverOrder(offered.order.order.id, {
      activation_code: "A",
    });

    expect(refused?.ok).toBe(false);
    if (refused?.ok !== false) throw new Error("the call was taken");
    expect(refused.error.code).toBe("event_not_applicable");
    expect(refused.error.message).toContain("quoted");

    // And an order that really is closed still says so, under the code the
    // contract promises means exactly that.
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(offered.order.order.id, { activation_code: "A" });
    const closed = await harnessed.gateway.refuseOrder(offered.order.order.id, {
      code: "out_of_stock",
      message: "too late",
    });
    if (closed?.ok !== false) throw new Error("a closed order took the call");
    expect(closed.error.code).toBe("order_already_closed");
  });

  it("has nothing to answer about an order that does not exist", async () => {
    const harnessed = await started();
    expect(await harnessed.gateway.deliverOrder("ord_nope", { a: "b" })).toBeNull();
    expect(await harnessed.gateway.acceptOrder("ord_nope", {})).toBeNull();
  });

  it("says out loud that this contract has no word for a successful acceptance", async () => {
    // The gap is in the route table rather than in the code: the answer route's
    // success has to name one of five published results and none of them is an
    // acceptance. The order is taken on all the same, and the message says so.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.poll(10, 0);

    const answered = await harnessed.gateway.answerOrder(orderId, {
      accepted: { eta_seconds: 30 },
    });

    expect(answered?.ok).toBe(false);
    if (answered?.ok !== false) throw new Error("the answer route found a word after all");
    expect(answered.error.code).toBe("acceptance_has_no_word_in_this_contract");
    // And the acceptance itself did land.
    expect((await harnessed.store.orderById(orderId))?.order.dispatch.accepted).toBe(true);

    // The call written for acceptances answers them properly.
    expect(await harnessed.gateway.acceptOrder(orderId, {})).toStrictEqual({ ok: true });
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
    // A worker tells a repeat from a new message by exactly that pair: the
    // identifier names the message and does not change, the instant names this
    // delivery and does. Sent out again with its original stamp, a repeat looks
    // like the delivery that had already been.
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
    await harnessed.queue.publish({
      kind: "order",
      id: "env_the_same_message",
      sent_at: stale,
      payload: orderDocumentOf(record),
    });

    // The poll hands it to nobody — the machine will not take the hand-over
    // yet — and puts it back on the stream instead of dropping it.
    expect((await harnessed.gateway.poll(10, 0)).envelopes).toStrictEqual([]);

    harnessed.advance(60_000);
    const back = await harnessed.queue.draw(10, 500);

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
    await harnessed.gateway.deliverOrder(first.order.order.id, { activation_code: "A" });
    await harnessed.gateway.payPurchase(second.order.order.id, "PAYMENT", "PAYMENT");

    expect(await harnessed.gateway.orders(undefined)).toHaveLength(2);
    expect((await harnessed.gateway.orders(true)).map((o) => o.order.id)).toStrictEqual([
      second.order.order.id,
    ]);
  });
});
