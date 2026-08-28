/**
 * The store the whole of the application logic is tested against.
 *
 * Almost everything this adapter promises is a promise about the port rather
 * than about a map, so almost everything it is checked for lives in
 * `testing/store-contract.ts` and is run twice: here against these maps, and
 * under `pnpm test:db` against a real Postgres. Written out twice instead, the
 * two copies drift, and they drift in one direction — the fast store is the one
 * everybody develops against, so the promise a purchase actually rests on is
 * the one nobody checked.
 *
 * What is left in this file is what only this adapter can be asked. An order
 * that refuses to be edited after it has been handed out is about objects in
 * one process; the Postgres adapter builds a fresh document on every read and
 * would ignore such an edit, so the two cannot be asked the same question. The
 * writes that go with an order are the same shape of thing: there the promise
 * comes from a transaction, and here it comes from the order the writes are
 * taken in, so what each one has to be checked for is its own arrangement and
 * not a shared sentence.
 */

import type { Order } from "@coinslot/core";
import { describe, expect, it } from "vitest";
import type { StoredOrder } from "../../ports/store.js";
import { describeStore } from "../../testing/store-contract.js";
import { MemoryStore } from "./store.js";

const counted = () => {
  let issued = 0;
  return (kind: string) => {
    issued += 1;
    return `${kind}_${issued}`;
  };
};

/** The merchant everything here belongs to, because an order needs one. */
const A = "mch_a";

const order = (id: string, state: Order["state"]): StoredOrder => ({
  order: {
    id,
    state,
    mode: { needsConfirmation: false, settle: "after_fulfillment" },
    policy: {
      deadlines: {
        quoteResponseMs: 1,
        quoteTtlMs: 1,
        settleResponseMs: 1,
        syncResponseMs: 1,
        paymentAfterConfirmationMs: 1,
        confirmationResponseMs: 1,
        asyncFulfillmentMs: 1,
      },
      redelivery: { baseDelayMs: 1, factor: 1, maxDelayMs: 1, maxAttempts: 1 },
    },
    payment: "none",
    cardPrice: { amount: "5.00", currency: "USD", asOf: 0 },
    price: null,
    quoteSource: null,
    dispatch: { attempts: 0, accepted: false },
    heldFulfillment: false,
    closure: null,
    test: true,
    timestamps: {
      createdAt: 0,
      quotedAt: null,
      confirmationRequestedAt: null,
      confirmedAt: null,
      settleStartedAt: null,
      paidAt: null,
      dispatchedAt: null,
    },
  },
  merchantId: A,
  itemId: "item_1",
  merchantItemId: "sku-1",
  params: {},
  priceId: null,
  delivery: null,
  payment: null,
  paidBy: null,
  settlement: null,
  paymentWords: [],
  paymentWordsDropped: 0,
  openDeliveryId: null,
});

describeStore("the store in memory", async () => new MemoryStore(counted()));

describe("MemoryStore, where it is not like the other one", () => {
  it("keeps what it was given, whatever the caller does with its copy afterwards", async () => {
    // The Postgres adapter would ignore an edit made to a returned object,
    // because what it hands back is built from a row and thrown away. If this
    // one honoured it, a caller editing what it read would be editing the
    // database — a bug that passes every test in the shared suite and fails in
    // production.
    const store = new MemoryStore(counted());
    await store.addMerchant({ id: A, name: "Merchant A" }, 0);
    await store.addOrder(order("ord_1", "created"));

    const read = await store.orderById("ord_1");
    expect(() => {
      (read as { itemId: string }).itemId = "item_other";
    }).toThrow();

    expect((await store.orderById("ord_1"))?.itemId).toBe("item_1");
  });

  it("says which merchant a key was refused for", async () => {
    // The shared suite can only ask that this is refused, not what it says.
    // There the refusal is the database's foreign key and reaches the caller as
    // the driver's own error, whose message happens to contain the merchant's
    // identifier among the statement's bound parameters — so a test matching it
    // would pass on a leak rather than on a sentence anybody wrote.
    //
    // Here the refusal is a guard of this adapter's own, standing in for that
    // foreign key, and what it says is this adapter's to promise. Whoever meets
    // it is running the seed or a command they typed, and the one thing they
    // need is which merchant the store cannot find: a bare "no such merchant"
    // in the middle of a script that names four of them is a message that
    // starts an investigation rather than ending one.
    const store = new MemoryStore(counted());
    await store.addMerchant({ id: A, name: "Merchant A" }, 0);

    await expect(
      store.addKey({ id: "mk_1", merchantId: "mch_nobody", label: "one", digest: "d" }, 1_000),
    ).rejects.toThrow(/mch_nobody/);
  });
});

describe("MemoryStore writes that go with an order", () => {
  it("does not let an envelope be seen before the order that implies it", async () => {
    // The sentence this adapter's atomicity rests on. An order envelope would
    // survive the other ordering, because acting on one comes back through this
    // store's own hold; a merchant event would not, because the poll hands one
    // over without touching the order at all. So the envelope becomes visible
    // after the order is written, and this is what says so.
    let seenState: string | undefined;
    let store!: MemoryStore;
    store = new MemoryStore(counted(), undefined, async (_merchantId, envelope) => {
      expect(envelope.id).toBe("env_1");
      return () => {
        // Read inside the arrival, which is the whole point: by now the store
        // must already be saying what the envelope announces.
        void store.orderById("ord_1").then((found) => {
          seenState = found?.order.state;
        });
      };
    });
    await store.addMerchant({ id: A, name: "Merchant A" }, 0);
    await store.addOrder(order("ord_1", "paid"));

    await store.withOrder("ord_1", (found) => ({
      save: { ...found, order: { ...found.order, state: "dispatched" } },
      alongside: [
        {
          kind: "envelope",
          merchantId: A,
          envelope: {
            kind: "order_event",
            id: "env_1",
            sent_at: "2026-08-26T12:00:00.000Z",
            payload: {
              type: "order.refund_due",
              order_id: "ord_1",
              at: "2026-08-26T12:00:00.000Z",
              price: { amount: "5.00", currency: "USD" },
              reason: "deadline_passed",
            },
          },
        },
      ],
      result: null,
    }));

    await Promise.resolve();
    expect(seenState).toBe("dispatched");
  });

  it("writes nothing at all when one of the writes refuses", async () => {
    // All or nothing, which is what the port promises and what the Postgres
    // adapter gets from a transaction. Here it comes from the order the writes
    // are taken in — the one that can refuse goes first — so a refusal leaves
    // no receipt, no envelope and an order exactly where it was.
    const store = new MemoryStore(counted(), undefined, async () => {
      throw new Error("the stream would not take it");
    });
    await store.addMerchant({ id: A, name: "Merchant A" }, 0);
    await store.addOrder(order("ord_1", "paid"));

    await expect(
      store.withOrder("ord_1", (found) => ({
        save: { ...found, order: { ...found.order, state: "delivered" } },
        alongside: [
          {
            kind: "receipt",
            merchantId: A,
            receipt: {
              id: "rcp_1",
              order_id: "ord_1",
              item_id: "item_1",
              price: {
                amount: "5.00",
                currency: "USD",
                at: "2026-08-26T12:00:00.000Z",
                as_of: "2026-08-26T12:00:00.000Z",
              },
              paid_at: "2026-08-26T12:00:00.000Z",
              outcome: "delivered",
              test: true,
            },
          },
          {
            kind: "envelope",
            merchantId: A,
            envelope: {
              kind: "order",
              id: "env_1",
              sent_at: "2026-08-26T12:00:00.000Z",
              payload: {
                id: "ord_1",
                merchant_item_id: "sku-1",
                params: {},
                price: {
                  amount: "5.00",
                  currency: "USD",
                  at: "2026-08-26T12:00:00.000Z",
                  as_of: "2026-08-26T12:00:00.000Z",
                },
                test: true,
              },
            },
          },
        ],
        result: null,
      })),
    ).rejects.toThrow("the stream would not take it");

    expect((await store.orderById("ord_1"))?.order.state).toBe("paid");
    // The receipt is named second in the list and is written first by nothing:
    // the envelope that refuses is taken before it, so it never happened.
    expect(await store.receiptForOrder("ord_1")).toBeNull();
  });
});
