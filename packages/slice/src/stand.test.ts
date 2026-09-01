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
      if (request.url === "/v0/items/remote-item/purchase") {
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
        address: `http://0.0.0.0:${gatewayPort}`,
        api_key: "the-key-the-stand-connects-with",
      }),
    );
    expect(connected.status).toBe(303);

    const bought = await post(
      new URLSearchParams({ action: "buy", item_id: "remote-item", params: "{}" }),
    );
    expect(bought.status).toBe(303);
    await waitUntil(() => purchases > 0, 1_000);
    expect(purchases).toBe(1);
    expect(purchaseAuthorities).toEqual([`0.0.0.0:${gatewayPort}`]);
  }, 15_000);
});
