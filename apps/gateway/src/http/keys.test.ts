/**
 * Registering a merchant, and the keys they keep afterwards, over the real HTTP
 * surface.
 *
 * Everything here goes through `serve`, so the door, the mounting loop and the
 * flows all run, and what is asserted is the answer a merchant's own client
 * would receive. Two of the rules below cannot be shown with one merchant at
 * all — that another merchant's key is answered as a key that does not exist,
 * and that registering twice makes two merchants rather than one — so those
 * tests seed two and assert about both, the way `tenancy.test.ts` does and for
 * the same reason.
 *
 * The rule this file exists for most is the smallest one to write and the
 * worst one to get wrong: a merchant cannot disable the key their own cabinet
 * is holding. Without it, one click puts a merchant in front of a cabinet that
 * answers every page with "the gateway will not take this key", and the way
 * back is a terminal they do not have.
 */

import type { Card, MerchantKeyList } from "@nuanu-ai/coinslot-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, type Served, serve } from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

/** The code this suite's gateway is configured to accept. */
const INVITATION = "the-code-from-the-invitation";

const cardFor = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: `${title}, sold by whoever published this card`,
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({
    PAY_TO_ADDRESS: PAY_TO,
    REGISTRATION_INVITATION: INVITATION,
    ...overrides,
  });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

interface Registered {
  readonly merchant_id: string;
  readonly secret: string;
}

/**
 * The identifiers of the keys one merchant's cabinets are calling with.
 *
 * Read out of the store, because nothing a caller is answered with carries one
 * any more: the list leaves these keys out, and registering hands back the key
 * itself and no row. A test that wants to aim at one has to reach past the
 * surface exactly as this does, which is the shape of the promise.
 */
const cabinetKeysOf = async (harnessed: Harness, merchantId: string): Promise<string[]> =>
  (await harnessed.store.keysOf(merchantId))
    .filter((key) => key.purpose === "cabinet")
    .map((key) => key.id);

/** The one key a merchant's cabinet is calling with, where there is one. */
const cabinetKeyOf = async (harnessed: Harness, merchantId: string): Promise<string> => {
  const [only, ...rest] = await cabinetKeysOf(harnessed, merchantId);
  expect(rest, "this merchant has more than one cabinet key").toStrictEqual([]);
  return only ?? "";
};

const register = async (served: Served, invitation = INVITATION) =>
  served.call("POST", "/v0/merchants", { body: { invitation } });

const registered = async (served: Served): Promise<Registered> => {
  const answered = await register(served);
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as Registered;
};

/**
 * What this merchant's products are sold under, and where their sales are paid,
 * set the way a cabinet sets them.
 *
 * The two travel together here because they are the two things a merchant made
 * by registering has to say before anything of theirs can be published, and
 * nothing in this file is about either — what it is about is keys. A test that
 * set only one would be refused at its first card for a reason it is not
 * testing; `seller-name.test.ts` and `payout-wallet.test.ts` are where each
 * refusal is the subject.
 */
const readyToSell = async (served: Served, key: string, name: string) => {
  const named = await served.call("POST", "/v0/seller-name", {
    body: { seller_name: name },
    headers: bearer(key),
  });
  expect(named.status, JSON.stringify(named.body)).toBe(200);

  const paidAt = await served.call("POST", "/v0/payout-wallet", {
    body: { payout_wallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" },
    headers: bearer(key),
  });
  expect(paidAt.status, JSON.stringify(paidAt.body)).toBe(200);
};

const keysWith = async (served: Served, key: string): Promise<MerchantKeyList> => {
  const answered = await served.call("GET", "/v0/keys", { headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as MerchantKeyList;
};

/** Whether a key still opens the door, asked with the smallest call there is. */
const opensTheDoor = async (served: Served, key: string): Promise<boolean> =>
  (await served.call("GET", "/v0/cards", { headers: bearer(key) })).status === 200;

const publish = async (served: Served, key: string, card: Card): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: bearer(key),
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { ok: { id: string } }).ok.id;
};

/** What a crawler asking the price of one product is told about its seller. */
const sellerInTheChallenge = async (
  served: Served,
  itemId: string,
): Promise<{ serviceName?: string; extensions: unknown }> => {
  const answered = await served.call("GET", `/v0/items/${itemId}/purchase`);
  expect(answered.status).toBe(402);
  const challenge = decodePaymentRequiredHeader(
    answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
  ) as unknown as {
    resource: { serviceName?: string };
    extensions?: Record<string, unknown>;
  };
  return { serviceName: challenge.resource.serviceName, extensions: challenge.extensions?.bazaar };
};

describe("registering a merchant", () => {
  it("makes a merchant whose first key opens the door", async () => {
    // The whole promise of the call: somebody with an invitation ends up with a
    // merchant of their own and something to reach the API with. A key that came
    // back and does not work is the same as no registration at all.
    const { served } = await started();

    const made = await registered(served);

    expect(made.merchant_id).not.toBe("");
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("asks for no name and lists the merchant under none", async () => {
    // The name buyers read is chosen on the screen after this one, where there
    // is room to say what it is for. A merchant who has just registered is
    // listed under nothing, and the call that says so is the one their cabinet
    // draws the settings screen from.
    const { served } = await started();

    const made = await registered(served);

    const listed = await served.call("GET", "/v0/seller-name", { headers: bearer(made.secret) });
    expect(listed.body).toStrictEqual({ seller_name: null });
  });

  it("lists the new merchant under the name they choose afterwards", async () => {
    // Not decoration. A merchant with no name publishes nothing, and a card
    // published under one carries it into the payment challenge a discovery
    // catalogue reads — which is the whole road from registering to being found.
    const { served } = await started();
    const made = await registered(served);
    await readyToSell(served, made.secret, "Someone's shop");

    const itemId = await publish(served, made.secret, cardFor("a-room", "A room"));
    const seller = await sellerInTheChallenge(served, itemId);

    expect(seller.serviceName).toBe("Someone's shop");
    expect(seller.extensions).toBeDefined();
  });

  it("turns away a wrong code, and writes nothing at all", async () => {
    const { served, harnessed } = await started();
    const before = (await harnessed.store.merchants()).length;

    const refused = await register(served, "not-the-code");

    expect(refused.status).toBe(403);
    expect((await harnessed.store.merchants()).length).toBe(before);
  });

  it("answers a closed door in exactly the words a wrong code gets", async () => {
    // A gateway with no invitation configured takes no registrations. If it
    // said so differently, the form would be a way of asking whether
    // registration is open here at all, which is the one thing the code in the
    // door is meant to stop being findable.
    //
    // The code presented to the closed gateway is the one the open gateway
    // below accepts, and that is the whole design of this test: presented with
    // a code that is wrong for it anyway, a closed gateway would be
    // indistinguishable from an open one, and the override could quietly stop
    // taking effect without anything failing.
    const closed = await started({ REGISTRATION_INVITATION: "" });
    const shut = await register(closed.served, INVITATION);
    const merchantsThere = (await closed.harnessed.store.merchants()).length;
    await closed.served.close();
    await closed.harnessed.stop();
    open = null;

    const { served, harnessed } = await started();
    const wrong = await register(served, "not-the-code");

    // Refused on both, in one status and one document. Said as three
    // assertions rather than two, because "the same answer either way" is also
    // true of two gateways that both registered the merchant.
    expect(shut.status).toBe(403);
    expect(shut.status).toBe(wrong.status);
    expect(shut.body).toStrictEqual(wrong.body);
    // And neither wrote anything: only the merchant the harness seeds is there.
    expect(merchantsThere).toBe(1);
    expect((await harnessed.store.merchants()).length).toBe(1);
  });

  it("gives each registration a merchant of its own", async () => {
    // Two people with the same invitation are two merchants, not two people at
    // one. Registering into a shared merchant would hand the second one the
    // first one's cards, orders and receipts on their first screen.
    const { served } = await started();

    const first = await registered(served);
    const second = await registered(served);
    await readyToSell(served, first.secret, "First shop");
    const itemId = await publish(served, first.secret, cardFor("a-room", "A room"));

    expect(second.merchant_id).not.toBe(first.merchant_id);
    const seenBySecond = await served.call("GET", "/v0/cards", { headers: bearer(second.secret) });
    expect((seenBySecond.body as { cards: unknown[] }).cards).toStrictEqual([]);
    const seenByFirst = await served.call("GET", "/v0/cards", { headers: bearer(first.secret) });
    expect(
      (seenByFirst.body as { cards: { id: string }[] }).cards.map((card) => card.id),
    ).toContain(itemId);
  });

  it("refuses a registration carrying a name, rather than writing one down", async () => {
    // A cabinet still sending the field it used to send has to be told, because
    // the alternative is a name accepted, ignored and never shown again — and
    // the person who typed it believing they had chosen what buyers would read.
    const { served } = await started();

    const withAName = await served.call("POST", "/v0/merchants", {
      body: { name: "Someone's shop", invitation: INVITATION },
    });

    expect(withAName.status).toBe(400);
  });
});

describe("the keys a merchant holds", () => {
  it("lists nothing at all for a merchant who has only ever signed in", async () => {
    // The first thing a keys screen ever draws. Registering makes the key a
    // cabinet calls with, and that is not one of the merchant's own: they did
    // not ask for it, cannot disable it, and a row for it would be a row whose
    // only effect is the question of why it will not go away.
    const { served, harnessed } = await started();
    const made = await registered(served);

    const listed = await keysWith(served, made.secret);

    expect(listed.keys).toStrictEqual([]);
    // And the key that made the call is named all the same, so the field means
    // the same thing on every call — it is simply not one of the rows here.
    expect(listed.this_call).toBe(await cabinetKeyOf(harnessed, made.merchant_id));
    expect(listed.keys.map((key) => key.id)).not.toContain(listed.this_call);
  });

  it("lists the keys the merchant asked for, and only those", async () => {
    // The list is what the merchant made. A key issued through the merchant's
    // own call is on it; the credential their cabinet is calling with is not,
    // whichever of the two the call comes in on.
    const { served } = await started();
    const made = await registered(served);
    const worker = await issued(served, made.secret, "the worker on the small box");

    const asTheCabinet = await keysWith(served, made.secret);
    const asTheWorker = await keysWith(served, worker.secret);

    expect(asTheCabinet.keys.map((key) => key.id)).toStrictEqual([worker.key.id]);
    expect(asTheWorker.keys.map((key) => key.id)).toStrictEqual([worker.key.id]);
  });

  it("names a different key when the call is made with a different key", async () => {
    // The half a merchant with one key cannot show, and the whole promise of
    // the field: `this_call` is the key that opened this call rather than the
    // merchant's first, their oldest, or whichever the list happens to start
    // with. Named wrongly, a cabinet would hide the disable button on a key
    // that works and offer it on the one the gateway answers 409 to, which is
    // the exact failure the field exists to prevent.
    const { served, harnessed } = await started();
    const made = await registered(served);
    const second = await issued(served, made.secret, "a second worker");

    const asTheFirst = await keysWith(served, made.secret);
    const asTheSecond = await keysWith(served, second.secret);

    expect(asTheFirst.this_call).toBe(await cabinetKeyOf(harnessed, made.merchant_id));
    expect(asTheSecond.this_call).toBe(second.key.id);
    // And the list itself is the same both times: which key asked changes the
    // one field and nothing else.
    expect(asTheSecond.keys).toStrictEqual(asTheFirst.keys);
  });

  it("lists no key of another merchant's", async () => {
    // One merchant reading another's keys learns how many workers they run and
    // what each is called. Seeded with two, because a list scoped to nobody
    // passes every assertion one merchant can make about their own.
    const { served } = await started();
    const first = await registered(served);
    const second = await registered(served);
    const ofTheFirst = await issued(served, first.secret, "the first shop's worker");
    const ofTheSecond = await issued(served, second.secret, "the second shop's worker");

    const forFirst = await keysWith(served, first.secret);
    const forSecond = await keysWith(served, second.secret);

    expect(forFirst.keys.map((key) => key.id)).toStrictEqual([ofTheFirst.key.id]);
    expect(forSecond.keys.map((key) => key.id)).toStrictEqual([ofTheSecond.key.id]);
  });

  it("keeps a revoked key in the list with the instant it stopped", async () => {
    // The question after an incident is when a key stopped working, and a list
    // that dropped the key answers nothing at all.
    const { served, harnessed } = await started();
    const made = await registered(served);
    const second = await issued(served, made.secret, "a second worker");

    await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(made.secret),
    });

    const listed = await keysWith(served, made.secret);
    const revoked = listed.keys.find((key) => key.id === second.key.id);
    expect(revoked?.disabled_at).toBe(new Date(harnessed.now()).toISOString());
  });
});

/** One key issued through the route, with the answer read back. */
const issued = async (
  served: Served,
  key: string,
  label: string,
): Promise<{ key: { id: string; label: string }; secret: string }> => {
  const answered = await served.call("POST", "/v0/keys", { body: { label }, headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as { key: { id: string; label: string }; secret: string };
};

describe("issuing another key", () => {
  it("issues a key that opens the door, leaving the one that asked for it working", async () => {
    // The whole reason a key is a row: a merchant hands one to each worker.
    const { served } = await started();
    const made = await registered(served);

    const second = await issued(served, made.secret, "a second worker");

    expect(second.key.label).toBe("a second worker");
    expect(await opensTheDoor(served, second.secret)).toBe(true);
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("issues the key to the merchant who asked and to nobody else", async () => {
    const { served } = await started();
    const first = await registered(served);
    const second = await registered(served);
    await readyToSell(served, first.secret, "First shop");
    const itemId = await publish(served, first.secret, cardFor("a-room", "A room"));

    const another = await issued(served, first.secret, "another of the first shop's");

    const seen = await served.call("GET", "/v0/cards", { headers: bearer(another.secret) });
    expect((seen.body as { cards: { id: string }[] }).cards.map((card) => card.id)).toStrictEqual([
      itemId,
    ]);
    expect((await keysWith(served, second.secret)).keys).toStrictEqual([]);
  });

  it("makes a key of the merchant's own, which is the kind that is listed", async () => {
    // The only kind this call makes. A key made for a cabinet is in no list, so
    // a key that appears in one is a key the merchant owns — which is what
    // makes the row they are about to revoke theirs to revoke.
    const { served, harnessed } = await started();
    const made = await registered(served);

    const second = await issued(served, made.secret, "a second worker");

    const listed = await keysWith(served, made.secret);
    expect(listed.keys.map((key) => key.id)).toStrictEqual([second.key.id]);
    expect(listed.this_call).toBe(await cabinetKeyOf(harnessed, made.merchant_id));
  });
});

describe("disabling a key", () => {
  it("stops the named key and leaves the one that asked for it working", async () => {
    const { served } = await started();
    const made = await registered(served);
    const second = await issued(served, made.secret, "a second worker");

    const answered = await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(made.secret),
    });

    expect(answered.status).toBe(200);
    expect(
      (answered.body as { key: { disabled_at: string | null } }).key.disabled_at,
    ).not.toBeNull();
    expect(await opensTheDoor(served, second.secret)).toBe(false);
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("refuses to disable the key the call was made with", async () => {
    // ADR-0014 §5. One click otherwise, and whoever holds that key meets "the
    // gateway will not take this key" on every call afterwards, with no
    // terminal to get back in through.
    const { served } = await started();
    const made = await registered(served);
    const worker = await issued(served, made.secret, "the worker on the small box");

    const answered = await served.call("POST", `/v0/keys/${worker.key.id}/disable`, {
      headers: bearer(worker.secret),
    });

    expect(answered.status).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("key_opened_this_call");
    // And the key is still working afterwards, which is the half that matters:
    // a refusal that had already written the revocation would be worse than no
    // rule at all.
    expect(await opensTheDoor(served, worker.secret)).toBe(true);
  });

  it("refuses the caller's own key even where the merchant has others", async () => {
    // The rule is about the key this call was made with and not about the last
    // working key: a merchant with two keys still cannot disable the one the
    // call in front of the gateway came in on.
    const { served } = await started();
    const made = await registered(served);
    const worker = await issued(served, made.secret, "the worker on the small box");
    await issued(served, made.secret, "a second worker");

    const answered = await served.call("POST", `/v0/keys/${worker.key.id}/disable`, {
      headers: bearer(worker.secret),
    });

    expect(answered.status).toBe(409);
    expect(await opensTheDoor(served, worker.secret)).toBe(true);
  });

  it("refuses to disable a key made for a cabinet, and leaves it working", async () => {
    // A merchant switches off what they issued. The key their cabinet calls
    // with is not that, and this call will not touch it — whoever asks and
    // however they came by the identifier, which is the point: nothing on this
    // surface hands one out, and a rule that rested on that would be a rule
    // waiting for the first route that does.
    const { served, harnessed } = await started();
    const made = await registered(served);
    const worker = await issued(served, made.secret, "the worker on the small box");
    const theCabinets = await cabinetKeyOf(harnessed, made.merchant_id);

    const answered = await served.call("POST", `/v0/keys/${theCabinets}/disable`, {
      headers: bearer(worker.secret),
    });

    expect(answered.status).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe(
      "key_made_for_a_cabinet",
    );
    // Nothing was written: the cabinet is still signed in, which is the whole
    // of what this refusal is protecting.
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("refuses a cabinet's key to another cabinet's key just the same", async () => {
    // The rule is about the key being aimed at rather than about who is
    // aiming: a cabinet cannot switch off the cabinet next door either, and
    // sweeping up after itself is the call it has for that.
    const { served, harnessed } = await started();
    const made = await registered(served);
    const second = await cabinetKey(served, made.secret);
    const [older] = await cabinetKeysOf(harnessed, made.merchant_id);

    const answered = await served.call("POST", `/v0/keys/${older}/disable`, {
      headers: bearer(second),
    });

    expect(answered.status).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe(
      "key_made_for_a_cabinet",
    );
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("answers another merchant's key exactly as a key that never existed", async () => {
    // Answered differently, this call would count somebody else's keys: a
    // stranger walking identifiers would learn which of them are real. The
    // stranger's key here is one of their own, because a cabinet's would be
    // told apart by the kind rather than by whose it is — and telling a
    // stranger that much is the thing this is about.
    const { served } = await started();
    const first = await registered(served);
    const second = await registered(served);
    const theirWorker = await issued(served, second.secret, "the second shop's worker");

    const theirs = await served.call("POST", `/v0/keys/${theirWorker.key.id}/disable`, {
      headers: bearer(first.secret),
    });
    const nobodys = await served.call("POST", "/v0/keys/mk_nobody_was_issued/disable", {
      headers: bearer(first.secret),
    });

    expect(theirs.status).toBe(404);
    expect(theirs.body).toStrictEqual(nobodys.body);
    // And the other merchant's key is untouched, which is what the refusal is
    // actually protecting.
    expect(await opensTheDoor(served, theirWorker.secret)).toBe(true);
  });

  it("answers a second disabling the same way and keeps the first instant", async () => {
    // A retry after a dropped connection is safe, and the instant somebody
    // reconstructs an incident from is not moved by it.
    const { served, harnessed } = await started();
    const made = await registered(served);
    const second = await issued(served, made.secret, "a second worker");

    const first = await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(made.secret),
    });
    harnessed.advance(60_000);
    const again = await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(made.secret),
    });

    expect(again.status).toBe(200);
    expect(again.body).toStrictEqual(first.body);
  });

  it("takes no key of a merchant who presents none", async () => {
    // The five key routes are behind the merchant's door like every other
    // merchant route, so a call with no key never reaches a handler.
    const { served } = await started();
    await registered(served);

    expect((await served.call("GET", "/v0/keys")).status).toBe(401);
    expect((await served.call("POST", "/v0/keys", { body: { label: "x" } })).status).toBe(401);
    expect((await served.call("POST", "/v0/keys/mk_whichever/disable")).status).toBe(401);
    expect((await served.call("POST", "/v0/keys/cabinet")).status).toBe(401);
    expect((await served.call("DELETE", "/v0/keys/cabinet")).status).toBe(401);
  });
});

/** One key made for a cabinet through the route, with the secret read back. */
const cabinetKey = async (served: Served, key: string): Promise<string> => {
  const answered = await served.call("POST", "/v0/keys/cabinet", { headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { secret: string }).secret;
};

/** How many keys a merchant has in all, which is the one read that sees both kinds. */
const keysInAll = async (harnessed: Harness, merchantId: string): Promise<number> =>
  (await harnessed.store.keysOf(merchantId)).length;

describe("the key a cabinet calls with", () => {
  it("makes another one that opens the door, leaving the one that asked working", async () => {
    // What a cabinet does on every sign-in: it asks for a credential of its
    // own, and until it has swept up, both work — the one it arrived with and
    // the one it is about to keep.
    const { served } = await started();
    const made = await registered(served);

    const fresh = await cabinetKey(served, made.secret);

    expect(await opensTheDoor(served, fresh)).toBe(true);
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("puts the new key in no list of the merchant's", async () => {
    // The whole point of the kind. A cabinet signing somebody in twice a day
    // would otherwise fill the one screen a merchant revokes keys on with rows
    // they never made and must not touch.
    const { served } = await started();
    const made = await registered(served);
    const worker = await issued(served, made.secret, "the worker on the small box");

    await cabinetKey(served, made.secret);

    expect((await keysWith(served, made.secret)).keys.map((key) => key.id)).toStrictEqual([
      worker.key.id,
    ]);
  });

  it("is refused to a key the merchant made for their own code, and makes nothing", async () => {
    // Not hygiene. These two calls are how a cabinet holds and replaces its own
    // credential, and the sweep beside this one would take that credential away
    // if a key of the merchant's own could reach it — so neither of them can be
    // reached that way, and this is the one of the pair where nothing is lost
    // by the refusal except a key nobody would hold.
    const { served, harnessed } = await started();
    const made = await registered(served);
    const worker = await issued(served, made.secret, "the worker on the small box");
    const before = await keysInAll(harnessed, made.merchant_id);

    const refused = await served.call("POST", "/v0/keys/cabinet", {
      headers: bearer(worker.secret),
    });

    expect(refused.status).toBe(403);
    expect((refused.body as { error: { code: string } }).error.code).toBe("not_a_cabinet_key");
    // Nothing was written: the count over both kinds is the only read that
    // could see a key made for a cabinet, and it has not moved.
    expect(await keysInAll(harnessed, made.merchant_id)).toBe(before);
  });
});

describe("sweeping up the cabinet keys", () => {
  it("removes the keys of earlier sign-ins and keeps the one calling", async () => {
    // A cabinet asks for a key, starts using it, and sweeps. What is left is
    // the one it is holding — and the one it arrived with is gone rather than
    // revoked, because a merchant never issued it and will never read it back.
    const { served } = await started();
    const made = await registered(served);
    const fresh = await cabinetKey(served, made.secret);

    const swept = await served.call("DELETE", "/v0/keys/cabinet", { headers: bearer(fresh) });

    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(swept.body).toStrictEqual({ removed: 1 });
    expect(await opensTheDoor(served, fresh)).toBe(true);
    expect(await opensTheDoor(served, made.secret)).toBe(false);
  });

  it("leaves the keys the merchant made for their own code alone", async () => {
    // The sweep is about one cabinet's leftovers. A worker on a small box that
    // stopped opening the door because somebody signed in from a phone would be
    // this call reaching a merchant's own things.
    const { served } = await started();
    const made = await registered(served);
    const worker = await issued(served, made.secret, "the worker on the small box");
    const fresh = await cabinetKey(served, made.secret);

    const swept = await served.call("DELETE", "/v0/keys/cabinet", { headers: bearer(fresh) });

    expect(swept.status).toBe(200);
    expect(await opensTheDoor(served, worker.secret)).toBe(true);
    expect((await keysWith(served, fresh)).keys.map((key) => key.id)).toStrictEqual([
      worker.key.id,
    ]);
  });

  it("signs nobody else's cabinet out", async () => {
    // Seeded with two merchants, because a sweep scoped to nobody passes every
    // assertion one merchant can make about their own keys.
    const { served } = await started();
    const first = await registered(served);
    const second = await registered(served);
    const fresh = await cabinetKey(served, first.secret);

    const swept = await served.call("DELETE", "/v0/keys/cabinet", { headers: bearer(fresh) });

    expect((swept.body as { removed: number }).removed).toBe(1);
    expect(await opensTheDoor(served, second.secret)).toBe(true);
  });

  it("is refused to a key the merchant made for their own code, and removes nothing", async () => {
    // The refusal that the whole shape of this call rests on: made with a key
    // of the merchant's own, the sweep would find every cabinet key of theirs
    // except the caller's — which is all of them — and the person signed into a
    // cabinet would be looking at a page that no longer opens.
    const { served } = await started();
    const made = await registered(served);
    const worker = await issued(served, made.secret, "the worker on the small box");

    const refused = await served.call("DELETE", "/v0/keys/cabinet", {
      headers: bearer(worker.secret),
    });

    expect(refused.status).toBe(403);
    expect((refused.body as { error: { code: string } }).error.code).toBe("not_a_cabinet_key");
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("answers a second sweep with nothing removed", async () => {
    // A retry after a dropped connection is safe: nothing is left to remove and
    // nought is an answer rather than a failure. It is also what a cabinet gets
    // the first time a merchant ever signs in.
    const { served } = await started();
    const made = await registered(served);
    const fresh = await cabinetKey(served, made.secret);

    const first = await served.call("DELETE", "/v0/keys/cabinet", { headers: bearer(fresh) });
    const again = await served.call("DELETE", "/v0/keys/cabinet", { headers: bearer(fresh) });

    expect(first.body).toStrictEqual({ removed: 1 });
    expect(again.status).toBe(200);
    expect(again.body).toStrictEqual({ removed: 0 });
    expect(await opensTheDoor(served, fresh)).toBe(true);
  });
});

describe("the merchant every ordinary test sells as", () => {
  it("still reaches its own keys, which is what the seeded merchant is for", async () => {
    // The harness seeds a merchant the way the command-line verb does, with no
    // registration involved. Its key resolves to a key row like any other, so
    // the list names it — a door that could only name a key registration made
    // would break every merchant made at a terminal.
    const { served, harnessed } = await started();

    const listed = await keysWith(served, harnessed.merchant.key);

    expect(listed.this_call).toBe(harnessed.merchant.keyId);
    expect(listed.keys.map((key) => key.id)).toStrictEqual([harnessed.merchant.keyId]);
  });
});
