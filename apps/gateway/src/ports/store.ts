/**
 * The store: everything the gateway remembers.
 *
 * It is a port because the thing behind it is one Postgres (ADR-0003 §6) and
 * the whole of the application logic has to be testable without one. What is
 * written here is therefore the smallest set of questions the flows actually
 * ask, in the words of the domain, and nothing about tables.
 *
 * One method is not an accessor and is the reason this is an interface rather
 * than three maps. `withOrder` holds an order still while a decision is made
 * about it. Two events about the same order arrive from different places all
 * the time — the agent's payment and a deadline, the merchant's answer and a
 * redelivery — and without that hold both would read the same order, both
 * would decide against it, and the second write would erase the first. Next to
 * someone else's money that is not a race to lose politely: it is how an order
 * gets charged twice.
 */

import type { Card, Delivery, Receipt } from "@coinslot/contracts";
import type { Order } from "@coinslot/core";

/** A card as its merchant published it, under the catalog identifier we issued. */
export interface StoredCard {
  readonly id: string;
  readonly card: Card;
  /** When this version of the card was published. */
  readonly asOf: number;
}

/**
 * One order: the machine's own order, and everything about the purchase the
 * machine has no opinion about.
 *
 * The payment sits here as the opaque thing the agent presented rather than as
 * anything this package understands. It is kept because the charge is executed
 * later than it is verified — in the synchronous mode, after the goods come
 * back — and by then the request that carried it is long over.
 */
export interface StoredOrder {
  readonly order: Order;
  /** Our catalog identifier for the product. */
  readonly itemId: string;
  /** The merchant's own identifier for it, so they need no mapping table. */
  readonly merchantItemId: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The price question this order was priced by, where one was asked. */
  readonly priceId: string | null;
  /** What the merchant handed over, once they have. */
  readonly delivery: Delivery | null;
  /** What the agent presented to pay with, verbatim, until the charge is done. */
  readonly payment: string | null;
  /**
   * The fingerprint of the payment this order is being fulfilled against, and
   * with it the answer to who this purchase belongs to.
   *
   * An order's identifier is not a secret the way a password is: it travels in
   * the challenge, on the merchant's stream and in a receipt. The route that
   * takes a payment takes no key — the payment is what stands in for one — so
   * without this, anybody holding an identifier could present a payment against
   * somebody else's purchase, and the gateway would treat them as its buyer:
   * swapping the authorisation that gets charged, taking the goods when they
   * came back, and closing the order on a verification that failed. The first
   * payment presented owns the order, and only the machine reopening it — a
   * repeat, on an order that takes one — lets another take over.
   */
  readonly paidBy: string | null;
  /**
   * The address the payment that owns this order says it spends from.
   *
   * It is what tells a repeat of a purchase from a stranger. A repeat carries a
   * fresh authorisation and therefore a different fingerprint, so the
   * fingerprint alone cannot say whether the agent asking is the one who bought
   * — and the two endings that a repeat exists for are exactly the ones where
   * goods have already been made. Anybody may write an address into a payment,
   * and a payment whose address is not the one that signed it does not verify,
   * so claiming to be somebody else buys only a refusal.
   */
  readonly paidFrom: string | null;
  /**
   * What the payment layer said when the charge went through, kept because the
   * agent's own client reads it off the answer to its purchase. It is the
   * payment layer's word and not ours: the order's own record of the money is
   * the machine's payment stage, and this is only the receipt for it.
   */
  readonly settlement: { readonly transaction: string } | null;
  /**
   * Everything the payment layer has actually said about this order, in its own
   * words and in order.
   *
   * The machine keeps a coarse verdict — verified, settled, unknown — and three
   * reasons a verification can fail. What the facilitator said is richer than
   * that and is the only thing an operator can work from when a charge goes
   * quiet: it is the difference between an outage, an empty wallet and a chain
   * nobody configured. Dropping it left the one order somebody has to
   * reconcile by hand with nothing to reconcile from.
   */
  readonly paymentWords: readonly PaymentWord[];
  /**
   * How many of them fell off the end of that list.
   *
   * The list is bounded, because the route that fills it takes no key and
   * anybody may present as many payments as they like against one order. What
   * is dropped is counted rather than dropped quietly: a reader of the last
   * twenty things the payment layer said needs to know whether there were
   * twenty or two hundred.
   */
  readonly paymentWordsDropped: number;
  /**
   * The delivery that is out with a worker and has not been answered.
   *
   * It is here so that a reminder about one delivery cannot undo the answer to
   * another. A merchant who took an order on and has a day to fulfill it
   * answered the delivery he was given; without this, the reminder left against
   * that same delivery would fire afterwards, the machine would be told his
   * handler never answered, and he would be sent the order again — every window,
   * all day.
   */
  readonly openDeliveryId: string | null;
}

/** One thing the payment layer said, and when. */
export interface PaymentWord {
  readonly at: number;
  readonly about: "verify" | "settle";
  readonly said: string;
}

/**
 * What `withOrder` decided: the order to write back, if any, and the answer to
 * give the caller. Leaving `save` out is how a read that changes nothing says
 * so, rather than writing the order it just read.
 */
export interface OrderChange<T> {
  readonly save?: StoredOrder;
  readonly result: T;
}

/**
 * An order that is not there. It is a value rather than a thrown error because
 * an agent asking about an order that never existed is an ordinary thing that
 * happens, and the caller has to answer it rather than crash on it.
 */
export type OrderLookup<T> =
  | { readonly found: true; readonly result: T }
  | { readonly found: false };

/** Whether a payment is this order's to spend. */
export type PaymentClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldBy: string };

export interface Store {
  /**
   * Publishes one card. Republishing under the same `merchant_item_id` changes
   * the card that is there rather than adding a second one, which is what the
   * portal promises, so the catalog identifier stays what it was.
   */
  publishCard(card: Card, at: number): Promise<StoredCard>;
  cardById(id: string): Promise<StoredCard | null>;
  cards(): Promise<readonly StoredCard[]>;

  /** Writes an order that is not there yet. */
  addOrder(record: StoredOrder): Promise<void>;
  orderById(id: string): Promise<StoredOrder | null>;
  /** Every order, or with `open` only the ones still owed work or money. */
  orders(query?: { readonly open?: boolean }): Promise<readonly StoredOrder[]>;

  /**
   * Holds one order still, hands it to `change`, and writes back whatever
   * `change` asks to be written. Nothing else touches that order in between.
   */
  withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
  ): Promise<OrderLookup<T>>;

  /**
   * Binds one payment to one order, once and for all.
   *
   * A signed payment authorises an amount to an address; nothing inside it says
   * which purchase it is for, and nothing about presenting it twice is visible
   * to the payment layer until the second charge is actually executed. Two
   * orders at the same price are therefore payable with one signature — both
   * verify, both go to a merchant, both are delivered, and only the second
   * charge fails. This is what stops that: the first order to present a payment
   * owns it, and the same payment presented for a second order is refused
   * before anything is verified or dispatched.
   */
  claimPayment(fingerprint: string, orderId: string): Promise<PaymentClaim>;

  /**
   * Forgets claims older than an instant, and says how many went.
   *
   * They cannot be kept forever. The route that makes them takes no key — the
   * payment is what stands in for one — so anybody can make as many as they
   * like, and a table that only grows under an open door is a table that fills
   * up. What a claim actually guards is the window between a payment being
   * verified and the charge being executed, because after that the token
   * itself refuses the same authorisation twice; how long that window is worth
   * keeping is configuration.
   */
  forgetClaimsBefore(instant: number): Promise<number>;

  putReceipt(receipt: Receipt): Promise<void>;
  receiptForOrder(orderId: string): Promise<Receipt | null>;
  receipts(): Promise<readonly Receipt[]>;
}
