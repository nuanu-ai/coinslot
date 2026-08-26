import { describe, expect, it } from "vitest";
import { OrderStatusSchema } from "./order-status.js";
import { ReceiptOutcomeSchema, ReceiptSchema } from "./receipt.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const receipt = {
  id: "rcp_4b90de",
  order_id: "ord_7c1e05",
  item_id: "itm_9f2c4a",
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  price_id: "prc_31a8c0",
  paid_at: "2026-08-26T10:20:03Z",
  outcome: "delivered",
  test: false,
};

describe("what a receipt says became of the purchase", () => {
  // The promise: a receipt says exactly what is known, in the same words the
  // order status uses. "Paid, delivery still running" is a different statement
  // from "delivered" and from "paid and never delivered", and an agent must
  // not have to read one as another.
  it("tells apart the four states a paid purchase can be in", () => {
    for (const outcome of ["in_progress", "delivered", "refund_due", "refunded"]) {
      expect(ReceiptOutcomeSchema.safeParse(outcome).success, outcome).toBe(true);
    }
  });

  it("borrows its words from the order status rather than inventing its own", () => {
    // A receipt outcome that read `pending` where the order said `in_progress`
    // would be two names for one state, and whichever an agent happened to
    // read would look like the whole truth.
    for (const outcome of ReceiptOutcomeSchema.options) {
      expect(OrderStatusSchema.safeParse(outcome).success, outcome).toBe(true);
    }
    expect(ReceiptOutcomeSchema.safeParse("pending").success).toBe(false);
  });

  it("has no value for a purchase whose money never moved", () => {
    // A refused, declined, expired or cancelled purchase leaves no receipt at
    // all: nothing moved, and there is nothing to be proof of. Neither does a
    // synchronous delivery whose payment failed — that is the case where the
    // merchant produced the goods and no payment executed, so there is no
    // record of one to write.
    for (const outcome of [
      "rejected",
      "declined",
      "expired",
      "cancelled",
      "delivered_unpaid",
      "",
    ]) {
      expect(ReceiptOutcomeSchema.safeParse(outcome).success, JSON.stringify(outcome)).toBe(false);
    }
  });
});

describe("receipt", () => {
  it("accepts the record of a completed purchase", () => {
    expect(ReceiptSchema.parse(receipt)).toStrictEqual(receipt);
  });

  it("accepts a receipt for a purchase still waiting on its delivery", () => {
    expect(ReceiptSchema.safeParse({ ...receipt, outcome: "in_progress" }).success).toBe(true);
  });

  it("accepts a receipt for a debt that has since been paid back", () => {
    expect(ReceiptSchema.safeParse({ ...receipt, outcome: "refunded" }).success).toBe(true);
  });

  it("accepts a receipt for a sale that had no price question behind it", () => {
    const { price_id, ...withoutPriceId } = receipt;
    expect(price_id).toBeDefined();
    expect(ReceiptSchema.safeParse(withoutPriceId).success).toBe(true);
  });

  for (const field of ["id", "order_id", "item_id", "price", "paid_at", "outcome", "test"]) {
    it(`refuses a receipt without ${field} and names it`, () => {
      expectMissingFieldRejected(ReceiptSchema, receipt, field);
    });
  }

  it("refuses a receipt that does not say whether the money was real", () => {
    // A receipt is proof of payment. An unmarked receipt for a test purchase
    // is proof of a payment that never happened.
    expect(errorOf(ReceiptSchema, { ...receipt, test: undefined })).toContain("test");
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(ReceiptSchema, { ...receipt, refunded: true })).toContain("refunded");
  });
});
