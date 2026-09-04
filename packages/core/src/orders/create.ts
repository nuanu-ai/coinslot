/**
 * The birth of an order, and the one guard that stands in front of it.
 *
 * Pausing is not leaving. A paused merchant sells nothing new, and his orders
 * that are already open play out in the ordinary way — which is why the guard
 * lives here, at creation, and the transition function never asks whether the
 * merchant is selling at all.
 */

import { assertNever } from "../index.js";
import type { Effect, Order, OrderMode, OrderPolicy, Price } from "./model.js";
import { effectsOnQuoted } from "./model.js";

/** Whether the merchant is taking new orders. */
export const MERCHANT_SELLING = ["open", "paused", "departed"] as const;

export type MerchantSelling = (typeof MERCHANT_SELLING)[number];

/**
 * Whether the card's price is asked of the merchant at the moment of purchase.
 * A static card lives off its snapshot and is not asked.
 */
export const PRICE_CHECKS = ["none", "merchant"] as const;

export type PriceCheck = (typeof PRICE_CHECKS)[number];

export const CREATE_REJECTIONS = ["selling_paused", "merchant_departed"] as const;

export type CreateRejection = (typeof CREATE_REJECTIONS)[number];

export type CreateOrderInput = {
  readonly id: string;
  readonly at: number;
  readonly mode: OrderMode;
  readonly policy: OrderPolicy;
  readonly priceCheck: PriceCheck;
  readonly cardPrice: Price;
  readonly test: boolean;
  readonly selling: MerchantSelling;
};

export type CreateOrderResult =
  | { readonly ok: true; readonly order: Order; readonly effects: readonly Effect[] }
  | {
      readonly ok: false;
      readonly rejection: { readonly code: CreateRejection; readonly message: string };
    };

export function createOrder(input: CreateOrderInput): CreateOrderResult {
  switch (input.selling) {
    case "paused":
      return {
        ok: false,
        rejection: {
          code: "selling_paused",
          // The sentence names the product and not the merchant, because
          // "paused" arrives here with three different causes folded into it
          // and the caller does the folding: one card taken off sale, the whole
          // catalog stopped, or a merchant who cannot be paid at all. It used
          // to say the merchant's cards were paused, and a buyer refused at a
          // single paused card was told something false about a merchant who
          // was selling everything else. What is true in all three is the only
          // thing the agent can act on anyway — this product cannot be bought
          // right now — and it is the same sentence the challenge is refused
          // with a step earlier, so the two doors agree.
          message: "this product is not on sale at the moment, so no new order is taken",
        },
      };
    case "departed":
      return {
        ok: false,
        rejection: {
          code: "merchant_departed",
          message: "the merchant has left, so no new order is taken",
        },
      };
    case "open":
      break;
    default:
      return assertNever(input.selling, "merchant selling status");
  }

  const base: Order = {
    id: input.id,
    state: "created",
    mode: input.mode,
    policy: input.policy,
    payment: "none",
    cardPrice: input.cardPrice,
    price: null,
    quoteSource: null,
    dispatch: { attempts: 0, accepted: false },
    heldFulfillment: false,
    closure: null,
    test: input.test,
    timestamps: {
      createdAt: input.at,
      quotedAt: null,
      confirmationRequestedAt: null,
      confirmedAt: null,
      settleStartedAt: null,
      paidAt: null,
      dispatchedAt: null,
    },
  };

  if (input.priceCheck === "merchant") {
    return { ok: true, order: base, effects: [{ kind: "request_quote" }] };
  }

  // A card without a price check is sold off its own snapshot, so the order is
  // born already quoted and the price carries the card's own `as_of`.
  return {
    ok: true,
    order: {
      ...base,
      state: "quoted",
      price: input.cardPrice,
      quoteSource: "card_snapshot",
      timestamps: { ...base.timestamps, quotedAt: input.at },
    },
    effects: effectsOnQuoted(input.mode),
  };
}
