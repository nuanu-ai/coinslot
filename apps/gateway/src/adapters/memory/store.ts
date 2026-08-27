/**
 * The store, in memory.
 *
 * This is not a stub for the real one: it is the adapter the whole of the
 * application logic is tested against, so it has to keep the same promises the
 * Postgres one does. Three of them are load-bearing and two are about
 * `withOrder`.
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
 *
 * The third is the scoping. Every read that names a merchant filters on it
 * here exactly as the Postgres adapter filters in SQL, and for the same reason:
 * this is the adapter the two-merchant tests run against, so a filter missing
 * here is a filter nothing would catch until somebody's catalog turned up in
 * somebody else's cabinet.
 */

import type { Card, Receipt } from "@coinslot/contracts";
import { isOpen, type MerchantSelling } from "@coinslot/core";
import type { Clock, Ids } from "../../ports/clock.js";
import type {
  CatalogEntry,
  MerchantScope,
  OrderChange,
  OrderLookup,
  PaymentClaim,
  Store,
  StoredCard,
  StoredKey,
  StoredMerchant,
  StoredOrder,
} from "../../ports/store.js";

/** What a merchant's row holds here, with the selling word that may move. */
interface MerchantRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  selling: MerchantSelling;
}

export class MemoryStore implements Store {
  readonly #merchants = new Map<string, MerchantRow>();
  /** Every key ever issued, by its identifier. The secrets are not here. */
  readonly #keys = new Map<string, StoredKey>();
  /** The digest of a key to the key it belongs to, which is how a door reads. */
  readonly #keysByDigest = new Map<string, string>();
  readonly #cards = new Map<string, StoredCard>();
  /**
   * A merchant's own key for a product, to the catalog identifier we issued.
   * The map key carries the merchant, because a merchant's identifier for a
   * product means something inside their catalog and nothing outside it.
   */
  readonly #cardIdByMerchantKey = new Map<string, string>();
  readonly #orders = new Map<string, StoredOrder>();
  readonly #receipts = new Map<string, { merchantId: string; receipt: Receipt }>();
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

  // --- merchants and their keys ---------------------------------------------

  async addMerchant(
    merchant: { readonly id: string; readonly name: string },
    at: number,
  ): Promise<StoredMerchant | null> {
    if (this.#merchants.has(merchant.id)) {
      return null;
    }
    const row: MerchantRow = {
      id: merchant.id,
      name: merchant.name,
      createdAt: at,
      selling: "open",
    };
    this.#merchants.set(merchant.id, row);
    return storedMerchantOf(row);
  }

  async merchantById(id: string): Promise<StoredMerchant | null> {
    const row = this.#merchants.get(id);
    return row === undefined ? null : storedMerchantOf(row);
  }

  async merchants(): Promise<readonly StoredMerchant[]> {
    return [...this.#merchants.values()].map(storedMerchantOf);
  }

  async addKey(
    key: {
      readonly id: string;
      readonly merchantId: string;
      readonly label: string;
      readonly digest: string;
    },
    at: number,
  ): Promise<StoredKey> {
    if (!this.#merchants.has(key.merchantId)) {
      // A key naming a merchant that is not there is a defect in whatever
      // asked for it, and the database refuses the same thing with a foreign
      // key. Written down here, it would be a key that opens a door onto
      // nothing.
      throw new Error(`there is no merchant ${key.merchantId} for a key to belong to`);
    }
    // Two keys under one identifier is a primary key violation in the database
    // and would be a silent overwrite here — one merchant's key replaced by
    // another's, with the first still in somebody's configuration and no longer
    // opening anything.
    if (this.#keys.has(key.id)) {
      throw new Error(`the key ${key.id} is already written down`);
    }
    if (this.#keysByDigest.has(key.digest)) {
      throw new Error(`a key with that digest is already written down`);
    }
    const stored: StoredKey = Object.freeze({
      id: key.id,
      merchantId: key.merchantId,
      label: key.label,
      createdAt: at,
      disabledAt: null,
    });
    this.#keys.set(stored.id, stored);
    this.#keysByDigest.set(key.digest, stored.id);
    return stored;
  }

  async merchantForKey(digest: string): Promise<string | null> {
    const keyId = this.#keysByDigest.get(digest);
    const key = keyId === undefined ? undefined : this.#keys.get(keyId);
    // A disabled key answers exactly what a key nobody issued answers.
    return key === undefined || key.disabledAt !== null ? null : key.merchantId;
  }

  async keyByDigest(digest: string): Promise<StoredKey | null> {
    const keyId = this.#keysByDigest.get(digest);
    return (keyId === undefined ? undefined : this.#keys.get(keyId)) ?? null;
  }

  async keysOf(merchantId: string): Promise<readonly StoredKey[]> {
    return [...this.#keys.values()].filter((key) => key.merchantId === merchantId);
  }

  async disableKey(id: string, at: number): Promise<StoredKey | null> {
    const found = this.#keys.get(id);
    if (found === undefined) {
      return null;
    }
    // The first revocation is the true one; a repeat does not move it.
    const stored: StoredKey = Object.freeze({ ...found, disabledAt: found.disabledAt ?? at });
    this.#keys.set(id, stored);
    return stored;
  }

  // --- the catalog ----------------------------------------------------------

  async publishCard(merchantId: string, card: Card, at: number): Promise<StoredCard> {
    // Republishing under the same merchant key changes the card that is there
    // rather than adding a second one, which is what the portal promises and
    // why the catalog identifier survives the edit.
    const owned = catalogKey(merchantId, card.merchant_item_id);
    const existing = this.#cardIdByMerchantKey.get(owned);
    const id = existing ?? this.#ids("item");
    // A pause survives the edit. A merchant changing a price is not asking for
    // a product they took off sale to go back on it.
    const paused = existing === undefined ? false : (this.#cards.get(existing)?.paused ?? false);
    const stored: StoredCard = Object.freeze({ id, merchantId, card, asOf: at, paused });

    this.#cardIdByMerchantKey.set(owned, id);
    this.#cards.set(id, stored);
    return stored;
  }

  async cardById(id: string): Promise<StoredCard | null> {
    return this.#cards.get(id) ?? null;
  }

  async cards(merchantId: string): Promise<readonly StoredCard[]> {
    return [...this.#cards.values()].filter((card) => card.merchantId === merchantId);
  }

  async catalogEntries(): Promise<readonly CatalogEntry[]> {
    return [...this.#cards.values()].map((card) => ({
      card,
      merchant: this.#sellingOf(card.merchantId),
    }));
  }

  async setCardPaused(merchantId: string, id: string, paused: boolean): Promise<StoredCard | null> {
    const found = this.#cards.get(id);
    // Another merchant's card is not found, which is the same answer as a card
    // that is not there: pausing is not a way of discovering what exists.
    if (found === undefined || found.merchantId !== merchantId) {
      return null;
    }
    const stored: StoredCard = Object.freeze({ ...found, paused });
    this.#cards.set(id, stored);
    return stored;
  }

  async selling(merchantId: string): Promise<MerchantSelling> {
    return this.#sellingOf(merchantId);
  }

  async setSelling(merchantId: string, selling: MerchantSelling): Promise<void> {
    const row = this.#merchants.get(merchantId);
    if (row === undefined) {
      throw new Error(`there is no merchant ${merchantId} to stop or start selling`);
    }
    row.selling = selling;
  }

  // --- orders ---------------------------------------------------------------

  async addOrder(record: StoredOrder): Promise<void> {
    if (this.#orders.has(record.order.id)) {
      throw new Error(`the order ${record.order.id} is already written down`);
    }
    this.#orders.set(record.order.id, Object.freeze({ ...record }));
  }

  async orderById(id: string): Promise<StoredOrder | null> {
    return this.#orders.get(id) ?? null;
  }

  async merchantOrder(merchantId: string, id: string): Promise<StoredOrder | null> {
    const found = this.#orders.get(id);
    return found === undefined || found.merchantId !== merchantId ? null : found;
  }

  async orders(
    merchantId: string,
    query?: { readonly open?: boolean },
  ): Promise<readonly StoredOrder[]> {
    const mine = [...this.#orders.values()].filter((record) => record.merchantId === merchantId);
    return query?.open === true ? mine.filter((record) => isOpen(record.order.state)) : mine;
  }

  async withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
    scope?: MerchantScope,
  ): Promise<OrderLookup<T>> {
    // Each order's decisions run one after another. The tail of the chain is
    // kept rather than the head, so an order nobody is currently deciding about
    // costs one settled promise and not a walk through everything that ever
    // happened to it.
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const mine = previous.then(async (): Promise<OrderLookup<T>> => {
      const found = this.#orders.get(id);
      // The ownership is read under the same hold as everything else, so a
      // merchant's call can never move a stranger's order and there is no
      // window between learning whose it is and acting on it.
      if (found === undefined || (scope !== undefined && found.merchantId !== scope.merchantId)) {
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

  // --- payments -------------------------------------------------------------

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

  // --- receipts -------------------------------------------------------------

  async putReceipt(merchantId: string, receipt: Receipt): Promise<void> {
    this.#receipts.set(receipt.order_id, { merchantId, receipt: Object.freeze({ ...receipt }) });
  }

  async receiptForOrder(orderId: string): Promise<Receipt | null> {
    return this.#receipts.get(orderId)?.receipt ?? null;
  }

  async receipts(merchantId: string): Promise<readonly Receipt[]> {
    return [...this.#receipts.values()]
      .filter((held) => held.merchantId === merchantId)
      .map((held) => held.receipt);
  }

  /**
   * The word one merchant is selling under.
   *
   * A merchant that is not there at all is a defect rather than a case: every
   * key names a merchant that exists, and every card and order carries one. It
   * throws instead of answering "open", because answering would be selling on
   * behalf of somebody nobody can find.
   */
  #sellingOf(merchantId: string): MerchantSelling {
    const row = this.#merchants.get(merchantId);
    if (row === undefined) {
      throw new Error(`there is no merchant ${merchantId}, so there is no word for their selling`);
    }
    return row.selling;
  }
}

/** A merchant's own identifier for a product, inside the merchant it belongs to. */
function catalogKey(merchantId: string, merchantItemId: string): string {
  // A separator neither half can carry. The identifier a merchant uses for a
  // product may hold a space and a slash — "SKU 100/1" is one of the contract's
  // own examples — so joining on anything printable is a way for two different
  // pairs to come out as the one string.
  return `${merchantId}\u0000${merchantItemId}`;
}

function storedMerchantOf(row: MerchantRow): StoredMerchant {
  return { id: row.id, name: row.name, selling: row.selling, createdAt: row.createdAt };
}
