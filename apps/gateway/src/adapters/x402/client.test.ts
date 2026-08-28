/**
 * The facilitator client, against a facilitator that is really there.
 *
 * Every test here stands a server up on 127.0.0.1 and lets the official client
 * make a real request to it. The reason is the one thing a hand-written fake
 * cannot check: that the credentials this gateway is configured with actually
 * arrive at the far end, as a header, on the request that carries the payment.
 * A fake client asserting that a function was called with the right arguments
 * would have gone green against the wrong header name, which is the defect this
 * file was written after.
 *
 * The address is given by name and never left to `listen(0)` alone. A bare
 * `listen(0)` takes the port on the IPv6 wildcard and leaves it free on
 * 127.0.0.1, and the calls below name 127.0.0.1 — the long version of why is in
 * `testing/harness.ts`, above `serve`.
 */

import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { cdpAuthenticatedClient, facilitatorClientFor } from "./client.js";

/**
 * A CDP API key of the shape the signer takes, made here and never written
 * down: sixty-four bytes of base64, the Ed25519 seed followed by its public
 * key. It opens nothing — no test in this file speaks to Coinbase — and
 * generating it is what keeps a credential-shaped string out of the repository.
 */
const anApiKeySecret = (): string => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const published = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return Buffer.concat([seed, published]).toString("base64");
};

interface Arrived {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
}

interface Standing {
  readonly url: string;
  readonly arrived: Arrived[];
  /** What the next request to this path is answered with. */
  answer(path: string, status: number, body: unknown): void;
}

const standing: Server[] = [];

afterEach(async () => {
  await Promise.all(
    standing.splice(0).map((server) => new Promise<void>((closed) => server.close(() => closed()))),
  );
});

/** A facilitator that records what reached it and answers what a test says. */
const aFacilitator = async (): Promise<Standing> => {
  const arrived: Arrived[] = [];
  const answers = new Map<string, { status: number; body: unknown }>();

  const server = createServer((request, response) => {
    const path = request.url ?? "";
    arrived.push({
      path,
      method: request.method ?? "",
      authorization: request.headers.authorization,
    });
    // The body is read and dropped: nothing here judges a payment, and a
    // request left unread keeps the socket open.
    request.resume();
    request.on("end", () => {
      const scripted = answers.get(path) ?? { status: 200, body: { isValid: true } };
      response.writeHead(scripted.status, { "content-type": "application/json" });
      response.end(JSON.stringify(scripted.body));
    });
  });

  standing.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((ready) => server.once("listening", () => ready()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    arrived,
    answer: (path, status, body) => answers.set(path, { status, body }),
  };
};

/** An address on the loopback interface with nothing behind it. */
const NOWHERE = "http://127.0.0.1:1";

const aPayment = (overrides: Partial<Parameters<typeof facilitatorClientFor>[0]> = {}) => ({
  facilitatorUrl: "https://x402.org/facilitator",
  network: "eip155:84532",
  timeoutSeconds: 300,
  payTo: null,
  cdpApiKeyId: null,
  cdpApiKeySecret: null,
  ...overrides,
});

const aPayload = { x402Version: 2, scheme: "exact", payload: { signature: "0xsigned" } };
const aRequirement = { scheme: "exact", network: "eip155:84532", amount: "1" };

/** The claims a signed token carries, read the way any reader of it would. */
const claimsOf = (authorization: string): Record<string, unknown> => {
  const token = authorization.replace(/^Bearer /, "");
  const [, claims = ""] = token.split(".");
  return JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
};

describe("talking to a facilitator that takes credentials", () => {
  it("signs every call for the address and the method it is actually made on", async () => {
    // The promise: a gateway configured with CDP credentials has them on the
    // wire, in the header the facilitator reads, bound to the request being
    // made. The binding is the part worth checking — the token names the method,
    // the host and the path it is good for, so a token signed for the wrong one
    // of the three is refused by the far end and the gateway settles nothing.
    const facilitator = await aFacilitator();
    const client = cdpAuthenticatedClient(facilitator.url, "an-api-key", anApiKeySecret());
    const host = new URL(facilitator.url).host;

    await client.verify(aPayload as never, aRequirement as never);
    facilitator.answer("/settle", 200, { success: true, transaction: "0xtx", network: "eip155:1" });
    await client.settle(aPayload as never, aRequirement as never);

    const [verified, settled] = facilitator.arrived;
    expect(verified?.authorization).toMatch(/^Bearer \S+$/);
    expect(claimsOf(verified?.authorization ?? "").uris).toStrictEqual([`POST ${host}/verify`]);
    expect(claimsOf(settled?.authorization ?? "").uris).toStrictEqual([`POST ${host}/settle`]);

    // The key it was signed with is the caller's, not one read out of the
    // ambient environment behind their back.
    expect(claimsOf(verified?.authorization ?? "").sub).toBe("an-api-key");
  });

  it("signs for the path the facilitator actually lives under", async () => {
    // Coinbase's facilitator is mounted under a path, and the token names the
    // whole of it. A token signed for `/verify` when the request goes to
    // `/platform/v2/x402/verify` is a token the far end refuses, and the whole
    // deployment settles nothing while looking configured.
    const facilitator = await aFacilitator();
    const client = cdpAuthenticatedClient(
      `${facilitator.url}/platform/v2/x402`,
      "an-api-key",
      anApiKeySecret(),
    );

    await client.verify(aPayload as never, aRequirement as never);

    const asked = facilitator.arrived[0];
    expect(asked?.path).toBe("/platform/v2/x402/verify");
    expect(claimsOf(asked?.authorization ?? "").uris).toStrictEqual([
      `POST ${new URL(facilitator.url).host}/platform/v2/x402/verify`,
    ]);
  });

  it("signs for the path a trailing slash would otherwise double", async () => {
    // A base written with a trailing slash is the same facilitator, and the
    // client strips it before building the address. The token has to be signed
    // against the address that is actually requested, not the one configured.
    const facilitator = await aFacilitator();
    const client = cdpAuthenticatedClient(
      `${facilitator.url}/x402/`,
      "an-api-key",
      anApiKeySecret(),
    );

    await client.verify(aPayload as never, aRequirement as never);

    const asked = facilitator.arrived[0];
    expect(asked?.path).toBe("/x402/verify");
    expect(claimsOf(asked?.authorization ?? "").uris).toStrictEqual([
      `POST ${new URL(facilitator.url).host}/x402/verify`,
    ]);
  });
});

describe("choosing a facilitator client for a configuration", () => {
  it("sends nothing to a facilitator that is not Coinbase's, credentials or no credentials", async () => {
    // The security promise, and the reason the fork is on the address rather
    // than on whether credentials happen to be set. Credentials left in an
    // environment beside somebody else's facilitator must not be handed to it:
    // a bearer token is a key, and this one is good for the account it came
    // from and not for the host it is sent to.
    const facilitator = await aFacilitator();
    const client = facilitatorClientFor(
      aPayment({
        facilitatorUrl: facilitator.url,
        cdpApiKeyId: "an-api-key",
        cdpApiKeySecret: anApiKeySecret(),
      }),
    );

    await client.verify(aPayload as never, aRequirement as never);

    expect(facilitator.arrived[0]?.authorization).toBeUndefined();
  });

  it("signs for Coinbase's facilitator, and names it by host rather than by one spelling", async () => {
    // No request is made here and none can be: reaching Coinbase is exactly what
    // this suite does not do. What is read instead is what the client would put
    // on the request, which is the library's own way of asking.
    const signed = facilitatorClientFor(
      aPayment({
        facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
        cdpApiKeyId: "an-api-key",
        cdpApiKeySecret: anApiKeySecret(),
      }),
    );

    const { headers } = await signed.createAuthHeaders("verify");
    expect(headers.Authorization).toMatch(/^Bearer \S+$/);
    expect(claimsOf(headers.Authorization ?? "").uris).toStrictEqual([
      "POST api.cdp.coinbase.com/platform/v2/x402/verify",
    ]);

    const unsigned = facilitatorClientFor(aPayment());
    expect((await unsigned.createAuthHeaders("verify")).headers.Authorization).toBeUndefined();
  });

  it("will not build an unauthenticated client for a facilitator that takes no request without one", async () => {
    // The configuration refuses this deployment at startup, so nothing in the
    // running gateway reaches here. It is a second lock on the same door,
    // because this function can be called by anything in the process and a
    // client built without credentials would fail silently at the first charge
    // rather than loudly here.
    expect(() =>
      facilitatorClientFor(
        aPayment({ facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402" }),
      ),
    ).toThrowError(/CDP_API_KEY/);
  });
});

describe("a facilitator that is not answering", () => {
  it("is built without being asked anything, so an outage cannot stop the process starting", async () => {
    // The spike's server called the facilitator while starting up and died when
    // it did not answer — a storefront killed by somebody else's outage. This
    // gateway builds its payment layer from configuration alone: nothing is
    // asked until there is a payment to ask about.
    const facilitator = await aFacilitator();

    const client = facilitatorClientFor(aPayment({ facilitatorUrl: facilitator.url }));
    expect(facilitator.arrived).toStrictEqual([]);

    // And it is a working client, not an inert one: the first request is the
    // first request, and it goes.
    await client.verify(aPayload as never, aRequirement as never);
    expect(facilitator.arrived).toHaveLength(1);
  });

  it("fails the call and not the process when nothing is listening", async () => {
    // A facilitator that cannot be reached is one call that could not be
    // answered. The client raises, the adapter above turns that into a silence
    // the order machine has a word for, and the process carries on — the second
    // call proves the first left nothing broken behind it.
    const client = facilitatorClientFor(aPayment({ facilitatorUrl: NOWHERE }));

    await expect(client.verify(aPayload as never, aRequirement as never)).rejects.toThrow();
    await expect(client.settle(aPayload as never, aRequirement as never)).rejects.toThrow();
    await expect(client.verify(aPayload as never, aRequirement as never)).rejects.toThrow();
  });

  it("raises rather than answering when the facilitator fails inside itself", async () => {
    // A 500 is not a verdict about the payment, and the client says so by
    // raising. What the adapter makes of that is its own test; what this one
    // pins is that a broken facilitator never reaches the machine looking like
    // an answer.
    const facilitator = await aFacilitator();
    facilitator.answer("/verify", 500, { error: "internal" });
    facilitator.answer("/settle", 503, { error: "unavailable" });
    const client = facilitatorClientFor(aPayment({ facilitatorUrl: facilitator.url }));

    await expect(client.verify(aPayload as never, aRequirement as never)).rejects.toThrow();
    await expect(client.settle(aPayload as never, aRequirement as never)).rejects.toThrow();
  });

  it("carries a refusal the facilitator sent with a refusing status, and the status with it", async () => {
    // The assumption the whole error taxonomy rests on, checked against the
    // library rather than read off its source: a 4xx whose body is a verdict
    // arrives as a raised error that still carries the verdict and the status.
    // Without both, the adapter above cannot tell a refusal from a silence.
    const facilitator = await aFacilitator();
    facilitator.answer("/verify", 400, {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_signature",
    });
    const client = facilitatorClientFor(aPayment({ facilitatorUrl: facilitator.url }));

    await expect(client.verify(aPayload as never, aRequirement as never)).rejects.toMatchObject({
      statusCode: 400,
      invalidReason: "invalid_exact_evm_payload_signature",
    });
  });

  it("hands back what the facilitator said when the charge goes through", async () => {
    const facilitator = await aFacilitator();
    facilitator.answer("/settle", 200, {
      success: true,
      transaction: "0xdeadbeef",
      network: "eip155:84532",
    });
    const client = facilitatorClientFor(aPayment({ facilitatorUrl: facilitator.url }));

    const settled = await client.settle(aPayload as never, aRequirement as never);

    expect(settled).toMatchObject({ success: true, transaction: "0xdeadbeef" });
  });
});
