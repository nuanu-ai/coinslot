import type { Card } from "@coinslot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Harness, harness, workUntilStopped } from "../testing/harness.js";

/**
 * The clocks, from the outside.
 *
 * Every row of the portal's "time ran out" table is a promise to somebody, and
 * each of these is one row of it: what happens when a deadline runs out, and
 * whose money is where afterwards. The numbers are in tens of milliseconds so
 * that a whole life of an order fits in a test, and they come from the same
 * configuration a deployment uses.
 */

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
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
};

/** Deadlines short enough that an order lives and dies inside one test. */
const brisk = {
  QUOTE_RESPONSE_MS: "20",
  QUOTE_TTL_MS: "60",
  SYNC_RESPONSE_MS: "80",
  SETTLE_RESPONSE_MS: "40",
  SYNC_BUDGET_MS: "200",
  HANDLER_ANSWER_MS: "1000",
  DEFAULT_ASYNC_FULFILLMENT_MS: "80",
};

let open: Harness | null = null;
const started = async (overrides: Record<string, string> = {}) => {
  open = await harness({ ...brisk, ...overrides });
  return open;
};

afterEach(async () => {
  await open?.stop();
  open = null;
});

const bought = async (harnessed: Harness, card: Card): Promise<string> => {
  const published = await harnessed.gateway.publishCard(card);
  if (!("ok" in published)) throw new Error("the card would not publish");
  const offered = await harnessed.gateway.beginPurchase(published.ok.id, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  return offered.order.order.id;
};

const state = async (harnessed: Harness, orderId: string) =>
  (await harnessed.store.orderById(orderId))?.order;

describe("when the time runs out", () => {
  it("closes a synchronous purchase nobody answered, and charges nothing", async () => {
    // The portal's row: "you are delivering a synchronous order" — the purchase
    // did not happen, there was no charge. Which is what the mode is for: the
    // buyer's money never moves until the goods exist.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    const settled = await harnessed.gateway.payPurchase(orderId, "PAYMENT");

    expect(settled.step).toBe("settled");
    if (settled.step !== "settled") throw new Error("the purchase did not settle");
    expect(settled.order.order.state).toBe("expired");
    expect(settled.order.order.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "sync_response",
    });
    expect(harnessed.facilitator.settles).toHaveLength(0);
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
  });

  it("marks an asynchronous order for a refund, because the money is already gone", async () => {
    // The other row of the same table, and the reason the two are different
    // words: here the charge went through at the purchase, so an ending that
    // said "nothing happened" would leave a buyer out of pocket with the
    // system claiming otherwise.
    const harnessed = await started();
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      {
        timeout: 2_000,
        interval: 5,
      },
    );

    const owing = await state(harnessed, orderId);
    expect(owing?.payment).toBe("settled");
    expect(owing?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });

    const told = await harnessed.gateway.poll(10, 0);
    const events = told.envelopes.flatMap((e) => (e.kind === "order_event" ? [e.payload] : []));
    expect(events.map((e) => e.type)).toContain("order.refund_due");
  });

  it("lets a price the agent sat on stop being a price", async () => {
    // "The agent got a price and is thinking" — the price stops applying, and
    // an agent who still wants it asks for a fresh one. Nothing was charged, so
    // the ending is free.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    await vi.waitFor(async () => expect((await state(harnessed, orderId))?.state).toBe("expired"), {
      timeout: 2_000,
      interval: 5,
    });

    expect((await state(harnessed, orderId))?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "quote_expiry",
    });
    expect(harnessed.facilitator.verifies).toHaveLength(0);
  });
});

describe("when a delivery goes unanswered", () => {
  it("sends the order again, after the wait the machine asked for", async () => {
    // An exception in the handler, a dead process and a broken connection are
    // the same thing to us — the answer never came — and they are answered with
    // another delivery, not with a refusal.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "10",
      DEFAULT_ASYNC_FULFILLMENT_MS: "3000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");

    // A worker that draws its stream and never answers anything.
    const silent = workUntilStopped(harnessed, {});
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.dispatch.attempts).toBeGreaterThan(1),
      { timeout: 2_000, interval: 5 },
    );
    await silent.stop();

    // Still open, still owed the goods, and never refused on our own account.
    expect((await state(harnessed, orderId))?.state).toBe("dispatched");
  });

  it("stops repeating once the attempts are spent, and leaves the debt behind", async () => {
    // The repeats are not endless. Here the merchant's own deadline is far
    // away — far enough that reaching the ending inside this test can only be
    // the attempt cap — and the money moved at the purchase, so what is left
    // when we stop trying is a debt rather than a free ending.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "5",
      REDELIVERY_MAX_ATTEMPTS: "2",
      DEFAULT_ASYNC_FULFILLMENT_MS: "60000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");

    const silent = workUntilStopped(harnessed, {});
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      { timeout: 2_000, interval: 5 },
    );
    await silent.stop();

    const owing = await state(harnessed, orderId);
    expect(owing?.dispatch.attempts).toBe(2);
    expect(owing?.payment).toBe("settled");
  });

  it("does not send an order again to a merchant who answered the delivery he was given", async () => {
    // A merchant who took the order on has a day to fulfill it. The reminder
    // left against the delivery he answered must not fire behind him, or he
    // would be handed the same order every window until his deadline.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      DEFAULT_ASYNC_FULFILLMENT_MS: "3000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");

    const taking = workUntilStopped(harnessed, {
      onOrder: () => ({ accepted: { eta_seconds: 60 } }),
    });
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.dispatch.accepted).toBe(true),
      { timeout: 2_000, interval: 5 },
    );

    // Long enough for the reminder against that delivery to have fired.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await taking.stop();

    expect((await state(harnessed, orderId))?.dispatch.attempts).toBe(1);
  });
});

describe("a timer that fires at the wrong moment", () => {
  it("cannot close an order whose deadline is not running", async () => {
    // A stale reminder off the queue, or one for a clock this order never had.
    // Closing an order on it would refund a buyer whose merchant is not late.
    const harnessed = await started();
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");
    await harnessed.gateway.deliverOrder(orderId, { activation_code: "A" });

    const refused = await harnessed.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      at: harnessed.now() + 1_000_000,
      deadline: "async_fulfillment",
    });

    expect(refused.outcome).toBe("refused");
    if (refused.outcome !== "refused") throw new Error("the stale timer was taken");
    expect(refused.rejection.code).toBe("deadline_not_armed");
    expect((await state(harnessed, orderId))?.state).toBe("delivered");
  });

  it("cannot close an order before its deadline has actually run out", async () => {
    const harnessed = await started({ DEFAULT_ASYNC_FULFILLMENT_MS: "3000" });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT");

    const early = await harnessed.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "async_fulfillment",
    });

    expect(early.outcome).toBe("refused");
    if (early.outcome !== "refused") throw new Error("the early timer was taken");
    expect(early.rejection.code).toBe("deadline_not_yet_due");
    expect((await state(harnessed, orderId))?.state).toBe("paid");
  });
});
