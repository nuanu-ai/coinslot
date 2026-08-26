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
    itemId: "item_1",
    merchantItemId: "sku-1",
    params: {},
    priceId: null,
    delivery: null,
    payment: null,
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
