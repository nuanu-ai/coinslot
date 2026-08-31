/**
 * The two products the mock merchant sells, and the goods it hands over for
 * each.
 *
 * They are the pilot's own two shapes rather than invented ones: a rented phone
 * number, delivered in the answer to the purchase (synchronous), priced when it
 * is bought because a number's availability and cost are a live question; and a
 * data eSIM, paid for at once and provisioned afterwards (asynchronous), sold
 * at its published price. The two together are the reason the slice exists —
 * one product whose money moves last and one whose money moves first — and they
 * are the candidates the pilot plan names for the two modes.
 *
 * The cards are held to the real `CardSchema` the moment they are published, so
 * anything wrong with one of them fails the merchant's own publish call rather
 * than this file. The goods are held to the same card's `result` declaration by
 * the SDK before they ever reach an agent, which is why `goodsFor` returns
 * exactly the fields each card declares and no others.
 */

import type { Card, Delivery } from "@nuanu-ai/coinslot-contracts";

/** The instant written the way every timestamp on the wire is written. */
const asTimestamp = (at: number): string => new Date(at).toISOString();

/**
 * A rented US phone number for thirty days, delivered synchronously.
 *
 * Its price is checked at the moment of purchase: the card carries a snapshot so
 * an agent has something to compare when choosing, and `price_check: "handler"`
 * sends the real question to the merchant's own price desk over the same
 * subscription the orders arrive on. The sale goes through at whatever the desk
 * answers, which is what the synchronous cycle is here to exercise.
 */
export const RENTED_NUMBER: Card = {
  merchant_item_id: "rented-number-us-30d",
  title: "Rented US phone number, 30 days",
  description:
    "A US phone number rented for 30 days, for receiving SMS one-time codes. The number is released at the end of the term; renewal is not included.",
  price: { amount: "3.00", currency: "USD" },
  params: {
    area_code: { type: "string", required: false, title: "Preferred US area code, if any" },
  },
  result: {
    phone_number: { type: "string", title: "The rented number, in E.164 form" },
    valid_until: { type: "string", title: "When the rental ends (ISO 8601)" },
  },
  fulfillment: "sync",
  price_check: "handler",
};

/**
 * A data-only eSIM for Europe, paid for at once and provisioned afterwards.
 *
 * Its price is the published one — there is no price check — so the money moves
 * at the purchase and the profile is issued later, which is the asynchronous
 * cycle. It names no delivery deadline of its own, so the gateway holds it to
 * the system default; the slice's asynchronous test never lets that deadline
 * run, because its subject is the ordinary path where the merchant delivers in
 * time.
 */
export const EUROPE_ESIM: Card = {
  merchant_item_id: "esim-eu-5gb-30d",
  title: "eSIM, Europe, 5 GB, 30 days",
  description:
    "A data-only eSIM for Europe: 5 GB, valid 30 days from first activation. Delivered as an activation code once the provider issues the profile.",
  price: { amount: "8.00", currency: "USD" },
  params: {
    email: { type: "string", required: true, title: "Where to send the activation code" },
  },
  result: {
    activation_code: { type: "string", title: "The eSIM activation code (an LPA string)" },
    iccid: { type: "string", title: "The eSIM ICCID" },
  },
  fulfillment: "async",
};

/** The two cards the mock merchant publishes, in the order it publishes them. */
export const CATALOG: readonly Card[] = [RENTED_NUMBER, EUROPE_ESIM];

/**
 * What the merchant's price desk answers for the rented number when it is asked
 * at the purchase.
 *
 * It answers half a dollar over the card's snapshot on purpose: the sale then
 * goes through at a number the card never carried, which is how the synchronous
 * test tells a purchase that consulted the merchant from one that fell back to
 * the snapshot. `as_of` is the moment the desk looked, which the gateway stamps
 * into the receipt.
 */
export const RENTED_NUMBER_LIVE_PRICE = { amount: "3.50", currency: "USD" } as const;

/**
 * The goods for one order, computed from its parameters so that the delivery is
 * a function of the purchase rather than a fixed string.
 *
 * Each branch returns exactly the fields its card's `result` declares: the SDK
 * holds the return value to that declaration before it is sent, so a field too
 * many or too few would be refused on the merchant's own side.
 */
export function goodsFor(
  merchantItemId: string,
  params: Readonly<Record<string, unknown>>,
  now: number,
): Delivery {
  switch (merchantItemId) {
    case RENTED_NUMBER.merchant_item_id: {
      const areaCode = typeof params.area_code === "string" ? params.area_code : "415";
      const thirtyDays = now + 30 * 24 * 60 * 60 * 1_000;
      return {
        phone_number: `+1${areaCode}5550${String(now % 1000).padStart(3, "0")}`,
        valid_until: asTimestamp(thirtyDays),
      };
    }
    case EUROPE_ESIM.merchant_item_id:
      return {
        activation_code: `LPA:1$smdp.example.com$K2-${String(now % 1_000_000).padStart(6, "0")}`,
        iccid: `8944${String(now).slice(-15).padStart(15, "0")}`,
      };
    default:
      throw new Error(`the mock merchant has no goods for ${merchantItemId}`);
  }
}
