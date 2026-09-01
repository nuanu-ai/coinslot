/**
 * The staple that holds the stranger's agent to our own contract.
 *
 * `buyer.ts` writes its addresses out as strings and reads the answers field by
 * field, on purpose: it stands in for an agent that has the portal and no
 * package of ours, and one that imported our route table would prove only that
 * our types agree with themselves. What that costs is drift. Rename an address
 * in `API_ROUTES` and nothing tells the buyer; the calls go on being made at a
 * path that no longer exists, and a 404 inside a poll for goods reads as an
 * order that never arrived rather than as a bug.
 *
 * So the contract is imported here, in the test, where importing it costs
 * nothing — and the buyer is driven against a real server on the loopback
 * interface that records the request line rather than answering it properly.
 * What is compared is what went on the wire against what the table says, so
 * this catches a rename whichever side made it.
 *
 * It holds the addresses, and the one distinction this buyer draws that no
 * gateway can be made to demonstrate: an answer that arrived and made no sense
 * against a call that never landed. What the answers have to look like when the
 * gateway is behaving is held by the schemas in `@nuanu-ai/coinslot-contracts` and by
 * the offline gate in `slice.test.ts`, which buys through a real one.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { API_ROUTES, expandPath, MERCHANT_KEY_HEADER } from "@nuanu-ai/coinslot-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeBuyer } from "./buyer.js";

/** The same valueless local-devnet key the rest of the slice signs with. */
const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * The order this server answers for with a proxy's error page instead of a
 * document, so the buyer can be shown one without a proxy in the way.
 */
const ORDER_BEHIND_A_BAD_PROXY = "ord_a_proxy_ate_it";

/** One request as it arrived, which is the only thing this file looks at. */
interface Asked {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

const asked: Asked[] = [];

let server: Server;
let buyer: ReturnType<typeof makeBuyer>;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    asked.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
    });
    // One order is answered the way something in the middle answers when the
    // gateway is unreachable: a status nobody designed, in HTML.
    if (request.url?.includes(ORDER_BEHIND_A_BAD_PROXY) === true) {
      response.statusCode = 502;
      response.setHeader("content-type", "text/html");
      response.end("<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>");
      return;
    }
    // An empty catalog page is the one answer that has to be well formed: the
    // buyer holds that one to the real schema, and a body it will not parse
    // would fail this file for a reason that has nothing to do with addresses.
    // Everything else is answered with an empty object on purpose — no payment
    // challenge, no order status — so that no assertion here can be satisfied
    // by an answer this file wrote.
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/v0/catalog" ? { items: [] } : {}));
  });
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  buyer = makeBuyer({
    baseUrl,
    privateKey: TEST_BUYER_KEY,
    maxUsd: 50,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

beforeEach(() => {
  asked.length = 0;
});

/** The one request a call made, or a failure naming how many there were. */
const theOne = (): Asked => {
  expect(asked).toHaveLength(1);
  const one = asked[0];
  if (one === undefined) throw new Error("nothing was asked for");
  return one;
};

describe("the addresses this buyer writes by hand", () => {
  it("reads the catalog where the contract publishes it", async () => {
    await buyer.catalog();

    const one = theOne();
    expect(one.method).toBe(API_ROUTES.list_catalog.method);
    expect(one.path).toBe(API_ROUTES.list_catalog.path);
  });

  it("buys at the purchase address, and asks it for a challenge on the method the contract allows", async () => {
    const itemId = "itm_9f2c4a";

    await buyer.buy(itemId, { email: "buyer@example.com" });
    const bought = theOne();
    expect(bought.method).toBe(API_ROUTES.purchase_item.method);
    expect(bought.path).toBe(expandPath(API_ROUTES.purchase_item.path, { item_id: itemId }));

    // The unpaid read of the price is a GET at the same address, and the table
    // is where that permission lives — a paywall bound to one method makes the
    // resource invisible to the crawlers that list it.
    asked.length = 0;
    // No challenge is answered here, so the buyer refuses rather than inventing
    // one; the request it made on the way is what this test is about.
    await expect(buyer.challenge(itemId)).rejects.toThrow(/PAYMENT-REQUIRED/i);
    const priced = theOne();
    expect(API_ROUTES.purchase_item.also_answers_on).toContain(priced.method);
    expect(priced.path).toBe(bought.path);
  });

  it("collects an order at the door ADR-0011 mounted for the agent", async () => {
    const orderId = "ord_7c1e05";

    await buyer.status(orderId);

    const one = theOne();
    expect(one.method).toBe(API_ROUTES.get_order_status.method);
    expect(one.path).toBe(expandPath(API_ROUTES.get_order_status.path, { order_id: orderId }));

    // The same address, offered without asking for it. It is what the buy
    // command prints when it stops watching, so a reader who pastes that line
    // is pasting the address that was being polled and not a second guess at
    // it.
    expect(buyer.statusUrl(orderId)).toContain(one.path);
  });

  it("writes an identifier into an address the way the contract writes it", async () => {
    // An identifier in this contract may hold a slash or a space, and one
    // concatenated in raw becomes two path segments and a different route. Both
    // sides encode; this is the assertion that they encode alike.
    const itemId = "SKU 100/1";

    await buyer.buy(itemId, {});

    expect(theOne().path).toBe(expandPath(API_ROUTES.purchase_item.path, { item_id: itemId }));
  });
});

describe("an answer that arrived against a call that never landed", () => {
  it("hands back an answer it cannot read, with the text of it, rather than throwing", async () => {
    // The case that cost a wait its ending. Something between an agent and the
    // gateway answers its own error page in HTML; parsed as a document that
    // raises, it takes down the poll that a paid order was being watched
    // through, and the address the buyer owed somebody is never printed. The
    // money has already moved by then, so the answer nobody can read must come
    // back as one — an answer this buyer could not read is a different thing
    // from an answer that says the purchase is over.
    const seen = await buyer.status(ORDER_BEHIND_A_BAD_PROXY);

    expect(seen.status).toBe(502);
    // Nothing is invented out of it: no state, no goods.
    expect(seen.state).toBeNull();
    expect(seen.delivered).toBeNull();
    // And nothing is lost either — the text is there to be printed, which is
    // the only way anybody finds out which box in the middle wrote it.
    expect(seen.body).toContain("502 Bad Gateway");
  });

  it("throws where the call never landed at all", async () => {
    // The other half of the split, and the reason the half above is not simply
    // "never throw". A door that answered badly and a door that is gone want
    // different next moves from a caller holding a paid order, so they do not
    // arrive looking alike.
    const nowhere = makeBuyer({
      baseUrl: "http://127.0.0.1:1",
      privateKey: TEST_BUYER_KEY,
      maxUsd: 50,
    });

    await expect(nowhere.status("ord_7c1e05")).rejects.toThrow();
  });
});

describe("what this buyer never sends", () => {
  it("carries no merchant key on any call it makes", async () => {
    // ADR-0011 in one assertion. An agent has no account, no registration and
    // no key: the catalog and the purchase are open doors, and the order status
    // is proved by knowing the identifier. A buyer that sent a key would be
    // walking doors this one is not supposed to have, and the day the status
    // route ends up behind the merchant's door nothing else here would notice.
    await buyer.catalog();
    await buyer.buy("itm_9f2c4a", {});
    await buyer.status("ord_7c1e05");

    expect(asked).toHaveLength(3);
    for (const one of asked) {
      expect(one.headers[MERCHANT_KEY_HEADER]).toBeUndefined();
    }
  });
});

describe("the fetch this buyer was given", () => {
  it("carries every call it makes, so none of them is missing from a trace", async () => {
    const went: string[] = [];
    const watched = makeBuyer({
      baseUrl,
      privateKey: TEST_BUYER_KEY,
      maxUsd: 50,
      fetch: (input, init) => {
        // `buy` arrives as a Request, and `String(new Request(…))` is
        // "[object Request]", which `new URL` throws on.
        went.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
        return fetch(input, init);
      },
    });

    await watched.catalog();
    // No challenge is answered by this server, so the buyer refuses — the
    // request it made on the way is what this is about.
    await expect(watched.challenge("itm_1")).rejects.toThrow(/PAYMENT-REQUIRED/i);
    await watched.status("ord_1");
    await watched.buy("itm_1", {});

    expect(went).toEqual([
      "/v0/catalog",
      "/v0/items/itm_1/purchase",
      "/v0/orders/ord_1/status",
      "/v0/items/itm_1/purchase",
    ]);
  });
});
