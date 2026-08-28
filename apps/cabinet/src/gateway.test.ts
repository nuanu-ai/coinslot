/**
 * What the cabinet actually sends the gateway, and what it does with what comes
 * back.
 *
 * Two things are held here. The first is that a call ends: a gateway that
 * accepts the connection and then says nothing is not the same failure as one
 * that is down, and it is the worse one — a refused connection comes back at
 * once, while a half-open one holds the request until something else gives up.
 * The screen a merchant is holding at that moment may be the one that stops
 * their selling, so a call with no deadline is a merchant who cannot stop.
 *
 * The second is the four calls ADR-0014 adds: registering, listing keys,
 * issuing one and revoking one. The screens above them are driven in
 * `server.test.ts` against a client the test supplies, so nothing there ever
 * sends a request — what a `POST /v0/keys` actually puts on the wire, and what
 * the cabinet does with an answer the contract refuses, is held here instead.
 *
 * The server on the other end records what arrived and answers what the test
 * says. What it is not is a gateway: it agrees with whatever is sent, so these
 * hold the cabinet's half of the call — the address, the method, the key header
 * or its absence, the body — and, on the way back, that an answer the contract
 * would not recognise stops here rather than reaching a page.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayFor, registrarFor } from "./gateway.js";

let held: Server | null = null;

/** A server that accepts the connection and never answers it. */
const silentServer = async (): Promise<string> => {
  const server = createServer(() => {
    // Deliberately no response, and no timeout of its own: the point is that
    // the caller is the one who has to give up.
  });
  held = server;
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent server did not take a port");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(() => {
  held?.closeAllConnections();
  held?.close();
  held = null;
});

/** One request as it arrived, so a test can read what was actually sent. */
interface Arrived {
  readonly method: string;
  readonly path: string;
  /** The merchant key header, or null where the request carried none. */
  readonly key: string | null;
  readonly body: string;
}

/** A server that records what arrived and answers with what it was given. */
const recordingServer = async (
  status: number,
  answer: unknown,
): Promise<{ url: string; arrived: Arrived[] }> => {
  const arrived: Arrived[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      arrived.push({
        method: request.method ?? "",
        path: request.url ?? "",
        key: request.headers.authorization ?? null,
        body,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    });
  });
  held = server;
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the recording server did not take a port");
  }
  return { url: `http://127.0.0.1:${address.port}`, arrived };
};

const KEY = "a-merchant-key-long-enough";

/** A key document of the shape the gateway answers with. */
const aKey = (over: Record<string, unknown> = {}) => ({
  id: "key_the_first_one",
  label: "the first key",
  created_at: "2026-08-28T09:00:00.000Z",
  disabled_at: null,
  ...over,
});

describe("a gateway that answers nothing", () => {
  it("gives up rather than holding the merchant's page open", async () => {
    // The promise: every call this client makes ends. Without a deadline this
    // test does not fail — it hangs until the runner's own timeout kills the
    // file, which is the same thing happening to a merchant with no runner to
    // rescue them.
    // Fifty milliseconds rather than the ten seconds a merchant gets, so the
    // suite stays fast; what is under test is that the deadline exists at all.
    const gateway = gatewayFor(await silentServer(), "a-merchant-key-long-enough", 50);

    const answered = await gateway.cards();

    expect(answered.ok).toBe(false);
    if (answered.ok) {
      throw new Error("the silent gateway answered");
    }
    expect(answered.status).toBe(0);
    // The two silences are told apart, because only one of them is worth
    // trying again in a moment.
    expect(answered.why).toMatch(/in time/);
  });

  it("tells a gateway that is not there from one that will not answer", async () => {
    // Nothing is listening on this port, so the connection is refused at once
    // and the wording is the other one.
    const gateway = gatewayFor("http://127.0.0.1:1", "a-merchant-key-long-enough");

    const answered = await gateway.cards();

    expect(answered.ok).toBe(false);
    if (answered.ok) {
      throw new Error("a port with nothing on it answered");
    }
    expect(answered.why).toBe("the gateway could not be reached");
  });
});

describe("the call that makes a merchant", () => {
  it("goes to the registration route with the invitation alone and no key at all", async () => {
    // No key, and that is the whole shape of this call: nobody registering has
    // one. A key header here would be a header carrying nothing, and the
    // gateway reads an empty bearer token as a key it does not know — which
    // would turn "you are not invited" into "your key is wrong" for somebody
    // who has neither.
    //
    // And no name either. The name buyers read is chosen after the account
    // exists, so a registration that sent one would be sending a field the
    // route does not take.
    const { url, arrived } = await recordingServer(200, {
      merchant_id: "mer_the_merchant",
      key: aKey(),
      secret: "the-secret-shown-once",
    });

    const made = await registrarFor(url).register("the-invitation");

    expect(made.ok).toBe(true);
    expect(arrived[0]?.method).toBe("POST");
    expect(arrived[0]?.path).toBe("/v0/merchants");
    expect(arrived[0]?.key).toBeNull();
    expect(JSON.parse(arrived[0]?.body ?? "{}")).toStrictEqual({ invitation: "the-invitation" });
  });

  it("hands back the merchant and the secret the account is written with", async () => {
    const { url } = await recordingServer(200, {
      merchant_id: "mer_the_merchant",
      key: aKey(),
      secret: "the-secret-shown-once",
    });

    const made = await registrarFor(url).register("the-invitation");

    if (!made.ok) {
      throw new Error(`the registration was refused: ${made.why}`);
    }
    expect(made.document.merchant_id).toBe("mer_the_merchant");
    expect(made.document.secret).toBe("the-secret-shown-once");
  });

  it("refuses an answer with no secret in it rather than writing an account with none", async () => {
    // The one field the cabinet cannot do without: it is what goes on the row,
    // and an account carrying an empty key is an account that signs in and then
    // meets a 401 on every screen, with nothing on the page to say why. Held to
    // the contract's shape here, so it fails at the call rather than three
    // screens later.
    const { url } = await recordingServer(200, {
      merchant_id: "mer_the_merchant",
      key: aKey(),
    });

    await expect(registrarFor(url).register("the-invitation")).rejects.toThrow();
  });

  it("carries the gateway's own status through, so a refusal can be told from a fault", async () => {
    // 403 is the invitation being refused and a registration that is not open,
    // deliberately indistinguishable from each other; anything else is not
    // about what the person typed. The screen decides what to say, and it can
    // only do that if the status arrives.
    const { url } = await recordingServer(403, {
      error: { code: "not_invited", message: "that is not an invitation we accept" },
    });

    const refused = await registrarFor(url).register("not-the-code");

    expect(refused.ok).toBe(false);
    if (refused.ok) {
      throw new Error("a refused registration answered as made");
    }
    expect(refused.status).toBe(403);
    expect(refused.why).toBe("that is not an invitation we accept");
  });
});

describe("the calls behind the name buyers read", () => {
  it("reads the name as the merchant whose key it holds, and hands back the name itself", async () => {
    // Unwrapped by the client rather than by the screen. The wrapper exists so
    // the answer can grow a field beside the name without every reader
    // changing; a page reaching through it is a page to edit the day it does.
    const { url, arrived } = await recordingServer(200, { seller_name: "A shop with a name" });

    const read = await gatewayFor(url, KEY).sellerName();

    expect(arrived[0]?.method).toBe("GET");
    expect(arrived[0]?.path).toBe("/v0/seller-name");
    expect(arrived[0]?.key).toBe(`Bearer ${KEY}`);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error(`reading the name failed: ${read.why}`);
    }
    expect(read.document).toBe("A shop with a name");
  });

  it("reads a merchant who has chosen no name as null rather than as an absence", async () => {
    // Null is the state every screen in this cabinet exists to get somebody out
    // of, so it has to arrive as an answer and not as a missing field. A client
    // that folded the two would leave the screens unable to tell "no name" from
    // "the call went wrong".
    const { url } = await recordingServer(200, { seller_name: null });

    const read = await gatewayFor(url, KEY).sellerName();

    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error(`reading the name failed: ${read.why}`);
    }
    expect(read.document).toBeNull();
  });

  it("sends the name a merchant typed and hands back what was written", async () => {
    const { url, arrived } = await recordingServer(200, { seller_name: "A shop with a name" });

    const set = await gatewayFor(url, KEY).setSellerName("A shop with a name");

    expect(arrived[0]?.method).toBe("POST");
    expect(arrived[0]?.path).toBe("/v0/seller-name");
    expect(arrived[0]?.key).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(arrived[0]?.body ?? "{}")).toStrictEqual({
      seller_name: "A shop with a name",
    });
    expect(set.ok).toBe(true);
    if (!set.ok) {
      throw new Error(`setting the name failed: ${set.why}`);
    }
    expect(set.document).toBe("A shop with a name");
  });

  it("refuses an answer with no name field in it rather than reading one as null", async () => {
    // The difference between a document that says "no name" and one that does
    // not mention names is the difference between a banner a merchant can act
    // on and a banner shown to somebody who has already done the thing.
    const { url } = await recordingServer(200, {});

    await expect(gatewayFor(url, KEY).sellerName()).rejects.toThrow();
  });

  it("carries a refusal of the name through with the gateway's status on it", async () => {
    // The screen has its own sentence for a name outside the rule and needs to
    // know it was refused rather than written.
    const { url } = await recordingServer(400, {
      error: { code: "invalid_request", message: "that name is not one the catalogue carries" },
    });

    const set = await gatewayFor(url, KEY).setSellerName("x".repeat(33));

    expect(set.ok).toBe(false);
    if (set.ok) {
      throw new Error("a refused name answered as written");
    }
    expect(set.status).toBe(400);
    expect(set.why).toBe("that name is not one the catalogue carries");
  });
});

describe("the calls a merchant makes about their keys", () => {
  it("asks for the list with the merchant's key on it", async () => {
    const { url, arrived } = await recordingServer(200, {
      keys: [aKey()],
      this_call: "key_the_first_one",
    });

    const listed = await gatewayFor(url, KEY).keys();

    expect(listed.ok).toBe(true);
    expect(arrived[0]?.method).toBe("GET");
    expect(arrived[0]?.path).toBe("/v0/keys");
    expect(arrived[0]?.key).toBe(`Bearer ${KEY}`);
  });

  it("refuses a list that does not say which key the call was made with", async () => {
    // Without it the screen cannot tell which row to leave without a control,
    // and a screen that guessed would offer the one click that costs a merchant
    // the way back into their own cabinet (ADR-0014 §5).
    const { url } = await recordingServer(200, { keys: [aKey()] });

    await expect(gatewayFor(url, KEY).keys()).rejects.toThrow();
  });

  it("sends the label as a document, and hands back the key with its secret", async () => {
    const { url, arrived } = await recordingServer(200, {
      key: aKey({ label: "the worker on the small box" }),
      secret: "the-secret-shown-once",
    });

    const issued = await gatewayFor(url, KEY).issueKey("the worker on the small box");

    expect(arrived[0]?.method).toBe("POST");
    expect(arrived[0]?.path).toBe("/v0/keys");
    expect(JSON.parse(arrived[0]?.body ?? "{}")).toStrictEqual({
      label: "the worker on the small box",
    });
    if (!issued.ok) {
      throw new Error(`the key was not issued: ${issued.why}`);
    }
    expect(issued.document.secret).toBe("the-secret-shown-once");
  });

  it("refuses an answer to issuing that carries no secret", async () => {
    // The secret is answered once and never again, so an answer without one is
    // a key the merchant can never be given. Better a page that says something
    // here is broken than a page that shows them an empty box and lets them
    // believe they have copied it.
    const { url } = await recordingServer(200, { key: aKey() });

    await expect(gatewayFor(url, KEY).issueKey("the worker")).rejects.toThrow();
  });

  it("puts the key's identifier into the address it posts to", async () => {
    const { url, arrived } = await recordingServer(200, {
      key: aKey({ disabled_at: "2026-08-28T12:00:00.000Z" }),
    });

    const stopped = await gatewayFor(url, KEY).disableKey("key_the_workers_use");

    expect(arrived[0]?.method).toBe("POST");
    expect(arrived[0]?.path).toBe("/v0/keys/key_the_workers_use/disable");
    expect(arrived[0]?.key).toBe(`Bearer ${KEY}`);
    if (!stopped.ok) {
      throw new Error(`the key was not revoked: ${stopped.why}`);
    }
    // The key itself comes back rather than the object it arrived wrapped in,
    // so the one screen that draws it is not reaching through a wrapper.
    expect(stopped.document.disabled_at).toBe("2026-08-28T12:00:00.000Z");
  });

  it("carries through the gateway's refusal to revoke the key the call was made with", async () => {
    // The screen offers no control for that key, so this is what a merchant who
    // reached the address another way is answered with. The gateway's own
    // sentence, under its own status: nothing is claimed about what did or did
    // not happen beyond what it said.
    const { url } = await recordingServer(409, {
      error: {
        code: "key_opened_this_call",
        message:
          "this call was made with that key, so disabling it would close the door behind you",
      },
    });

    const refused = await gatewayFor(url, KEY).disableKey("key_the_cabinet_is_using");

    expect(refused.ok).toBe(false);
    if (refused.ok) {
      throw new Error("a refused revocation answered as done");
    }
    expect(refused.status).toBe(409);
    expect(refused.why).toContain("disabling it would close the door behind you");
  });

  it("refuses a key document that says nothing about whether the key was revoked", async () => {
    // `disabled_at` is required and nullable rather than optional, and the
    // reason is the reading of an absent one: "this key works" and "nobody
    // wrote it down" are not the same, and a screen that guessed the first
    // would show a revoked key as live beside a Revoke button.
    const { url } = await recordingServer(200, {
      keys: [{ id: "key_one", label: "the worker", created_at: "2026-08-28T09:00:00.000Z" }],
      this_call: "key_one",
    });

    await expect(gatewayFor(url, KEY).keys()).rejects.toThrow();
  });
});
