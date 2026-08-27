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

/** The merchant almost every test here has, because a card needs one. */
const A = "mch_a";
/** A second one, for the tests whose subject is that the two cannot see each other. */
const B = "mch_b";

/** A store with two merchants already in it, which is what a scoped read needs. */
const twoMerchants = async (now?: () => number): Promise<MemoryStore> => {
  const store = new MemoryStore(counted(), now);
  await store.addMerchant({ id: A, name: "Merchant A" }, 0);
  await store.addMerchant({ id: B, name: "Merchant B" }, 0);
  return store;
};

const order = (id: string, state: Order["state"], merchantId = A): StoredOrder => ({
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
  merchantId,
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

describe("MemoryStore cards", () => {
  it("changes the card that is there when it is published again, and keeps its catalog identifier", async () => {
    // The portal's promise: republishing under the same merchant_item_id is how
    // a card is changed rather than how a second one appears. A merchant who
    // corrected a typo and found two products in the catalog — one of them at
    // an address agents already hold — would have been told the opposite.
    const store = await twoMerchants();

    const first = await store.publishCard(A, card("sku-1", "A room"), 1_000);
    const again = await store.publishCard(A, card("sku-1", "A room, corrected"), 2_000);

    expect(again.id).toBe(first.id);
    expect(again.asOf).toBe(2_000);
    expect(await store.cards(A)).toHaveLength(1);
    expect((await store.cardById(first.id))?.card.title).toBe("A room, corrected");
  });

  it("gives a different product its own identifier", async () => {
    const store = await twoMerchants();

    const room = await store.publishCard(A, card("sku-1", "A room"), 1_000);
    const esim = await store.publishCard(A, card("sku-2", "An eSIM"), 1_000);

    expect(esim.id).not.toBe(room.id);
    expect(await store.cards(A)).toHaveLength(2);
  });

  it("lets two merchants use one identifier for two different products", async () => {
    // A merchant's own identifier for a product means something inside their
    // catalog and nothing outside it, which is what the card contract has
    // always said. Held unique across the gateway, the second merchant to
    // publish a "sku-1" would edit the first merchant's card instead of
    // publishing their own.
    const store = await twoMerchants();

    const mine = await store.publishCard(A, card("sku-1", "A's room"), 1_000);
    const theirs = await store.publishCard(B, card("sku-1", "B's room"), 1_000);

    expect(theirs.id).not.toBe(mine.id);
    expect((await store.cards(A)).map((held) => held.card.title)).toStrictEqual(["A's room"]);
    expect((await store.cards(B)).map((held) => held.card.title)).toStrictEqual(["B's room"]);
  });

  it("shows the whole catalog with each card's own merchant's word beside it", async () => {
    // One catalog across every merchant is the product, and the selling word is
    // per merchant: A stopping takes A's cards out of what an agent sees and
    // leaves B's exactly where they were.
    const store = await twoMerchants();
    await store.publishCard(A, card("sku-1", "A's room"), 1_000);
    await store.publishCard(B, card("sku-1", "B's room"), 1_000);
    await store.setSelling(A, "paused");

    const entries = await store.catalogEntries();

    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.card.merchantId === A)?.merchant).toBe("paused");
    expect(entries.find((entry) => entry.card.merchantId === B)?.merchant).toBe("open");
  });

  it("has nothing to say about a card nobody published", async () => {
    expect(await (await twoMerchants()).cardById("item_nope")).toBeNull();
  });

  it("publishes a card selling, and keeps a pause across the next publish", async () => {
    // A merchant editing a price is not asking for a product they took off sale
    // to go back on it. A pause that evaporated on the next publish would put
    // stock they do not have in front of an agent, and nothing would say so.
    const store = await twoMerchants();
    const first = await store.publishCard(A, card("sku-1", "A room"), 1_000);
    expect(first.paused).toBe(false);

    await store.setCardPaused(A, first.id, true);
    const again = await store.publishCard(A, card("sku-1", "A room, dearer"), 2_000);

    expect(again.paused).toBe(true);
    expect((await store.cardById(first.id))?.paused).toBe(true);
  });

  it("says there is no such card rather than pausing nothing quietly", async () => {
    expect(await (await twoMerchants()).setCardPaused(A, "item_nope", true)).toBeNull();
  });

  it("answers another merchant's card exactly as it answers a card that is not there", async () => {
    // Two silences that have to sound the same. A pause call that said "that is
    // somebody else's" would be a way of finding out what a stranger sells.
    const store = await twoMerchants();
    const theirs = await store.publishCard(B, card("sku-1", "B's room"), 1_000);

    expect(await store.setCardPaused(A, theirs.id, true)).toBeNull();
    expect(await store.setCardPaused(A, "item_nope", true)).toBeNull();
    // And nothing happened to it.
    expect((await store.cardById(theirs.id))?.paused).toBe(false);
  });

  it("has a merchant selling until somebody says otherwise, and remembers when they do", async () => {
    // There is no state of the world in which we hold a merchant's cards and
    // cannot say whether they are selling, so this never answers "I do not
    // know" — and the answer it gives before anybody has pressed anything is
    // the one the order machine has been given all along.
    const store = await twoMerchants();

    expect(await store.selling(A)).toBe("open");

    await store.setSelling(A, "paused");
    expect(await store.selling(A)).toBe("paused");
    // One merchant's switch and nobody else's.
    expect(await store.selling(B)).toBe("open");

    await store.setSelling(A, "open");
    expect(await store.selling(A)).toBe("open");
  });

  it("will not answer for a merchant it does not hold, in either direction", async () => {
    // Answering "open" for a merchant nobody can find would be selling on
    // behalf of somebody who does not exist.
    const store = await twoMerchants();

    await expect(store.selling("mch_nobody")).rejects.toThrow(/mch_nobody/);
    await expect(store.setSelling("mch_nobody", "paused")).rejects.toThrow(/mch_nobody/);
  });
});

describe("MemoryStore merchants and their keys", () => {
  it("writes a merchant down once, and says so rather than writing over one", async () => {
    const store = new MemoryStore(counted());

    expect(await store.addMerchant({ id: A, name: "Merchant A" }, 1_000)).toMatchObject({
      id: A,
      name: "Merchant A",
      selling: "open",
    });
    // The one caller is a command somebody typed, and running it twice is a
    // thing people do. It must not replace the merchant that is there.
    expect(await store.addMerchant({ id: A, name: "Somebody else" }, 2_000)).toBeNull();
    expect((await store.merchantById(A))?.name).toBe("Merchant A");
  });

  it("resolves a key to its own merchant and never to another", async () => {
    const store = await twoMerchants();
    await store.addKey({ id: "mk_a", merchantId: A, label: "A's", digest: "digest-a" }, 1_000);
    await store.addKey({ id: "mk_b", merchantId: B, label: "B's", digest: "digest-b" }, 1_000);

    expect(await store.merchantForKey("digest-a")).toBe(A);
    expect(await store.merchantForKey("digest-b")).toBe(B);
  });

  it("answers a disabled key exactly as it answers a key nobody was issued", async () => {
    // No oracle. A door that told "this key exists and is off" apart from "this
    // was never a key" would confirm which guesses had once been real keys,
    // which is the thing revoking a key has to stop.
    const store = await twoMerchants();
    await store.addKey({ id: "mk_a", merchantId: A, label: "A's", digest: "digest-a" }, 1_000);

    await store.disableKey("mk_a", 2_000);

    expect(await store.merchantForKey("digest-a")).toBeNull();
    expect(await store.merchantForKey("a-digest-nobody-was-issued")).toBeNull();
  });

  it("leaves a merchant's other keys working when one of them is disabled", async () => {
    // The whole reason a key is a row rather than a variable.
    const store = await twoMerchants();
    await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
    await store.addKey({ id: "mk_2", merchantId: A, label: "two", digest: "digest-2" }, 1_000);

    await store.disableKey("mk_1", 2_000);

    expect(await store.merchantForKey("digest-1")).toBeNull();
    expect(await store.merchantForKey("digest-2")).toBe(A);
  });

  it("keeps the instant a key was first revoked at when it is revoked again", async () => {
    // A retry after a dropped connection must not rewrite the one fact somebody
    // reconstructing an incident is working from.
    const store = await twoMerchants();
    await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

    expect((await store.disableKey("mk_1", 2_000))?.disabledAt).toBe(2_000);
    expect((await store.disableKey("mk_1", 9_000))?.disabledAt).toBe(2_000);
  });

  it("says there is no such key rather than disabling nothing quietly", async () => {
    expect(await (await twoMerchants()).disableKey("mk_nope", 1_000)).toBeNull();
  });

  it("lists one merchant's keys, revoked ones included, and nobody else's", async () => {
    const store = await twoMerchants();
    await store.addKey({ id: "mk_a1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
    await store.addKey({ id: "mk_a2", merchantId: A, label: "two", digest: "digest-2" }, 1_000);
    await store.addKey({ id: "mk_b1", merchantId: B, label: "theirs", digest: "digest-3" }, 1_000);
    await store.disableKey("mk_a2", 2_000);

    expect((await store.keysOf(A)).map((key) => key.id)).toStrictEqual(["mk_a1", "mk_a2"]);
    expect((await store.keysOf(B)).map((key) => key.id)).toStrictEqual(["mk_b1"]);
  });

  it("finds a key by its digest whatever state it is in, which the door does not", async () => {
    // The one caller is the seed, which would otherwise issue a second key with
    // a digest already taken every time it ran against a key somebody disabled.
    const store = await twoMerchants();
    await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
    await store.disableKey("mk_1", 2_000);

    expect((await store.keyByDigest("digest-1"))?.id).toBe("mk_1");
    expect(await store.keyByDigest("a-digest-nobody-was-issued")).toBeNull();
  });

  it("refuses a key for a merchant that is not there", async () => {
    // A key that opens a door onto nothing is worse than a command that failed,
    // and the database refuses the same thing with a foreign key.
    const store = await twoMerchants();

    await expect(
      store.addKey({ id: "mk_1", merchantId: "mch_nobody", label: "one", digest: "d" }, 1_000),
    ).rejects.toThrow(/mch_nobody/);
  });
});

describe("MemoryStore orders", () => {
  it("holds an order still, so two decisions about it cannot both write over the same read", async () => {
    // This is the double-charge test. Two events about one order arrive from
    // different places all the time — a payment and a deadline, an answer and a
    // redelivery — and if both read the same order and both write, the second
    // erases the first. Here that shows up as a lost increment; next to
    // someone else's money it shows up as a charge that happened twice.
    const store = await twoMerchants();
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
    const store = await twoMerchants();
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
    const store = await twoMerchants();
    expect(await store.withOrder("ord_nope", () => ({ result: 1 }))).toStrictEqual({
      found: false,
    });
  });

  it("finds nothing where the order is another merchant's, and writes nothing", async () => {
    // The ownership is read under the same hold as the order itself, so there
    // is no window between learning whose it is and acting on it — and the
    // answer is the one an identifier naming nothing gets, so a merchant
    // holding one out of a log learns nothing by trying it.
    const store = await twoMerchants();
    await store.addOrder(order("ord_1", "created", B));

    const asA = await store.withOrder(
      "ord_1",
      (found) => ({
        save: { ...found, order: { ...found.order, state: "cancelled" as const } },
        result: "moved it",
      }),
      { merchantId: A },
    );

    expect(asA).toStrictEqual({ found: false });
    expect((await store.orderById("ord_1"))?.order.state).toBe("created");
  });

  it("does not let a decision about an order move it to another merchant", async () => {
    // A sale belongs to whoever made it, settled at the birth of the order and
    // never again. The Postgres adapter writes the merchant from the row and
    // leaves the column out of its update, so a save carrying a different one
    // would put the new merchant in the document and the old one in the column
    // — an order in one merchant's list whose envelopes go on another's stream.
    // Nothing reaches this today; the two adapters agreeing is what keeps it
    // that way.
    const store = await twoMerchants();
    await store.addOrder(order("ord_1", "created", A));

    await store.withOrder("ord_1", (found) => ({
      save: { ...found, merchantId: B, order: { ...found.order, state: "quoted" as const } },
      result: null,
    }));

    expect((await store.orderById("ord_1"))?.merchantId).toBe(A);
    expect((await store.orders(A)).map((held) => held.order.id)).toStrictEqual(["ord_1"]);
    expect(await store.orders(B)).toStrictEqual([]);
    // And the change the decision was actually making did land.
    expect((await store.orderById("ord_1"))?.order.state).toBe("quoted");
  });

  it("hands one merchant their own order and calls another's not found", async () => {
    const store = await twoMerchants();
    await store.addOrder(order("ord_mine", "created", A));
    await store.addOrder(order("ord_theirs", "created", B));

    expect((await store.merchantOrder(A, "ord_mine"))?.order.id).toBe("ord_mine");
    expect(await store.merchantOrder(A, "ord_theirs")).toBeNull();
    // The buying surface's read is unscoped on purpose: the route that uses it
    // takes no key, because the payment presented stands in for one.
    expect((await store.orderById("ord_theirs"))?.order.id).toBe("ord_theirs");
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
    const store = await twoMerchants();
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
    const store = await twoMerchants();
    const record = order("ord_1", "created");
    await store.addOrder(record);

    const read = await store.orderById("ord_1");
    expect(() => {
      (read as { itemId: string }).itemId = "item_other";
    }).toThrow();

    expect((await store.orderById("ord_1"))?.itemId).toBe("item_1");
  });

  it("refuses to write an order twice under the same identifier", async () => {
    const store = await twoMerchants();
    await store.addOrder(order("ord_1", "created"));
    await expect(store.addOrder(order("ord_1", "quoted"))).rejects.toThrow(/already written down/);
  });

  it("lists the orders still owed something apart from the ones that are over", async () => {
    // The merchant's list of unclosed orders has to show the two the portal
    // calls open after the purchase itself is over — a debt, and goods
    // delivered against a charge that never landed.
    const store = await twoMerchants();
    await store.addOrder(order("ord_open", "dispatched"));
    await store.addOrder(order("ord_debt", "refund_due"));
    await store.addOrder(order("ord_unpaid", "delivered_unpaid"));
    await store.addOrder(order("ord_done", "delivered"));
    // Another merchant's open order, which must be in neither list.
    await store.addOrder(order("ord_theirs", "dispatched", B));

    expect((await store.orders(A, { open: true })).map((o) => o.order.id)).toStrictEqual([
      "ord_open",
      "ord_debt",
      "ord_unpaid",
    ]);
    expect(await store.orders(A)).toHaveLength(4);
    expect((await store.orders(B)).map((o) => o.order.id)).toStrictEqual(["ord_theirs"]);
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

describe("MemoryStore payment claims", () => {
  it("gives one payment to one order, and refuses it to any other", async () => {
    // This is the replay guard. A signed payment says how much, to whom and on
    // which chain, and nothing about which purchase it is for — so without
    // this, two orders at the same price are payable with one signature, both
    // reach a merchant, both are delivered, and only the second charge fails.
    const store = await twoMerchants();

    expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });
    expect(await store.claimPayment("fp-1", "ord_2")).toStrictEqual({
      claimed: false,
      heldBy: "ord_1",
    });
    // And a different payment is nobody's yet.
    expect(await store.claimPayment("fp-2", "ord_2")).toStrictEqual({ claimed: true });
  });

  it("lets the order that owns a payment present it again", async () => {
    // A dropped connection and a retry is the ordinary case, and the portal
    // promises the merchant that repeating a call is safe.
    const store = await twoMerchants();
    await store.claimPayment("fp-1", "ord_1");

    expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });
  });

  it("forgets claims older than an instant, and says how many went", async () => {
    // They cannot be kept forever: the route that makes them takes no key.
    let now = 1_000;
    const store = await twoMerchants(() => now);

    await store.claimPayment("old", "ord_1");
    now = 5_000;
    await store.claimPayment("fresh", "ord_2");

    expect(await store.forgetClaimsBefore(2_000)).toBe(1);
    // The old one is free again; the fresh one still belongs to its order.
    expect(await store.claimPayment("old", "ord_3")).toStrictEqual({ claimed: true });
    expect(await store.claimPayment("fresh", "ord_3")).toStrictEqual({
      claimed: false,
      heldBy: "ord_2",
    });
  });
});

describe("MemoryStore receipts", () => {
  it("keeps one receipt per order and finds it by the order", async () => {
    const store = await twoMerchants();
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

    await store.putReceipt(A, receipt);

    expect(await store.receiptForOrder("ord_1")).toStrictEqual(receipt);
    expect(await store.receiptForOrder("ord_2")).toBeNull();
    expect(await store.receipts(A)).toHaveLength(1);
  });

  it("gives each merchant their own receipts and none of the other's", async () => {
    const store = await twoMerchants();
    const receipt = (id: string, orderId: string) =>
      ({
        id,
        order_id: orderId,
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
      }) as const;

    await store.putReceipt(A, receipt("rcp_1", "ord_1"));
    await store.putReceipt(B, receipt("rcp_2", "ord_2"));

    expect((await store.receipts(A)).map((held) => held.id)).toStrictEqual(["rcp_1"]);
    expect((await store.receipts(B)).map((held) => held.id)).toStrictEqual(["rcp_2"]);
    // The agent's own answer to its purchase carries the receipt, and the agent
    // has no key, so this read is unscoped on purpose.
    expect((await store.receiptForOrder("ord_2"))?.id).toBe("rcp_2");
  });

  it("does not let a receipt change hands when it is written again", async () => {
    // The machine writes a receipt again as an order moves on. That is not an
    // occasion for the sale to belong to somebody else.
    const store = await twoMerchants();
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

    await store.putReceipt(A, receipt);
    // Written again, and named for the wrong merchant. The rewrite lands and
    // the ownership does not move: what the machine is doing here is bringing a
    // receipt into line with an order, not selling it to somebody else.
    await store.putReceipt(B, { ...receipt, outcome: "refund_due" });

    expect((await store.receipts(A)).map((held) => held.outcome)).toStrictEqual(["refund_due"]);
    expect(await store.receipts(B)).toStrictEqual([]);
  });
});
