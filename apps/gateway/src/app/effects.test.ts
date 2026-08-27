/**
 * The effects that are written down with the order, and the sweep that finds
 * what slipped anyway (ADR-0013).
 *
 * Two promises are checked here and they are different in kind.
 *
 * The first is atomicity. An order that says the merchant was handed the work,
 * or that a sale was receipted, must not be able to say so when the envelope or
 * the receipt was never written. A unit test cannot kill a process between two
 * writes, so the failure is put back the only way a test can put it back: the
 * write that has to go with the order is made to refuse, and what is then
 * checked is that the order did not move without it. That is the same fact from
 * the other side — either both landed or neither did.
 *
 * The second is that the sweep is safe to run twice, because it will be. Two of
 * its three arms are no-ops on a second run and are checked to be exactly that:
 * the receipt it wrote is the receipt that is still there, and an order its
 * reminder closed is no longer open. The third arm — the envelope for an order
 * that is paid and has reached nobody — is not a no-op when the first envelope
 * still has not been picked up, and it is not pretended to be. What is checked
 * for that one is the thing that actually matters: after the merchant's worker
 * has turned, an order swept twice ends exactly where an order swept once ends,
 * with one delivery kept and one receipt.
 */

import type { Card } from "@coinslot/contracts";
import type { Order } from "@coinslot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness, workOnce } from "../testing/harness.js";
import { SWEEP_EFFECTS } from "./runner.js";

const asyncCard: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

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
  if (!("ok" in result)) throw new Error(`publishing failed: ${JSON.stringify(result.errors)}`);
  return result.ok.id;
};

/** An order priced and waiting for a payment. */
const quoted = async (harnessed: Harness, card: Card): Promise<string> => {
  const itemId = await published(harnessed, card);
  const offered = await harnessed.gateway.beginPurchase(itemId, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  return offered.order.order.id;
};

/** Runs the sweep the way the queue's own scheduler runs it. */
const sweep = async (harnessed: Harness): Promise<void> => {
  const work = harnessed.queue.daily.get(SWEEP_EFFECTS);
  if (work === undefined) throw new Error("the gateway registered no sweep of effects");
  await work();
};

describe("an effect that could not be written down", () => {
  it("leaves no order saying the merchant was handed work he never got", async () => {
    // The failure this closes: the money moves, the order says paid, and
    // nothing ever reaches the merchant — and no retry repairs it, because the
    // state has already moved past the transition that emits the dispatch.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);

    harnessed.queue.publish = async () => {
      throw new Error("the queue would not take the envelope");
    };

    await expect(
      harnessed.gateway.runner.presentVerifiedPayment(orderId, "alice", "PAY-A", harnessed.now()),
    ).rejects.toThrow("the queue would not take the envelope");

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).not.toBe("paid");
  });

  it("leaves no order calling itself delivered with no receipt behind it", async () => {
    // A receipt is what a merchant reconciles a wallet against. An order that
    // says delivered with nothing written is a sale that is invisible to the
    // person whose money it was.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      harnessed.now(),
    );

    harnessed.store.putReceipt = async () => {
      throw new Error("the receipt would not be written");
    };

    await expect(
      workOnce(harnessed, { onOrder: () => ({ delivered: { activation_code: "CODE" } }) }, 0),
    ).rejects.toThrow("the receipt would not be written");

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).not.toBe("delivered");
  });

  it("is the only reason those orders do not move, with nothing broken", async () => {
    // The negative control. Both cases above pass trivially if a purchase never
    // reaches those states at all, so here is the same purchase with nothing
    // refusing: the order does say paid, and the envelope is on the stream.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);

    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      harnessed.now(),
    );

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).toBe("paid");
    const drawn = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    expect(drawn.map((delivery) => delivery.envelope.kind)).toStrictEqual(["order"]);
  });
});

describe("the sweep of what an order is still owed", () => {
  it("writes the receipt a delivered order has none of, and writes it once", async () => {
    // An order out of an older version of this code, or out of a defect nobody
    // has found: delivered, and nothing recording the sale. The second run is
    // the whole point — the receipt that is there afterwards is the one the
    // first run wrote, identifier and all, not a second one over the top of it.
    const harnessed = await started();
    const orderId = await quoted(harnessed, syncCard);
    await harnessed.store.withOrder(orderId, (found) => ({
      save: { ...found, order: deliveredWithMoneyIn(found.order) },
      result: null,
    }));
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();

    await sweep(harnessed);
    const written = await harnessed.store.receiptForOrder(orderId);
    expect(written?.outcome).toBe("delivered");
    expect(written?.price.amount).toBe("80.00");

    await sweep(harnessed);
    expect(await harnessed.store.receiptForOrder(orderId)).toStrictEqual(written);
  });

  it("starts the clock again on an open order whose deadline has passed", async () => {
    // A reminder is the only thing that ever declares an order overdue. One
    // that was armed and then lost — a handler that threw past the queue's
    // patience — is an order nothing will ever close, and a buyer nothing will
    // ever refund. The sweep asks the order which clocks are running and finds
    // one that ran out while the order sat where it was.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("quoted");

    // Past the life of the price. Nothing has fired, because the reminder armed
    // when the order was made is waiting on real time and no real time passed.
    harnessed.advance(harnessed.runtime.config.deadlines.quoteTtlMs + 1_000);

    await sweep(harnessed);
    await vi.waitFor(async () => {
      expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");
    });

    // The order is closed, so the second run has nothing to ask about it.
    await sweep(harnessed);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");
  });

  it("hands a paid order to its merchant again when nobody has taken it", async () => {
    // The order is paid, the money is in, and nothing is on the merchant's
    // stream. Left alone it runs out its fulfillment deadline and turns into a
    // debt nobody meant to owe.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    await sweep(harnessed);

    const drawn = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    expect(drawn).toHaveLength(1);
    const sent = drawn[0]?.envelope;
    // The order itself, not some other merchant's and not an event about it.
    expect(sent?.kind).toBe("order");
    expect(sent?.kind === "order" ? sent.payload.id : null).toBe(orderId);
  });

  it("stops asking once the merchant has actually taken it", async () => {
    // The second run is a no-op here, and it is the order's own state that
    // makes it one: a worker that drew the envelope moved the order out of
    // paid, and the sweep's question is about orders in paid.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    await sweep(harnessed);
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) }, 0);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("dispatched");

    await sweep(harnessed);
    expect(await harnessed.queue.draw(harnessed.merchant.id, 10, 0)).toStrictEqual([]);
  });

  it("leaves an order swept twice where an order swept once ends up", async () => {
    // With nobody drawing anything in between, the second run does put a second
    // envelope on the stream: from where the sweep stands the first one reached
    // no one, and that is the case it exists for. What must hold is the ending
    // — one delivery kept, one receipt, and a merchant asked twice for an order
    // his handler is already told to expect twice.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    await sweep(harnessed);
    await sweep(harnessed);

    // Both envelopes are answered, the way a merchant's handler answers a
    // repeat: with goods of its own, made a second time.
    let made = 0;
    const answered = await workOnce(
      harnessed,
      {
        onOrder: () => {
          made += 1;
          return { delivered: { activation_code: `CODE-${made}` } };
        },
      },
      0,
    );
    expect(answered).toBe(2);

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).toBe("delivered");
    expect(after?.delivery).toStrictEqual({ activation_code: "CODE-1" });
    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.outcome).toBe("delivered");
  });
});

/**
 * An order paid for, with nothing on its merchant's stream and long enough ago
 * that a worker would have taken it by now.
 *
 * The envelope is drawn off the stream and thrown away rather than never
 * written, because with the dispatch committing alongside the order there is no
 * longer a way to make the gateway produce one without the other — which is the
 * point of the change and is why the state has to be arranged by hand here.
 */
async function paidWithNothingOnTheStream(harnessed: Harness): Promise<string> {
  const orderId = await quoted(harnessed, asyncCard);
  await harnessed.gateway.runner.presentVerifiedPayment(orderId, "alice", "PAY-A", harnessed.now());
  const lost = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
  expect(lost).toHaveLength(1);

  harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs + 1_000);
  return orderId;
}

/**
 * The same order, delivered and paid for, as a record written by something
 * other than this gateway.
 *
 * It is built by hand for the reason the money-invariant test builds one by
 * hand: nothing this gateway does can produce a delivered order with no
 * receipt any more, and the case the sweep exists for is exactly a record that
 * did not come from here.
 */
function deliveredWithMoneyIn(order: Order): Order {
  return {
    ...order,
    state: "delivered",
    payment: "settled",
    closure: null,
    timestamps: { ...order.timestamps, paidAt: order.timestamps.quotedAt },
  };
}
