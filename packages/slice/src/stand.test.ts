/**
 * The stand is local; the gateway it operates is not required to be.
 *
 * This process-level test uses 0.0.0.0 deliberately. It reaches the local
 * fake gateway, but it is not one of the hostnames the old safety policy
 * called loopback. Putting that policy back must make this test lose the
 * purchase request.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it } from "vitest";

const waitUntil = async (that: () => boolean, within = 5_000): Promise<void> => {
  const until = Date.now() + within;
  while (!that()) {
    if (Date.now() > until) throw new Error(`still not true after ${within}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  await close(server);
  return port;
};

let stand: ChildProcess | undefined;
let gateway: Server | undefined;

afterEach(async () => {
  if (stand !== undefined && stand.exitCode === null) {
    const exited = new Promise<void>((resolve) => stand?.once("exit", () => resolve()));
    stand.kill("SIGTERM");
    await exited;
  }
  stand = undefined;
  if (gateway !== undefined) await close(gateway);
  gateway = undefined;
});

/**
 * A stand of its own, pointed at one gateway, with the posting done for you.
 *
 * The two tests below both drive the console through several presses and then
 * read what it drew, and neither is about how a child process is started.
 */
const standFacing = async (
  gatewayPort: number,
): Promise<{
  press: (fields: Record<string, string>) => Promise<Response>;
  page: (tab: string) => Promise<string>;
}> => {
  const standPort = await freePort();
  let output = "";
  stand = spawn("pnpm", ["exec", "tsx", "src/stand.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      STAND_BUYER_KEY: `0x${"11".repeat(32)}`,
      STAND_PORT: String(standPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  stand.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  stand.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  await waitUntil(() => output.includes(`http://127.0.0.1:${standPort}`));

  const standUrl = `http://127.0.0.1:${standPort}`;
  const press = (fields: Record<string, string>): Promise<Response> =>
    fetch(standUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: standUrl },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  const connected = await press({
    action: "connect",
    address: `http://127.0.0.1:${gatewayPort}`,
    api_key: "csk_test_the-key-the-stand-connects-with",
  });
  if (connected.status !== 303) throw new Error(`the stand would not connect: ${connected.status}`);

  return { press, page: (tab) => fetch(standUrl + tab).then((answer) => answer.text()) };
};

/** What the parameters box on the agent tab is holding, read back as JSON. */
const parametersBox = (page: string): unknown => {
  const box = page.indexOf('<textarea name="params"');
  if (box < 0) throw new Error("the page is not offering a parameters box");
  const from = page.indexOf(">", box) + 1;
  const text = page
    .slice(from, page.indexOf("</textarea>", from))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  return JSON.parse(text);
};

describe("the stand buyer's key", () => {
  it("refuses to start when no test-wallet key was supplied", async () => {
    const standPort = await freePort();
    const { STAND_BUYER_KEY: _missing, ...withoutBuyerKey } = process.env;
    let output = "";
    stand = spawn("pnpm", ["exec", "tsx", "src/stand.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...withoutBuyerKey, STAND_PORT: String(standPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    stand.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    stand.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });

    await waitUntil(() => stand?.exitCode !== null);
    expect(stand.exitCode).toBe(1);
    expect(output).toContain("STAND_BUYER_KEY");
  }, 10_000);
});

describe("a stand pointed at a gateway elsewhere", () => {
  it("sends the purchase to the gateway it was given", async () => {
    let purchases = 0;
    const purchaseAuthorities: string[] = [];
    gateway = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain each request before answering so keep-alive cannot carry its
        // body into the next call this process observes.
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/worker/poll") {
        response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes: [] }));
        return;
      }
      if (request.url === "/v0/cards") {
        response.end(JSON.stringify({ selling: "open", cards: [] }));
        return;
      }
      if (request.url === "/x402/remote-item/purchase") {
        purchases += 1;
        purchaseAuthorities.push(request.headers.host ?? "");
        response.end(JSON.stringify({ received: true }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    gateway.listen(0, "0.0.0.0");
    await new Promise<void>((resolve) => gateway?.once("listening", resolve));
    const gatewayPort = (gateway.address() as AddressInfo).port;

    const standPort = await freePort();
    let output = "";
    stand = spawn("pnpm", ["exec", "tsx", "src/stand.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        STAND_BUYER_KEY: `0x${"11".repeat(32)}`,
        STAND_PORT: String(standPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    stand.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    stand.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    await waitUntil(() => output.includes(`http://127.0.0.1:${standPort}`));

    const standUrl = `http://127.0.0.1:${standPort}`;
    const post = (body: URLSearchParams): Promise<Response> =>
      fetch(standUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: standUrl,
        },
        body,
        redirect: "manual",
      });

    const connected = await post(
      new URLSearchParams({
        action: "connect",
        address: `http://0.0.0.0:${gatewayPort}`,
        api_key: "the-key-the-stand-connects-with",
      }),
    );
    expect(connected.status).toBe(303);

    const bought = await post(
      new URLSearchParams({ action: "start_purchase", item_id: "remote-item", params: "{}" }),
    );
    expect(bought.status).toBe(303);
    await waitUntil(() => purchases > 0, 1_000);
    expect(purchases).toBe(1);
    expect(purchaseAuthorities).toEqual([`0.0.0.0:${gatewayPort}`]);
  }, 15_000);
});

/**
 * The log's lines as the page rendered them: what each one carries, and
 * whether the page marked it as an answer that did not work.
 *
 * The payload is parsed back rather than matched as text, because the whole
 * question here is where in the detail the envelope sits. Two lines about one
 * publish carry the same words; only one of them carries them at the top
 * level, and a substring match cannot tell those apart.
 */
const logLines = (page: string): Array<{ marked: boolean; payload: { ok?: unknown } | null }> =>
  page
    .split('<details class="lline"')
    .slice(1)
    .map((chunk) => {
      const summary = chunk.slice(0, chunk.indexOf("</summary>"));
      const body = chunk.slice(chunk.indexOf("<pre>") + "<pre>".length, chunk.indexOf("</pre>"));
      const text = body
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
      let payload: { ok?: unknown } | null = null;
      try {
        payload = JSON.parse(text) as { ok?: unknown };
      } catch {
        // A line whose detail is not an object is not one this is about.
      }
      return { marked: / class="lrow[^"]*\bbad\b/.test(summary), payload };
    });

/** A card in the shortest shape the contract takes, so the gateway is what refuses it. */
const A_CARD = {
  merchant_item_id: "chain-tip",
  title: "The height of the latest block",
  description: "The current tip of the chain, answered in the purchase itself.",
  price: "0.001 USD",
  result: { height: { type: "integer", title: "The block number at the tip" } },
  fulfillment: "sync",
};

/** What the gateway answers a card it will not put in the catalog. */
const CARD_REFUSED = {
  ok: false,
  error: {
    code: "card_rejected",
    message: "this card was not published: one thing stands between it and the catalog",
    retryable: false,
    problems: [{ path: ["price"], code: "custom", message: "this price cannot be read" }],
  },
};

describe("a card the gateway will not publish", () => {
  it("leaves a line the log marks as failed, under a clean status", async () => {
    // The promise: publishing is the one call on this console that says no at
    // HTTP 200. Nothing about the exchange looks wrong — a call went out, an
    // answer came back — so a console reporting the call rather than its answer
    // would show a card going up that the gateway had just turned down. What
    // catches it is the envelope arriving in the line's detail at the top
    // level, where the log's reading of `ok` can find it; nested a level down
    // it is invisible, and this asserts through the page the operator reads
    // rather than through a copy of that rule.
    gateway = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drained before answering, as the test above drains.
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/v0/worker/poll") {
        response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes: [] }));
        return;
      }
      if (request.url === "/v0/cards") {
        response.end(JSON.stringify({ selling: "open", cards: [] }));
        return;
      }
      if (request.url === "/v0/catalog/publish") {
        response.end(JSON.stringify(CARD_REFUSED));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    gateway.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => gateway?.once("listening", resolve));
    const gatewayPort = (gateway.address() as AddressInfo).port;

    const standPort = await freePort();
    let output = "";
    stand = spawn("pnpm", ["exec", "tsx", "src/stand.ts"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        STAND_BUYER_KEY: `0x${"11".repeat(32)}`,
        STAND_PORT: String(standPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    stand.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    stand.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    await waitUntil(() => output.includes(`http://127.0.0.1:${standPort}`));

    const standUrl = `http://127.0.0.1:${standPort}`;
    const post = (body: URLSearchParams): Promise<Response> =>
      fetch(standUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: standUrl,
        },
        body,
        redirect: "manual",
      });

    const connected = await post(
      new URLSearchParams({
        action: "connect",
        address: `http://127.0.0.1:${gatewayPort}`,
        api_key: "csk_test_the-key-the-stand-connects-with",
      }),
    );
    expect(connected.status).toBe(303);

    const published = await post(
      new URLSearchParams({ action: "publish", card: JSON.stringify(A_CARD) }),
    );
    expect(published.status).toBe(303);

    const page = await fetch(standUrl).then((answer) => answer.text());

    // The line is found by the payload it carries rather than by the sentence
    // over it. These sentences are rewritten whenever somebody reading a screen
    // cannot follow one, and a test holding the wording would fail on an
    // improvement and pass on a swallowed refusal — the wrong way round.
    const carrying = logLines(page).filter((line) => line.payload?.ok === false);

    // Exactly one, and it is the console's report of the answer. The line
    // beside it — the SDK call going out — carries the same envelope a level
    // down under `result`, which is not this and must not be counted as it.
    expect(carrying).toHaveLength(1);

    const reported = carrying[0];
    if (reported === undefined) throw new Error("the publish answer never reached the log");

    expect(reported.marked).toBe(true);
    expect((reported.payload as { error: { code: string } }).error.code).toBe("card_rejected");
  }, 15_000);
});

/** A gateway that answers everything the console reads on connecting, and nothing else. */
const quietGateway = async (): Promise<{ port: number }> => {
  gateway = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drained before answering, as the tests above drain.
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/v0/worker/poll") {
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes: [] }));
      return;
    }
    if (request.url === "/v0/cards") {
      response.end(JSON.stringify({ selling: "open", cards: [] }));
      return;
    }
    if (request.url?.startsWith("/v0/orders") === true) {
      response.end(JSON.stringify({ orders: [] }));
      return;
    }
    response.end(JSON.stringify({}));
  });
  gateway.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => gateway?.once("listening", resolve));
  return { port: (gateway.address() as AddressInfo).port };
};

describe("the parameters an agent typed", () => {
  it("are still there after asking what the product costs", async () => {
    // The promise: what you typed is what the next press sends. Asking the
    // price is a GET that carries no parameters, so nothing about it needs
    // them — but the box they were typed into is on the form that press
    // submits, and a console that threw them away sent the buyer back to a
    // placeholder and priced, opened and paid for a purchase with fields
    // nobody meant. Losing typing is not a cosmetic fault when the next
    // button along spends money.
    const { port } = await quietGateway();
    const { press, page } = await standFacing(port);

    // Choosing fills the box from the card's declaration; here there is no
    // card to declare anything, so the placeholder is the empty object and
    // what the person then typed is unmistakably theirs.
    expect((await press({ action: "choose", item_id: "remote-item" })).status).toBe(303);
    expect(parametersBox(await page("/agent"))).toStrictEqual({});

    const typed = { city: "Bali", nights: 2 };
    expect((await press({ action: "ask_price", params: JSON.stringify(typed) })).status).toBe(303);

    expect(parametersBox(await page("/agent"))).toStrictEqual(typed);
  }, 15_000);
});

const OWED_ORDER = {
  id: "order-the-stand-owes",
  merchant_item_id: "the-item-it-was-ordered-from",
  params: {},
  price: {
    amount: "1.00",
    currency: "USD",
    at: "2026-09-04T00:00:00Z",
    as_of: "2026-09-04T00:00:00Z",
  },
  test: false,
} as const;

/**
 * A gateway holding one order, which it hands over and then waits to be paid
 * off — with the delivery itself held open until the test lets it through.
 *
 * The delivery blocks so the console can be caught in the one state this is
 * about: an order it has accepted and not yet delivered, read and drawn. What
 * the open list says is driven by the delivery rather than by a timer, so the
 * moment the panel is meant to go stale is a moment the test chooses.
 */
const gatewayOwedOneOrder = async (): Promise<{
  port: number;
  handOverTheOrder: () => void;
  deliveryBegan: () => boolean;
  releaseDelivery: () => void;
}> => {
  let handing = false;
  let handed = false;
  let began = false;
  let delivered = false;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  gateway = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drained before answering, as the tests above drain.
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/v0/worker/poll") {
      const envelopes =
        handing && !handed
          ? [
              {
                kind: "order",
                id: "envelope-for-the-owed-order",
                sent_at: "2026-09-04T00:00:00Z",
                payload: OWED_ORDER,
              },
            ]
          : [];
      handed = handed || handing;
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes }));
      return;
    }
    if (request.url === "/v0/cards") {
      response.end(JSON.stringify({ selling: "open", cards: [] }));
      return;
    }
    if (request.url?.endsWith("/deliver") === true) {
      began = true;
      await released;
      delivered = true;
      response.end(JSON.stringify({ ok: true, result: "delivered" }));
      return;
    }
    if (request.url?.startsWith("/v0/orders?") === true || request.url === "/v0/orders") {
      const open = new URL(request.url, "http://gateway").searchParams.get("open") === "true";
      const standing = handed && !delivered;
      const rows =
        open && !standing
          ? []
          : handed
            ? [{ ...OWED_ORDER, status: delivered ? "delivered" : "in_progress" }]
            : [];
      response.end(JSON.stringify({ orders: rows }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: "accepted" }));
  });
  gateway.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => gateway?.once("listening", resolve));
  return {
    port: (gateway.address() as AddressInfo).port,
    handOverTheOrder: () => {
      handing = true;
    },
    deliveryBegan: () => began,
    releaseDelivery: () => release?.(),
  };
};

/** Whether the Owed panel is offering to close an order by hand. */
const offersToDeliverOwed = (page: string): boolean => page.includes('value="deliver_owed"');

describe("an order the stand closed on its own", () => {
  it("leaves the Owed panel with nothing to press, without anybody pressing Read", async () => {
    // The promise: the merchant's seat shows the orders the gateway has, not
    // the ones it had when somebody last pressed something. "Accept, then
    // deliver after the delay" closes the order from a timer inside this
    // process, so nothing the operator did is there to bring the screen up to
    // date afterwards — and the log said the goods had gone and the gateway had
    // taken them while the panel beside it still offered Deliver now and
    // Refuse. Pressing either sends a closing call for an order that is
    // already closed, so the console was inviting the one mistake it exists to
    // teach you to avoid.
    const owing = await gatewayOwedOneOrder();
    const { press, page } = await standFacing(owing.port);

    expect(
      (
        await press({
          action: "moods",
          order: "accept_then_deliver",
          quote: "price",
          deliver_after_ms: "0",
          price_amount: "1.00",
          price_currency: "USD",
          refusal_code: "cannot_fulfill",
          refusal_message: "not this time",
          goods: "",
        })
      ).status,
    ).toBe(303);

    owing.handOverTheOrder();
    await waitUntil(owing.deliveryBegan);

    try {
      // Read once by hand, while the order is genuinely still owed. Without
      // this the panel would be empty for the dull reason that it had never
      // held anything.
      expect((await press({ action: "read_orders" })).status).toBe(303);
      expect(offersToDeliverOwed(await page("/orders"))).toBe(true);
    } finally {
      owing.releaseDelivery();
    }

    expect(offersToDeliverOwed(await untilOwedIsEmpty(page))).toBe(false);
  }, 20_000);
});

/** How long the Owed panel is given to stop offering an order that is over. */
const untilOwedIsEmpty = async (page: (tab: string) => Promise<string>): Promise<string> => {
  const until = Date.now() + 5_000;
  let drawn = await page("/orders");
  while (offersToDeliverOwed(drawn) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    drawn = await page("/orders");
  }
  return drawn;
};

/** A gateway holding one open order that is ended by an event rather than by us. */
const gatewayEndingAnOrderItself = async (): Promise<{
  port: number;
  endTheOrder: () => void;
}> => {
  let over = false;
  let told = false;
  gateway = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drained before answering, as the tests above drain.
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/v0/worker/poll") {
      const envelopes =
        over && !told
          ? [
              {
                kind: "order_event",
                id: "envelope-carrying-the-event",
                sent_at: "2026-09-04T00:00:10Z",
                payload: {
                  type: "order.unpaid_after_confirmation",
                  order_id: OWED_ORDER.id,
                  at: "2026-09-04T00:00:10Z",
                },
              },
            ]
          : [];
      told = told || over;
      response.end(JSON.stringify({ contract_version: CONTRACT_VERSION, envelopes }));
      return;
    }
    if (request.url === "/v0/cards") {
      response.end(JSON.stringify({ selling: "open", cards: [] }));
      return;
    }
    if (request.url?.startsWith("/v0/orders") === true) {
      const open = new URL(request.url, "http://gateway").searchParams.get("open") === "true";
      response.end(
        JSON.stringify({
          orders:
            open && over
              ? []
              : [{ ...OWED_ORDER, status: over ? "expired" : ("in_progress" as const) }],
        }),
      );
      return;
    }
    response.end(JSON.stringify({ ok: true, result: "accepted" }));
  });
  gateway.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => gateway?.once("listening", resolve));
  return {
    port: (gateway.address() as AddressInfo).port,
    endTheOrder: () => {
      over = true;
    },
  };
};

describe("an order the gateway ended by itself", () => {
  it("leaves the Owed panel with nothing to press, without anybody pressing Read", async () => {
    // The promise as above, from the other direction: an event arrives on the
    // subscription and nobody at the console did anything to cause it, so
    // nothing they did afterwards is there to bring the screen up to date. The
    // log wrote the event down and the panel beside it went on offering to
    // deliver an order that had already ended.
    const ending = await gatewayEndingAnOrderItself();
    const { page } = await standFacing(ending.port);

    expect(offersToDeliverOwed(await page("/orders"))).toBe(true);

    ending.endTheOrder();

    expect(offersToDeliverOwed(await untilOwedIsEmpty(page))).toBe(false);
  }, 20_000);
});
