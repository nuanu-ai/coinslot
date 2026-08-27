/**
 * The store, on one Postgres, through drizzle (ADR-0003 §6).
 *
 * It keeps the same promises the in-memory adapter does, and one of them is the
 * only reason this is not a set of four queries. `withOrder` holds an order
 * still while a decision is made about it, and here that hold is a row lock
 * inside a transaction — `select ... for update` — so two events about one
 * order queue up in the database rather than racing through it. The in-memory
 * adapter gets the same guarantee from a chain of promises, which is what the
 * same thing looks like in one process.
 *
 * The hold is per order and not over the table: two different orders never wait
 * for each other, because two different rows are two different locks.
 *
 * The scoping is the other thing worth reading before a query here is changed.
 * Every read a merchant makes carries `merchant_id` in its predicate, so a row
 * belonging to somebody else is not filtered out after the fact — it is never
 * selected, which is also what makes "not yours" and "not there" the same
 * answer from where the caller stands.
 */

import type { Card, Receipt } from "@coinslot/contracts";
import { isOpen, MERCHANT_SELLING, type MerchantSelling } from "@coinslot/core";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Ids } from "../../ports/clock.js";
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
import { cards, merchantKeys, merchants, orders, paymentClaims, receipts } from "./schema.js";

export class PostgresStore implements Store {
  readonly #db: NodePgDatabase;
  readonly #ids: Ids;

  constructor(db: NodePgDatabase, ids: Ids) {
    this.#db = db;
    this.#ids = ids;
  }

  // --- merchants and their keys ---------------------------------------------

  async addMerchant(
    merchant: { readonly id: string; readonly name: string },
    at: number,
  ): Promise<StoredMerchant | null> {
    // A merchant nobody has paused is selling, which is what a new row says.
    const [row] = await this.#db
      .insert(merchants)
      .values({
        id: merchant.id,
        name: merchant.name,
        selling: "open",
        createdAt: new Date(at),
        updatedAt: new Date(at),
      })
      .onConflictDoNothing({ target: merchants.id })
      .returning();
    // Nothing came back: the identifier is taken, and this wrote nothing over
    // whatever was there. The one caller is a command somebody typed twice.
    return row === undefined ? null : storedMerchantOf(row);
  }

  async merchantById(id: string): Promise<StoredMerchant | null> {
    const [row] = await this.#db.select().from(merchants).where(eq(merchants.id, id)).limit(1);
    return row === undefined ? null : storedMerchantOf(row);
  }

  async merchants(): Promise<readonly StoredMerchant[]> {
    const rows = await this.#db.select().from(merchants).orderBy(merchants.createdAt);
    return rows.map(storedMerchantOf);
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
    // A key naming a merchant that is not there is refused by the foreign key
    // rather than written: a key that opens a door onto nothing is worse than
    // a command that failed.
    const [row] = await this.#db
      .insert(merchantKeys)
      .values({
        id: key.id,
        merchantId: key.merchantId,
        label: key.label,
        digest: key.digest,
        createdAt: new Date(at),
      })
      .returning();

    if (row === undefined) {
      throw new Error(`issuing a key for ${key.merchantId} wrote no row`);
    }
    return storedKeyOf(row);
  }

  async merchantForKey(digest: string): Promise<string | null> {
    // The disabled ones are excluded in the predicate rather than read back and
    // checked, so there is one answer and one shape of answer for every key
    // that does not open the door — never issued and revoked alike.
    const [row] = await this.#db
      .select({ merchantId: merchantKeys.merchantId })
      .from(merchantKeys)
      .where(and(eq(merchantKeys.digest, digest), isNull(merchantKeys.disabledAt)))
      .limit(1);
    return row?.merchantId ?? null;
  }

  async keyByDigest(digest: string): Promise<StoredKey | null> {
    const [row] = await this.#db
      .select()
      .from(merchantKeys)
      .where(eq(merchantKeys.digest, digest))
      .limit(1);
    return row === undefined ? null : storedKeyOf(row);
  }

  async keysOf(merchantId: string): Promise<readonly StoredKey[]> {
    const rows = await this.#db
      .select()
      .from(merchantKeys)
      .where(eq(merchantKeys.merchantId, merchantId))
      .orderBy(merchantKeys.createdAt);
    return rows.map(storedKeyOf);
  }

  async disableKey(id: string, at: number): Promise<StoredKey | null> {
    const [row] = await this.#db
      .update(merchantKeys)
      // The first revocation is the true one. Written as a plain assignment, a
      // second run of the command would move the instant somebody is
      // reconstructing an incident from.
      .set({ disabledAt: sql`coalesce(${merchantKeys.disabledAt}, ${new Date(at)})` })
      .where(eq(merchantKeys.id, id))
      .returning();
    return row === undefined ? null : storedKeyOf(row);
  }

  // --- the catalog ----------------------------------------------------------

  async publishCard(merchantId: string, card: Card, at: number): Promise<StoredCard> {
    // Republishing under the same merchant key changes the card that is there.
    // The insert names the identifier it would use, and the conflict clause is
    // what keeps the existing one instead — so a card that is already there
    // never changes the address agents already hold.
    const [row] = await this.#db
      .insert(cards)
      .values({
        id: this.#ids("item"),
        merchantId,
        merchantItemId: card.merchant_item_id,
        card,
        asOf: new Date(at),
      })
      .onConflictDoUpdate({
        // The merchant is half of the target, so a publish only ever edits the
        // publisher's own card. Targeting the identifier alone would hand the
        // second merchant to use a "sku-1" the first merchant's card.
        target: [cards.merchantId, cards.merchantItemId],
        // `paused` is deliberately not in this set. A merchant editing a price
        // is not asking for a product they took off sale to go back on it, and
        // a pause that evaporated on the next publish would put stock they do
        // not have in front of an agent.
        set: { card, asOf: new Date(at) },
      })
      .returning();

    if (row === undefined) {
      throw new Error(`publishing ${card.merchant_item_id} wrote no row`);
    }
    return storedCardOf(row);
  }

  async cardById(id: string): Promise<StoredCard | null> {
    const [row] = await this.#db.select().from(cards).where(eq(cards.id, id)).limit(1);
    return row === undefined ? null : storedCardOf(row);
  }

  async cards(merchantId: string): Promise<readonly StoredCard[]> {
    const rows = await this.#db
      .select()
      .from(cards)
      .where(eq(cards.merchantId, merchantId))
      .orderBy(cards.asOf);
    return rows.map(storedCardOf);
  }

  async catalogEntries(): Promise<readonly CatalogEntry[]> {
    // One statement rather than the cards and then a word per merchant: the
    // catalog is read on every agent's first call, and a query per merchant
    // behind it grows with the number of merchants for no reason.
    const rows = await this.#db
      .select({ card: cards, selling: merchants.selling })
      .from(cards)
      .innerJoin(merchants, eq(cards.merchantId, merchants.id))
      .orderBy(cards.asOf);
    return rows.map((row) => ({
      card: storedCardOf(row.card),
      merchant: sellingWordOf(row.selling),
    }));
  }

  async setCardPaused(merchantId: string, id: string, paused: boolean): Promise<StoredCard | null> {
    const [row] = await this.#db
      .update(cards)
      .set({ paused })
      // Both halves in the predicate: another merchant's card is not updated
      // and not reported, so this answers exactly what a card that is not there
      // answers.
      .where(and(eq(cards.id, id), eq(cards.merchantId, merchantId)))
      .returning();
    return row === undefined ? null : storedCardOf(row);
  }

  async selling(merchantId: string): Promise<MerchantSelling> {
    const [row] = await this.#db
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);

    if (row === undefined) {
      // Every key names a merchant that exists and every card carries one, so
      // there is no ordinary way here. Answering "open" would be selling on
      // behalf of somebody nobody can find.
      throw new Error(
        `there is no merchant ${merchantId}, so there is no word for whether they are selling`,
      );
    }
    return sellingWordOf(row.selling);
  }

  async setSelling(merchantId: string, selling: MerchantSelling): Promise<void> {
    const changed = await this.#db
      .update(merchants)
      .set({ selling, updatedAt: sql`now()` })
      .where(eq(merchants.id, merchantId))
      .returning({ id: merchants.id });

    if (changed.length === 0) {
      throw new Error(`there is no merchant ${merchantId} to stop or start selling`);
    }
  }

  // --- orders ---------------------------------------------------------------

  async addOrder(record: StoredOrder): Promise<void> {
    await this.#db.insert(orders).values(rowFor(record));
  }

  async orderById(id: string): Promise<StoredOrder | null> {
    const [row] = await this.#db.select().from(orders).where(eq(orders.id, id)).limit(1);
    return row?.record ?? null;
  }

  async merchantOrder(merchantId: string, id: string): Promise<StoredOrder | null> {
    const [row] = await this.#db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.merchantId, merchantId)))
      .limit(1);
    return row?.record ?? null;
  }

  async orders(
    merchantId: string,
    query?: { readonly open?: boolean },
  ): Promise<readonly StoredOrder[]> {
    const mine = eq(orders.merchantId, merchantId);
    const rows = await this.#db
      .select()
      .from(orders)
      .where(query?.open === true ? and(mine, eq(orders.open, true)) : mine)
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
    scope?: MerchantScope,
  ): Promise<OrderLookup<T>> {
    return this.#db.transaction(async (tx) => {
      // The lock is taken on the row itself, so a second decision about this
      // order waits here rather than reading the same order and writing over
      // whatever the first one decided. Where a merchant is named, whose order
      // it is is part of the same predicate as the lock: a stranger's order is
      // never selected, never locked and never reported, so there is no window
      // between finding out whose it is and acting on it.
      const [row] = await tx
        .select()
        .from(orders)
        .where(
          scope === undefined
            ? eq(orders.id, id)
            : and(eq(orders.id, id), eq(orders.merchantId, scope.merchantId)),
        )
        .limit(1)
        .for("update");

      if (row === undefined) {
        return { found: false };
      }

      const decided = await change(row.record);
      if (decided.save !== undefined) {
        // The merchant is taken from the row rather than from what came back.
        // It is settled at the birth of an order and never again, and this is
        // where that is actually kept: a save carrying a different one would
        // otherwise write the new merchant into the document while the column
        // — which every one of a merchant's own reads filters on — kept the
        // old. The two readers would then disagree, and the split is exactly
        // the one that puts an order in one merchant's list while its envelopes
        // go on another's stream.
        const next = rowFor({ ...decided.save, merchantId: row.merchantId });
        await tx
          .update(orders)
          .set({
            state: next.state,
            open: next.open,
            record: next.record,
            updatedAt: next.updatedAt,
          })
          .where(eq(orders.id, id));
      }
      return { found: true, result: decided.result };
    });
  }

  async claimPayment(fingerprint: string, orderId: string): Promise<PaymentClaim> {
    // One statement, and the primary key is the decision. Two requests
    // presenting the same payment at the same instant both arrive here and the
    // database picks between them; the loser's conflict clause writes the
    // holder's own identifier back over itself, so what comes out is the row
    // that stands either way. Doing it as an insert and then a read would leave
    // a gap between the two, and a branch for a row that vanished in it — a
    // branch nothing could ever reach or test.
    const [row] = await this.#db
      .insert(paymentClaims)
      .values({ fingerprint, orderId, claimedAt: new Date() })
      .onConflictDoUpdate({
        target: paymentClaims.fingerprint,
        set: { orderId: sql`${paymentClaims.orderId}` },
      })
      .returning();

    if (row === undefined) {
      throw new Error(`claiming a payment for ${orderId} wrote and read no row`);
    }
    // The same order presenting the same payment again is the ordinary retry
    // the portal promises is safe, and it still owns it.
    return row.orderId === orderId ? { claimed: true } : { claimed: false, heldBy: row.orderId };
  }

  async releaseClaim(fingerprint: string, orderId: string): Promise<void> {
    // Both halves of the key in the predicate, so a fingerprint another order
    // holds is left where it is even if this one asks for it by mistake.
    await this.#db
      .delete(paymentClaims)
      .where(and(eq(paymentClaims.fingerprint, fingerprint), eq(paymentClaims.orderId, orderId)));
  }

  async forgetClaimsBefore(instant: number): Promise<number> {
    const gone = await this.#db
      .delete(paymentClaims)
      .where(lt(paymentClaims.claimedAt, new Date(instant)))
      .returning({ fingerprint: paymentClaims.fingerprint });
    return gone.length;
  }

  // --- receipts -------------------------------------------------------------

  async putReceipt(merchantId: string, receipt: Receipt): Promise<void> {
    await this.#db
      .insert(receipts)
      .values({ orderId: receipt.order_id, merchantId, receipt, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: receipts.orderId,
        // The merchant is not in this set. A receipt belongs to whoever made
        // the sale, and writing it again — which is what the machine does when
        // an order moves on — is not an occasion for it to change hands.
        set: { receipt, updatedAt: sql`now()` },
      });
  }

  async receiptForOrder(orderId: string): Promise<Receipt | null> {
    const [row] = await this.#db
      .select()
      .from(receipts)
      .where(eq(receipts.orderId, orderId))
      .limit(1);
    return row?.receipt ?? null;
  }

  async receipts(merchantId: string): Promise<readonly Receipt[]> {
    const rows = await this.#db
      .select()
      .from(receipts)
      .where(eq(receipts.merchantId, merchantId))
      .orderBy(receipts.updatedAt);
    return rows.map((row) => row.receipt);
  }
}

/** One card row as the rest of the gateway reads it. */
function storedCardOf(row: {
  id: string;
  merchantId: string;
  card: Card;
  asOf: Date;
  paused: boolean;
}): StoredCard {
  return {
    id: row.id,
    merchantId: row.merchantId,
    card: row.card,
    asOf: row.asOf.getTime(),
    paused: row.paused,
  };
}

/** One merchant row as the rest of the gateway reads it. */
function storedMerchantOf(row: {
  id: string;
  name: string;
  selling: string;
  createdAt: Date;
}): StoredMerchant {
  return {
    id: row.id,
    name: row.name,
    selling: sellingWordOf(row.selling),
    createdAt: row.createdAt.getTime(),
  };
}

/** One key row as the rest of the gateway reads it. The digest stays behind. */
function storedKeyOf(row: {
  id: string;
  merchantId: string;
  label: string;
  createdAt: Date;
  disabledAt: Date | null;
}): StoredKey {
  return {
    id: row.id,
    merchantId: row.merchantId,
    label: row.label,
    createdAt: row.createdAt.getTime(),
    disabledAt: row.disabledAt === null ? null : row.disabledAt.getTime(),
  };
}

/**
 * The selling word out of a text column, or a refusal.
 *
 * A word the machine does not know reached the column — a hand-edited row, or a
 * value from a version of this code that is not this one. Guessing here would
 * be guessing about whether somebody is selling.
 */
function sellingWordOf(word: string): MerchantSelling {
  if (!(MERCHANT_SELLING as readonly string[]).includes(word)) {
    throw new Error(
      `the merchant's selling state is "${word}", which is not one of ${MERCHANT_SELLING.join(", ")}`,
    );
  }
  return word as MerchantSelling;
}

/** The columns, written from the document so they cannot disagree with it. */
function rowFor(record: StoredOrder) {
  return {
    id: record.order.id,
    state: record.order.state,
    open: isOpen(record.order.state),
    merchantId: record.merchantId,
    itemId: record.itemId,
    merchantItemId: record.merchantItemId,
    record,
    createdAt: new Date(record.order.timestamps.createdAt),
    updatedAt: new Date(),
  };
}

/**
 * One pool for the process, and the drizzle handle over it.
 *
 * The pool is an event emitter that reports failures of idle connections, and
 * an unhandled one of those is an uncaught exception and a dead process. That
 * matters more here than in most services: every parked purchase and every
 * parked worker lives in this process's memory, so a database hiccup that
 * killed it would drop every agent mid-purchase rather than degrading anything.
 * It is logged and the pool goes on; a failure that actually stops the work
 * surfaces on the next query, where somebody is waiting for an answer.
 */
export function connect(databaseUrl: string): { db: NodePgDatabase; pool: Pool } {
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", (error) => {
    console.error("[gateway] an idle database connection failed", error);
  });
  return { db: drizzle(pool), pool };
}
