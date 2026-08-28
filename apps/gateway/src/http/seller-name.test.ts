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
import { type Harness, harness, type Served, serve } from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

const cardFor = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: `${title}, sold by whoever published this card`,
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

let open: { harnessed: Harness; served: Served } | null = null;

const started = async () => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO });
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

describe("the name a merchant is listed under", () => {
  it("reads back nothing for a merchant nobody has named", async () => {
    // Null is the answer, not an empty string and not a 404. A merchant who has
    // no name has a settings page to draw, and the shape it draws from has to
    // say "there is none" in a way a reader cannot mistake for "I could not
    // find you".
    const { served, harnessed } = await started();
    const nameless = await harnessed.addMerchant("A merchant with no listing");
    await setSellerName(served, nameless.key, null);

    expect(await sellerName(served, nameless.key)).toStrictEqual({ seller_name: null });
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

  it("takes a name away again", async () => {
    // A merchant who wants to stop being listed says so with null. Without it
    // the only way out would be a name they do not want, and the terminal.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");

    const cleared = await setSellerName(served, harnessed.merchant.key, null);

    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body).toStrictEqual({ seller_name: null });
    expect(await sellerName(served, harnessed.merchant.key)).toStrictEqual({ seller_name: null });
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

  it("carries no seller once the name is taken away, which is what makes the above a claim", async () => {
    // The negative control, and a gap worth knowing about rather than
    // discovering. Publishing is refused while no name is set, but a merchant
    // who publishes and then clears their name leaves cards already listed
    // whose challenge names nobody. Nothing refuses that today.
    const { served, harnessed } = await started();
    await setSellerName(served, harnessed.merchant.key, "Someone's shop");
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    await setSellerName(served, harnessed.merchant.key, null);

    expect(await sellerInTheChallenge(served, itemId)).toBeUndefined();
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
