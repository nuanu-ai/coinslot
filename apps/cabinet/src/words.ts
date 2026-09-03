/**
 * The words a merchant reads, for every value the wire can send.
 *
 * The wire's vocabularies are what a program branches on and they are not
 * English sentences: `refund_due`, `delivered_unpaid`, `payment_unresolved`.
 * This file is the one place they become something a person reads, and it is
 * one place rather than three so that a state does not have one name on the
 * orders screen and another on the receipts screen. A merchant who saw
 * "awaiting fulfilment" beside an order and "not delivered yet" beside its
 * receipt would reasonably go looking for two different situations.
 *
 * Every map is total over its vocabulary, and a test walks each vocabulary
 * through it. That is not tidiness: a status with no word here would reach a
 * merchant as `undefined` or as the raw wire value, and the states most likely
 * to be added later are the rare ones — which are exactly the ones a merchant
 * has never seen and cannot guess.
 *
 * Two of the words are deliberately weaker than the design they came from, and
 * both are the fifth gate. The design's orders table says "accepted, awaiting
 * delivery"; nothing an agent or a merchant reads over this API can tell an
 * order the merchant has taken on from one that was created a second ago,
 * because `in_progress` folds them on purpose (`order-status.ts` argues it),
 * so the cabinet says the weaker thing it can stand behind. And
 * `payment_unresolved` is rendered as a question rather than as a failure,
 * because the fact behind it is that we asked the payment network and heard
 * nothing — not that nothing was charged.
 */

import type { Fulfillment, OrderStatus, SellingState } from "@nuanu-ai/coinslot-contracts";

/** How a state reads to the eye, before any word is read. */
export type Tone = "ok" | "warn" | "busy" | "quiet";

export interface Word {
  readonly text: string;
  readonly tone: Tone;
}

/**
 * Where an order stands, in the merchant's words.
 *
 * The endings that cost the merchant something are marked `warn` and the ones
 * that cost nobody anything are quiet. `delivered` is the only `ok`: it is the
 * only ending in which the goods are the buyer's and the money is the
 * merchant's.
 */
export const ORDER_WORDS: Readonly<Record<OrderStatus, Word>> = Object.freeze({
  in_progress: { text: "awaiting fulfilment", tone: "busy" },
  delivered: { text: "delivered", tone: "ok" },
  rejected: { text: "refused", tone: "quiet" },
  payment_unresolved: { text: "payment outcome unknown", tone: "warn" },
  declined: { text: "declined at confirmation", tone: "quiet" },
  expired: { text: "closed on time limit", tone: "quiet" },
  cancelled: { text: "closed when you left", tone: "quiet" },
  refund_due: { text: "refund due", tone: "warn" },
  refunded: { text: "refunded", tone: "quiet" },
  delivered_unpaid: { text: "delivered, not paid", tone: "warn" },
});

/**
 * When the product reaches the buyer, which is also when the money moves.
 *
 * The design's own words, and they are the merchant's rather than the
 * contract's: "immediate" and "later" say what a merchant's own operation has
 * to be ready for, where `sync` and `async` say how the call is shaped.
 */
export const FULFILLMENT_WORDS: Readonly<Record<Fulfillment, string>> = Object.freeze({
  sync: "immediate",
  async: "later",
  confirm: "after you confirm",
});

/** Whether a merchant, or one of their cards, is taking new orders. */
export const SELLING_WORDS: Readonly<Record<SellingState, Word>> = Object.freeze({
  open: { text: "selling", tone: "ok" },
  paused: { text: "paused", tone: "warn" },
  departed: { text: "left", tone: "quiet" },
});

/**
 * The orders that are open and are owed something the merchant can act on.
 *
 * These are the two the portal names as the ones that stay open after the
 * purchase itself is over: money taken and nothing delivered, and goods
 * delivered against a payment that never executed. An order merely under way
 * is not here — it is open, it may well be the merchant's to deliver, and this
 * API cannot yet tell that from an order created a second ago, so calling it
 * out would be a demand for attention we cannot justify.
 */
export const NEEDS_ATTENTION: readonly OrderStatus[] = Object.freeze([
  "refund_due",
  "delivered_unpaid",
]);

export const needsAttention = (status: OrderStatus): boolean => NEEDS_ATTENTION.includes(status);

/**
 * A sum of money as a merchant reads it.
 *
 * The amount is passed through exactly as it arrived. It is a decimal string
 * on the wire precisely so that nothing on the way turns it into a float, and
 * a screen that reformatted it would be the last place that promise is kept —
 * `"5.00"` shown as `$5` is a different number to anybody comparing this
 * against their own books.
 */
export const money = (sum: { readonly amount: string; readonly currency: string }): string =>
  `${sum.amount} ${sum.currency}`;

/**
 * A moment as a merchant reads it, in UTC, to the second.
 *
 * UTC and not the merchant's own zone, and it says so beside every one it
 * prints. The server has no idea what zone the reader is in — nothing in the
 * request carries it — and quietly rendering the server's zone would put a
 * time on a receipt that is off by hours with nothing to say it is.
 *
 * The seconds are here because this screen is reconciled against a wallet.
 * Cut to the minute, two receipts a few seconds apart are one line twice, and
 * the merchant matching transfers cannot tell which is which. The truncation
 * that remains is below the second, and nothing in this contract is timed
 * finely enough for that to separate two payments.
 */
export const moment = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    // A timestamp the gateway sent and we cannot read. Showing the raw value
    // is the honest answer: it is what we were told, and inventing a date for
    // it would put a moment on a receipt that nothing stands behind.
    return iso;
  }
  const date = at.toISOString();
  return `${date.slice(0, 10)} ${date.slice(11, 19)} UTC`;
};
