/**
 * The store, in memory.
 *
 * This is not a stub for the real one: it is the adapter the whole of the
 * application logic is tested against, so it has to keep the same promises the
 * Postgres one does. Two of them are load-bearing and both are about `withOrder`.
 *
 * An order is held still while a decision is made about it, and the hold is per
 * order rather than over the whole store — two different orders never wait for
 * each other, and the same order never has two decisions in flight. The
 * Postgres adapter gets this from a row lock inside a transaction; here it is a
 * queue of promises per identifier, which is the same guarantee in the one
 * process this map lives in.
 *
 * And what goes in comes out unchanged. Orders are frozen on the way in,
 * because a caller that kept a reference and edited it afterwards would be
 * editing the database — which the Postgres adapter would simply ignore, and
 * the difference between the two would show up as a test that passes here and
 * a purchase that fails there.
 */

import type { Card, Receipt } from "@coinslot/contracts";
import { isOpen, type MerchantSelling } from "@coinslot/core";
import type { Clock, Ids } from "../../ports/clock.js";
import type {
  OrderChange,
  OrderLookup,
  PaymentClaim,
  Store,
  StoredCard,
  StoredOrder,
} from "../../ports/store.js";

export class MemoryStore implements Store {
  readonly #cards = new Map<string, StoredCard>();
  /** The merchant's own key for a product, to the catalog identifier we issued. */
  readonly #cardIdByMerchantKey = new Map<string, string>();
  /** One merchant in stage one, so one word. Nobody has paused them yet. */
  #selling: MerchantSelling = "open";
  readonly #orders = new Map<string, StoredOrder>();
  readonly #receipts = new Map<string, Receipt>();
  /** Which order owns which payment, so no payment is spent on two. */
  readonly #paymentClaims = new Map<string, { orderId: string; at: number }>();
  /** The tail of the queue of decisions waiting on each order. */
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #ids: Ids;
  readonly #now: Clock;

  constructor(ids: Ids, now: Clock = () => Date.now()) {
    this.#ids = ids;
    this.#now = now;
  }

  async publishCard(card: Card, at: number): Promise<StoredCard> {
    // Republishing under the same merchant key changes the card that is there
    // rather than adding a second one, which is what the portal promises and
    // why the catalog identifier survives the edit.
    const existing = this.#cardIdByMerchantKey.get(card.merchant_item_id);
    const id = existing ?? this.#ids("item");
    // A pause survives the edit. A merchant changing a price is not asking for
    // a product they took off sale to go back on it.
    const paused = existing === undefined ? false : (this.#cards.get(existing)?.paused ?? false);
    const stored: StoredCard = Object.freeze({ id, card, asOf: at, paused });

    this.#cardIdByMerchantKey.set(card.merchant_item_id, id);
    this.#cards.set(id, stored);
    return stored;
  }

  async cardById(id: string): Promise<StoredCard | null> {
    return this.#cards.get(id) ?? null;
  }

  async cards(): Promise<readonly StoredCard[]> {
    return [...this.#cards.values()];
  }

  async setCardPaused(id: string, paused: boolean): Promise<StoredCard | null> {
    const found = this.#cards.get(id);
    if (found === undefined) {
      return null;
    }
    const stored: StoredCard = Object.freeze({ ...found, paused });
    this.#cards.set(id, stored);
    return stored;
  }

  async selling(): Promise<MerchantSelling> {
    return this.#selling;
  }

  async setSelling(selling: MerchantSelling): Promise<void> {
    this.#selling = selling;
  }

  async addOrder(record: StoredOrder): Promise<void> {
    if (this.#orders.has(record.order.id)) {
      throw new Error(`the order ${record.order.id} is already written down`);
    }
    this.#orders.set(record.order.id, Object.freeze({ ...record }));
  }

  async orderById(id: string): Promise<StoredOrder | null> {
    return this.#orders.get(id) ?? null;
  }

  async orders(query?: { readonly open?: boolean }): Promise<readonly StoredOrder[]> {
    const all = [...this.#orders.values()];
    return query?.open === true ? all.filter((record) => isOpen(record.order.state)) : all;
  }

  async withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
  ): Promise<OrderLookup<T>> {
    // Each order's decisions run one after another. The tail of the chain is
    // kept rather than the head, so an order nobody is currently deciding about
    // costs one settled promise and not a walk through everything that ever
    // happened to it.
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const mine = previous.then(async (): Promise<OrderLookup<T>> => {
      const found = this.#orders.get(id);
      if (found === undefined) {
        return { found: false };
      }

      const decided = await change(found);
      if (decided.save !== undefined) {
        this.#orders.set(id, Object.freeze({ ...decided.save }));
      }
      return { found: true, result: decided.result };
    });

    // The chain must not break on a failed decision, or every later decision
    // about that order would inherit the failure and never run.
    this.#locks.set(
      id,
      mine.catch(() => undefined),
    );
    return mine;
  }

  async claimPayment(fingerprint: string, orderId: string): Promise<PaymentClaim> {
    const held = this.#paymentClaims.get(fingerprint);
    if (held === undefined) {
      this.#paymentClaims.set(fingerprint, { orderId, at: this.#now() });
      return { claimed: true };
    }
    // The same order presenting the same payment again is the ordinary retry
    // the portal promises is safe, and it still owns it.
    return held.orderId === orderId ? { claimed: true } : { claimed: false, heldBy: held.orderId };
  }

  async releaseClaim(fingerprint: string, orderId: string): Promise<void> {
    // Only the holder lets go. A fingerprint some other order holds is left
    // where it is, so this can never hand one buyer's signature to another.
    if (this.#paymentClaims.get(fingerprint)?.orderId === orderId) {
      this.#paymentClaims.delete(fingerprint);
    }
  }

  async forgetClaimsBefore(instant: number): Promise<number> {
    let gone = 0;
    for (const [fingerprint, claim] of [...this.#paymentClaims]) {
      if (claim.at < instant) {
        this.#paymentClaims.delete(fingerprint);
        gone += 1;
      }
    }
    return gone;
  }

  async putReceipt(receipt: Receipt): Promise<void> {
    this.#receipts.set(receipt.order_id, Object.freeze({ ...receipt }));
  }

  async receiptForOrder(orderId: string): Promise<Receipt | null> {
    return this.#receipts.get(orderId) ?? null;
  }

  async receipts(): Promise<readonly Receipt[]> {
    return [...this.#receipts.values()];
  }
}
