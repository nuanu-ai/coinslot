/**
 * The tables.
 *
 * An order is kept as one document rather than as a column per field, and that
 * is the decision worth arguing. The order machine's shape is the product and
 * it is still moving; a column per field would put that shape into the schema,
 * and every change to a state, a stage or a timestamp would become a migration
 * of somebody's live orders. What is pulled out into columns is only what the
 * gateway actually queries by — which order, whose product, and whether it is
 * still owed something — and those are written from the document on every save,
 * so they cannot drift from it.
 *
 * The cost is named too: nothing here can be reported on in SQL beyond those
 * columns. The trigger to revisit is the first report the cabinet needs that
 * this cannot answer.
 *
 * Every table but one carries the merchant it belongs to, not null. That is
 * ADR-0010 and it is the difference between a filter somebody remembered to
 * write and a row that cannot exist without an owner; the exception is the
 * claims on payments, which says why in its own place.
 *
 * Money is never a column. Prices live inside the documents as the decimal
 * strings the contract writes them in, so nothing on the way through a database
 * driver can turn one into a float.
 */

import type { Card, Receipt } from "@coinslot/contracts";
import { boolean, index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { StoredOrder } from "../../ports/store.js";

/**
 * A merchant.
 *
 * One row per merchant, carrying an identity and the one fact the order machine
 * asks about them: whether they are taking new orders. That fact is a table
 * rather than a setting in the environment because a merchant presses it and it
 * has to survive a restart — configuration is what the operator sets, and this
 * is what the merchant sets.
 *
 * There is no address, no password and no record of who signed them up. That is
 * registration, which is the decision after this one (ADR-0010), and a column
 * nobody fills in is a column that lies. The name is what a person reads at a
 * terminal; nothing on the wire carries it. What does go out is the separate
 * listing name beside it, and only where somebody set one.
 */
export const merchants = pgTable("merchants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /**
   * The name this seller is listed under in a discovery catalog, where anybody
   * has named one. Null is the ordinary state and it is never filled in from
   * the name above: that one is for a person at a terminal and may be written
   * in any alphabet, and this one goes out to strangers through a catalog that
   * carries printable ASCII and cuts anything else without a word.
   */
  serviceName: text("service_name"),
  /**
   * The address on the chain this merchant's sales are paid into, where
   * somebody has set one. Null is the ordinary state.
   *
   * A column and not a setting in the environment, because the money is the
   * merchant's and never ours: it goes straight from a buyer's agent to this
   * address, and one address per deployment would mean one address for every
   * merchant on it — which is the custodial arrangement this whole design
   * refuses. It is never filled in from the operator's own configured address
   * for the same reason.
   *
   * Always in the mixed-case spelling a wallet displays. An address has two
   * spellings, and holding both would make one address two strings to every
   * comparison and to every read back; of the two, this is the one a merchant
   * can check against their own wallet at a glance.
   */
  payoutWallet: text("payout_wallet"),
  /** The order machine's own word: open, paused or departed. */
  selling: text("selling").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

/**
 * One key a merchant opens the door with.
 *
 * The secret is not here. What is kept is its SHA-256 digest, and it is unique
 * because that is what a request is resolved by: the door hashes what was
 * presented and looks the result up, which is constant-time by construction and
 * needs no comparison of one secret against another. A copy of this table is
 * not a set of keys somebody can spend.
 *
 * `disabled_at` rather than a boolean. Both answer whether the key works; only
 * one of them answers the question somebody asks after an incident, which is
 * when it stopped. Revoking a key is a write to this one row and touches no
 * other key and no session — which is the whole reason a key is a row and not
 * an environment variable.
 */
export const merchantKeys = pgTable(
  "merchant_keys",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    /** What its owner called it, so one of several can be told from the others. */
    label: text("label").notNull(),
    /** The SHA-256 of the key, in lower-case hex. Never the key. */
    digest: text("digest").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    /** When it was revoked, or null while it still opens the door. */
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
  },
  // Listing one merchant's keys reads by this; the door reads by the unique
  // index on the digest above.
  (table) => [index("merchant_keys_merchant_idx").on(table.merchantId)],
);

export const cards = pgTable(
  "cards",
  {
    /** Our catalog identifier, the one an agent and a receipt both use. */
    id: text("id").primaryKey(),
    /** Whose card this is. Every read a merchant makes filters on it. */
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    /**
     * The merchant's own key for this product. Republishing under it changes
     * the card that is there rather than adding a second one, and the database
     * is where that promise is actually kept.
     */
    merchantItemId: text("merchant_item_id").notNull(),
    card: jsonb("card").$type<Card>().notNull(),
    /** When this version of the card was published. */
    asOf: timestamp("as_of", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * Whether this card is off sale in its own right. A column and not a field
     * inside the document, because republishing writes the document whole and a
     * pause kept in there would be erased by the next edit to a price.
     */
    paused: boolean("paused").notNull().default(false),
  },
  (table) => [
    // Unique inside a merchant and not across the gateway, which is what the
    // card contract has always said a merchant's own identifier means. Held
    // unique globally, the second merchant to publish a "sku-1" would edit the
    // first merchant's card instead of publishing their own.
    unique("cards_merchant_item_unique").on(table.merchantId, table.merchantItemId),
    index("cards_merchant_idx").on(table.merchantId),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    /** Written from the document, so a list can be drawn without reading them all. */
    state: text("state").notNull(),
    /** Whether this order is still owed work or money. */
    open: boolean("open").notNull(),
    /** Whose sale this is, written from the document like the rest of these. */
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    itemId: text("item_id").notNull(),
    merchantItemId: text("merchant_item_id").notNull(),
    record: jsonb("record").$type<StoredOrder>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  // A merchant lists their own orders, open ones first among them, so the
  // merchant leads the index: an index on `open` alone would have every
  // merchant's list walking every merchant's orders.
  (table) => [index("orders_open_idx").on(table.merchantId, table.open, table.createdAt)],
);

export const receipts = pgTable(
  "receipts",
  {
    /** One receipt per order, which is what makes writing it again an update. */
    orderId: text("order_id").primaryKey(),
    /** Whose receipt it is. A merchant reconciles their own list and no other. */
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    receipt: jsonb("receipt").$type<Receipt>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("receipts_merchant_idx").on(table.merchantId, table.updatedAt)],
);

/**
 * Which order owns which payment.
 *
 * The primary key is the whole of the mechanism: a signed payment carries no
 * record of which purchase it is for, so two orders at the same price are
 * payable with one signature unless something refuses the second. That refusal
 * is this row already existing.
 *
 * The one table here with no merchant on it, and deliberately. The two orders
 * one signature would buy are as likely to be at two merchants as at one — an
 * agent walking the public catalog is not shopping inside a tenant — so a
 * fingerprint unique per merchant would let the same authorisation be spent
 * once at each.
 */
export const paymentClaims = pgTable(
  "payment_claims",
  {
    /** A canonical fingerprint of the authorisation the agent actually signed. */
    fingerprint: text("fingerprint").primaryKey(),
    orderId: text("order_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  // Claims are swept by age, and read back by order when somebody is working
  // out what an order was paid with.
  (table) => [
    index("payment_claims_swept_idx").on(table.claimedAt),
    index("payment_claims_order_idx").on(table.orderId),
  ],
);
