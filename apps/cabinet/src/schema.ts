/**
 * The cabinet's own two tables.
 *
 * They share a database with the gateway's (ADR-0003 §6, one Postgres), so the
 * names say whose they are. Nothing here is a merchant's data: a card, an order
 * and a receipt all come from the public API and none of them can be reached
 * from a query in this process.
 *
 * The migrations generated from this file live in `drizzle/` and are applied by
 * `pnpm --filter @coinslot/cabinet db:migrate`. They keep their bookkeeping in a
 * table of their own, `drizzle.cabinet_migrations`, because the gateway's
 * migrations keep theirs in the default one and two independent histories
 * writing one journal would each conclude the other's migrations were its own
 * and already applied.
 */

import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A person who can sign into the cabinet.
 *
 * The address is unique because that is the promise the sign-in rests on, and
 * the database is where it is actually kept: a check in the process ahead of an
 * insert is two statements with a gap between them, and two commands run at once
 * fit inside that gap.
 *
 * There is no name, no role and no record of who created it. ADR-0009 names the
 * trigger for all three — a second person at a merchant, or a second merchant —
 * and until then a column nobody fills in is a column that lies.
 */
export const accounts = pgTable("cabinet_accounts", {
  id: text("id").primaryKey(),
  /** Lower case and trimmed, which is how it is written and how it is read. */
  email: text("email").notNull().unique(),
  /** `credentials.ts` decides what is in here; this table never looks. */
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  /**
   * The merchant whose cards, orders and receipts this account's screens show.
   *
   * Nullable, which is a decision rather than laziness. There is an account on
   * a deployed server that was made before merchants had accounts at all, and a
   * NOT NULL column cannot be added to a table that already has a row in it. An
   * account with nothing here cannot sign in — there is no key to draw a screen
   * with — and the sign-in says exactly that rather than serving an empty
   * cabinet.
   */
  merchantId: text("merchant_id"),
  /**
   * The key that merchant reaches the gateway with, as the gateway issued it.
   *
   * This is a secret at rest, and ADR-0014 §2 is where the argument for keeping
   * it this way lives: it is the same secret that used to sit in plain text in
   * the cabinet's environment, moved from a file into a row so it can be
   * revoked one merchant at a time instead of by a deployment. Unlike the
   * password beside it, which is a derivation, this column hands over what it
   * holds — so nothing above this table may put it on a page, in a log or in
   * the text of an error.
   */
  merchantKey: text("merchant_key"),
});

/**
 * One person signed in on one device.
 *
 * The primary key is the fingerprint of the identifier rather than the
 * identifier, so this table is not a list of sessions somebody who has a copy
 * of it can spend.
 *
 * The reference to the account cascades on delete: an account that goes takes
 * its sessions with it, in the database rather than in whichever code path
 * happened to delete it.
 */
export const sessions = pgTable(
  "cabinet_sessions",
  {
    fingerprint: text("fingerprint").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Twelve hours after it opened, and never moved. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    // The sweep on every sign-in reads by this, and ending every session one
    // person has reads by the other.
    index("cabinet_sessions_expires_idx").on(table.expiresAt),
    index("cabinet_sessions_account_idx").on(table.accountId),
  ],
);
