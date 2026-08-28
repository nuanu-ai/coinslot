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
  invitationAccepted,
  issueKey,
  KEY_PREFIX,
  keyDigest,
  makeMerchant,
  newKeySecret,
  REGISTERED_MERCHANT_NAME,
  registerMerchant,
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
    expect((await store.workingKey(keyDigest(issued.secret)))?.merchantId).toBe("mch_1");
    // And the key itself is not what anything is looked up by.
    expect(await store.workingKey(issued.secret)).toBeNull();
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
    expect((await store.workingKey(keyDigest("the-sandbox-key")))?.merchantId).toBe(
      SEEDED_MERCHANT.id,
    );
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
    expect(await store.workingKey(keyDigest("the-sandbox-key"))).toBeNull();
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
    expect((await store.workingKey(keyDigest("the-sandbox-key")))?.merchantId).toBe(
      SEEDED_MERCHANT.id,
    );
  });

  it("throws when the write failed for a reason that is not a race", async () => {
    // The catch above is narrow on purpose. A store that cannot write is a
    // start-up failure somebody has to see, and swallowing it would leave a
    // gateway up with a key that opens nothing.
    const store = aStore();
    const broken = {
      ...store,
      addMerchant: store.addMerchant.bind(store),
      // The seed reads the merchant back to see whether it needs a listing
      // name, and writes one if it has none. Both are the real store's, so
      // this stays a test about the key write and nothing else.
      merchantById: store.merchantById.bind(store),
      setServiceName: store.setServiceName.bind(store),
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

describe("the code in the door of registration", () => {
  // The promise: this call is not a way of finding out whether registration is
  // open here, nor of learning a character of the code one attempt at a time.

  it("accepts the code the gateway was configured with and nothing else", () => {
    expect(invitationAccepted("the-code", "the-code")).toBe(true);
    expect(invitationAccepted("the-code", "the-cod")).toBe(false);
    expect(invitationAccepted("the-code", "the-codE")).toBe(false);
    expect(invitationAccepted("the-code", "the-code ")).toBe(false);
    expect(invitationAccepted("the-code", "")).toBe(false);
  });

  it("accepts nothing at all where no code is configured", () => {
    // Registration closed, and closed for every value anybody could present —
    // including the empty one, which is what a caller sending no code at all
    // would come down to if the shape of the request let it through.
    expect(invitationAccepted(null, "")).toBe(false);
    expect(invitationAccepted(null, "the-code")).toBe(false);
    expect(invitationAccepted(null, "any string whatsoever")).toBe(false);
  });

  it("answers a code of the wrong length rather than throwing on it", () => {
    // What this pins and what it does not are worth telling apart, because the
    // reason the code is written the way it is goes further than the assertion
    // can. The comparison is over two digests rather than two codes, and
    // `timingSafeEqual` refuses two buffers of different lengths outright — so
    // comparing the codes themselves would throw on exactly the guesses that
    // are the wrong length, and a caller would learn the length one attempt at
    // a time. That is the mutation these two lines kill.
    //
    // How long the comparison takes is not tested here and could not usefully
    // be: a timing assertion in a unit suite measures the machine it runs on.
    // An implementation that compared the two codes with `===` would pass this.
    expect(invitationAccepted("short", "a very much longer guess indeed")).toBe(false);
    expect(invitationAccepted("a very much longer code indeed", "short")).toBe(false);
  });
});

describe("registering a merchant", () => {
  it("makes the merchant and issues one key, in one act", async () => {
    // Both in one act (ADR-0014 §1): a merchant written without a key is a
    // merchant nobody can reach, under an identifier that was generated inside
    // this call and that nobody outside it ever held.
    const store = aStore();

    const made = await registerMerchant(store, countedIds(), 1_000);

    expect((await store.workingKey(keyDigest(made?.secret ?? "")))?.merchantId).toBe(
      made?.merchant.id,
    );
    expect(await store.keysOf(made?.merchant.id ?? "")).toHaveLength(1);
  });

  it("lists the new merchant under nothing at all", async () => {
    // Nobody has chosen a name yet, and there is nothing to stand in for one.
    // Filling it from anywhere would put a word the merchant did not choose in
    // front of every buyer who reads a catalogue.
    const store = aStore();

    const made = await registerMerchant(store, countedIds(), 1_000);

    expect(made?.merchant.serviceName).toBeNull();
  });

  it("gives the row a name that says nobody typed one", async () => {
    // The merchant row carries a name a person reads at a terminal, and this
    // merchant was made by a route rather than by somebody typing. Left empty
    // it would be a blank column in every listing; filled with a word that
    // looks chosen, it would be a name somebody goes looking for the owner of.
    const store = aStore();

    const made = await registerMerchant(store, countedIds(), 1_000);

    expect(made?.merchant.name).toBe(REGISTERED_MERCHANT_NAME);
    expect(made?.merchant.name).not.toBe("");
  });

  it("generates the key rather than taking one", async () => {
    // Nothing in the request names a secret and nothing here reads one back:
    // what a registration hands over is generated, and its digest is what is
    // written down. That the row it comes back beside cannot carry the secret
    // is the document's own promise and is held in `merchant.test.ts`.
    const store = aStore();
    const ids = countedIds();

    const first = await registerMerchant(store, ids, 1_000);
    const second = await registerMerchant(store, ids, 1_000);

    expect(first?.secret.startsWith(KEY_PREFIX)).toBe(true);
    expect(second?.secret.startsWith(KEY_PREFIX)).toBe(true);
    expect(first?.secret).not.toBe(second?.secret);
  });

  it("gives every registration its own merchant", async () => {
    const store = aStore();
    const ids = countedIds();

    const first = await registerMerchant(store, ids, 1_000);
    const second = await registerMerchant(store, ids, 2_000);

    expect(first?.merchant.id).not.toBe(second?.merchant.id);
    expect((await store.merchants()).length).toBe(2);
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
