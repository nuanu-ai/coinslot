/**
 * The cabinet's own four tables.
 *
 * They share a database with the gateway's (ADR-0003 §6, one Postgres), so the
 * names say whose they are. Nothing here is a merchant's data: a card, an order
 * and a receipt all come from the public API and none of them can be reached
 * from a query in this process.
 *
 * Four of them rather than two, because signing in is a component's job now
 * (ADR-0009) and the component keeps its people, their sessions, their
 * passwords and its one-time links in separate places. The shape of each table
 * is the component's; the names are ours, and every one of them is prefixed so
 * that a person reading this database can tell at a glance which process owns
 * what. Left at the component's own defaults these would be `user`, `session`,
 * `account` and `verification` — four of the most generic words there are, in a
 * database that already has a merchant's orders in it, and one of them a
 * reserved word in Postgres.
 *
 * The migrations generated from this file live in `drizzle/` and are applied by
 * `pnpm --filter @coinslot/cabinet db:migrate`. They keep their bookkeeping in a
 * table of their own, `drizzle.cabinet_migrations`, because the gateway's
 * migrations keep theirs in the default one and two independent histories
 * writing one journal would each conclude the other's migrations were its own
 * and already applied.
 */

import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** How the component writes and reads every moment in these tables. */
const moment = (column: string) =>
  timestamp(column, { withTimezone: true, mode: "date" }).notNull();

/**
 * A person who can sign into the cabinet.
 *
 * The address is unique because that is the promise the sign-in rests on, and
 * the database is where it is actually kept: a check in the process ahead of an
 * insert is two statements with a gap between them, and two commands run at once
 * fit inside that gap.
 *
 * There is no password here any more. The component keeps what it derives from
 * one in `cabinet_credentials`, a row per way of signing in, and this table
 * holds only who the person is. The two columns at the bottom are the ones that
 * are ours rather than the component's, and they are the reason this table kept
 * its name through the change instead of being made again beside the old one.
 */
export const accounts = pgTable("cabinet_accounts", {
  id: text("id").primaryKey(),
  /** Lower case and trimmed, which is how it is written and how it is read. */
  email: text("email").notNull().unique(),
  /**
   * Whether anybody has shown they can read mail sent to that address.
   *
   * False on the day an account is made and it stays false until somebody
   * follows the link, because nothing in the cabinet waits for a message
   * (ADR-0009). What it buys its owner is the one thing that needs it: a
   * password they have lost can be replaced by a link we send there. Every
   * other screen works either way, and every screen says which it is.
   */
  emailVerified: boolean("email_verified").notNull().default(false),
  /**
   * The name this merchant's products are sold under.
   *
   * The component asks every person for a name and this is the name there is:
   * an account is one merchant (ADR-0014), so the person and the shopfront are
   * not two things here yet. It is empty on an account made by the command,
   * which is handed a merchant that already exists and is never told what it
   * calls itself.
   */
  name: text("name").notNull().default(""),
  createdAt: moment("created_at"),
  updatedAt: moment("updated_at"),
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
   * password next door, which is a derivation, this column hands over what it
   * holds — so nothing above this table may put it on a page, in a log or in
   * the text of an error.
   */
  merchantKey: text("merchant_key"),
});

/**
 * One person signed in on one device.
 *
 * The identifier the browser carries is in `token`, and it is here as it was
 * issued rather than as a fingerprint of one. What stands between a copy of
 * this table and a pile of sessions somebody can spend is that the cookie is
 * not the token alone: the component signs it, and a value with no signature
 * over it is refused before this table is read at all. That is a different
 * bargain from the one this table used to make and it is worth knowing which
 * one is in force — the secret that makes those signatures is in the cabinet's
 * configuration, so a copy of this table and a copy of that configuration
 * together are what the fingerprint used to rule out on its own.
 *
 * The reference to the account cascades on delete: an account that goes takes
 * its sessions with it, in the database rather than in whichever code path
 * happened to delete it.
 */
export const sessions = pgTable(
  "cabinet_sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    expiresAt: moment("expires_at"),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
    /**
     * Where the request came from and what it said it was.
     *
     * The component fills these in from the request it is handed, and it is
     * never handed one here: every call the cabinet makes is from its own
     * handler with a body and no request behind it, so both stay empty. They
     * are in the table because the component writes to them, not because
     * anything reads them.
     */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    // Ending every session one person has reads by the first, and the sweep of
    // sessions whose time is up reads by the second.
    index("cabinet_sessions_account_idx").on(table.userId),
    index("cabinet_sessions_expires_idx").on(table.expiresAt),
  ],
);

/**
 * One way of signing in, for one person.
 *
 * There is exactly one kind in this cabinet and it is a password, so every row
 * here names the same provider and carries a derivation in `password`. The
 * table has room for the tokens of a social provider because the component's
 * shape has room for them; nothing in the cabinet issues or reads one, and
 * ADR-0009 names no plan to.
 *
 * What is in `password` is a derivation and not a password: it cannot be read
 * back, and two people who chose the same one do not have the same row.
 */
export const credentials = pgTable(
  "cabinet_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Which provider this is a way of signing in with, always `credential`. */
    providerId: text("provider_id").notNull(),
    /** Who the person is at that provider, which here is their own identifier. */
    accountId: text("account_id").notNull(),
    /** Who issued it, which for a password is this cabinet. */
    issuer: text("issuer").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
  },
  (table) => [index("cabinet_credentials_account_idx").on(table.userId)],
);

/**
 * A one-time link that has been handed out and not yet spent.
 *
 * Two things put rows here: confirming an address and replacing a forgotten
 * password. Each row is the token, who it is for, and the moment it stops
 * working — the component writes them, spends them and deletes them, and
 * nothing in the cabinet reads this table by hand.
 *
 * It has no reference to an account on purpose. A row here can name an address
 * that no account has, which is what lets the form that asks for a reset answer
 * the same way whether or not anybody has that address.
 */
export const verifications = pgTable(
  "cabinet_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: moment("expires_at"),
    createdAt: moment("created_at"),
    updatedAt: moment("updated_at"),
  },
  (table) => [index("cabinet_verifications_identifier_idx").on(table.identifier)],
);
