import type { Card } from "@coinslot/contracts";
import {
  CatalogPageSchema,
  PublishResultSchema,
  WorkerPollResponseSchema,
} from "@coinslot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, workOnce, workUntilStopped } from "../testing/harness.js";

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
    const bought = await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");
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
    const bought = await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");
    await worker.stop();

    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.order.order.state).toBe("failed");
    expect(harnessed.facilitator.settles).toHaveLength(0);
    expect(await harnessed.store.receiptForOrder(offered.order.order.id)).toBeNull();
  });

  it("takes nothing from a payment that does not check out", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, syncCard);
    harnessed.facilitator.willRefuseVerification("insufficient_funds", "the wallet is empty");

    const offered = await harnessed.gateway.beginPurchase(itemId, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const bought = await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");

    if (bought.step !== "settled") throw new Error("the purchase did not settle");
    expect(bought.order.order.state).toBe("rejected");
    expect(bought.order.order.closure).toStrictEqual({
      cause: "payment_not_verified",
      reason: "insufficient_funds",
    });
    expect(harnessed.facilitator.settles).toHaveLength(0);
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
    const bought = await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");
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
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");
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

    const bought = await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");

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

  it("answers a second delivery the same way as the first", async () => {
    // The portal's promise: called again after a dropped connection, deliver
    // delivers nothing twice and charges nothing twice.
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");

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
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) });

    const answered = await harnessed.gateway.refuseOrder(offered.order.order.id, {
      code: "out_of_stock",
      message: "the supplier has none",
    });

    expect(answered).toStrictEqual({ ok: true, result: "refused" });
    const owing = await harnessed.store.orderById(offered.order.order.id);
    expect(owing?.order.state).toBe("refund_due");

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
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");
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
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");
    await harnessed.gateway.refuseOrder(orderId, { code: "cannot_fulfill", message: "late" });

    const late = await harnessed.gateway.deliverOrder(orderId, { activation_code: "A" });

    expect(late).toStrictEqual({ ok: true, result: "debt_closed_by_delivery" });
    const closed = await harnessed.store.orderById(orderId);
    expect(closed?.order.state).toBe("delivered");
    expect(closed?.order.closure).toBeNull();
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("delivered");
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
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");

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
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");
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
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");

    expect((await parked).envelopes).toHaveLength(1);
  });

  it("never hands out more than the gateway's own batch, whatever is asked for", async () => {
    const harnessed = await started({ WORKER_POLL_MAX_ENVELOPES: "1" });
    const itemId = await published(harnessed, asyncCard);
    for (const _ of [0, 1, 2]) {
      const offered = await harnessed.gateway.beginPurchase(itemId, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT");
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
    const buying = harnessed.gateway.payPurchase(orderId, "PAYMENT");
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
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");
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

describe("the merchant's list of orders", () => {
  it("shows the ones still owed something apart from everything", async () => {
    const harnessed = await started();
    const itemId = await published(harnessed, asyncCard);
    const first = await harnessed.gateway.beginPurchase(itemId, {});
    const second = await harnessed.gateway.beginPurchase(itemId, {});
    if (first.step !== "pay" || second.step !== "pay") throw new Error("no price was offered");

    await harnessed.gateway.payPurchase(first.order.order.id, "PAYMENT");
    await harnessed.gateway.deliverOrder(first.order.order.id, { activation_code: "A" });
    await harnessed.gateway.payPurchase(second.order.order.id, "PAYMENT");

    expect(await harnessed.gateway.orders(undefined)).toHaveLength(2);
    expect((await harnessed.gateway.orders(true)).map((o) => o.order.id)).toStrictEqual([
      second.order.order.id,
    ]);
  });
});
