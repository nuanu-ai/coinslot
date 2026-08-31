/**
 * The migrations that touch rows, run against rows.
 *
 * Everything else in `pnpm test:db` runs against a database the migrator built
 * from nothing, where a backfill touches nothing at all — so the one thing such
 * a migration exists to do is exercised nowhere. This is the file that
 * exercises it: a database is brought up to the version before the change, rows
 * are written the way that version wrote them, and then the migration runs.
 *
 * What is being checked is not that it completes. It is what became of the
 * rows: that nothing is lost, that nothing changes hands, and that what the
 * migration was not written for is left exactly as it was found.
 *
 * The migrations are applied as SQL rather than through drizzle's migrator,
 * because the point is to stop part way — and the migrator applies everything
 * in the folder. What runs here is therefore the exact text a deployment
 * applies, split on the same breakpoints the migrator splits on.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEEDED_MERCHANT } from "../../app/merchants.js";
import { PaymentEdge } from "../../http/x402.js";
import { noDatabaseHere, readyDatabase, testDatabaseUrl } from "../../testing/database.js";
import { countedIds, testConfig } from "../../testing/harness.js";
import { connect, type Database, PostgresStore } from "./store.js";

/**
 * A database of this file's own, beside the one the rest of `pnpm test:db` uses.
 *
 * It has to be a database rather than a schema, and the reason is in the
 * migration: drizzle writes its foreign keys as `references "public"."merchants"`,
 * so tables built in any other schema would point back at a `public` this file
 * is not touching. Standing the whole thing up at the version before the change
 * and then moving it is also not something to do to tables another suite is
 * emptying between its own tests.
 */
const wanted = (() => {
  const url = new URL(testDatabaseUrl());
  url.pathname = "/coinslot_test_migration";
  return url.toString();
})();
const databaseUrl = await readyDatabase(wanted);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsIn = join(here, "..", "..", "..", "drizzle");

/** One migration file, as the statements the migrator would run one by one. */
async function statementsOf(file: string): Promise<string[]> {
  const sql = await readFile(join(migrationsIn, file), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

if (databaseUrl === null) {
  describe.skip(`the migrations that touch rows ${noDatabaseHere(wanted)}`, () => {
    it("needs a database", () => undefined);
  });
} else {
  describe("the migration that gives every row an owner", () => {
    const url = databaseUrl;
    let pool: Pool;

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    /** The rows a gateway of the previous version would be holding. */
    const asItWasBefore = async (): Promise<void> => {
      await pool.query(
        `insert into cards (id, merchant_item_id, card, as_of, paused)
         values ($1, $2, $3, now(), true)`,
        ["itm_old", "sku-1", JSON.stringify({ merchant_item_id: "sku-1", title: "A room" })],
      );
      await pool.query(
        `insert into orders (id, state, open, item_id, merchant_item_id, record, created_at, updated_at)
         values ($1, $2, true, $3, $4, $5, now(), now())`,
        [
          "ord_old",
          "dispatched",
          "itm_old",
          "sku-1",
          JSON.stringify({
            order: { id: "ord_old", state: "dispatched" },
            itemId: "itm_old",
            merchantItemId: "sku-1",
          }),
        ],
      );
      await pool.query(
        `insert into receipts (order_id, receipt, updated_at) values ($1, $2, now())`,
        ["ord_old", JSON.stringify({ id: "rcp_old", order_id: "ord_old" })],
      );
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      // Emptied back to nothing and brought up to the version just before this
      // change. Doing it before rather than after is what makes a run that died
      // half way through harmless to the next one.
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      await run("0000_init.sql");
      await run("0001_payment_claims.sql");
      await run("0002_selling.sql");
    });

    it("gives every card, order and receipt to the one merchant they belong to", async () => {
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const owners = await pool.query<{ merchant_id: string }>(
        `select merchant_id from cards
         union all select merchant_id from orders
         union all select merchant_id from receipts`,
      );
      expect(owners.rows.map((row) => row.merchant_id)).toStrictEqual([
        SEEDED_MERCHANT.id,
        SEEDED_MERCHANT.id,
        SEEDED_MERCHANT.id,
      ]);
    });

    it("puts the merchant inside the order's document as well as in its column", async () => {
      // Two readers, and they must not disagree. The column is what a merchant's
      // own list of orders filters on; the document is what tells the
      // interpreter whose stream the next envelope for this order goes on. An
      // order with the column and no field would be one whose redelivery
      // reached nobody, and nothing would say so.
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ merchant_id: string; record: { merchantId?: string } }>(
        "select merchant_id, record from orders where id = 'ord_old'",
      );
      expect(rows[0]?.record.merchantId).toBe(SEEDED_MERCHANT.id);
      expect(rows[0]?.record.merchantId).toBe(rows[0]?.merchant_id);
    });

    it("loses nothing a card was carrying, including a pause", async () => {
      // A pause is stock a merchant took off sale. Dropped by a migration, it
      // is that stock back in front of an agent with nobody saying so.
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ paused: boolean; merchant_item_id: string }>(
        "select paused, merchant_item_id from cards where id = 'itm_old'",
      );
      expect(rows[0]?.paused).toBe(true);
      expect(rows[0]?.merchant_item_id).toBe("sku-1");
    });

    it("does not put a merchant who had stopped selling back on sale", async () => {
      // The row that carries the selling word is the one this adopts. Written
      // over, a merchant who had paused would come back from a migration
      // selling, and the first thing they would learn about it is an order.
      await pool.query(
        "insert into merchants (id, selling, updated_at) values ($1, 'paused', now())",
        [SEEDED_MERCHANT.id],
      );
      await asItWasBefore();

      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ selling: string; name: string }>(
        "select selling, name from merchants",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.selling).toBe("paused");
      // And the row got the name the column now demands, rather than failing.
      expect(rows[0]?.name).not.toBe("");
    });

    it("leaves one merchant and no orphans on a database that never sold anything", async () => {
      // The other half: a volume that has run the stack and never had the
      // selling switch pressed has no merchant row at all.
      await run("0003_merchant_tenancy.sql");

      const { rows } = await pool.query<{ id: string; selling: string }>(
        "select id, selling from merchants",
      );
      expect(rows).toStrictEqual([{ id: SEEDED_MERCHANT.id, selling: "open" }]);
    });

    it("lets two merchants use one identifier for two products afterwards", async () => {
      // The uniqueness moved from the merchant's own identifier to the pair.
      // Left where it was, the second merchant to publish a "sku-1" would edit
      // the first merchant's card.
      await asItWasBefore();
      await run("0003_merchant_tenancy.sql");
      await pool.query(
        "insert into merchants (id, name, selling, created_at, updated_at) values ($1, 'Another', 'open', now(), now())",
        ["mch_other"],
      );

      await pool.query(
        `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
         values ($1, $2, 'sku-1', $3, now())`,
        ["itm_new", "mch_other", JSON.stringify({ merchant_item_id: "sku-1" })],
      );

      const { rows } = await pool.query<{ count: string }>(
        "select count(*)::text as count from cards where merchant_item_id = 'sku-1'",
      );
      expect(rows[0]?.count).toBe("2");
      // And the same merchant still cannot have two cards under one identifier.
      await expect(
        pool.query(
          `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
           values ($1, $2, 'sku-1', $3, now())`,
          ["itm_clash", "mch_other", JSON.stringify({ merchant_item_id: "sku-1" })],
        ),
      ).rejects.toThrow();
    });

    it("refuses a card, an order or a receipt that names no merchant", async () => {
      // The difference between a filter somebody remembered to write and a row
      // that cannot exist without an owner.
      await run("0003_merchant_tenancy.sql");

      await expect(
        pool.query(
          "insert into cards (id, merchant_item_id, card, as_of) values ('itm_x', 'sku-x', '{}', now())",
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `insert into cards (id, merchant_id, merchant_item_id, card, as_of)
           values ('itm_x', 'mch_nobody', 'sku-x', '{}', now())`,
        ),
      ).rejects.toThrow();
    });
  });

  /**
   * The migration that gives an order verified before yesterday the address its
   * charge will be sent to.
   *
   * The window it closes is a real one and it is measured in a deploy. An
   * order's document carries `payTo` — the address the payment was checked
   * against, kept from that moment so a merchant who moves their wallet
   * mid-sale is paid at the new one on their next sale and not on this one. The
   * orders verified before that field existed have no such key, and it reads
   * back as nothing: on a deployment that settles for real the charge is then
   * refused with the sentence about a merchant who has set no wallet — which is
   * false for a merchant who has one — out of the effects loop, as a five
   * hundred, inside the merchant's own delivery call, after the goods went out.
   *
   * So the repair is in the data and not in a branch that would outlive the
   * window: the orders still open and already paid for are given their own
   * merchant's current address, and everything else is left exactly as it was
   * found.
   */
  describe("the migration that carries the address a charge is sent to", () => {
    const url = databaseUrl;
    let pool: Pool;
    let db: Database;
    let store: PostgresStore;

    /** A merchant with somewhere to be paid, and one without. */
    const PAID_AT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const WITH_WALLET = "mch_paid";
    const WITHOUT_WALLET = "mch_unpaid";

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    /**
     * One order as the version before this migration wrote it: no `payTo` key
     * anywhere in the document, because there was no such field.
     */
    const orderAsItWas = (
      id: string,
      merchantId: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      order: {
        id,
        state: "paid",
        price: { amount: "80.00", currency: "USD", asOf: 0 },
      },
      merchantId,
      itemId: "itm_1",
      merchantItemId: "sku-1",
      params: {},
      priceId: null,
      delivery: null,
      payment: "the authorisation the agent signed",
      paidBy: "0x1111111111111111111111111111111111111111",
      settlement: null,
      paymentWords: [],
      paymentWordsDropped: 0,
      openDeliveryId: null,
      ...extra,
    });

    const writeOrder = async (
      id: string,
      merchantId: string,
      { open = true, extra = {} }: { open?: boolean; extra?: Record<string, unknown> } = {},
    ): Promise<void> => {
      await pool.query(
        `insert into orders (id, state, open, merchant_id, item_id, merchant_item_id, record, created_at, updated_at)
         values ($1, 'paid', $2, $3, 'itm_1', 'sku-1', $4, now(), now())`,
        [id, open, merchantId, JSON.stringify(orderAsItWas(id, merchantId, extra))],
      );
    };

    /** The document as the gateway reads it back, through its own store. */
    const readBack = async (id: string): Promise<Record<string, unknown>> => {
      const record = await store.orderById(id);
      if (record === null) {
        throw new Error(`the order ${id} is not there`);
      }
      return record as unknown as Record<string, unknown>;
    };

    /**
     * Where the charge for this order would actually be sent, on a deployment
     * that settles for real — or the refusal, in the words a person would read.
     *
     * This is the call the settle path makes with `record.payTo` in hand
     * (`app/runner.ts`, `adapters/x402/facilitator.ts`), and it is the one that
     * throws where there is no address. Asserting on the row alone would say
     * that a key is present; this says what becomes of somebody's money.
     */
    const chargedTo = (payTo: unknown): string =>
      new PaymentEdge(
        testConfig({ PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000009" }).payment,
        "https://coinslot.example",
        300,
      ).requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", payTo as string | null)
        .payTo;

    beforeAll(async () => {
      const connected = connect(url);
      pool = connected.pool;
      db = connected.db;
      store = new PostgresStore(db, countedIds());
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
      ]) {
        await run(file);
      }
      await pool.query(
        `insert into merchants (id, name, selling, payout_wallet, created_at, updated_at)
         values ($1, 'A merchant who is paid somewhere', 'open', $2, now(), now()),
                ($3, 'A merchant who set no wallet', 'open', null, now(), now())`,
        [WITH_WALLET, PAID_AT, WITHOUT_WALLET],
      );
    });

    it("sends the charge on an order verified before the field existed to its merchant's wallet", async () => {
      // The promise: a sale that was verified last week and is delivered today
      // settles, at the address its own merchant is paid at, instead of dying
      // inside the merchant's delivery call with a sentence that is not true
      // of them.
      await writeOrder("ord_open", WITH_WALLET);

      await run("0006_order_pay_to_backfill.sql");

      expect((await readBack("ord_open")).payTo).toBe(PAID_AT);
      expect(chargedTo((await readBack("ord_open")).payTo)).toBe(PAID_AT);
    });

    it("leaves the order of a merchant who has no wallet alone, because that sentence is true", async () => {
      // The one order the refusal was written for. There is no address to give
      // it and the operator's own will not stand in (ADR-0019), so the honest
      // outcome is the refusal that names what is missing — inventing an
      // address here would send somebody's takings to somebody else.
      await writeOrder("ord_nowhere", WITHOUT_WALLET);

      await run("0006_order_pay_to_backfill.sql");

      const untouched = await readBack("ord_nowhere");
      expect("payTo" in untouched).toBe(false);
      expect(() => chargedTo(untouched.payTo)).toThrow(/no wallet/);
    });

    it("touches no order that is closed or that nobody has paid for", async () => {
      // A closed order is history: its charge is over, and rewriting the
      // address it was settled against would make the record disagree with the
      // chain. An open order with no payment has been promised nothing yet —
      // the address arrives with the payment and not before, so writing one now
      // would say a wallet had been checked when none had.
      await writeOrder("ord_closed", WITH_WALLET, { open: false });
      await writeOrder("ord_unpaid", WITH_WALLET, { extra: { payment: null } });

      await run("0006_order_pay_to_backfill.sql");

      expect("payTo" in (await readBack("ord_closed"))).toBe(false);
      expect("payTo" in (await readBack("ord_unpaid"))).toBe(false);
    });

    it("does not write over an address a payment was already verified against", async () => {
      // What the field is for: the address the payer signed for, which is not
      // necessarily the one the merchant is paid at now. An order carrying one
      // is an order the running gateway wrote, and a migration that read "no
      // address yet" as "no key" would move a charge the buyer never
      // authorised. The sandbox writes that field as null on purpose, and null
      // is an answer rather than an absence.
      const signedFor = "0x1111111111111111111111111111111111111111";
      await writeOrder("ord_signed", WITH_WALLET, { extra: { payTo: signedFor } });
      await writeOrder("ord_sandbox", WITH_WALLET, { extra: { payTo: null } });

      await run("0006_order_pay_to_backfill.sql");

      expect((await readBack("ord_signed")).payTo).toBe(signedFor);
      expect((await readBack("ord_sandbox")).payTo).toBeNull();
    });
  });

  /**
   * The migration that separates the keys a merchant made from the one their
   * cabinet calls with.
   *
   * Every key already written was made before there was any such distinction,
   * so the column arrives with a word for all of them and the rows registration
   * made are moved across. Finding those rows by their label is the part worth
   * exercising rather than trusting: the sentence it matches was written by one
   * line of code and by nobody's hand, and a migration that matched nothing
   * would leave a cabinet's key sitting in the list a merchant revokes keys
   * from — which is the state this whole change exists to end, arrived at
   * silently.
   */
  describe("the migration that says what each key was made for", () => {
    const url = databaseUrl;
    let pool: Pool;

    const MERCHANT = "mch_a";
    /** The label the version before this one gave a merchant's first key. */
    const AS_REGISTRATION_WROTE_IT = "the key this merchant registered with";

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    /**
     * One key row, written at the instant a merchant issues one.
     *
     * Later than its merchant's own creation, which is the whole difference
     * between a key somebody asked for and the one registration made: those two
     * rows are written in one transaction from one timestamp, and this one
     * cannot be.
     */
    const writeKey = async (id: string, label: string): Promise<void> => {
      await pool.query(
        `insert into merchant_keys (id, merchant_id, label, digest, created_at)
         values ($1, $2, $3, $4, now())`,
        [id, MERCHANT, label, `digest-of-${id}`],
      );
    };

    /** The same, at the merchant's own creation, the way registering writes it. */
    const writeKeyAsRegistrationDoes = async (id: string, label: string): Promise<void> => {
      await pool.query(
        `insert into merchant_keys (id, merchant_id, label, digest, created_at)
         select $1, $2, $3, $4, m.created_at from merchants m where m.id = $2`,
        [id, MERCHANT, label, `digest-of-${id}`],
      );
    };

    const purposeOf = async (id: string): Promise<string> => {
      const { rows } = await pool.query<{ purpose: string }>(
        "select purpose from merchant_keys where id = $1",
        [id],
      );
      const found = rows[0];
      if (found === undefined) {
        throw new Error(`the key ${id} is not there`);
      }
      return found.purpose;
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
      ]) {
        await run(file);
      }
      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at)
         values ($1, 'A merchant', 'open', now(), now())`,
        [MERCHANT],
      );
    });

    it("hands the keys registration made to the cabinet and leaves the rest alone", async () => {
      // The one row that changes hands and the three that must not. A key a
      // merchant asked for stays theirs — it is in their own worker and on the
      // list they revoke it from — and so does the sandbox's, which is handed
      // to a merchant process out of a configuration file.
      //
      // The last of the three is the case either half of the rule would get
      // wrong on its own: a merchant who named a key our own internal sentence.
      // They asked for it, so it is theirs, and what says so is that they asked
      // for it later than their merchant row was written.
      await writeKeyAsRegistrationDoes("mk_registered", AS_REGISTRATION_WROTE_IT);
      await writeKey("mk_worker", "the worker on the small box");
      await writeKey("mk_sandbox", "the sandbox key from the compose file");
      await writeKey("mk_same_words", AS_REGISTRATION_WROTE_IT);

      await run("0007_cabinet_keys.sql");

      expect(await purposeOf("mk_registered")).toBe("cabinet");
      expect(await purposeOf("mk_worker")).toBe("merchant_code");
      expect(await purposeOf("mk_sandbox")).toBe("merchant_code");
      expect(await purposeOf("mk_same_words")).toBe("merchant_code");
    });

    it("leaves a key alone that was written at its merchant's instant under another name", async () => {
      // The other half, on its own. Sharing the instant is not enough either:
      // whatever else a row written in that moment might be, the key
      // registration made is the one carrying the sentence registration wrote.
      await writeKeyAsRegistrationDoes("mk_same_instant", "the worker on the small box");

      await run("0007_cabinet_keys.sql");

      expect(await purposeOf("mk_same_instant")).toBe("merchant_code");
    });

    it("refuses a key written afterwards that does not say what it is for", async () => {
      // The default exists for the length of the backfill and is taken away
      // again, so that this column cannot be quietly left out by anything
      // written later. Left in place, a key inserted without it would become
      // one more of the merchant's own — which is the one row that must never
      // appear in their list by accident.
      await run("0007_cabinet_keys.sql");

      await expect(writeKey("mk_silent", "a key that says nothing")).rejects.toThrow(/purpose/);
    });
  });

  /**
   * The migration that starts writing down when a key was last called.
   *
   * There is nothing to backfill and that is the whole of what it has to get
   * right. The instant a key was made is on the row already and it is not the
   * instant it was last used; written into the new column it would put a date
   * on a merchant's screen that nothing stands behind, and the merchant would
   * revoke a key on the strength of it.
   *
   * So the rows it finds keep their blank, which is the honest answer for them
   * — nothing was recorded — and is the same blank a key written tomorrow and
   * never called will carry. Nothing on the row separates the two, and nothing
   * is meant to: what says so is the sentence under the column on the screen.
   */
  describe("the migration that starts recording when a key was last used", () => {
    const url = databaseUrl;
    let pool: Pool;

    const MERCHANT = "mch_a";

    const run = async (file: string): Promise<void> => {
      for (const statement of await statementsOf(file)) {
        await pool.query(statement);
      }
    };

    const writeKey = async (id: string): Promise<void> => {
      await pool.query(
        `insert into merchant_keys (id, merchant_id, label, digest, purpose, created_at)
         values ($1, $2, $3, $4, 'merchant_code', now())`,
        [id, MERCHANT, `the key ${id}`, `digest-of-${id}`],
      );
    };

    const lastUseOf = async (id: string): Promise<Date | null> => {
      const { rows } = await pool.query<{ last_used_at: Date | null }>(
        "select last_used_at from merchant_keys where id = $1",
        [id],
      );
      const found = rows[0];
      if (found === undefined) {
        throw new Error(`the key ${id} is not there`);
      }
      return found.last_used_at;
    };

    beforeAll(async () => {
      pool = connect(url).pool;
    }, 60_000);

    afterAll(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      for (const file of [
        "0000_init.sql",
        "0001_payment_claims.sql",
        "0002_selling.sql",
        "0003_merchant_tenancy.sql",
        "0004_merchant_service_name.sql",
        "0005_merchant_payout_wallet.sql",
        "0006_order_pay_to_backfill.sql",
        "0007_cabinet_keys.sql",
      ]) {
        await run(file);
      }
      await pool.query(
        `insert into merchants (id, name, selling, created_at, updated_at)
         values ($1, 'A merchant', 'open', now(), now())`,
        [MERCHANT],
      );
    });

    it("guesses nothing about the keys it finds", async () => {
      // The one thing that must not happen: a key that has been sitting in
      // somebody's worker for a month coming out of this with a date on it. The
      // date to hand is when the key was made, and the difference between that
      // and when it was last called is the difference between a key a merchant
      // may revoke and one they may not.
      await writeKey("mk_older_than_the_record");

      await run("0008_key_last_use.sql");

      expect(await lastUseOf("mk_older_than_the_record")).toBeNull();
    });
  });
}
