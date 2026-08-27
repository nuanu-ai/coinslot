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
