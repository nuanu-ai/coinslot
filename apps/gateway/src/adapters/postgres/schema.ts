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
 * Money is never a column. Prices live inside the documents as the decimal
 * strings the contract writes them in, so nothing on the way through a database
 * driver can turn one into a float.
 */

import type { Card, Receipt } from "@coinslot/contracts";
import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { StoredOrder } from "../../ports/store.js";

export const cards = pgTable("cards", {
  /** Our catalog identifier, the one an agent and a receipt both use. */
  id: text("id").primaryKey(),
  /**
   * The merchant's own key. It is unique because republishing under it changes
   * the card that is there rather than adding a second one, and the database is
   * where that promise is actually kept.
   */
  merchantItemId: text("merchant_item_id").notNull().unique(),
  card: jsonb("card").$type<Card>().notNull(),
  /** When this version of the card was published. */
  asOf: timestamp("as_of", { withTimezone: true, mode: "date" }).notNull(),
});

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    /** Written from the document, so a list can be drawn without reading them all. */
    state: text("state").notNull(),
    /** Whether this order is still owed work or money. */
    open: boolean("open").notNull(),
    itemId: text("item_id").notNull(),
    merchantItemId: text("merchant_item_id").notNull(),
    record: jsonb("record").$type<StoredOrder>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("orders_open_idx").on(table.open, table.createdAt)],
);

export const receipts = pgTable("receipts", {
  /** One receipt per order, which is what makes writing it again an update. */
  orderId: text("order_id").primaryKey(),
  receipt: jsonb("receipt").$type<Receipt>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

/**
 * Which order owns which payment.
 *
 * The primary key is the whole of the mechanism: a signed payment carries no
 * record of which purchase it is for, so two orders at the same price are
 * payable with one signature unless something refuses the second. That refusal
 * is this row already existing.
 */
export const paymentClaims = pgTable("payment_claims", {
  /** A stable fingerprint of the part of the payment the agent actually signed. */
  fingerprint: text("fingerprint").primaryKey(),
  orderId: text("order_id").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }).notNull(),
});
