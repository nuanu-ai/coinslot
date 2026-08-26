import type { Card } from "@coinslot/contracts";
import type { Order } from "@coinslot/core";
import { describe, expect, it } from "vitest";
import type { StoredOrder } from "../../ports/store.js";
import { MemoryStore } from "./store.js";

const counted = () => {
  let issued = 0;
  return (kind: string) => {
    issued += 1;
    return `${kind}_${issued}`;
  };
};

const card = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: "a product",
  price: { amount: "5.00", currency: "USD" },
  result: { access_url: { type: "string" } },
  fulfillment: "sync",
});

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
  itemId: "item_1",
  merchantItemId: "sku-1",
  params: {},
  priceId: null,
  delivery: null,
  payment: null,
  settlement: null,
  paymentWords: [],
  openDeliveryId: null,
});

describe("MemoryStore cards", () => {
  it("changes the card that is there when it is published again, and keeps its catalog identifier", async () => {
    // The portal's promise: republishing under the same merchant_item_id is how
    // a card is changed rather than how a second one appears. A merchant who
    // corrected a typo and found two products in the catalog — one of them at
    // an address agents already hold — would have been told the opposite.
    const store = new MemoryStore(counted());

    const first = await store.publishCard(card("sku-1", "A room"), 1_000);
    const again = await store.publishCard(card("sku-1", "A room, corrected"), 2_000);

    expect(again.id).toBe(first.id);
    expect(again.asOf).toBe(2_000);
    expect(await store.cards()).toHaveLength(1);
    expect((await store.cardById(first.id))?.card.title).toBe("A room, corrected");
  });

  it("gives a different product its own identifier", async () => {
    const store = new MemoryStore(counted());

    const room = await store.publishCard(card("sku-1", "A room"), 1_000);
    const esim = await store.publishCard(card("sku-2", "An eSIM"), 1_000);

    expect(esim.id).not.toBe(room.id);
    expect(await store.cards()).toHaveLength(2);
  });

  it("has nothing to say about a card nobody published", async () => {
    expect(await new MemoryStore(counted()).cardById("item_nope")).toBeNull();
  });
});

describe("MemoryStore orders", () => {
  it("holds an order still, so two decisions about it cannot both write over the same read", async () => {
    // This is the double-charge test. Two events about one order arrive from
    // different places all the time — a payment and a deadline, an answer and a
    // redelivery — and if both read the same order and both write, the second
    // erases the first. Here that shows up as a lost increment; next to
    // someone else's money it shows up as a charge that happened twice.
    const store = new MemoryStore(counted());
    await store.addOrder(order("ord_1", "created"));

    const bump = () =>
      store.withOrder("ord_1", async (found) => {
        // A pause between the read and the write is what a real transaction
        // has, and what a lock has to survive.
        await Promise.resolve();
        const attempts = found.order.dispatch.attempts + 1;
        return {
          save: { ...found, order: { ...found.order, dispatch: { attempts, accepted: false } } },
          result: attempts,
        };
      });

    const [one, two, three] = await Promise.all([bump(), bump(), bump()]);

    expect([one, two, three]).toStrictEqual([
      { found: true, result: 1 },
      { found: true, result: 2 },
      { found: true, result: 3 },
    ]);
    expect((await store.orderById("ord_1"))?.order.dispatch.attempts).toBe(3);
  });

  it("does not make one order wait on another", async () => {
    const store = new MemoryStore(counted());
    await store.addOrder(order("ord_1", "created"));
    await store.addOrder(order("ord_2", "created"));

    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.withOrder("ord_1", async () => {
      await held;
      return { result: "first" };
    });
    const second = await store.withOrder("ord_2", () => ({ result: "second" }));

    expect(second).toStrictEqual({ found: true, result: "second" });
    releaseFirst();
    expect(await first).toStrictEqual({ found: true, result: "first" });
  });

  it("says an order is not there rather than throwing", async () => {
    // An agent asking after an order that never existed is ordinary. The caller
    // has to answer it, which it cannot do if the store crashes on it.
    const store = new MemoryStore(counted());
    expect(await store.withOrder("ord_nope", () => ({ result: 1 }))).toStrictEqual({
      found: false,
    });
  });

  it("writes nothing when the decision asked for nothing to be written", async () => {
    const store = new MemoryStore(counted());
    await store.addOrder(order("ord_1", "created"));

    await store.withOrder("ord_1", () => ({ result: "just looking" }));

    expect((await store.orderById("ord_1"))?.order.state).toBe("created");
  });

  it("lets the next decision about an order run after one of them failed", async () => {
    // A decision that threw must not take the order with it: every later event
    // about that order would inherit the failure and the order would be stuck
    // for good.
    const store = new MemoryStore(counted());
    await store.addOrder(order("ord_1", "created"));

    const broken = store.withOrder("ord_1", () => {
      throw new Error("the decision blew up");
    });
    await expect(broken).rejects.toThrow("the decision blew up");

    expect(await store.withOrder("ord_1", () => ({ result: "still here" }))).toStrictEqual({
      found: true,
      result: "still here",
    });
  });

  it("keeps what it was given, whatever the caller does with its copy afterwards", async () => {
    // The Postgres adapter would ignore an edit made to a returned object. If
    // this one honoured it, a bug would pass every test here and fail in
    // production.
    const store = new MemoryStore(counted());
    const record = order("ord_1", "created");
    await store.addOrder(record);

    const read = await store.orderById("ord_1");
    expect(() => {
      (read as { itemId: string }).itemId = "item_other";
    }).toThrow();

    expect((await store.orderById("ord_1"))?.itemId).toBe("item_1");
  });

  it("refuses to write an order twice under the same identifier", async () => {
    const store = new MemoryStore(counted());
    await store.addOrder(order("ord_1", "created"));
    await expect(store.addOrder(order("ord_1", "quoted"))).rejects.toThrow(/already written down/);
  });

  it("lists the orders still owed something apart from the ones that are over", async () => {
    // The merchant's list of unclosed orders has to show the two the portal
    // calls open after the purchase itself is over — a debt, and goods
    // delivered against a charge that never landed.
    const store = new MemoryStore(counted());
    await store.addOrder(order("ord_open", "dispatched"));
    await store.addOrder(order("ord_debt", "refund_due"));
    await store.addOrder(order("ord_unpaid", "delivered_unpaid"));
    await store.addOrder(order("ord_done", "delivered"));

    expect((await store.orders({ open: true })).map((o) => o.order.id)).toStrictEqual([
      "ord_open",
      "ord_debt",
      "ord_unpaid",
    ]);
    expect(await store.orders()).toHaveLength(4);
  });
});

describe("MemoryStore receipts", () => {
  it("keeps one receipt per order and finds it by the order", async () => {
    const store = new MemoryStore(counted());
    const receipt = {
      id: "rcp_1",
      order_id: "ord_1",
      item_id: "item_1",
      price: {
        amount: "5.00",
        currency: "USD",
        at: "2026-08-26T00:00:00.000Z",
        as_of: "2026-08-26T00:00:00.000Z",
      },
      paid_at: "2026-08-26T00:00:00.000Z",
      outcome: "delivered",
      test: true,
    } as const;

    await store.putReceipt(receipt);

    expect(await store.receiptForOrder("ord_1")).toStrictEqual(receipt);
    expect(await store.receiptForOrder("ord_2")).toBeNull();
    expect(await store.receipts()).toHaveLength(1);
  });
});
