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

import type { Card, Receipt, WorkerEnvelope } from "@coinslot/contracts";
import { isOpen, MERCHANT_SELLING, type MerchantSelling } from "@coinslot/core";
import { and, eq, exists, isNull, lt, not, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import type { DrizzleTransactionLike } from "pg-boss";
import type { Ids } from "../../ports/clock.js";
import type {
  CatalogEntry,
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
} from "../../ports/store.js";
import { cards, merchantKeys, merchants, orders, paymentClaims, receipts } from "./schema.js";

/**
 * How an envelope that has to be written with an order gets onto a merchant's
 * stream (ADR-0013).
 *
 * Two calls rather than one, and the second is not an afterthought. `within`
 * writes the job as part of the transaction the order is being written in, so
 * the two commit or roll back together; nothing can see that job until the
 * commit, a poll parked in this process included. `committed` is what tells
 * those parked polls to look again, and it runs after the transaction has
 * actually committed — woken any earlier they would fetch, find nothing, and
 * have spent the wake that ADR-0004 §4 exists to give them.
 */
export interface Envelopes {
  within(
    tx: DrizzleTransactionLike,
    merchantId: string,
    envelope: WorkerEnvelope,
    afterMs?: number,
  ): Promise<void>;
  /** The transaction those envelopes were written in has committed. */
  committed(merchantIds: readonly string[]): void;
}

/**
 * The answer for a store that was built without one.
 *
 * The command-line verbs make a store to list merchants and issue keys with,
 * and none of them writes an order. Refusing out loud is the alternative to a
 * store that quietly drops a merchant's work.
 */
export const noEnvelopes: Envelopes = {
  async within(_tx, _merchantId, envelope) {
    throw new Error(
      `this store was built with nowhere to put the envelope ${envelope.id}: a store that writes orders is given a stream`,
    );
  },
  committed() {},
};

/**
 * Somewhere a statement can be run: the pool, or a transaction on it. Drizzle
 * hands the two the same query builder, and the difference is the only thing
 * this file cares about.
 */
type Queries = NodePgDatabase | Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

/**
 * The drizzle handle together with the pool it was built over, which is what
 * `drizzle(pool)` hands back.
 *
 * The pool is named in the type because one method needs a connection it can
 * keep rather than a statement it can run: a session-level advisory lock
 * belongs to the session that took it, and a pool would hand the unlock to a
 * different one.
 */
export type Database = NodePgDatabase & { readonly $client: Pool };

export class PostgresStore implements Store {
  readonly #db: Database;
  readonly #ids: Ids;
  readonly #envelopes: Envelopes;

  constructor(db: Database, ids: Ids, envelopes: Envelopes = noEnvelopes) {
    this.#db = db;
    this.#ids = ids;
    this.#envelopes = envelopes;
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

  async setServiceName(
    id: string,
    serviceName: string | null,
    at: number,
  ): Promise<StoredMerchant | null> {
    const [row] = await this.#db
      .update(merchants)
      .set({ serviceName, updatedAt: new Date(at) })
      .where(eq(merchants.id, id))
      .returning();
    return row === undefined ? null : storedMerchantOf(row);
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

  async openOrders(): Promise<readonly StoredOrder[]> {
    const rows = await this.#db
      .select()
      .from(orders)
      .where(eq(orders.open, true))
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async runAlone<T>(name: string, work: () => Promise<T>): Promise<Ran<T>> {
    // An advisory lock, and one connection held for as long as the work runs.
    // The connection is the whole reason this is not two statements on the
    // pool: a session lock belongs to the session that took it, and a pool
    // hands out whichever connection is free, so an unlock issued on a
    // different one would release nothing and the work would be blocked until
    // the process ended.
    //
    // A session lock rather than a transaction one, because the alternative
    // means holding a transaction open for the length of the work — an idle
    // transaction keeping a snapshot alive for as long as a sweep takes — and
    // the work here writes through other connections anyway.
    //
    // Which is the other thing to know about the connection: it comes out of
    // the same pool the work then queries through, and it is held for the whole
    // run. Nothing sets a timeout on waiting for one, so on a pool too small to
    // spare it the work would wait rather than fail, and would wait on a
    // connection only it could release. The default pool has room and a sweep
    // is one connection; a deployment that tightens the pool should count this
    // one in.
    //
    // The key is hashed from a name of ours under a prefix of ours, and what a
    // collision with somebody else's key would cost is worth having the right
    // way round. pg-boss takes advisory locks in this same database, and both
    // kinds share one key space — a session lock and a transaction lock on the
    // same number are the same lock — so a collision costs whichever side
    // arrives second. Reaching a key pg-boss holds, we are told no and skip the
    // run. Reaching a key we hold, pg-boss waits rather than asks:
    // `pg_advisory_xact_lock` inside a transaction that sets `lock_timeout` to
    // thirty seconds, so its create-queue or migration sits behind our session
    // for the length of a sweep and then fails on the timeout. Both halves are
    // real and the second is the worse one, which is why ours is the session
    // that has to be considerate.
    //
    // The prefix on the name is not what keeps us apart from pg-boss. It goes
    // through `hashtext` with everything else, so it reserves no region of a
    // flat 32-bit key space; what it does is keep our own names from colliding
    // with each other. Nothing here can rule out a collision with somebody
    // else's key, and nothing needs to: what a collision costs is written above.
    const client = await this.#db.$client.connect();
    let broken: unknown = null;

    // Nothing is listened for on this client here, and that is deliberate rather
    // than an omission. A checked-out client carries no error listener of the
    // pool's — pg-pool takes its own off on the way out and hands it back only
    // on release — so a fatal while a client is pinned would be an `error` event
    // with nobody listening, which in Node is an uncaught exception and a dead
    // process. `connect()` covers that for every client the pool hands out, on
    // `acquire` and `release`, because this is not the only place that pins one:
    // every drizzle transaction does, `withOrder` is a drizzle transaction, and
    // the payment path got there first. A second listener here would log the
    // same failure twice and say nothing the first one did not.
    //
    // What this still needs to know is whether the connection can be given back,
    // and that is answered below by the unlock rather than by an event.

    try {
      const taken = await client.query<{ got: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as got",
        [`coinslot.${name}`],
      );
      if (taken.rows[0]?.got !== true) {
        return { ran: false };
      }

      try {
        return { ran: true, result: await work() };
      } finally {
        // Let go however the work ended. A lock left behind on a live
        // connection outlives the failure that caused it and would keep every
        // later run out for as long as the process lives.
        //
        // Its own failure is said out loud and dropped, never thrown. This runs
        // in a `finally`, so a rejection here would replace whatever the work
        // returned or threw: a sweep that finished would be reported as a
        // failure and its work handed out again, and a sweep that failed would
        // have its own reason swallowed and the connection's put in its place.
        // Neither is a thing to learn from a log afterwards. And a lock that
        // could not be released has usually been released already, by the
        // backend going away, which is also what broke the connection.
        try {
          await client.query("select pg_advisory_unlock(hashtext($1))", [`coinslot.${name}`]);
        } catch (thrown) {
          console.error(`[gateway] could not let go of ${name}`, thrown);
          // And the connection goes with the failure, which is the only thing
          // that actually frees the name. An unlock can fail on a session that
          // is still perfectly alive — a statement timeout is enough — and then
          // the lock is still held, by a client about to go back into the pool
          // holding it. Every later run is told the name is taken and does
          // nothing, which reads in the log exactly like a healthy skip, and
          // this is the safety net for effects that went missing. Marking the
          // connection broken makes the release below end the session instead,
          // and a session ending is what a session lock is released by.
          //
          // Without this it self-heals eventually: the pooled connection is
          // reaped on the idle timeout, about ten seconds on a quiet gateway.
          // On a busy pool, or one with a minimum size or a longer idle timeout
          // set, that reaping does not come and the name stays wedged for the
          // life of the process.
          //
          // One thing it does not close. Postgres counts advisory locks, so a
          // session that took the same name twice needs two unlocks; if the
          // leaking connection were drawn again before it was destroyed and
          // granted the name a second time, a single unlock would only
          // decrement. That cannot happen on this path — the client is never
          // back in the pool between the failure and the release — and it is an
          // argument for ending the session rather than against it, since
          // ending the session releases every count at once.
          broken = thrown;
        }
      }
    } finally {
      // A client whose lock could not be let go is released with the failure,
      // which asks the pool to end the session rather than hand the client to
      // the next caller still holding the name.
      //
      // Said plainly because a probe found it out: for a connection that is
      // already gone the pool would discard the client anyway, since it also
      // drops one that is no longer queryable. What the argument adds is the
      // case that connection cannot cover — a session that is alive, queryable,
      // and holding a lock it refused to release.
      client.release(broken === null ? undefined : (broken as Error));
    }
  }

  async deliveredWithoutReceipt(): Promise<readonly StoredOrder[]> {
    // The absence is asked in the predicate rather than by reading the orders
    // and then the receipts, so what comes back is the size of what is wrong
    // and not the size of the history — normally nothing at all.
    //
    // What that does not do is bound the reading. There is no index on `state`
    // and the one on `open` leads with the merchant, so this walks the orders
    // table and so does `openOrders` above. Once a day, unpaged, which is
    // nothing at a pilot's volume and is the first thing to look at when the
    // table is large: the answer is an index, and it is not here yet because
    // adding one is a change to the schema rather than to this file.
    const rows = await this.#db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.state, "delivered"),
          not(
            exists(
              this.#db
                .select({ one: sql`1` })
                .from(receipts)
                .where(eq(receipts.orderId, orders.id)),
            ),
          ),
        ),
      )
      .orderBy(orders.createdAt);
    return rows.map((row) => row.record);
  }

  async withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
    scope?: MerchantScope,
  ): Promise<OrderLookup<T>> {
    // Which streams were written to inside the transaction, so that the polls
    // parked on them can be woken once it has committed and not before.
    const streams: string[] = [];
    const lookup = await this.#db.transaction(async (tx): Promise<OrderLookup<T>> => {
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

      // The writes that must not be lost go in this transaction, so that a
      // process that dies mid-flight either did both or did neither (ADR-0013).
      // pg-boss takes a handle in its send options whose whole contract is
      // running one statement, and `fromDrizzle` makes one out of this
      // transaction — so the job insert is on this connection, inside this
      // transaction, and rolls back with the order if anything below fails.
      for (const write of decided.alongside ?? []) {
        if (write.kind === "receipt") {
          await this.#putReceiptWithin(tx, write.merchantId, write.receipt);
          continue;
        }
        await this.#envelopes.within(tx, write.merchantId, write.envelope, write.afterMs);
        streams.push(write.merchantId);
      }

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

    // Committed: the jobs written above are visible now, so a poll parked in
    // this process is told to look rather than waiting out its polling
    // interval. Nothing depends on this happening — another process finds the
    // work by polling — which is why it is after the transaction and not in it.
    this.#envelopes.committed(streams);
    return lookup;
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
    await this.#putReceiptWithin(this.#db, merchantId, receipt);
  }

  /**
   * The one statement that writes a receipt, on whichever handle it is given —
   * the pool for a caller of its own, or the transaction an order is being
   * written in. One statement rather than two, so that a receipt written beside
   * an order and a receipt written by the sweep cannot come to disagree about
   * whose sale it was.
   */
  async #putReceiptWithin(on: Queries, merchantId: string, receipt: Receipt): Promise<void> {
    await on
      .insert(receipts)
      .values({ orderId: receipt.order_id, merchantId, receipt, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: receipts.orderId,
        // The merchant is not in this set. A receipt belongs to whoever made
        // the sale, and writing it again — which is what the machine does when
        // an order moves on, and what the sweep does for one that has none — is
        // not an occasion for it to change hands.
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
  serviceName: string | null;
  selling: string;
  createdAt: Date;
}): StoredMerchant {
  return {
    id: row.id,
    name: row.name,
    serviceName: row.serviceName,
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
 *
 * The connections that are checked out are the other half of that, and they are
 * the half that is easy to miss. The pool's listener above is on idle
 * connections only: pg-pool takes it off a client on the way out and puts it
 * back on release, so for as long as somebody holds a client there is nobody
 * listening to it. A fatal in that window — an administrator terminating a
 * backend, a failover, a pooler dropping a session — is an `error` event with no
 * listener, which is the uncaught exception this whole function exists to avoid,
 * arrived at down the other road.
 *
 * That window is not rare and it is not short. Every drizzle transaction is a
 * checked-out client, `withOrder` is a drizzle transaction, and the callback
 * inside it arms the order's deadlines — a round trip on the queue's own pool,
 * during which this connection is pinned with no query in flight for a fatal to
 * surface through. The sweep's advisory lock is the same shape and holds for
 * longer. So the guard is here, on the pool, rather than at either of them: one
 * listener attached to every client that leaves and taken off every client that
 * comes back, which covers the two that exist today and whatever pins a client
 * next.
 *
 * The two moments are the right ones and the order in pg-pool is what makes
 * them safe. `acquire` is emitted before the pool strips its own listener, and
 * the strip names that listener, so ours is attached first and survives it.
 * `release` is emitted after the pool has put its own back on, so ours comes off
 * a client that is already covered again. Neither edge leaves a gap.
 *
 * Logged and nothing more. What to do about a broken connection is the
 * caller's: a query in flight rejects on its own, and the pool discards a client
 * that is no longer queryable when it is released.
 *
 * The pool options are here for the tests, which need pools of one connection to
 * say anything about which session holds what. They go through this function
 * rather than building their own, because a pool built any other way is a pool
 * without these listeners — and a test running unguarded is a test that cannot
 * see the thing it was written for.
 */
export function connect(
  databaseUrl: string,
  options: PoolConfig = {},
): { db: Database; pool: Pool } {
  const pool = new Pool({ ...options, connectionString: databaseUrl });
  pool.on("error", (error) => {
    console.error("[gateway] an idle database connection failed", error);
  });

  // One function for the whole pool rather than one per checkout: removal is by
  // identity, so attaching and detaching the same function keeps the count at
  // one however many clients are out at once.
  const noticeTheFailure = (failed: unknown) => {
    console.error("[gateway] a database connection somebody was holding failed", failed);
  };
  pool.on("acquire", (client) => client.on("error", noticeTheFailure));
  pool.on("release", (_failed, client) => client.removeListener("error", noticeTheFailure));

  return { db: drizzle(pool), pool };
}
