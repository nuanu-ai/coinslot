import { describe, expect, it } from "vitest";
import { OrderSchema } from "./order.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const order = {
  id: "ord_7c1e05",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  price_id: "prc_31a8c0",
  test: false,
};

describe("order", () => {
  // The promise: a handler holding one order can deliver it and write the sale
  // down without asking us anything and without looking the card up.
  it("accepts an order the way a handler receives it", () => {
    expect(OrderSchema.parse(order)).toStrictEqual(order);
  });

  it("accepts an order for a card that takes no purchase parameters", () => {
    expect(OrderSchema.safeParse({ ...order, params: {} }).success).toBe(true);
  });

  it("accepts an order sold from the card price, with no price question behind it", () => {
    // A card with no price check is sold from its own price, so there was no
    // question and there is no identifier for one. Requiring the field would
    // make the gateway invent an identifier that names nothing.
    const { price_id, ...withoutPriceId } = order;
    expect(price_id).toBeDefined();
    expect(OrderSchema.safeParse(withoutPriceId).success).toBe(true);
  });

  for (const field of ["id", "merchant_item_id", "params", "price", "test"]) {
    it(`refuses an order without ${field} and names it`, () => {
      expectMissingFieldRejected(OrderSchema, order, field);
    });
  }

  it("refuses an order whose test flag is a word rather than a flag", () => {
    // The loop above is where a missing flag is asked about. This is the other
    // way it goes wrong, and the more likely one: `"false"` out of a form or a
    // query string is a truthy string, and read as a flag it turns every test
    // order into a live one — a real delivery against money that never moved.
    expect(OrderSchema.safeParse({ ...order, test: "false" }).success).toBe(false);
  });

  it("carries a sale price with both moments", () => {
    // The price in the order is the price the sale went through at, which is
    // not always the price in the card. `at` says when that price was fixed for
    // this sale and `as_of` how fresh the price behind it was.
    for (const field of ["amount", "currency", "at", "as_of"]) {
      const price = Object.fromEntries(
        Object.entries(order.price).filter(([name]) => name !== field),
      );
      expect(errorOf(OrderSchema, { ...order, price }), field).toContain(field);
    }
  });

  it("refuses a price written as a number", () => {
    expect(OrderSchema.safeParse({ ...order, price: { ...order.price, amount: 5 } }).success).toBe(
      false,
    );
  });

  it("refuses a field it does not know", () => {
    // An order that carries something the handler is meant to act on, and
    // which we never defined, is a promise we did not make.
    expect(errorOf(OrderSchema, { ...order, discount_code: "FREE" })).toContain("discount_code");
  });

  it("refuses a purchase parameter whose name a card could never declare", () => {
    expect(OrderSchema.safeParse({ ...order, params: { "not ok": 1 } }).success).toBe(false);
  });
});
