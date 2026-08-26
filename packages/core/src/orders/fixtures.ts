/**
 * Order fixtures for the tests of this package. Nothing here is exported from
 * the package index on purpose: the gateway builds orders out of real
 * purchases, and a builder that quietly guesses defaults has no business
 * standing next to someone else's money.
 *
 * Every number below is a test value and nothing more. The real deadlines and
 * the real redelivery schedule are named before the pilot — they are still
 * open questions in `docs/research/16-order-state-machine.md`, which is why
 * the machine takes them as a policy instead of carrying constants.
 */

import type { CreateOrderInput, MerchantSelling, PriceCheck } from "./create.js";
import { createOrder } from "./create.js";
import type { FulfillmentMode, Order, OrderPolicy, Price } from "./model.js";
import { modeOf } from "./model.js";

/** An arbitrary but fixed instant. Time is a value here, never a clock. */
export const T0 = 1_000_000;

export const TEST_POLICY: OrderPolicy = {
  deadlines: {
    quoteTtlMs: 60_000,
    syncResponseMs: 10_000,
    paymentAfterConfirmationMs: 300_000,
    confirmationResponseMs: 600_000,
    asyncFulfillmentMs: 86_400_000,
  },
  redelivery: {
    baseDelayMs: 1_000,
    factor: 2,
    maxDelayMs: 60_000,
    maxAttempts: 5,
  },
};

export const TEST_PRICE: Price = { amount: "5.00", currency: "USD", asOf: T0 };

export function createInput(
  fulfillment: FulfillmentMode,
  overrides: Partial<CreateOrderInput> = {},
): CreateOrderInput {
  return {
    id: "ord_7c1e05",
    at: T0,
    mode: modeOf(fulfillment),
    policy: TEST_POLICY,
    priceCheck: "none" satisfies PriceCheck,
    cardPrice: TEST_PRICE,
    test: false,
    selling: "open" satisfies MerchantSelling,
    ...overrides,
  };
}

/** An order that already passed creation, for tests that start further in. */
export function newOrder(
  fulfillment: FulfillmentMode,
  overrides: Partial<CreateOrderInput> = {},
): Order {
  const created = createOrder(createInput(fulfillment, overrides));
  if (!created.ok) {
    throw new Error(`fixture could not create the order: ${created.rejection.code}`);
  }
  return created.order;
}
