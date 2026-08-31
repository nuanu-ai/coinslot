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

import { isOpen, type MerchantSelling } from "@coinslot/core";
import type { Card, Receipt, WorkerEnvelope } from "@nuanu-ai/coinslot-contracts";
import type { Clock, Ids } from "../../ports/clock.js";
import type {
  CatalogEntry,
  KeyPurpose,
  MerchantScope,
  OrderChange,
  OrderLookup,
  PaymentClaim,
  Ran,
  Store,
  StoredCard,
  StoredKey,
  StoredMerchant,
  StoredOrder,
  WithTheOrder,
} from "../../ports/store.js";

/**
 * Where this store puts an envelope that has to be written with an order.
 *
 * It is in two halves for the same reason the Postgres adapter's is. Taking the
 * envelope can refuse, and it does so here, before anything about the order is
 * written; putting it where a worker can reach it happens in the call this
 * hands back, after the order is written. In a deployment the two halves are
 * one transaction and the database provides both properties at once. Here they
 * are two maps in one process, and the ordering is what stands in for it.
 *
 * One half without the other is a real failure rather than a nicety. Taking it
 * after the order is written leaves a record saying something happened when
 * nothing did. Making it visible before means a worker can be handed an
 * envelope for a change to an order that is not written down yet — and while an
 * order envelope is safe there, because acting on one comes back through the
 * store's own hold, a merchant event is not: the poll hands one over without
 * touching the order at all.
 */
export type Envelopes = (
  merchantId: string,
  envelope: WorkerEnvelope,
  afterMs?: number,
) => Promise<() => void>;

/**
 * The answer for a store that was built without one.
 *
 * Most of the stores made in this repository serve a command somebody typed or
 * a test about the catalog, and none of those ever writes an order. Refusing
 * out loud is the alternative to a store that quietly drops a merchant's work.
 */
const noEnvelopes: Envelopes = async (_merchantId, envelope) => {
  throw new Error(
    `this store was built with nowhere to put the envelope ${envelope.id}: a store that writes orders is given a stream`,
  );
};

/** What a merchant's row holds here, with the selling word that may move. */
interface MerchantRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  selling: MerchantSelling;
  /** The name this seller is listed under in a catalog, where one is named. */
  serviceName: string | null;
  /** Where this merchant's sales are paid, as a wallet writes it, where one is set. */
  payoutWallet: string | null;
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
  /** Work being run alone right now, by the name it was asked for under. */
  readonly #running = new Set<string>();
  readonly #ids: Ids;
  readonly #now: Clock;
  readonly #envelopes: Envelopes;

  constructor(ids: Ids, now: Clock = () => Date.now(), envelopes: Envelopes = noEnvelopes) {
    this.#ids = ids;
    this.#now = now;
    this.#envelopes = envelopes;
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
      serviceName: null,
      payoutWallet: null,
    };
    this.#merchants.set(merchant.id, row);
    return storedMerchantOf(row);
  }

  async registerMerchant(
    merchant: { readonly id: string; readonly name: string },
    key: { readonly id: string; readonly label: string; readonly digest: string },
    at: number,
  ): Promise<{ merchant: StoredMerchant; key: StoredKey } | null> {
    if (this.#merchants.has(merchant.id)) {
      return null;
    }
    // Listed under nothing and paid nowhere, exactly as a merchant made at a
    // terminal is. Both are chosen afterwards, and until they are, this
    // merchant publishes nothing.
    const row: MerchantRow = {
      id: merchant.id,
      name: merchant.name,
      createdAt: at,
      selling: "open",
      serviceName: null,
      payoutWallet: null,
    };
    this.#merchants.set(merchant.id, row);

    // Nothing is awaited between the two writes, so in one process this is what
    // the database's transaction is over there: no other decision can run in
    // between and find a merchant with no key. The undo is still needed for the
    // one thing that can go wrong inside the second write — a digest already
    // taken — because a merchant left behind by that has a generated identifier
    // nobody holds and no way in.
    try {
      const stored = this.#writeKey({ ...key, merchantId: merchant.id, purpose: "cabinet" }, at);
      return { merchant: storedMerchantOf(row), key: stored };
    } catch (thrown) {
      this.#merchants.delete(merchant.id);
      throw thrown;
    }
  }

  async merchantById(id: string): Promise<StoredMerchant | null> {
    const row = this.#merchants.get(id);
    return row === undefined ? null : storedMerchantOf(row);
  }

  async merchants(): Promise<readonly StoredMerchant[]> {
    return [...this.#merchants.values()].map(storedMerchantOf);
  }

  async setServiceName(
    id: string,
    serviceName: string | null,
    _at: number,
  ): Promise<StoredMerchant | null> {
    const row = this.#merchants.get(id);
    if (row === undefined) {
      return null;
    }
    row.serviceName = serviceName;
    return storedMerchantOf(row);
  }

  async setPayoutWallet(
    id: string,
    payoutWallet: string,
    _at: number,
  ): Promise<StoredMerchant | null> {
    const row = this.#merchants.get(id);
    if (row === undefined) {
      return null;
    }
    row.payoutWallet = payoutWallet;
    return storedMerchantOf(row);
  }

  async addKey(
    key: {
      readonly id: string;
      readonly merchantId: string;
      readonly label: string;
      readonly digest: string;
      readonly purpose: KeyPurpose;
    },
    at: number,
  ): Promise<StoredKey> {
    return this.#writeKey(key, at);
  }

  /**
   * The key write itself, without a promise around it.
   *
   * It is separate so that registering can write a merchant and a key with
   * nothing awaited in between, which is what makes the two land together in
   * one process. Called through `addKey` everywhere else.
   */
  #writeKey(
    key: {
      readonly id: string;
      readonly merchantId: string;
      readonly label: string;
      readonly digest: string;
      readonly purpose: KeyPurpose;
    },
    at: number,
  ): StoredKey {
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
      purpose: key.purpose,
      createdAt: at,
      disabledAt: null,
      lastUsedAt: null,
    });
    this.#keys.set(stored.id, stored);
    this.#keysByDigest.set(key.digest, stored.id);
    return stored;
  }

  async noteKeyUse(id: string, at: number): Promise<void> {
    const found = this.#keys.get(id);
    if (found === undefined) {
      // Revoked or forgotten between the door reading it and this being
      // written. Nothing is owed to a row that is not there.
      return;
    }
    if (found.lastUsedAt !== null && found.lastUsedAt >= at) {
      // An older call arriving after a newer one, which two gateways on two
      // clocks produce. The mark goes forwards or it stays.
      return;
    }
    this.#keys.set(found.id, Object.freeze({ ...found, lastUsedAt: at }));
  }

  async workingKey(digest: string): Promise<StoredKey | null> {
    const keyId = this.#keysByDigest.get(digest);
    const key = keyId === undefined ? undefined : this.#keys.get(keyId);
    // A disabled key answers exactly what a key nobody issued answers.
    return key === undefined || key.disabledAt !== null ? null : key;
  }

  async keyByDigest(digest: string): Promise<StoredKey | null> {
    const keyId = this.#keysByDigest.get(digest);
    return (keyId === undefined ? undefined : this.#keys.get(keyId)) ?? null;
  }

  async keysOf(merchantId: string): Promise<readonly StoredKey[]> {
    // Sorted rather than left in the order the map holds them, so that this
    // answers with what the database answers with. The two agreeing is what
    // makes a test about a merchant's list of keys mean the same thing in both
    // places; left to insertion order, this one would pass on an assertion the
    // other fails whenever two keys share an instant.
    return [...this.#keys.values()]
      .filter((key) => key.merchantId === merchantId)
      .sort((one, other) => one.createdAt - other.createdAt || (one.id < other.id ? -1 : 1));
  }

  async codeKeysOf(merchantId: string): Promise<readonly StoredKey[]> {
    // Read through the wide list rather than filtering the map again, so the
    // two answer in one order and a change to that order cannot reach one of
    // them and not the other.
    return (await this.keysOf(merchantId)).filter((key) => key.purpose === "merchant_code");
  }

  async forgetCabinetKey(keyId: string): Promise<boolean> {
    const going = this.#keys.get(keyId);
    if (going === undefined || going.purpose !== "cabinet") {
      return false;
    }
    this.#keys.delete(going.id);
    // The digest goes with it. Left behind, it would be an entry pointing at a
    // key that is not there — which reads as nothing at the door, but is a
    // digest nothing can ever write again, since writing one refuses a digest
    // already taken.
    for (const [digest, id] of this.#keysByDigest) {
      if (id === going.id) {
        this.#keysByDigest.delete(digest);
      }
    }
    return true;
  }

  async disableKey(id: string, at: number): Promise<StoredKey | null> {
    const found = this.#keys.get(id);
    return found === undefined ? null : this.#revoke(found, at);
  }

  async disableKeyOf(
    merchantId: string,
    id: string,
    at: number,
  ): Promise<StoredKey | "made_for_a_cabinet" | null> {
    const found = this.#keys.get(id);
    // Another merchant's key is not found rather than refused, which is what
    // makes a refusal say nothing about whose keys exist. Postgres does the same
    // thing with a predicate; here it is this line.
    if (found === undefined || found.merchantId !== merchantId) {
      return null;
    }
    // Their own key, and not one they made. Told apart from the null above
    // because this one is a fact about their own row, and because revoking it
    // would sign somebody out of the cabinet they are standing in.
    if (found.purpose !== "merchant_code") {
      return "made_for_a_cabinet";
    }
    return this.#revoke(found, at);
  }

  /** The write both of them make. The first revocation is the true one. */
  #revoke(found: StoredKey, at: number): StoredKey {
    const stored: StoredKey = Object.freeze({ ...found, disabledAt: found.disabledAt ?? at });
    this.#keys.set(found.id, stored);
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
      payoutWallet: this.#merchants.get(card.merchantId)?.payoutWallet ?? null,
      serviceName: this.#merchants.get(card.merchantId)?.serviceName ?? null,
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

      // Three steps, and the Postgres adapter gets all three from one
      // transaction. Everything that has to go with the order is taken first,
      // so anything that would refuse refuses before a word about the order is
      // written; then the order is written; then what was taken becomes visible
      // to anybody else. Both other orderings are wrong, and differently: doing
      // it all after the order leaves a record saying something happened when
      // nothing did, and making it visible before the order lets a worker be
      // handed an envelope for a change that is not written down.
      //
      // That last one is why this is three steps and not two. An order envelope
      // would have been safe either way, because acting on one comes back
      // through this very hold; a merchant event would not, because the poll
      // hands one over without touching the order at all.
      // The envelopes are taken before the receipts, and the order is the whole
      // of what makes a half-written list impossible here. Taking an envelope
      // is the step that can refuse; writing a receipt is a map that cannot. So
      // with the envelopes first, anything that refuses does so while nothing
      // at all has been written, and a list is either wholly taken or wholly
      // not. Reversed, a receipt would already be written when the envelope
      // beside it refused, and this adapter would keep a promise the Postgres
      // one keeps and the port makes.
      const alongside = [...(decided.alongside ?? [])].sort(
        (one, other) => rankOf(one) - rankOf(other),
      );
      const arrivals: (() => void)[] = [];
      for (const write of alongside) {
        arrivals.push(await this.#takeWithTheOrder(write));
      }

      if (decided.save !== undefined) {
        // The merchant comes from the order that was read and not from the
        // save, exactly as the Postgres adapter takes it from the row: a sale
        // belongs to whoever made it, settled at the birth of the order and
        // never again. There the column would have kept the old merchant while
        // the document took the new one, and the two readers would disagree
        // about whose order it is; here it would simply change hands. Neither
        // is a thing a decision about an order gets to do.
        this.#orders.set(id, Object.freeze({ ...decided.save, merchantId: found.merchantId }));
      }

      // Written down: what was taken above is now somebody else's to see. None
      // of these can refuse, which is what makes the order safe to have written.
      for (const arrive of arrivals) {
        arrive();
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

  async openOrders(): Promise<readonly StoredOrder[]> {
    return [...this.#orders.values()].filter((record) => isOpen(record.order.state));
  }

  async runAlone<T>(name: string, work: () => Promise<T>): Promise<Ran<T>> {
    // One process, so a name held in memory is the same guarantee the advisory
    // lock gives across several. It is taken before anything is awaited, which
    // is what makes it a lock at all here: two callers starting in the same
    // turn both reach this line before either yields.
    if (this.#running.has(name)) {
      return { ran: false };
    }
    this.#running.add(name);
    try {
      return { ran: true, result: await work() };
    } finally {
      // Let go however it ended. Work that threw is work nobody is doing.
      this.#running.delete(name);
    }
  }

  async deliveredWithoutReceipt(): Promise<readonly StoredOrder[]> {
    return [...this.#orders.values()].filter(
      (record) => record.order.state === "delivered" && !this.#receipts.has(record.order.id),
    );
  }

  /**
   * Takes one write that goes with an order, and hands back the call that makes
   * it visible.
   *
   * A receipt is visible the moment it is written rather than held back with
   * the envelopes, and the reason is narrow: writing it is the step that cannot
   * refuse, so holding it would buy nothing against a half-written list. What
   * it costs is a window — a microtask, between this and the order being
   * written — in which somebody asking for the receipt of an order would be
   * handed one saying `delivered` while the order still says otherwise. Nothing
   * looks: a receipt is read by the agent's answer to its own purchase and by a
   * merchant's list, both of which arrive long afterwards, and neither is woken
   * by a receipt appearing. It is a smaller window than the alternative and not
   * a closed one.
   *
   * It goes through the store's own method rather than into the map behind its
   * back, so there is one place a receipt is written and one rule about whose
   * it is.
   */
  async #takeWithTheOrder(write: WithTheOrder): Promise<() => void> {
    if (write.kind === "receipt") {
      await this.putReceipt(write.merchantId, write.receipt);
      return () => {};
    }
    return this.#envelopes(write.merchantId, write.envelope, write.afterMs);
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
    // The merchant is written once and never again. The machine writes a
    // receipt again as an order moves on, and that is not an occasion for the
    // sale to belong to somebody else — the Postgres adapter leaves the column
    // out of its upsert for the same reason, and the two have to agree.
    const held = this.#receipts.get(receipt.order_id);
    this.#receipts.set(receipt.order_id, {
      merchantId: held?.merchantId ?? merchantId,
      receipt: Object.freeze({ ...receipt }),
    });
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

/**
 * Which of the writes that go with an order is taken first: the ones that can
 * refuse, before the ones that cannot.
 */
function rankOf(write: WithTheOrder): number {
  return write.kind === "envelope" ? 0 : 1;
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
  return {
    id: row.id,
    name: row.name,
    serviceName: row.serviceName,
    payoutWallet: row.payoutWallet,
    selling: row.selling,
    createdAt: row.createdAt,
  };
}
