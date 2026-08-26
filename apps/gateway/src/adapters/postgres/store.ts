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
 */

import type { Card, Receipt } from "@coinslot/contracts";
import { isOpen } from "@coinslot/core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Ids } from "../../ports/clock.js";
import type {
  OrderChange,
  OrderLookup,
  PaymentClaim,
  Store,
  StoredCard,
  StoredOrder,
} from "../../ports/store.js";
import { cards, orders, paymentClaims, receipts } from "./schema.js";

export class PostgresStore implements Store {
  readonly #db: NodePgDatabase;
  readonly #ids: Ids;

  constructor(db: NodePgDatabase, ids: Ids) {
    this.#db = db;
    this.#ids = ids;
  }

  async publishCard(card: Card, at: number): Promise<StoredCard> {
    // Republishing under the same merchant key changes the card that is there.
    // The insert names the identifier it would use, and the conflict clause is
    // what keeps the existing one instead — so a card that is already there
    // never changes the address agents already hold.
    const [row] = await this.#db
      .insert(cards)
      .values({
        id: this.#ids("item"),
        merchantItemId: card.merchant_item_id,
        card,
        asOf: new Date(at),
      })
      .onConflictDoUpdate({
        target: cards.merchantItemId,
        set: { card, asOf: new Date(at) },
      })
      .returning();

    if (row === undefined) {
      throw new Error(`publishing ${card.merchant_item_id} wrote no row`);
    }
    return { id: row.id, card: row.card, asOf: row.asOf.getTime() };
  }

  async cardById(id: string): Promise<StoredCard | null> {
    const [row] = await this.#db.select().from(cards).where(eq(cards.id, id)).limit(1);
    return row === undefined ? null : { id: row.id, card: row.card, asOf: row.asOf.getTime() };
  }

  async cards(): Promise<readonly StoredCard[]> {
    const rows = await this.#db.select().from(cards).orderBy(cards.asOf);
    return rows.map((row) => ({ id: row.id, card: row.card, asOf: row.asOf.getTime() }));
  }

  async addOrder(record: StoredOrder): Promise<void> {
    await this.#db.insert(orders).values(rowFor(record));
  }

  async orderById(id: string): Promise<StoredOrder | null> {
    const [row] = await this.#db.select().from(orders).where(eq(orders.id, id)).limit(1);
    return row?.record ?? null;
  }

  async orders(query?: { readonly open?: boolean }): Promise<readonly StoredOrder[]> {
    const rows = await this.#db
      .select()
      .from(orders)
      .where(query?.open === true ? and(eq(orders.open, true)) : undefined)
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
  ): Promise<OrderLookup<T>> {
    return this.#db.transaction(async (tx) => {
      // The lock is taken on the row itself, so a second decision about this
      // order waits here rather than reading the same order and writing over
      // whatever the first one decided.
      const [row] = await tx.select().from(orders).where(eq(orders.id, id)).limit(1).for("update");

      if (row === undefined) {
        return { found: false };
      }

      const decided = await change(row.record);
      if (decided.save !== undefined) {
        const next = rowFor(decided.save);
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
    // The insert is the check. Two requests presenting the same payment at the
    // same instant both reach here and the primary key decides between them,
    // which is the one place a decision like this can be made without a race.
    const [taken] = await this.#db
      .insert(paymentClaims)
      .values({ fingerprint, orderId, claimedAt: new Date() })
      .onConflictDoNothing({ target: paymentClaims.fingerprint })
      .returning();

    if (taken !== undefined) {
      return { claimed: true };
    }

    const [held] = await this.#db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.fingerprint, fingerprint))
      .limit(1);

    if (held === undefined) {
      // The row was there a moment ago and is not now. Nothing deletes these,
      // so this is not a state this code knows how to be in.
      throw new Error(`the claim on a payment for ${orderId} vanished between two queries`);
    }
    // The same order presenting the same payment again is the ordinary retry
    // the portal promises is safe, and it still owns it.
    return held.orderId === orderId ? { claimed: true } : { claimed: false, heldBy: held.orderId };
  }

  async putReceipt(receipt: Receipt): Promise<void> {
    await this.#db
      .insert(receipts)
      .values({ orderId: receipt.order_id, receipt, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: receipts.orderId,
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

  async receipts(): Promise<readonly Receipt[]> {
    const rows = await this.#db.select().from(receipts).orderBy(receipts.updatedAt);
    return rows.map((row) => row.receipt);
  }
}

/** The columns, written from the document so they cannot disagree with it. */
function rowFor(record: StoredOrder) {
  return {
    id: record.order.id,
    state: record.order.state,
    open: isOpen(record.order.state),
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
