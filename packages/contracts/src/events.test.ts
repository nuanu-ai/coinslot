import { describe, expect, it } from "vitest";
import { ORDER_EVENT_TYPES, OrderEventSchema, RefundDueReasonSchema } from "./events.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const refundDue = {
  type: "order.refund_due",
  order_id: "ord_7c1e05",
  at: "2026-08-27T10:20:00Z",
  price: { amount: "5.00", currency: "USD" },
  reason: "deadline_passed",
};

const unpaid = {
  type: "order.unpaid_after_confirmation",
  order_id: "ord_7c1e05",
  at: "2026-08-26T11:20:00Z",
};

const paymentFailed = {
  type: "order.payment_failed_after_delivery",
  order_id: "ord_7c1e05",
  at: "2026-08-26T10:20:05Z",
};

describe("the events a merchant hears without asking", () => {
  // The promise: the three things that can happen to an order without the
  // merchant's participation arrive on the same subscription as the orders,
  // so none of them has to be found by reconciling records by hand.

  it("names the three", () => {
    expect(Object.values(ORDER_EVENT_TYPES)).toStrictEqual([
      "order.refund_due",
      "order.unpaid_after_confirmation",
      "order.payment_failed_after_delivery",
    ]);
  });

  it("accepts an order marked as owing a refund", () => {
    expect(OrderEventSchema.parse(refundDue)).toStrictEqual(refundDue);
  });

  it("accepts a confirmed order the agent never paid for", () => {
    expect(OrderEventSchema.parse(unpaid)).toStrictEqual(unpaid);
  });

  it("accepts a payment that did not execute after a synchronous delivery", () => {
    expect(OrderEventSchema.parse(paymentFailed)).toStrictEqual(paymentFailed);
  });

  it("refuses an event of a kind we do not send", () => {
    // The catalog grows by adding a shape here, not by a sender inventing a
    // name. A consumer that switches on the type has to be able to trust that
    // an unknown one is a version mismatch and not a typo.
    for (const type of ["refund_due", "order.refunded", "order.delivered", ""]) {
      expect(OrderEventSchema.safeParse({ ...unpaid, type }).success, JSON.stringify(type)).toBe(
        false,
      );
    }
  });

  it("refuses an event that does not say which kind it is", () => {
    expectMissingFieldRejected(OrderEventSchema, unpaid, "type");
  });

  for (const field of ["order_id", "at"]) {
    it(`refuses an event without ${field} and names it`, () => {
      expectMissingFieldRejected(OrderEventSchema, unpaid, field);
      expectMissingFieldRejected(OrderEventSchema, refundDue, field);
    });
  }
});

describe("an order that owes a refund", () => {
  // The promise: the merchant learns which order, how much and why in one
  // message. The money went to their wallet directly, so the sum is theirs to
  // send back, and a message that named only the order would leave them
  // looking it up.

  for (const field of ["price", "reason"]) {
    it(`refuses a refund-due event without ${field} and names it`, () => {
      expectMissingFieldRejected(OrderEventSchema, refundDue, field);
    });
  }

  it("tells the three ways an order comes to owe a refund apart", () => {
    for (const reason of ["refused", "deadline_passed", "merchant_left"]) {
      expect(RefundDueReasonSchema.safeParse(reason).success, reason).toBe(true);
      expect(OrderEventSchema.safeParse({ ...refundDue, reason }).success, reason).toBe(true);
    }
  });

  it("refuses a reason that is not one of them", () => {
    expect(errorOf(OrderEventSchema, { ...refundDue, reason: "out_of_stock" })).toContain("reason");
  });

  it("refuses a sum written as a number", () => {
    expect(
      OrderEventSchema.safeParse({ ...refundDue, price: { amount: 5, currency: "USD" } }).success,
    ).toBe(false);
  });

  it("does not carry a sum on the events where no sum is owed", () => {
    // A confirmed order that went unpaid cost the merchant nothing, and a
    // synchronous delivery whose payment failed leaves them holding the
    // question, not a debt. Attaching money to either would read as one.
    expect(
      OrderEventSchema.safeParse({ ...unpaid, price: { amount: "5.00", currency: "USD" } }).success,
    ).toBe(false);
    expect(
      OrderEventSchema.safeParse({ ...paymentFailed, price: { amount: "5.00", currency: "USD" } })
        .success,
    ).toBe(false);
  });
});
