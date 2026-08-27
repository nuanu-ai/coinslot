/**
 * Making a merchant, issuing a key, and seeding the sandbox with one.
 *
 * The subject here is the three things that would otherwise fail silently. A
 * key hashed one way when it is issued and another way at the door is a bug
 * that looks like a wrong key rather than like two hashes. A secret readable
 * from anywhere but the moment of issue is a key somebody can spend out of a
 * copy of the table. And a seed that is not idempotent is a sandbox that either
 * issues a key on every restart or, worse, quietly puts back one somebody
 * revoked on purpose.
 */

import { describe, expect, it } from "vitest";
import { MemoryStore } from "../adapters/memory/store.js";
import { countedIds } from "../testing/harness.js";
import {
  issueKey,
  KEY_PREFIX,
  keyDigest,
  makeMerchant,
  newKeySecret,
  SEEDED_MERCHANT,
  seedSandboxKey,
  setServiceName,
} from "./merchants.js";

const aStore = () => new MemoryStore(countedIds());

describe("a key", () => {
  it("is generated rather than chosen, and no two are the same", () => {
    // A key somebody chooses is a key somebody reuses, and this one is compared
    // against nothing — so generating it is what makes having no length rule
    // safe rather than merely tidy.
    const first = newKeySecret();
    const second = newKeySecret();

    expect(first).not.toBe(second);
    expect(first.startsWith(KEY_PREFIX)).toBe(true);
    expect(second.startsWith(KEY_PREFIX)).toBe(true);
  });

  it("is stored as a digest and never comes back out", async () => {
    // The promise a copy of the table rests on: what is kept is not a key
    // anybody can spend, and nobody — us included — can read one back.
    const store = aStore();
    await makeMerchant(store, countedIds(), "A merchant", 1_000, "mch_1");

    const issued = await issueKey(store, countedIds(), "mch_1", "the worker's", 1_000);

    expect(JSON.stringify(issued.key)).not.toContain(issued.secret);
    expect(await store.merchantForKey(keyDigest(issued.secret))).toBe("mch_1");
    // And the key itself is not what anything is looked up by.
    expect(await store.merchantForKey(issued.secret)).toBeNull();
  });

  it("hashes the same secret the same way every time, and two secrets differently", () => {
    // The one thing that has to hold between the command that issues a key and
    // the door that reads it. A second spelling of this would be a key that
    // works in one of them and not the other.
    expect(keyDigest("a-key")).toBe(keyDigest("a-key"));
    expect(keyDigest("a-key")).not.toBe(keyDigest("a-keY"));
    expect(keyDigest("a-key")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("seeding the sandbox", () => {
  it("makes the merchant and the key on a database that has neither", async () => {
    const store = aStore();

    const seeded = await seedSandboxKey(store, countedIds(), "the-sandbox-key", 1_000);

    expect(seeded).toStrictEqual({ kind: "issued", merchantId: SEEDED_MERCHANT.id });
    expect(await store.merchantForKey(keyDigest("the-sandbox-key"))).toBe(SEEDED_MERCHANT.id);
  });

  it("writes nothing the second time, so a restart is not a second key", async () => {
    // A restart and a second replica both run this. A seed that issued again
    // would leave a merchant with a key per boot, none of which anybody
    // remembers making.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000);

    const again = await seedSandboxKey(store, ids, "the-sandbox-key", 2_000);

    expect(again).toStrictEqual({ kind: "already_there" });
    expect(await store.keysOf(SEEDED_MERCHANT.id)).toHaveLength(1);
  });

  it("leaves a key somebody disabled disabled, and says so", async () => {
    // Revoking a key must not be a thing a restart undoes. It is also why the
    // seed reads the key in whatever state it is in rather than through the
    // door's own lookup, which answers nothing for a disabled key — through
    // that, this would issue a second key with a digest already taken.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000);
    const [key] = await store.keysOf(SEEDED_MERCHANT.id);
    if (key === undefined) throw new Error("the seed wrote no key");
    await store.disableKey(key.id, 2_000);

    const again = await seedSandboxKey(store, ids, "the-sandbox-key", 3_000);

    expect(again).toStrictEqual({ kind: "disabled" });
    expect(await store.keysOf(SEEDED_MERCHANT.id)).toHaveLength(1);
    expect(await store.merchantForKey(keyDigest("the-sandbox-key"))).toBeNull();
  });

  it("survives two processes seeding the same key at the same instant", async () => {
    // Both read no key and both write one, and the digest is unique — so the
    // database refuses one of them. Left to propagate, that refusal takes the
    // losing process down at start-up with an error about a database that did
    // not answer, which is the one thing that had not gone wrong.
    const store = aStore();
    const ids = countedIds();

    const [first, second] = await Promise.all([
      seedSandboxKey(store, ids, "the-sandbox-key", 1_000),
      seedSandboxKey(store, ids, "the-sandbox-key", 1_000),
    ]);

    expect([first.kind, second.kind].sort()).toStrictEqual(["already_there", "issued"]);
    expect(await store.keysOf(SEEDED_MERCHANT.id)).toHaveLength(1);
    expect(await store.merchantForKey(keyDigest("the-sandbox-key"))).toBe(SEEDED_MERCHANT.id);
  });

  it("throws when the write failed for a reason that is not a race", async () => {
    // The catch above is narrow on purpose. A store that cannot write is a
    // start-up failure somebody has to see, and swallowing it would leave a
    // gateway up with a key that opens nothing.
    const store = aStore();
    const broken = {
      ...store,
      addMerchant: store.addMerchant.bind(store),
      keyByDigest: async () => null,
      addKey: async () => {
        throw new Error("the disk is full");
      },
    } as unknown as MemoryStore;

    await expect(seedSandboxKey(broken, countedIds(), "the-sandbox-key", 1_000)).rejects.toThrow(
      "the disk is full",
    );
  });

  it("does not put a merchant who had paused back on sale", async () => {
    // The seed runs on every boot, and the selling word is the merchant's own.
    // A seed that reset it would be a restart that started selling on somebody
    // else's behalf.
    const store = aStore();
    const ids = countedIds();
    await seedSandboxKey(store, ids, "the-sandbox-key", 1_000);
    await store.setSelling(SEEDED_MERCHANT.id, "paused");

    await seedSandboxKey(store, ids, "the-sandbox-key", 2_000);

    expect(await store.selling(SEEDED_MERCHANT.id)).toBe("paused");
  });
});

describe("the name a merchant is listed under", () => {
  // The promise: what a seller is called in a discovery catalog is a fact the
  // merchant owns, kept in the one place a merchant is kept, and it never
  // reaches the catalog in a shape the catalog would quietly cut down.
  it("is nothing at all until somebody sets one", async () => {
    // A merchant is made from a name typed at a terminal, and that name is not
    // a listing name: it may be written in any alphabet and be any length.
    // Standing it in for one would put a mangled version of somebody's name in
    // front of every agent that searches.
    const store = aStore();

    const made = await makeMerchant(store, countedIds(), "Кафе «Ветер»", 1_000, "mch_1");

    expect(made?.serviceName).toBeNull();
  });

  it("is kept once it is set, and read back with the merchant", async () => {
    const store = aStore();
    await makeMerchant(store, countedIds(), "A merchant", 1_000, "mch_1");

    const named = await setServiceName(store, "mch_1", "Freeland", 2_000);

    expect(named?.serviceName).toBe("Freeland");
    expect((await store.merchantById("mch_1"))?.serviceName).toBe("Freeland");
  });

  it("can be taken away again", async () => {
    const store = aStore();
    await makeMerchant(store, countedIds(), "A merchant", 1_000, "mch_1");
    await setServiceName(store, "mch_1", "Freeland", 2_000);

    const cleared = await setServiceName(store, "mch_1", null, 3_000);

    expect(cleared?.serviceName).toBeNull();
  });

  it("is nothing for a merchant who is not there", async () => {
    expect(await setServiceName(aStore(), "mch_nobody", "Freeland", 1_000)).toBeNull();
  });

  it("refuses a name the catalog would cut down rather than writing it", async () => {
    // The measured behaviour of the catalog: a name outside printable ASCII or
    // longer than thirty-two characters is dropped without a word. A merchant
    // has to meet that here, where somebody is reading the answer.
    const store = aStore();
    await makeMerchant(store, countedIds(), "A merchant", 1_000, "mch_1");

    await expect(setServiceName(store, "mch_1", "x".repeat(33), 2_000)).rejects.toThrow(/32/);
    await expect(setServiceName(store, "mch_1", "Кафе", 2_000)).rejects.toThrow(/ASCII/i);
    expect((await store.merchantById("mch_1"))?.serviceName).toBeNull();
  });
});
