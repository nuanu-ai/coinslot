/**
 * The name buyers read beside a merchant's products, over the real HTTP
 * surface.
 *
 * It is the one thing a merchant sets about themselves rather than about a
 * card, and it is the name that travels: a payment challenge carries it, and a
 * discovery catalogue lists the seller under it. Everything here goes through
 * `serve`, so the door, the mounting loop and the flows all run, and what is
 * asserted is the answer a merchant's own cabinet would receive.
 *
 * The rule these tests exist for most is the one that costs somebody else
 * money: a card published by a merchant who has set no name would reach a
 * buyer's agent inside a payment request that names nobody as the seller. That
 * has been shipped here once. So the refusal is asserted together with its
 * opposite — a merchant who has a name publishes — because either half alone
 * would pass against a gateway that refused everything or refused nothing.
 */

import type { Card } from "@coinslot/contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { setServiceName } from "../app/merchants.js";
import { SANDBOX_FACILITATOR } from "../config.js";
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

/** What this merchant is listed under right now, read back over the route. */
const sellerName = async (served: Served, key: string) => {
  const answered = await served.call("GET", "/v0/seller-name", { headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as { seller_name: string | null };
};

const setSellerName = async (served: Served, key: string, name: string | null) =>
  served.call("POST", "/v0/seller-name", { body: { seller_name: name }, headers: bearer(key) });

/**
 * A merchant listed under nothing, made the only way one comes to exist: by
 * registering. The harness names the merchants it seeds, because a merchant
 * with no name publishes nothing and almost every test here sells something;
 * this is the state a real merchant is in between signing up and choosing.
 */
const nameless = async (served: Served): Promise<string> => {
  const answered = await served.call("POST", "/v0/merchants", {
    body: { invitation: INVITATION },
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { secret: string }).secret;
};

/**
 * Somewhere for this merchant's money to go, which a registered merchant also
 * arrives without.
 *
 * It is here so that the refusals below are about the name and nothing else:
 * this gateway settles for real, so a merchant with no wallet is refused at the
 * publish too, and a test that left it out would pass on the wrong reason.
 */
const payableAt = async (served: Served, key: string): Promise<void> => {
  const answered = await served.call("POST", "/v0/payout-wallet", {
    body: { payout_wallet: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" },
    headers: bearer(key),
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
};

describe("the name a merchant is listed under", () => {
  it("reads back nothing for a merchant nobody has named", async () => {
    // Null is the answer, not an empty string and not a 404. A merchant who has
    // no name has a settings page to draw, and the shape it draws from has to
    // say "there is none" in a way a reader cannot mistake for "I could not
    // find you".
    const { served } = await started();
    const key = await nameless(served);

    expect(await sellerName(served, key)).toStrictEqual({ seller_name: null });
  });

  it("sets a name and hands back what was written rather than what was sent", async () => {
    const { served, harnessed } = await started();

    const answered = await setSellerName(served, harnessed.merchant.key, "Someone's shop");

    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toStrictEqual({ seller_name: "Someone's shop" });
    // And it is there on the next call, which is what makes the answer above a
    // read of the row rather than an echo of the request.
    expect(await sellerName(served, harnessed.merchant.key)).toStrictEqual({
      seller_name: "Someone's shop",
    });
  });

  it("refuses to take a name away, and says what to do instead", async () => {
    // The one thing this call will not do. A merchant left with cards on sale
    // and no name has products offered through a payment request that names no
    // seller, and nothing afterwards says so — while what they were actually
    // reaching for, stopping their selling, is a control they already have and
    // one that leaves their cards where they can find them again.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");

    const cleared = await setSellerName(served, harnessed.merchant.key, null);

    expect(cleared.status).toBe(400);
    const { error } = cleared.body as { error: { problems: { message: string }[] } };
    expect(error.problems.map((problem) => problem.message).join(" ")).toContain("pause");
    // And the name they had is still theirs: a refusal that had already written
    // the removal would be worse than no rule at all.
    expect(await sellerName(served, harnessed.merchant.key)).toStrictEqual({
      seller_name: "Someone's shop",
    });
  });

  it("changes a name that is already set, which is what a merchant wanted anyway", async () => {
    // The act the refusal above sends people to when what they want is a
    // different name rather than none.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");

    const renamed = await setSellerName(served, harnessed.merchant.key, "The shop on the corner");

    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(await sellerName(served, harnessed.merchant.key)).toStrictEqual({
      seller_name: "The shop on the corner",
    });
  });

  it("names the merchant whose key the call was made with and nobody else", async () => {
    // Seeded with two, because one proves nothing: a route that wrote the name
    // onto every merchant would pass every assertion one merchant can make
    // about their own.
    const { served, harnessed } = await started();
    const first = await harnessed.addMerchant("First shop");
    const second = await harnessed.addMerchant("Second shop");

    await setSellerName(served, first.key, "The first shop's name");

    expect(await sellerName(served, first.key)).toStrictEqual({
      seller_name: "The first shop's name",
    });
    expect((await sellerName(served, second.key)).seller_name).not.toBe("The first shop's name");
  });

  it("refuses a name a discovery catalogue would silently mangle", async () => {
    // Held here rather than accepted and cut later: the catalogue drops what it
    // cannot render and tells nobody, so a merchant would be listed under a
    // word they did not choose.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");

    const tooLong = await setSellerName(served, harnessed.merchant.key, "x".repeat(33));
    const foreign = await setSellerName(served, harnessed.merchant.key, "Кафе");

    expect(tooLong.status).toBe(400);
    expect(foreign.status).toBe(400);
    // And nothing was written, so the merchant keeps the name they had.
    expect(await sellerName(served, harnessed.merchant.key)).toStrictEqual({
      seller_name: "Someone's shop",
    });
  });

  it("refuses a call that leaves the field out, rather than reading it as none", async () => {
    // An absent field and a null one would otherwise be one thing, and they are
    // opposites: a cabinet with a bug that drops the field would quietly
    // delist the merchant.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");

    const empty = await served.call("POST", "/v0/seller-name", {
      body: {},
      headers: bearer(harnessed.merchant.key),
    });

    expect(empty.status).toBe(400);
    expect(await sellerName(served, harnessed.merchant.key)).toStrictEqual({
      seller_name: "Someone's shop",
    });
  });

  it("takes no name from a caller who presents no key", async () => {
    // Both routes are behind the merchant's door like every other merchant
    // route, so a call with no key never reaches a handler at all.
    const { served } = await started();

    expect((await served.call("GET", "/v0/seller-name")).status).toBe(401);
    expect(
      (await served.call("POST", "/v0/seller-name", { body: { seller_name: "Anybody's shop" } }))
        .status,
    ).toBe(401);
  });

  it("puts the name it was given into the payment challenge for that merchant's card", async () => {
    // The whole reason this name exists. A challenge is what a discovery
    // catalogue reads and what a buyer's agent is shown before it pays, and the
    // seller in it is this name and nothing else.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    expect(await sellerInTheChallenge(served, itemId)).toBe("Someone's shop");
  });

  it("puts a changed name into the challenge of a card already published", async () => {
    // The negative control for the assertion above: the challenge reads the
    // merchant's name at the moment it is asked for, rather than copying it on
    // to each card as it is published. A merchant who renames themselves is
    // renamed everywhere they are offered for sale, with no republishing.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    await setSellerName(served, harnessed.merchant.key, "The shop on the corner");

    expect(await sellerInTheChallenge(served, itemId)).toBe("The shop on the corner");
  });
});

describe("publishing before a name has been chosen", () => {
  /** One publish call, whatever it came to. */
  const publishing = (served: Served, key: string, card: Card) =>
    served.call("POST", "/v0/catalog/publish", { body: card, headers: bearer(key) });

  it("refuses a merchant who has set no name, and says where to set one", async () => {
    // The rule this file exists for. A card published by a merchant with no
    // name reaches a buyer's agent inside a payment request that names no
    // seller at all, and the agent is invited to pay somebody the request does
    // not name. This gateway has shipped that once.
    const { served } = await started();
    const key = await nameless(served);

    const refused = await publishing(served, key, cardFor("a-room", "A room"));

    expect(refused.status).toBe(422);
    const { errors } = refused.body as { errors: { code: string; message: string }[] };
    // The words have to tell them what to do next. "Something is missing" would
    // send a merchant through the fields of a card looking for a field that is
    // not on the card at all — what is missing belongs to the merchant.
    expect(errors.map((finding) => finding.code)).toContain("no_seller_name");
    expect(errors.map((finding) => finding.message).join(" ")).toContain("/v0/seller-name");
  });

  it("publishes for a merchant who has one, which is what makes the refusal a rule", async () => {
    // The other half. Asserted alone, the refusal above would pass against a
    // gateway that had stopped publishing anything at all.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");

    const published = await publishing(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    expect(published.status).toBe(200);
  });

  it("writes nothing, so the card is not there afterwards", async () => {
    // A refusal that had already written the card would be worse than no rule:
    // the merchant would be told no and be selling anyway.
    const { served } = await started();
    const key = await nameless(served);

    await publishing(served, key, cardFor("a-room", "A room"));

    const own = await served.call("GET", "/v0/cards", { headers: bearer(key) });
    expect((own.body as { cards: unknown[] }).cards).toStrictEqual([]);
  });

  it("says what is wrong with the card as well, rather than one thing at a time", async () => {
    // A merchant with no name and a card that is also wrong learns both in one
    // answer. Told them one at a time, they fix the card, publish again, and
    // only then find out about the name.
    const { served } = await started();
    const key = await nameless(served);

    const refused = await publishing(served, key, {
      ...cardFor("a-room", "A room"),
      price: { amount: "not a number", currency: "USD" },
    });

    expect(refused.status).toBe(422);
    const { errors } = refused.body as { errors: { path: string[]; code: string }[] };
    expect(errors.map((finding) => finding.code)).toContain("no_seller_name");
    expect(errors.some((finding) => finding.path.includes("price"))).toBe(true);
  });

  it("lets a merchant publish as soon as they set one", async () => {
    // The road out of the refusal, walked end to end. A rule a merchant cannot
    // get past is not a rule, it is a wall.
    //
    // The wallet is set alongside because a merchant made by registering is
    // missing that too, and this gateway settles for real: the name is what
    // this test is about, and being refused for the other reason would say
    // nothing about it either way.
    const { served } = await started();
    const key = await nameless(served);
    await payableAt(served, key);
    expect((await publishing(served, key, cardFor("a-room", "A room"))).status).toBe(422);

    await setSellerName(served, key, "Their own shop");

    const published = await publishing(served, key, cardFor("a-room", "A room"));
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(
      await sellerInTheChallenge(served, (published.body as { ok: { id: string } }).ok.id),
    ).toBe("Their own shop");
  });
});

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
): Promise<string | undefined> => {
  const answered = await served.call("GET", `/v0/items/${itemId}/purchase`);
  expect(answered.status).toBe(402);
  const challenge = decodePaymentRequiredHeader(
    answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
  ) as unknown as { resource: { serviceName?: string } };
  return challenge.resource.serviceName;
};

/**
 * One card on sale whose merchant is listed under no name.
 *
 * The road here is the only one there is, and it is a real one: a merchant
 * publishes under a name, and somebody at a terminal then runs
 * `merchant listed-as <id> --none` — the verb that exists for a name that
 * should never have been listed. The route a merchant has refuses to take a
 * name away and the publish door refuses to make a card without one, so this is
 * the state, reached the way it is reached, with the call the command makes
 * underneath.
 */
const soldUnderNoName = async (
  harnessed: Harness,
  served: Served,
  merchantItemId = "a-room",
): Promise<{ readonly itemId: string; readonly key: string; readonly merchantId: string }> => {
  const key = await nameless(served);
  await payableAt(served, key);
  await setSellerName(served, key, "A name that was pulled");
  const itemId = await publish(served, key, cardFor(merchantItemId, "A room"));

  const opened = await harnessed.gateway.keyBehind(key);
  if (opened === null) {
    throw new Error("the key this test just registered opens nothing");
  }
  await setServiceName(harnessed.store, opened.merchantId, null, harnessed.now());
  return { itemId, key, merchantId: opened.merchantId };
};

describe("a card whose merchant is listed under no name", () => {
  it("tells an agent it is not on sale rather than inviting it to pay a seller nobody names", async () => {
    // The finding this describe exists for. The name is not decoration: it is
    // what the payment request calls the seller, and the challenge simply
    // leaves the field out when there is none — so an agent would be invited to
    // pay somebody the request does not name, which this gateway has shipped
    // once already. Off sale is the truth and it is a word the agent's own
    // client already reads.
    const { served, harnessed } = await started();
    const { itemId } = await soldUnderNoName(harnessed, served);

    const answered = await served.call("GET", `/v0/items/${itemId}/purchase`);

    expect(answered.status, JSON.stringify(answered.body)).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
  });

  it("opens no order against a sale the request could not describe", async () => {
    // The half that costs more than a status code: an order written first and
    // refused afterwards leaves a row on the merchant's own stream, in their
    // cabinet, against a deadline, for a sale that could never have been made.
    const { served, harnessed } = await started();
    const { itemId, merchantId } = await soldUnderNoName(harnessed, served);

    const answered = await served.call("POST", `/v0/items/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status, JSON.stringify(answered.body)).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
    expect(await harnessed.gateway.orders(merchantId, undefined)).toStrictEqual([]);
  });

  it("is not in the catalog an agent walks", async () => {
    // A catalog is an offer, and an entry every purchase of which comes back
    // refused is an offer we would not honour: the agent budgets against it,
    // chooses it over a competitor, and finds out at the till.
    const { served, harnessed } = await started();
    const { itemId } = await soldUnderNoName(harnessed, served);
    const sellable = await publish(served, harnessed.merchant.key, cardFor("a-desk", "A desk"));

    const listed = (await served.call("GET", "/v0/catalog")).body as { items: { id: string }[] };

    expect(listed.items.map((item) => item.id)).not.toContain(itemId);
    // The other half, or the assertion above would pass against a catalog that
    // had stopped listing anything at all.
    expect(listed.items.map((item) => item.id)).toContain(sellable);
  });

  it("says the same thing to its own merchant as it says to a buyer", async () => {
    // One word about whether a card sells, and everybody who asks gets it. A
    // cabinet showing a card as selling while every purchase of it came back
    // refused would send its merchant looking at the card for the fault.
    const { served, harnessed } = await started();
    const { itemId, key } = await soldUnderNoName(harnessed, served);

    const own = (await served.call("GET", "/v0/cards", { headers: bearer(key) })).body as {
      cards: { id: string; selling: string }[];
    };

    expect(own.cards.find((card) => card.id === itemId)?.selling).not.toBe("open");
  });

  it("stops selling in the sandbox too, where a missing wallet is excused and a missing name is not", async () => {
    // The two merchant-shaped reasons a card comes off sale are not one rule.
    // A sandbox settles against nothing, so there is no money to send and no
    // address to be missing — that is why a local stack sells with no wallet
    // configured anywhere. The name is not about money: a sandbox challenge
    // names its seller exactly as a real one does, and nothing sells under
    // nobody's name.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    const { itemId } = await soldUnderNoName(harnessed, served);

    const answered = await served.call("GET", `/v0/items/${itemId}/purchase`);

    expect(answered.status, JSON.stringify(answered.body)).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
  });
});
