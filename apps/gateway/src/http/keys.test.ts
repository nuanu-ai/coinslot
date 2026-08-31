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
  readonly key: { readonly id: string; readonly label: string };
  readonly secret: string;
}

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
  it("lists this merchant's keys and names the one the call was made with", async () => {
    const { served } = await started();
    const made = await registered(served);

    const listed = await keysWith(served, made.secret);

    expect(listed.keys.map((key) => key.id)).toStrictEqual([made.key.id]);
    expect(listed.this_call).toBe(made.key.id);
  });

  it("names a different key when the call is made with a different key", async () => {
    // The half a merchant with one key cannot show, and the whole promise of
    // the field: `this_call` is the key that opened this call rather than the
    // merchant's first, their oldest, or whichever the list happens to start
    // with. Named wrongly, a cabinet would hide the disable button on a key
    // that works and offer it on the one the gateway answers 409 to, which is
    // the exact failure the field exists to prevent.
    const { served } = await started();
    const made = await registered(served);
    const second = await issued(served, made.secret, "a second worker");

    const asTheFirst = await keysWith(served, made.secret);
    const asTheSecond = await keysWith(served, second.secret);

    expect(asTheFirst.this_call).toBe(made.key.id);
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

    const ofFirst = await keysWith(served, first.secret);
    const ofSecond = await keysWith(served, second.secret);

    expect(ofFirst.keys.map((key) => key.id)).toStrictEqual([first.key.id]);
    expect(ofSecond.keys.map((key) => key.id)).toStrictEqual([second.key.id]);
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
    expect((await keysWith(served, second.secret)).keys.map((key) => key.id)).toStrictEqual([
      second.key.id,
    ]);
  });

  it("shows the new key in the list, beside the one that asked for it", async () => {
    const { served } = await started();
    const made = await registered(served);

    const second = await issued(served, made.secret, "a second worker");

    const listed = await keysWith(served, made.secret);
    expect(listed.keys.map((key) => key.id).sort()).toStrictEqual(
      [made.key.id, second.key.id].sort(),
    );
    expect(listed.this_call).toBe(made.key.id);
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
    // ADR-0014 §5. One click otherwise, and the merchant is in front of a
    // cabinet that answers every page with "the gateway will not take this
    // key", with no terminal to get back in through.
    const { served } = await started();
    const made = await registered(served);

    const answered = await served.call("POST", `/v0/keys/${made.key.id}/disable`, {
      headers: bearer(made.secret),
    });

    expect(answered.status).toBe(409);
    // And the key is still working afterwards, which is the half that matters:
    // a refusal that had already written the revocation would be worse than no
    // rule at all.
    expect(await opensTheDoor(served, made.secret)).toBe(true);
    const listed = await keysWith(served, made.secret);
    expect(listed.keys.find((key) => key.id === made.key.id)?.disabled_at).toBeNull();
  });

  it("refuses the caller's own key even where the merchant has others", async () => {
    // The rule is about the key this call was made with and not about the last
    // working key: a merchant with two keys still cannot disable the one their
    // cabinet is holding, because the cabinet holds exactly that one.
    const { served } = await started();
    const made = await registered(served);
    await issued(served, made.secret, "a second worker");

    const answered = await served.call("POST", `/v0/keys/${made.key.id}/disable`, {
      headers: bearer(made.secret),
    });

    expect(answered.status).toBe(409);
    expect(await opensTheDoor(served, made.secret)).toBe(true);
  });

  it("answers another merchant's key exactly as a key that never existed", async () => {
    // Answered differently, this call would count somebody else's keys: a
    // stranger walking identifiers would learn which of them are real.
    const { served } = await started();
    const first = await registered(served);
    const second = await registered(served);

    const theirs = await served.call("POST", `/v0/keys/${second.key.id}/disable`, {
      headers: bearer(first.secret),
    });
    const nobodys = await served.call("POST", "/v0/keys/mk_nobody_was_issued/disable", {
      headers: bearer(first.secret),
    });

    expect(theirs.status).toBe(404);
    expect(theirs.body).toStrictEqual(nobodys.body);
    // And the other merchant's key is untouched, which is what the refusal is
    // actually protecting.
    expect(await opensTheDoor(served, second.secret)).toBe(true);
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
    // The three key routes are behind the merchant's door like every other
    // merchant route, so a call with no key never reaches a handler.
    const { served } = await started();
    const made = await registered(served);

    expect((await served.call("GET", "/v0/keys")).status).toBe(401);
    expect((await served.call("POST", "/v0/keys", { body: { label: "x" } })).status).toBe(401);
    expect((await served.call("POST", `/v0/keys/${made.key.id}/disable`)).status).toBe(401);
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
