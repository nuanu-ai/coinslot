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
      env: { ...process.env, STAND_PORT: String(standPort) },
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
