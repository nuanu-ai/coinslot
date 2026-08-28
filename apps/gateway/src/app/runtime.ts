/**
 * What every flow is given, and the translations from a card to the machine's
 * vocabulary.
 *
 * The policy is built here rather than anywhere further in, because it is the
 * one place where our numbers and the merchant's meet. Ours come from the
 * configuration; his two come off the card, and where he named neither the
 * configuration says what he is held to instead. A default invented at the
 * point of use would be a deadline nobody agreed to, applied to somebody's
 * money.
 */

import type { Card } from "@coinslot/contracts";
import type { MerchantSelling, OrderMode, OrderPolicy } from "@coinslot/core";
import { modeOf } from "@coinslot/core";
import { type GatewayConfig, isSandboxFacilitator } from "../config.js";
import type { Clock, Ids } from "../ports/clock.js";
import type { Facilitator } from "../ports/facilitator.js";
import type { Queue } from "../ports/queue.js";
import type { Store, StoredCard } from "../ports/store.js";

export interface Runtime {
  readonly config: GatewayConfig;
  readonly store: Store;
  readonly queue: Queue;
  readonly facilitator: Facilitator;
  readonly clock: Clock;
  readonly ids: Ids;
}

export function policyFor(card: Card, config: GatewayConfig): OrderPolicy {
  const { deadlines } = config;
  return {
    deadlines: {
      quoteResponseMs: deadlines.quoteResponseMs,
      quoteTtlMs: deadlines.quoteTtlMs,
      settleResponseMs: deadlines.settleResponseMs,
      syncResponseMs: deadlines.syncResponseMs,
      paymentAfterConfirmationMs: deadlines.paymentAfterConfirmationMs,
      confirmationResponseMs:
        card.confirm_deadline_seconds === undefined
          ? deadlines.defaultConfirmationResponseMs
          : card.confirm_deadline_seconds * 1_000,
      asyncFulfillmentMs:
        card.fulfill_deadline_seconds === undefined
          ? deadlines.defaultAsyncFulfillmentMs
          : card.fulfill_deadline_seconds * 1_000,
    },
    redelivery: config.redelivery,
  };
}

export function modeForCard(card: Card): OrderMode {
  return modeOf(card.fulfillment);
}

/**
 * Whether the merchant is asked what this product costs at the moment of
 * purchase.
 *
 * A card whose price check names an address rather than the handler is asked
 * over a transport the pilot does not serve, and this says so out loud instead
 * of quietly treating the card as static. The order is created with a price
 * check that will go unanswered, and the merchant's silence is then resolved
 * by the machine's own per-mode policy — which is the honest ending, because a
 * question we cannot ask and a question that got no answer are the same fact
 * from the order's side.
 */
export function priceCheckOf(card: Card): "none" | "merchant" {
  return card.price_check === undefined ? "none" : "merchant";
}

/** Whether the price question can actually be put to this merchant today. */
export function quoteReachesTheMerchant(card: Card): boolean {
  return card.price_check === "handler";
}

/**
 * The one word the order machine is given about whether this card may be sold.
 *
 * There are two switches a merchant can press — one card off sale, or the whole
 * catalog — and a third thing that stops a sale without anybody pressing
 * anything: a merchant with nowhere for the money to go. There is exactly one
 * guard in the machine. This is where the three become the one, and it is a
 * translation rather than a second notion of pausing: what comes out is the
 * machine's own vocabulary, and a card that comes out `paused` refuses new
 * orders through the guard that already exists, with the rejection and the
 * message that already exist.
 *
 * The wallet belongs here rather than at the purchase, and the difference is a
 * row in a database. A challenge for such a card cannot be written at all —
 * there is no address to put in it and the operator's own will not stand in
 * (ADR-0019) — so a purchase that checked at the till would have opened the
 * order first and failed afterwards, leaving one nobody can pay and nothing
 * will ever collect. Folded in here, the card is not offered, not listed, and
 * refused with the word an agent's client already knows.
 *
 * A departed merchant stays departed whatever a card says. Leaving is not a
 * pause a card can be excused from, and reading a card as merely paused would
 * be the difference between "no new orders" and "the open ones closed and the
 * money for the undelivered is yours to return".
 */
export function sellingFor(
  merchant: MerchantSelling,
  card: StoredCard,
  payable: boolean,
): MerchantSelling {
  return merchant === "open" && (card.paused || !payable) ? "paused" : merchant;
}

/**
 * Whether a sale of this merchant's card could be paid for at all.
 *
 * It is the publish door's own rule, read at every later moment as well: an
 * address is what a payment request names, so a merchant who has none has
 * nothing that can be sold where the money is real. The sandbox asks for none
 * and this says so, because there is nothing to send and no chain to send it on
 * (ADR-0008) — a local stack that stopped selling over an address nobody can be
 * paid at would be a stack nobody can bring up.
 */
export function payableTo(payoutWallet: string | null, config: GatewayConfig): boolean {
  return payoutWallet !== null || isSandboxFacilitator(config.payment.facilitatorUrl);
}
