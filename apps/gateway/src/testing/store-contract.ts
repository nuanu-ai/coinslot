/**
 * The promises the store keeps, written once and run against both of them.
 *
 * There are two stores: the one a deployment runs on, which is Postgres, and
 * the one the whole of the application logic is tested against, which is a
 * handful of maps in memory. Two implementations of one interface drift, and
 * the way they drift is that the fast one is the one everybody develops
 * against — so the promise an agent's purchase actually rests on is the one
 * nobody checked. Until this file the answer was prose: a comment in one test
 * file naming the other, and a reader trusted to keep them in step. This is the
 * same answer with teeth. The suite runs under `pnpm test` against memory and
 * under `pnpm test:db` against a real database, and a difference between them
 * is a failure rather than a surprise in front of a merchant.
 *
 * The store handed back by `open` is empty and has nothing in it — no merchant,
 * no card, no order — because every test here builds what it needs and a store
 * carrying somebody else's leftovers is a store whose counts mean nothing.
 *
 * Two things are deliberately kept out, and both for the same reason: they are
 * not promises about the port, they are promises about one adapter's machinery.
 *
 * The first is anything that pins an adapter's own materials. A returned object
 * that refuses to be edited is an in-memory concern — the Postgres adapter
 * hands back a fresh document on every read and would ignore an edit to it — so
 * it stays in the in-memory file. So do the round trips, the driver's error
 * codes, the pool's listeners, the advisory lock across two connections and the
 * migrations, which stay in the database file.
 *
 * The second is the clock and the identifiers. Nothing here asserts what an
 * identifier looks like beyond what the port says about it, and nothing waits
 * on wall time: where an instant is needed it is passed in, and the one place
 * that cannot be — a claim on a payment is stamped by whichever adapter's own
 * clock — is asked about with an instant well before and well after rather than
 * with a count of milliseconds.
 *
 * What is not covered here is worth naming as plainly. `openOrders`,
 * `deliveredWithoutReceipt`, `runAlone` and `merchants` have no case in this
 * suite, because they had none in the in-memory file either and inventing
 * coverage is a separate piece of work from stopping two adapters drifting.
 * `runAlone` in particular is checked on Postgres across two pools, which is
 * where it can actually fail, and nowhere in memory. Writes that go alongside
 * an order — the envelopes of ADR-0013 — are also absent: what each adapter has
 * to arrange for them is its own, one transaction against one ordering, and
 * both files check theirs where the failure lives.
 */

import type { Card, Receipt } from "@coinslot/contracts";
import type { Order } from "@coinslot/core";
import { describe, expect, it } from "vitest";
import type { Store, StoredOrder } from "../ports/store.js";

/** The merchant almost everything here belongs to, because a card needs one. */
const A = "mch_a";
/** A second one, for the cases whose subject is that the two cannot see each other. */
const B = "mch_b";

const card = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: "a product",
  price: { amount: "5.00", currency: "USD" },
  result: { access_url: { type: "string" } },
  fulfillment: "sync",
});

/**
 * One order, as little of one as the store will accept.
 *
 * The instant it was created at is a parameter and not a constant, and what
 * that buys is a stable answer rather than a known one. Nothing here asserts
 * the order a merchant's list comes back in — the port promises none and the
 * comparisons above sort — but the database orders that list by this instant,
 * so orders sharing one would come back in whatever order the planner chose
 * that time. Distinct instants are what keep a list read twice the same list,
 * which is the difference between a suite that fails and a suite that flickers.
 */
const anOrder = (
  id: string,
  state: Order["state"],
  at: { readonly merchantId?: string; readonly createdAt?: number } = {},
): StoredOrder => ({
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
      createdAt: at.createdAt ?? 1_000,
      quotedAt: null,
      confirmationRequestedAt: null,
      confirmedAt: null,
      settleStartedAt: null,
      paidAt: null,
      dispatchedAt: null,
    },
  },
  merchantId: at.merchantId ?? A,
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

const aReceipt = (id: string, orderId: string, outcome: Receipt["outcome"]): Receipt => ({
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
  outcome,
  test: true,
});

/**
 * What the work answered, or the news that it had not answered in time.
 *
 * The one case that needs this is the one where the failure is a wait that
 * never ends. Left to the runner, a store that made two orders share a lock
 * would show up as a test timing out after thirty seconds with nothing said
 * about why; with a bound of its own it shows up as an assertion naming the
 * thing that went wrong.
 */
async function answeredWithin<T>(ms: number, work: Promise<T>): Promise<T | "still waiting"> {
  let bell: ReturnType<typeof setTimeout> | undefined;
  const rang = new Promise<"still waiting">((resolve) => {
    bell = setTimeout(() => resolve("still waiting"), ms);
  });
  try {
    return await Promise.race([work, rang]);
  } finally {
    clearTimeout(bell);
  }
}

/**
 * The identifiers of a list of orders, in an order of this suite's own.
 *
 * Which order a merchant's orders come back in is not among the things the
 * port promises, and the two adapters do not arrive at one the same way: a
 * column decides it in the database and the sequence a map was filled in
 * decides it in memory. A comparison written as a sequence would therefore be
 * asserting whatever the fixture happened to produce, so what is compared is a
 * set, laid out in one order so a failure still reads as a list.
 */
async function idsOf(orders: Promise<readonly StoredOrder[]>): Promise<string[]> {
  return (await orders).map((held) => held.order.id).sort((one, other) => one.localeCompare(other));
}

/**
 * What a call that had to be refused was refused with.
 *
 * It fails rather than answering when nothing was refused, so that a store
 * which quietly accepted the write is reported as the defect it is instead of
 * as an assertion about `undefined`.
 */
async function refusalOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("nothing was refused, and being refused is what this is about");
}

/**
 * Everything an unhandled failure would put in a log.
 *
 * `console.error` prints an exception's causes as well as its own message, so
 * the whole chain is what actually reaches whatever collects the log — and the
 * whole chain is what a test about something that must not be written down has
 * to read. A refusal that carried the driver's own error as its cause would
 * pass a test that only read the top message.
 */
function asLogged(thrown: unknown): string {
  const said: string[] = [];
  let at: unknown = thrown;
  for (let deep = 0; deep < 8 && at !== null && at !== undefined; deep += 1) {
    said.push(String(at), JSON.stringify(at) ?? "");
    at = typeof at === "object" && "cause" in at ? (at as { cause: unknown }).cause : null;
  }
  return said.join(" ");
}

/** Runs the whole contract against one store. */
export function describeStore(name: string, open: () => Promise<Store>): void {
  describe(name, () => {
    /** An empty store, for the few cases whose subject is a store with nothing in it. */
    const fresh = open;

    /** A store with two merchants in it, which is what a card or an order needs. */
    const twoMerchants = async (): Promise<Store> => {
      const store = await open();
      await store.addMerchant({ id: A, name: "Merchant A" }, 1_000);
      await store.addMerchant({ id: B, name: "Merchant B" }, 2_000);
      return store;
    };

    describe("a card", () => {
      it("is changed by being published again, and keeps its catalog identifier", async () => {
        // The portal's promise: republishing under the same merchant_item_id is
        // how a card is changed rather than how a second one appears. A merchant
        // who corrected a typo and found two products in the catalog — one of
        // them at an address agents already hold — would have been told the
        // opposite.
        const store = await twoMerchants();

        const first = await store.publishCard(A, card("sku-1", "A room"), 10_000);
        const again = await store.publishCard(A, card("sku-1", "A room, corrected"), 20_000);

        expect(again.id).toBe(first.id);
        expect(again.asOf).toBe(20_000);
        expect(await store.cards(A)).toHaveLength(1);
        expect((await store.cardById(first.id))?.card.title).toBe("A room, corrected");
      });

      it("gets its own identifier when it is a different product", async () => {
        const store = await twoMerchants();

        const room = await store.publishCard(A, card("sku-1", "A room"), 10_000);
        const esim = await store.publishCard(A, card("sku-2", "An eSIM"), 20_000);

        expect(esim.id).not.toBe(room.id);
        expect(await store.cards(A)).toHaveLength(2);
      });

      it("is one merchant's even where two merchants use one identifier", async () => {
        // A merchant's own identifier for a product means something inside their
        // catalog and nothing outside it, which is what the card contract has
        // always said. Held unique across the gateway, the second merchant to
        // publish a "sku-1" would edit the first merchant's card instead of
        // publishing their own.
        const store = await twoMerchants();

        const mine = await store.publishCard(A, card("sku-1", "A's room"), 10_000);
        const theirs = await store.publishCard(B, card("sku-1", "B's room"), 20_000);

        expect(theirs.id).not.toBe(mine.id);
        expect((await store.cards(A)).map((held) => held.card.title)).toStrictEqual(["A's room"]);
        expect((await store.cards(B)).map((held) => held.card.title)).toStrictEqual(["B's room"]);
      });

      it("is nothing at all when nobody published it", async () => {
        expect(await (await twoMerchants()).cardById("item_nope")).toBeNull();
      });

      it("is published selling, and stays off sale across the next publish", async () => {
        // A merchant editing a price is not asking for a product they took off
        // sale to go back on it. A pause that evaporated on the next publish
        // would put stock they do not have in front of an agent, and nothing
        // would say so.
        const store = await twoMerchants();
        const first = await store.publishCard(A, card("sku-1", "A room"), 10_000);
        expect(first.paused).toBe(false);

        await store.setCardPaused(A, first.id, true);
        const again = await store.publishCard(A, card("sku-1", "A room, dearer"), 20_000);

        expect(again.paused).toBe(true);
        expect(again.card.title).toBe("A room, dearer");
        expect((await store.cardById(first.id))?.paused).toBe(true);
      });

      it("goes off sale and back on, and says so about one that is not there", async () => {
        const store = await twoMerchants();
        const stored = await store.publishCard(A, card("sku-1", "A room"), 10_000);

        expect((await store.setCardPaused(A, stored.id, true))?.paused).toBe(true);
        expect((await store.cardById(stored.id))?.paused).toBe(true);
        expect((await store.setCardPaused(A, stored.id, false))?.paused).toBe(false);
        expect(await store.setCardPaused(A, "item_nope", true)).toBeNull();
      });

      it("is another merchant's exactly as loudly as it is nobody's", async () => {
        // Two silences that have to sound the same. A pause call that said "that
        // is somebody else's" would be a way of finding out what a stranger
        // sells.
        const store = await twoMerchants();
        const theirs = await store.publishCard(B, card("sku-1", "B's room"), 10_000);

        expect(await store.setCardPaused(A, theirs.id, true)).toBeNull();
        expect(await store.setCardPaused(A, "item_nope", true)).toBeNull();
        // And nothing happened to it.
        expect((await store.cardById(theirs.id))?.paused).toBe(false);
      });
    });

    describe("the catalog", () => {
      it("carries every card with its own merchant's word beside it", async () => {
        // One catalog across every merchant is the product, and the selling word
        // is per merchant: A stopping takes A's cards out of what an agent sees
        // and leaves B's exactly where they were.
        const store = await twoMerchants();
        await store.publishCard(A, card("sku-1", "A's room"), 10_000);
        await store.publishCard(B, card("sku-1", "B's room"), 20_000);
        await store.setSelling(A, "paused");

        const entries = await store.catalogEntries();

        expect(entries).toHaveLength(2);
        expect(entries.find((entry) => entry.card.merchantId === A)?.merchant).toBe("paused");
        expect(entries.find((entry) => entry.card.merchantId === B)?.merchant).toBe("open");
      });
    });

    describe("whether a merchant is selling", () => {
      it("is open until somebody says otherwise, and is remembered when they do", async () => {
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

      it("is refused for a merchant the store does not hold, in either direction", async () => {
        // Answering "open" for a merchant nobody can find would be selling on
        // behalf of somebody who does not exist.
        //
        // The merchant is named in the refusal by both adapters and that is
        // asserted, because the one thing an operator reading this needs is
        // which merchant the gateway cannot find.
        const store = await twoMerchants();

        await expect(store.selling("mch_nobody")).rejects.toThrow(/mch_nobody/);
        await expect(store.setSelling("mch_nobody", "paused")).rejects.toThrow(/mch_nobody/);
      });
    });

    describe("a merchant", () => {
      it("is written down once, and is not written over by a second attempt", async () => {
        // The one caller is a command somebody typed, and running it twice is a
        // thing people do. It must not replace the merchant that is there.
        const store = await fresh();

        expect(await store.addMerchant({ id: A, name: "Merchant A" }, 1_000)).toMatchObject({
          id: A,
          name: "Merchant A",
          selling: "open",
        });
        expect(await store.addMerchant({ id: A, name: "Somebody else" }, 2_000)).toBeNull();
        expect((await store.merchantById(A))?.name).toBe("Merchant A");
      });

      it("is listed under a name for a catalog only where somebody set one", async () => {
        // The name a seller is listed under travels to strangers, and everything
        // offline is tested against the in-memory store. A column that took a
        // name and gave back something else — or, worse, one that answered for a
        // merchant nobody named — would show up only in production, in a
        // catalog.
        const store = await twoMerchants();

        const made = await store.merchantById(A);
        expect(made?.name).toBe("Merchant A");
        // Nobody has named one, which is the ordinary state and is never filled
        // in from the name a person reads at a terminal.
        expect(made?.serviceName).toBeNull();

        expect((await store.setServiceName(A, "Freeland", 3_000))?.serviceName).toBe("Freeland");
        expect((await store.merchantById(A))?.serviceName).toBe("Freeland");

        expect((await store.setServiceName(A, null, 4_000))?.serviceName).toBeNull();
        expect((await store.merchantById(A))?.serviceName).toBeNull();
        // And the merchant beside them was never listed under anything.
        expect((await store.merchantById(B))?.serviceName).toBeNull();

        expect(await store.setServiceName("mch_nobody", "Freeland", 5_000)).toBeNull();
      });
    });

    describe("a key", () => {
      it("opens the door onto its own merchant and never onto another", async () => {
        const store = await twoMerchants();
        await store.addKey({ id: "mk_a", merchantId: A, label: "A's", digest: "digest-a" }, 1_000);
        await store.addKey({ id: "mk_b", merchantId: B, label: "B's", digest: "digest-b" }, 2_000);

        expect(await store.merchantForKey("digest-a")).toBe(A);
        expect(await store.merchantForKey("digest-b")).toBe(B);
      });

      it("is refused once disabled, exactly as a key nobody was issued is", async () => {
        // No oracle. A door that told "this key exists and is off" apart from
        // "this was never a key" would confirm which guesses had once been real
        // keys, which is the thing revoking a key has to stop.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_a", merchantId: A, label: "A's", digest: "digest-a" }, 1_000);

        await store.disableKey("mk_a", 2_000);

        expect(await store.merchantForKey("digest-a")).toBeNull();
        expect(await store.merchantForKey("a-digest-nobody-was-issued")).toBeNull();
      });

      it("leaves its merchant's other keys working when it is disabled", async () => {
        // The whole reason a key is a row rather than a variable.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
        await store.addKey({ id: "mk_2", merchantId: A, label: "two", digest: "digest-2" }, 2_000);

        await store.disableKey("mk_1", 3_000);

        expect(await store.merchantForKey("digest-1")).toBeNull();
        expect(await store.merchantForKey("digest-2")).toBe(A);
      });

      it("keeps the instant it was first revoked at when it is revoked again", async () => {
        // A retry after a dropped connection must not rewrite the one fact
        // somebody reconstructing an incident is working from.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        expect((await store.disableKey("mk_1", 2_000))?.disabledAt).toBe(2_000);
        expect((await store.disableKey("mk_1", 9_000))?.disabledAt).toBe(2_000);
      });

      it("is said not to be there rather than disabled quietly", async () => {
        expect(await (await twoMerchants()).disableKey("mk_nope", 1_000)).toBeNull();
      });

      it("is in its own merchant's list, revoked or not, and in nobody else's", async () => {
        const store = await twoMerchants();
        await store.addKey({ id: "mk_a1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
        await store.addKey({ id: "mk_a2", merchantId: A, label: "two", digest: "digest-2" }, 2_000);
        await store.addKey(
          { id: "mk_b1", merchantId: B, label: "theirs", digest: "digest-3" },
          3_000,
        );
        await store.disableKey("mk_a2", 4_000);

        expect((await store.keysOf(A)).map((key) => key.id)).toStrictEqual(["mk_a1", "mk_a2"]);
        expect((await store.keysOf(B)).map((key) => key.id)).toStrictEqual(["mk_b1"]);
      });

      it("is found by its digest whatever state it is in, which the door is not", async () => {
        // The one caller is the seed, which would otherwise issue a second key
        // with a digest already taken every time it ran against a key somebody
        // disabled.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);
        await store.disableKey("mk_1", 2_000);

        expect((await store.keyByDigest("digest-1"))?.id).toBe("mk_1");
        expect(await store.keyByDigest("a-digest-nobody-was-issued")).toBeNull();
      });

      it("is refused for a merchant that is not there", async () => {
        // A key that opens a door onto nothing is worse than a command that
        // failed. In the database that refusal is a foreign key; in memory it is
        // a guard standing in for one, and the two have to agree that this is a
        // failure rather than a key.
        //
        // What is not asserted is the wording, and deliberately. The database's
        // refusal reaches us as the driver's, and the driver's message happens
        // to carry every bound parameter — so a test matching the merchant's
        // name here would pass on a leak rather than on a sentence anybody
        // wrote.
        const store = await twoMerchants();

        await expect(
          store.addKey({ id: "mk_1", merchantId: "mch_nobody", label: "one", digest: "d" }, 1_000),
        ).rejects.toThrow();
        expect(await store.merchantForKey("d")).toBeNull();
      });

      it("is refused under an identifier another key already has", async () => {
        // The identifiers are ours, so a clash is a defect in whatever issues
        // them rather than anything a merchant can cause. What it must never be
        // is a silent overwrite: one merchant's key replaced by another's, the
        // first still in somebody's configuration and no longer opening
        // anything, and nobody told.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        await expect(
          store.addKey({ id: "mk_1", merchantId: B, label: "theirs", digest: "digest-2" }, 2_000),
        ).rejects.toThrow(/the key mk_1 is already written down/);

        // The key that was there still opens its own door, and the one that was
        // refused opens none.
        expect(await store.merchantForKey("digest-1")).toBe(A);
        expect(await store.merchantForKey("digest-2")).toBeNull();
      });

      it("is refused under a digest another key already has", async () => {
        // The door resolves a request by the digest alone, so two keys carrying
        // one digest would be one secret opening two merchants' doors — and
        // which merchant a request reached would come down to which row the
        // database happened to hand back. The command that issues keys asks
        // `keyByDigest` before it writes; this is what stands behind that when
        // two issues race, and it is the database's own rule rather than a
        // check somebody remembered.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        await expect(
          store.addKey({ id: "mk_2", merchantId: B, label: "theirs", digest: "digest-1" }, 2_000),
        ).rejects.toThrow(/a key with that digest is already written down/);

        expect(await store.merchantForKey("digest-1")).toBe(A);
        expect((await store.keysOf(B)).map((key) => key.id)).toStrictEqual([]);
      });

      it("is refused without ever saying the digest out loud", async () => {
        // A digest is the stored form of a secret its owner was shown once and
        // nothing can read back, and a refusal is the one moment the store has
        // it in hand with something going wrong. The database's own refusal
        // carries it twice over — in the statement's bound parameters and in
        // the detail line naming the value that clashed — so a store that
        // passed the driver's error along, or hung it on a refusal of its own as
        // a cause, would put every merchant's stored secret into whatever
        // collects the log the first time a key was issued twice.
        //
        // Both routes to a refusal are read, because the parameters of the
        // insert carry the digest whichever of the two rules turned it away.
        const store = await twoMerchants();
        await store.addKey({ id: "mk_1", merchantId: A, label: "one", digest: "digest-1" }, 1_000);

        const forTheIdentifier = await refusalOf(
          store.addKey({ id: "mk_1", merchantId: B, label: "theirs", digest: "digest-2" }, 2_000),
        );
        const forTheDigest = await refusalOf(
          store.addKey({ id: "mk_2", merchantId: B, label: "theirs", digest: "digest-1" }, 3_000),
        );

        expect(asLogged(forTheIdentifier)).not.toContain("digest-2");
        expect(asLogged(forTheDigest)).not.toContain("digest-1");
      });
    });

    describe("an order", () => {
      it("is written once under one identifier, and a second attempt is refused", async () => {
        // An order written twice would be an order whose history is somebody
        // else's: the second write carries a different state, a different price
        // and possibly a different payer, and the first order — the one an agent
        // is holding an identifier for — is gone. The database refuses this with
        // a primary key and the in-memory store with a check, and what matters
        // is that both refuse it in words the gateway can read rather than in a
        // driver's.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        await expect(store.addOrder(anOrder("ord_1", "quoted"))).rejects.toThrow(
          /already written down/,
        );
        // And the order that was there is untouched, which is the point of
        // refusing.
        expect((await store.orderById("ord_1"))?.order.state).toBe("created");
      });

      it("is said not to be there rather than thrown about", async () => {
        // An agent asking after an order that never existed is ordinary. The
        // caller has to answer it, which it cannot do if the store crashes on
        // it.
        const store = await twoMerchants();

        expect(await store.withOrder("ord_nope", () => ({ result: 1 }))).toStrictEqual({
          found: false,
        });
      });

      it("is held still, so two decisions cannot both write over the same read", async () => {
        // This is the double-charge test. Two events about one order arrive from
        // different places all the time — a payment and a deadline, an answer and
        // a redelivery — and if both read the same order and both write, the
        // second erases the first. Here that shows up as a lost increment; next
        // to someone else's money it shows up as a charge that happened twice.
        //
        // The pause inside the decision is what a real transaction has and what
        // a lock has to survive. What comes back is sorted rather than taken in
        // order: the port promises that the three decisions do not overlap, not
        // which of them goes first.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        const bump = () =>
          store.withOrder("ord_1", async (found) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const attempts = found.order.dispatch.attempts + 1;
            return {
              save: {
                ...found,
                order: { ...found.order, dispatch: { attempts, accepted: false } },
              },
              result: attempts,
            };
          });

        const decided = await Promise.all([bump(), bump(), bump()]);

        // Sorted as numbers. JavaScript's own sort compares them as text, which
        // agrees with the numbers only while there are fewer than ten of them —
        // a comparison that would start lying the day somebody raised the count
        // to eleven, and lie by passing.
        expect(
          decided
            .map((lookup) => (lookup.found ? lookup.result : null))
            .sort((one, other) => Number(one) - Number(other)),
        ).toStrictEqual([1, 2, 3]);
        expect((await store.orderById("ord_1"))?.order.dispatch.attempts).toBe(3);
      });

      it("does not make one order wait on another", async () => {
        // Two orders are two locks. A store that made them one would put every
        // decision in the gateway in a single queue behind whichever order is
        // slowest, and the slowest is an order whose decision is waiting on a
        // merchant. In memory the hold is a chain of promises per identifier; on
        // Postgres it is `select ... for update`, and there the granularity is
        // decided by the predicate that goes with it — a `for update` matching
        // more than the one row locks that much of the orders table, which is
        // precisely the mistake only a real database can make.
        //
        // Staged the way it would actually go wrong. A decision about the first
        // order is held open — an unresolved promise inside its callback, which
        // on Postgres means a transaction still holding that row's lock — and a
        // decision about the second is asked for while it is. If the two share a
        // lock the second never answers, so it is given two seconds and then
        // reports itself still waiting: the assertion below then names the
        // defect, rather than the runner reporting a timeout with nothing said
        // about why.
        //
        // Both decisions are let go and waited out in a `finally` whatever
        // happens above, and that is not tidiness. A decision still in flight is
        // a transaction still holding a row, so a test that walked away from a
        // failed assertion would leave the next test's first write — the truncate
        // that empties the table — waiting on it, and the failure would land
        // somewhere other than here.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created", { createdAt: 1_000 }));
        await store.addOrder(anOrder("ord_2", "created", { createdAt: 2_000 }));

        let releaseFirst: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });

        const first = store.withOrder("ord_1", async () => {
          await held;
          return { result: "first" };
        });
        const second = store.withOrder("ord_2", () => ({ result: "second" }));

        try {
          expect(await answeredWithin(2_000, second)).toStrictEqual({
            found: true,
            result: "second",
          });
        } finally {
          releaseFirst();
          await Promise.allSettled([first, second]);
        }

        expect(await first).toStrictEqual({ found: true, result: "first" });
        expect(await second).toStrictEqual({ found: true, result: "second" });
      });

      it("is still there to decide about after a decision about it failed", async () => {
        // A decision that threw must not take the order with it: every later
        // event about that order would inherit the failure and the order would be
        // stuck for good — no deadline could close it, no answer from the
        // merchant could move it, and nobody would be told.
        //
        // The two adapters arrive at this differently and that is the whole
        // reason it is here. In memory the chain of promises has to be caught, or
        // every later decision waits on a rejection; on Postgres the transaction
        // is rolled back and the row lock goes with it, and a lock that outlived
        // the failure would wedge the order just as thoroughly.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        const broken = store.withOrder("ord_1", () => {
          throw new Error("the decision blew up");
        });
        await expect(broken).rejects.toThrow("the decision blew up");

        expect(await store.withOrder("ord_1", () => ({ result: "still here" }))).toStrictEqual({
          found: true,
          result: "still here",
        });
        // And the decision that failed wrote nothing.
        expect((await store.orderById("ord_1"))?.order.state).toBe("created");
      });

      it("is not written when the decision asked for nothing to be written", async () => {
        // Leaving `save` out is how a read that changes nothing says so. A store
        // that wrote the order back anyway would move its updated instant on
        // every read and, worse, would write whatever the caller happened to be
        // holding.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        await store.withOrder("ord_1", () => ({ result: "just looking" }));

        expect((await store.orderById("ord_1"))?.order.state).toBe("created");
      });

      it("is not found by another merchant, and is not written by one either", async () => {
        // The ownership is read under the same hold as the order itself, so
        // there is no window between learning whose it is and acting on it — and
        // the answer is the one an identifier naming nothing gets, so a merchant
        // holding one out of a log learns nothing by trying it.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created", { merchantId: B }));

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

      it("does not change hands because a decision about it said so", async () => {
        // A sale belongs to whoever made it, settled at the birth of the order
        // and never again. The Postgres adapter writes the merchant from the row
        // and leaves the column out of its update, so a save carrying a different
        // one would put the new merchant in the document and the old one in the
        // column — an order in one merchant's list whose envelopes go on
        // another's stream. Nothing reaches this today; the two adapters
        // agreeing is what keeps it that way.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_1", "created"));

        await store.withOrder("ord_1", (found) => ({
          save: { ...found, merchantId: B, order: { ...found.order, state: "quoted" as const } },
          result: null,
        }));

        expect((await store.orderById("ord_1"))?.merchantId).toBe(A);
        expect(await idsOf(store.orders(A))).toStrictEqual(["ord_1"]);
        expect(await store.orders(B)).toStrictEqual([]);
        // And the change the decision was actually making did land.
        expect((await store.orderById("ord_1"))?.order.state).toBe("quoted");
      });

      it("is its own merchant's to read, and the buying surface's whoever asks", async () => {
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_mine", "created", { createdAt: 1_000 }));
        await store.addOrder(anOrder("ord_theirs", "created", { merchantId: B, createdAt: 2_000 }));

        expect((await store.merchantOrder(A, "ord_mine"))?.order.id).toBe("ord_mine");
        expect(await store.merchantOrder(A, "ord_theirs")).toBeNull();
        // The buying surface's read is unscoped on purpose: the route that uses
        // it takes no key, because the payment presented stands in for one.
        expect((await store.orderById("ord_theirs"))?.order.id).toBe("ord_theirs");
      });

      it("is listed among the ones still owed something, or apart from them", async () => {
        // The merchant's list of unclosed orders has to show the two the portal
        // calls open after the purchase itself is over — a debt, and goods
        // delivered against a charge that never landed. One adapter answers this
        // from a column written on every save and the other works it out from the
        // state each time, so a column that fell behind the document is exactly
        // what this catches.
        const store = await twoMerchants();
        await store.addOrder(anOrder("ord_open", "dispatched", { createdAt: 1_000 }));
        await store.addOrder(anOrder("ord_debt", "refund_due", { createdAt: 2_000 }));
        await store.addOrder(anOrder("ord_unpaid", "delivered_unpaid", { createdAt: 3_000 }));
        await store.addOrder(anOrder("ord_done", "delivered", { createdAt: 4_000 }));
        // Another merchant's open order, which must be in neither list.
        await store.addOrder(
          anOrder("ord_theirs", "dispatched", { merchantId: B, createdAt: 5_000 }),
        );

        // Sorted before it is compared, because which order a merchant's list
        // comes back in is not something the port promises and not something
        // the two adapters arrive at the same way. Written as a sequence this
        // would be asserting an accident, and it would go red one day for a
        // reason that has nothing to do with the open column.
        expect(await idsOf(store.orders(A, { open: true }))).toStrictEqual([
          "ord_debt",
          "ord_open",
          "ord_unpaid",
        ]);
        expect(await store.orders(A)).toHaveLength(4);
        expect(await idsOf(store.orders(B))).toStrictEqual(["ord_theirs"]);
      });
    });

    describe("a payment", () => {
      it("belongs to the first order that presented it, and to no other", async () => {
        // This is the replay guard. A signed payment says how much, to whom and
        // on which chain, and nothing about which purchase it is for — so
        // without this, two orders at the same price are payable with one
        // signature, both reach a merchant, both are delivered, and only the
        // second charge fails. It is a map and a check in one store and one
        // insert against a primary key in the other, which is the widest the two
        // ever are apart.
        const store = await twoMerchants();

        expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });
        expect(await store.claimPayment("fp-1", "ord_2")).toStrictEqual({
          claimed: false,
          heldBy: "ord_1",
        });
        // And a different payment is nobody's yet.
        expect(await store.claimPayment("fp-2", "ord_2")).toStrictEqual({ claimed: true });
      });

      it("is presented again by its own order without complaint", async () => {
        // A dropped connection and a retry is the ordinary case, and the portal
        // promises the merchant that repeating a call is safe.
        const store = await twoMerchants();
        await store.claimPayment("fp-1", "ord_1");

        expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });
      });

      it("is let go by the order holding it and by nobody else", async () => {
        // The claim is taken before the ownership decision and has to be, so a
        // presentation the decision turns away must be able to give it back:
        // otherwise a live authorisation is bound to an order that can never
        // accept it, and the agent that lost the race is told "already spent" and
        // pointed at somebody else's order. Only the holder may do it, or one
        // buyer could free another buyer's signature.
        const store = await twoMerchants();
        expect(await store.claimPayment("fp-1", "ord_1")).toStrictEqual({ claimed: true });

        await store.releaseClaim("fp-1", "ord_2");
        expect(await store.claimPayment("fp-1", "ord_2")).toStrictEqual({
          claimed: false,
          heldBy: "ord_1",
        });

        await store.releaseClaim("fp-1", "ord_1");
        expect(await store.claimPayment("fp-1", "ord_2")).toStrictEqual({ claimed: true });
      });

      it("is forgotten once it is older than the instant asked about", async () => {
        // They cannot be kept forever: the route that makes them takes no key, so
        // anybody can make as many as they like and a table that only grows under
        // an open door is a table that fills up.
        //
        // When a claim was made is the one instant neither adapter takes from the
        // caller — each stamps it with its own clock — so this is asked with an
        // instant a minute either side of now rather than with a count. A sweep
        // reaching a minute into the future takes what was just claimed; one
        // reaching a minute into the past takes nothing.
        const store = await twoMerchants();
        await store.claimPayment("fp-1", "ord_1");
        await store.claimPayment("fp-2", "ord_2");

        expect(await store.forgetClaimsBefore(Date.now() - 60_000)).toBe(0);
        expect(await store.claimPayment("fp-1", "ord_3")).toStrictEqual({
          claimed: false,
          heldBy: "ord_1",
        });

        expect(await store.forgetClaimsBefore(Date.now() + 60_000)).toBe(2);
        // Free again, both of them, and free for whoever asks next.
        expect(await store.claimPayment("fp-1", "ord_3")).toStrictEqual({ claimed: true });
        expect(await store.claimPayment("fp-2", "ord_3")).toStrictEqual({ claimed: true });
      });
    });

    describe("a receipt", () => {
      it("is one per order and is found by the order", async () => {
        const store = await twoMerchants();
        const receipt = aReceipt("rcp_1", "ord_1", "delivered");

        await store.putReceipt(A, receipt);

        expect(await store.receiptForOrder("ord_1")).toStrictEqual(receipt);
        expect(await store.receiptForOrder("ord_2")).toBeNull();
        expect(await store.receipts(A)).toHaveLength(1);
      });

      it("is in its own merchant's list and in nobody else's", async () => {
        const store = await twoMerchants();

        await store.putReceipt(A, aReceipt("rcp_1", "ord_1", "delivered"));
        await store.putReceipt(B, aReceipt("rcp_2", "ord_2", "delivered"));

        expect((await store.receipts(A)).map((held) => held.id)).toStrictEqual(["rcp_1"]);
        expect((await store.receipts(B)).map((held) => held.id)).toStrictEqual(["rcp_2"]);
        // The agent's own answer to its purchase carries the receipt, and the
        // agent has no key, so this read is unscoped on purpose.
        expect((await store.receiptForOrder("ord_2"))?.id).toBe("rcp_2");
      });

      it("does not change hands when it is written again", async () => {
        // The machine writes a receipt again as an order moves on, and the sweep
        // writes one for an order that has none. Neither is an occasion for the
        // sale to belong to somebody else — the Postgres adapter leaves the
        // merchant out of its upsert and the in-memory one keeps the merchant it
        // first wrote, which is a rule expressed by omission in both and
        // therefore one nothing else would catch.
        const store = await twoMerchants();
        await store.putReceipt(A, aReceipt("rcp_1", "ord_1", "delivered"));

        // Written again, and named for the wrong merchant.
        await store.putReceipt(B, aReceipt("rcp_1", "ord_1", "refund_due"));

        expect((await store.receipts(A)).map((held) => held.outcome)).toStrictEqual(["refund_due"]);
        expect(await store.receipts(B)).toStrictEqual([]);
      });
    });
  });
}
