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
 * The second is that the sweep is safe to run twice, because it will be, and
 * every one of its three arms is checked to do nothing at all on a second run.
 * Each is a no-op for a reason that is in the world rather than in a memory of
 * having run: the receipt it wrote is still there, the order its reminder
 * closed is no longer open, and the envelope it put on the stream is still
 * waiting on it.
 *
 * That last one is checked harder than the other two, because the cost of
 * getting it wrong lands on the order rather than on the merchant. A second
 * envelope is ordinary on the wire and the handler is told to expect one; what
 * it is not is free, because the machine counts every hand-over and the count
 * is what its attempt cap reads. So the tests here follow the count as well as
 * the stream.
 */

import type { Card } from "@coinslot/contracts";
import type { Order } from "@coinslot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness, workOnce } from "../testing/harness.js";
import { SWEEP_EFFECTS, type Swept } from "./runner.js";

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

/**
 * Runs the sweep the way the queue's own scheduler runs it, and hands back what
 * it says it repaired.
 */
const sweep = async (harnessed: Harness): Promise<Swept> => {
  const swept = await runSweep(harnessed);
  if (swept === null) throw new Error("the sweep found another run holding it");
  return swept;
};

/** The same, for a test that expects a run to find somebody else holding it. */
const runSweep = async (harnessed: Harness): Promise<Swept | null> => {
  const work = harnessed.queue.daily.get(SWEEP_EFFECTS);
  if (work === undefined) throw new Error("the gateway registered no sweep of effects");
  return (await work()) as Swept | null;
};

describe("an effect that could not be written down", () => {
  it("leaves no order saying the merchant was handed work he never got", async () => {
    // The failure this closes: the money moves, the order says paid, and
    // nothing ever reaches the merchant — and no retry repairs it, because the
    // state has already moved past the transition that emits the dispatch.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);

    harnessed.queue.stage = async () => {
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

    expect((await sweep(harnessed)).rearmed).toBe(1);
    await vi.waitFor(async () => {
      expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");
    });

    // The order is closed, so the second run has nothing to ask about it.
    expect((await sweep(harnessed)).rearmed).toBe(0);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("expired");
  });

  it("leaves alone a clock that is still running", async () => {
    // A sweep with no patience here would put a reminder on every open order in
    // the gateway every time it ran. Nothing would come of any of them — the
    // machine refuses an expiry claiming an instant its deadline has not
    // reached — so the cost is a queue full of work that can only be refused,
    // and nothing about an order would ever show it.
    const harnessed = await started();
    await quoted(harnessed, asyncCard);

    // Still inside the life of the price, which is the whole difference from
    // the case above.
    harnessed.advance(harnessed.runtime.config.deadlines.quoteTtlMs - 1_000);

    expect(await sweep(harnessed)).toStrictEqual({
      dispatched: 0,
      receipted: 0,
      rearmed: 0,
      refused: 0,
    });
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

  it("leaves alone an order whose envelope is still waiting to be drawn", async () => {
    // The one that costs the order rather than the merchant. A second envelope
    // is ordinary on the wire, and it is not ordinary for the order: when the
    // worker draws both, each hand-over is counted, and the counter is what the
    // attempt cap reads. A merchant who was merely between polls would come
    // back to an order that had already spent two of its deliveries without
    // ever having failed one.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      harnessed.now(),
    );

    // Long past any patience, and the envelope is still sitting on the stream
    // where the sale put it.
    harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs * 10);
    expect((await sweep(harnessed)).dispatched).toBe(0);

    // The merchant comes back and takes what is there: one hand-over, and the
    // order still has every delivery the policy allows it.
    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) }, 0);
    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).toBe("dispatched");
    expect(after?.order.dispatch.attempts).toBe(1);
  });

  it("leaves alone an order whose envelope is in a worker's hands", async () => {
    // The gap the queue cannot answer for. A drawn envelope is not waiting on
    // the stream any more, and the worker holding it may simply be working
    // through a batch. The patience is what covers that, and it is the whole of
    // what the patience is still for.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      harnessed.now(),
    );
    expect(await harnessed.queue.draw(harnessed.merchant.id, 10, 0)).toHaveLength(1);
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("paid");

    harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs - 1_000);

    expect((await sweep(harnessed)).dispatched).toBe(0);
    expect(await harnessed.queue.draw(harnessed.merchant.id, 10, 0)).toStrictEqual([]);
  });

  it("never sends a merchant event a second time", async () => {
    // An order is delivered at least once and an event at most once — the
    // contract says so in its own words, and the difference is not decoration.
    // A merchant's handler is told to expect the same order twice; nothing tells
    // it to expect the same event twice, and a debt announced twice is a second
    // refund somebody may act on. So the sweep has no arm for events, and this
    // is what says so out loud.
    const harnessed = await started();
    const orderId = await quoted(harnessed, asyncCard);
    await harnessed.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      harnessed.now(),
    );

    // The merchant never fulfils it and his deadline runs out, so the money
    // that came in is owed back and he is told once.
    harnessed.advance(harnessed.runtime.config.deadlines.defaultAsyncFulfillmentMs + 1_000);
    await harnessed.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "async_fulfillment",
    });
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("refund_due");

    // Everything said so far is drawn off and answered, the way a worker that
    // was running would have done.
    const said = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    expect(said.map((delivery) => delivery.envelope.kind)).toContain("order_event");

    // From here nothing may put that debt on the stream again.
    await sweep(harnessed);
    await sweep(harnessed);
    expect(await harnessed.queue.draw(harnessed.merchant.id, 10, 0)).toStrictEqual([]);
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

  it("lets only one run happen at a time, whatever starts it", async () => {
    // Two runs one after another are safe because each arm asks the world what
    // is missing before it acts. Two runs beside each other are not, and the
    // shape is the ordinary one: both ask the stream whether the order is still
    // held, both are told no, and both send it — which is the double hand-over
    // this whole arm exists to avoid, arrived at by the thing meant to avoid
    // it. The receipt arm has the same shape, both reading the orders without
    // receipts before either writes one.
    //
    // It is not a hypothetical overlap, and it comes from a second gateway
    // rather than from this one. Inside a process the queue's worker waits for
    // the handler before it fetches again, so a run here cannot start beside
    // one that has not returned; two processes on one database have nothing
    // arranging that between them. This test starts the two by hand, which is
    // how one process reproduces what two would do.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    const [first, second] = await Promise.all([runSweep(harnessed), runSweep(harnessed)]);

    // One of them ran and one of them found the work already in hand. Which is
    // which is a race, and neither answer is the wrong one.
    const ran = [first, second].filter((swept) => swept !== null);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.dispatched).toBe(1);

    // And the order was handed over once, which is the fact underneath.
    const drawn = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.envelope.kind === "order" ? drawn[0]?.envelope.payload.id : null).toBe(
      orderId,
    );
  });

  it("does nothing at all on the second run, with nobody drawing in between", async () => {
    // The envelope the first run put there is still waiting, and an order whose
    // envelope is waiting is not an order that has reached nobody. So the second
    // run has nothing to say about it — literally nothing, not a harmless
    // repeat — and the merchant who finally polls is handed the order once.
    const harnessed = await started();
    const orderId = await paidWithNothingOnTheStream(harnessed);

    expect((await sweep(harnessed)).dispatched).toBe(1);
    expect(await sweep(harnessed)).toStrictEqual({
      dispatched: 0,
      receipted: 0,
      rearmed: 0,
      refused: 0,
    });

    const answered = await workOnce(
      harnessed,
      { onOrder: () => ({ delivered: { activation_code: "CODE" } }) },
      0,
    );
    expect(answered).toBe(1);

    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).toBe("delivered");
    expect(after?.order.dispatch.attempts).toBe(1);
    expect(after?.delivery).toStrictEqual({ activation_code: "CODE" });
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("delivered");
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
