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
 * It holds the addresses and not the documents. What the answers have to look
 * like is held by the schemas in `@coinslot/contracts` and by the offline gate
 * in `slice.test.ts`, which buys through a real gateway; the one thing neither
 * of those can see is a buyer politely asking the wrong door.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { API_ROUTES, expandPath, MERCHANT_KEY_HEADER } from "@coinslot/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeBuyer } from "./buyer.js";

/** The same valueless local-devnet key the rest of the slice signs with. */
const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** One request as it arrived, which is the only thing this file looks at. */
interface Asked {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

const asked: Asked[] = [];

let server: Server;
let buyer: ReturnType<typeof makeBuyer>;

beforeAll(async () => {
  server = createServer((request, response) => {
    asked.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
    });
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
  buyer = makeBuyer({
    baseUrl: `http://127.0.0.1:${port}`,
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
