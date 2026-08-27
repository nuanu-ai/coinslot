import type { Order } from "@coinslot/core";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredOrder } from "../ports/store.js";
import { type Harness, harness } from "../testing/harness.js";

/**
 * The last check before anything is written down.
 *
 * `moneyInvariantViolations` is a list of things a person would notice: a buyer
 * whose money is gone with nothing recording it, a merchant credited for goods
 * nobody paid for, a debt with no charge behind it. A violation is a defect
 * rather than a case, and the only safe thing to do about one is stop, because
 * the alternative is to write it down and carry on selling against it.
 *
 * Nothing the order machine produces breaks any of them, which is why an order
 * has to be built by hand here to test that the guard is real. That is exactly
 * the shape of the accident it exists for: an order that came out of a database
 * written by an older version of this code, or out of a defect nobody has found
 * yet.
 */

const impossible = (): StoredOrder => {
  const order: Order = {
    id: "ord_impossible",
    // A success whose money never moved. The buyer has the goods, the merchant
    // is credited, and nothing was charged.
    state: "delivered",
    payment: "verified",
    mode: { needsConfirmation: false, settle: "after_fulfillment" },
    policy: {
      deadlines: {
        quoteResponseMs: 5_000,
        quoteTtlMs: 30_000,
        settleResponseMs: 2_000,
        syncResponseMs: 8_000,
        paymentAfterConfirmationMs: 300_000,
        confirmationResponseMs: 3_600_000,
        asyncFulfillmentMs: 86_400_000,
      },
      redelivery: { baseDelayMs: 500, factor: 2, maxDelayMs: 30_000, maxAttempts: 5 },
    },
    cardPrice: { amount: "80.00", currency: "USD", asOf: 0 },
    price: { amount: "80.00", currency: "USD", asOf: 0 },
    quoteSource: "card_snapshot",
    dispatch: { attempts: 1, accepted: false },
    heldFulfillment: false,
    closure: null,
    test: true,
    timestamps: {
      createdAt: 0,
      quotedAt: 0,
      confirmationRequestedAt: null,
      confirmedAt: null,
      settleStartedAt: null,
      paidAt: 0,
      dispatchedAt: 0,
    },
  };

  return {
    order,
    merchantId: "mch_the_runner",
    itemId: "item_1",
    merchantItemId: "sku-1",
    params: {},
    priceId: null,
    delivery: null,
    payment: null,
    paidBy: null,
    settlement: null,
    paymentWords: [],
    paymentWordsDropped: 0,
    openDeliveryId: null,
  };
};

let open: Harness | null = null;

afterEach(async () => {
  await open?.stop();
  open = null;
});

describe("an order that cannot be true", () => {
  it("is not written down, and the work stops on it", async () => {
    open = await harness();
    await open.store.addOrder(impossible());

    // An event the machine takes without changing anything. What it hands back
    // is still the order that came in, and that order says a buyer got goods
    // nobody was charged for.
    const applied = open.gateway.runner.apply("ord_impossible", {
      kind: "purchase_repeated",
      at: open.now(),
    });

    await expect(applied).rejects.toThrow(/breaks what must be true about money/);
    await expect(applied).rejects.toThrow(/the order is a success and the money never moved/);
  });

  it("is not created either", async () => {
    open = await harness();
    const record = impossible();

    await expect(open.gateway.runner.create(record, [], open.now())).rejects.toThrow(
      /breaks what must be true about money/,
    );

    expect(await open.store.orderById("ord_impossible")).toBeNull();
  });
});

describe("an order whose next clock could not be started", () => {
  it("is not written down at all", async () => {
    // Of the two ways this can fail, one is repairable and one is not. Written
    // first and then failing to arm, the order has moved, no clock is on it,
    // and the event that would come back is one the machine says no longer
    // applies — so the delivery is marked done and the order hangs with nobody
    // waiting on anything. Armed first and failing, nothing is written and the
    // event comes back to an order that has not moved.
    open = await harness();
    const published = await open.gateway.publishCard(open.merchant.id, {
      merchant_item_id: "esim",
      title: "A seven day eSIM",
      description: "Seven days of data",
      price: { amount: "12.00", currency: "USD" },
      result: { activation_code: { type: "string" } },
      fulfillment: "async",
    });
    if (!("ok" in published)) throw new Error("the card would not publish");

    const offered = await open.gateway.beginPurchase(published.ok.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    // From here the queue will not take a reminder.
    open.queue.remind = async () => {
      throw new Error("the queue was briefly unreachable");
    };

    await expect(
      open.gateway.runner.apply(orderId, { kind: "payment_verified", at: open.now() }),
    ).rejects.toThrow("the queue was briefly unreachable");

    // The order is exactly where it was, so the event can simply be sent again.
    const after = await open.store.orderById(orderId);
    expect(after?.order.state).toBe("quoted");
    expect(after?.order.payment).toBe("none");
  });
});

describe("who an order belongs to", () => {
  /** An order that has been quoted and is waiting for a payment. */
  const waiting = async (harnessed: Harness) => {
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "esim",
      title: "A seven day eSIM",
      description: "Seven days of data",
      price: { amount: "12.00", currency: "USD" },
      result: { activation_code: { type: "string" } },
      fulfillment: "async",
    });
    if (!("ok" in published)) throw new Error("the card would not publish");
    const offered = await harnessed.gateway.beginPurchase(published.ok.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    return offered.order.order.id;
  };

  it("is settled by the first verified payment, and not taken from its owner", async () => {
    // The ownership decision reads the order under the lock, so a payment that
    // is not the order's own is turned away without a mark on it — the charge is
    // never swapped for a stranger's, and the merchant is never paid with an
    // authorisation the buyer did not present.
    open = await harness();
    const orderId = await waiting(open);

    const first = await open.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A",
      open.now(),
    );
    expect(first.kind).toBe("took");

    const stranger = await open.gateway.runner.presentVerifiedPayment(
      orderId,
      "bob",
      "PAY-B",
      open.now(),
    );
    expect(stranger.kind).toBe("not_owner");

    const after = await open.store.orderById(orderId);
    expect(after?.paidBy).toBe("alice");
    expect(after?.payment).toBe("PAY-A");
  });

  it("tells the owner asking again where it stands, and changes nothing", async () => {
    // A dropped connection and a retry from the same buyer is not a second
    // purchase. It finds the order already its own and under way, and the
    // answer is wherever it has got to — the payment that is being charged is
    // still the first one.
    open = await harness();
    const orderId = await waiting(open);
    await open.gateway.runner.presentVerifiedPayment(orderId, "alice", "PAY-A", open.now());

    const again = await open.gateway.runner.presentVerifiedPayment(
      orderId,
      "alice",
      "PAY-A-AGAIN",
      open.now(),
    );
    expect(again.kind).toBe("already_yours");

    const after = await open.store.orderById(orderId);
    expect(after?.payment).toBe("PAY-A");
    expect(after?.paidBy).toBe("alice");
  });
});
