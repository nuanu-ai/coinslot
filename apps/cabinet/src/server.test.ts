/**
 * The cabinet, driven the way a merchant drives it: over HTTP, against a real
 * gateway.
 *
 * Nothing between the browser and the order machine is stubbed. The gateway on
 * the other end is the real one on in-memory adapters — the same harness its
 * own HTTP tests use — so every screen here is drawn from documents the real
 * API produced, and a cabinet that drifted from the contract fails here rather
 * than in front of a merchant. That is ADR-0005 §3 held by a test: if the
 * cabinet cannot show something, the API is missing it.
 *
 * Signing in is not stubbed either. The component ADR-0009 hands identity to is
 * the real one, doing the real deriving and the real signing; what is swapped
 * for the tests is only where it keeps its rows, which is the component's own
 * memory store rather than Postgres, because `pnpm test` works without a
 * database. `identity.db-test.ts` runs the same flows against a real one, on
 * tables the checked-in migrations built.
 *
 * The assertions are about what a merchant can see and do — a state beside a
 * card, a control that pauses it, a purchase that is refused afterwards. They
 * are deliberately not about markup: a page that changed its class names has
 * not broken a promise to anybody.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { SITES } from "@coinslot/core";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
  workUntilStopped,
} from "@coinslot/gateway/testing";
import {
  type Card,
  checksummedAddressOf,
  type MerchantKey,
  type MerchantKeyList,
  type Order,
  type RegisteredMerchant,
} from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CabinetConfig, loadConfig } from "./config.js";
import { type Answer, type GatewayClient, gatewayFor, type Registrar } from "./gateway.js";
import { type Identity, identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { buildApp } from "./server.js";
import { readable } from "./testing/html.js";

/**
 * The key the gateway harness's own merchant holds, named rather than spelled
 * again. Every call in this file goes to a real gateway, whose door reads the
 * environment off the prefix, so a second copy of the string here would come
 * apart from the harness the first time that prefix changed. Every gateway this
 * file boots is a test one, which is why the environment can be named here.
 */
const KEY = theMerchantKey("test");
const asMerchant = { authorization: `Bearer ${KEY}` };
const PAY_TO = "0x0000000000000000000000000000000000000001";

/** The name the session cookie travels under. */
const COOKIE = "coinslot.session_token";

/** The person whose account every test in this file signs in as. */
const PERSON = "dmitry@example.com";
/**
 * A second person with an account on the same cabinet.
 *
 * ADR-0009 §9 says the pilot has one merchant and one person, and this is the
 * fixture for the case that does not care: a request can carry a session that
 * belongs to somebody else, and "somebody else" cannot be tested with one
 * account in the store.
 */
const OTHER = "someone@example.com";
/**
 * A third person, whose account has no merchant on it.
 *
 * That is a real row on a deployed server — it was written before an account
 * named the merchant it signs in for — and it is a row no door in the cabinet
 * can produce, because every one of them writes the merchant in the same act
 * that writes the account. So it is made here the way the deployment has it:
 * an ordinary account, with the two columns emptied afterwards.
 */
const BEFORE_MERCHANTS = "before-merchants@example.com";
const PASSWORD = "a-password-nobody-guesses";

/**
 * The code the gateway is told to accept, for the tests that register for real.
 *
 * Almost every test here signs in as an account the harness seeded, whose key
 * is one of the merchant's own — the shape a deployment only gets when somebody
 * at a terminal made the account. The tests about the key a cabinet holds
 * cannot use it: the two calls about that key are refused to any other kind. So
 * they go through the registration form against the real gateway, which is
 * where a real cabinet key comes from, and this is what stands in the door.
 */
const INVITATION = "the-invitation-the-gateway-accepts";

/** Somebody registering for themselves, who has no account until they do. */
const FRESH = { email: "fresh-merchant@example.com", password: "a-password-of-their-own" };

/**
 * The merchant both of those accounts sign in as.
 *
 * One merchant with two people at it, which ADR-0009 §9 names as a shape the
 * cabinet does not really have — it is here because "somebody else's session"
 * cannot be tested with one account, and because the key on both rows is the
 * one the harness seeded, so every screen these tests read is drawn from the
 * real gateway.
 */
const THE_MERCHANT = { id: "mer_the_merchant", key: KEY };

/**
 * The cabinet's identity under test: the real component on its memory store,
 * with the account almost every test signs in as already in it.
 *
 * The rows are handed in rather than kept inside so that a test can put an
 * account into a state no door produces, and can read what the component
 * actually wrote. The few tests that need another person make that person
 * themselves instead of making every test derive three passwords.
 */
const withIdentity = async (
  config: CabinetConfig,
  postman: (message: Message) => Promise<void>,
): Promise<{
  identity: Identity;
  forgetMerchant: (email: string) => void;
  rows: Record<string, Record<string, unknown>[]>;
}> => {
  const rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
  };
  const identity = identityFor(config, { rows, postman });
  await identity.make(PERSON, PASSWORD, THE_MERCHANT);
  const forgetMerchant = (email: string): void => {
    for (const row of rows.cabinet_accounts ?? []) {
      if (row.email === email) {
        row.merchantId = null;
        row.merchantKey = null;
      }
    }
  };
  return { identity, forgetMerchant, rows };
};

/**
 * The session rows the component has written.
 *
 * Read straight out of its store rather than inferred from a cookie, because
 * the two assertions that use it are about what the row says and not about what
 * the browser was told — a browser can be told anything about a cookie and the
 * cabinet still asks the store.
 */
const sessionRows = (): Record<string, unknown>[] => open?.rows.cabinet_sessions ?? [];

/**
 * When the one open session runs out, to the millisecond.
 *
 * The number rather than the rendering of it. `String(date)` is written to the
 * second, and a session refreshed on the same second as the page before it
 * would read as one that had not moved at all — which is how the assertion
 * below passed while nothing was being asserted.
 */
const expiryOfTheSession = (): number => Number(new Date(sessionRows()[0]?.expiresAt as never));

/** Whether that exact cookie value is still a session somebody is signed in on. */
const stillASession = async (identity: Identity, value: string): Promise<boolean> =>
  (await identity.whoIs(`${COOKIE}=${value}`)) !== null;

const roomCard: Card = {
  merchant_item_id: "SKU 100/1",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const esimCard: Card = {
  merchant_item_id: "esim-eu-5",
  title: "eSIM Europe, 5 GB for 30 days",
  description: "A data plan delivered as a profile after the purchase",
  price: { amount: "8.00", currency: "USD" },
  result: { iccid: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 14_400,
};

/**
 * A card priced under the gateway's ceiling on one test purchase, whose goods
 * come back in the answer.
 *
 * The two cards above are both above that ceiling, and a test purchase of
 * either is refused before the walk starts — which is a case of its own below
 * and not the one the happy walk needs.
 */
const lockerCard: Card = {
  merchant_item_id: "locker-day",
  title: "A locker for the day",
  description: "One locker by the changing rooms, until closing time",
  price: { amount: "3.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

/** A card whose purchase asks the buyer two questions. */
const tourCard: Card = {
  merchant_item_id: "tour-morning",
  title: "A guided tour, mornings",
  description: "Ninety minutes with a guide, starting at ten",
  price: { amount: "4.00", currency: "USD" },
  params: {
    email: { type: "string", required: true, title: "Where to send the ticket" },
    party: { type: "integer", title: "How many are coming" },
  },
  result: { ticket_code: { type: "string" } },
  fulfillment: "sync",
};

/**
 * A second card that asks a question, and asks a different one.
 *
 * It is the negative control for the form the cabinet draws from a card's own
 * declaration: with one such card on the page, a form built from a list
 * somebody wrote out by hand would pass every assertion about the first.
 */
const bicycleCard: Card = {
  merchant_item_id: "bike-hour",
  title: "A bicycle for an hour",
  description: "One bicycle from the rack by the gate",
  price: { amount: "2.00", currency: "USD" },
  params: {
    returned_at: { type: "string", required: true, title: "When you will bring it back" },
  },
  result: { unlock_code: { type: "string" } },
  fulfillment: "sync",
};

/** One answer from the cabinet, as a browser would have it. */
interface Visit {
  readonly status: number;
  readonly headers: Headers;
  readonly html: string;
  /** Where a redirect points, or null where the answer is a page. */
  readonly to: string | null;
}

interface Browser {
  get(path: string): Promise<Visit>;
  post(path: string, form?: Record<string, string>): Promise<Visit>;
  /** A post of a body this cabinet's forms never send, as a scanner would. */
  postRaw(path: string, contentType: string, body: string): Promise<Visit>;
  /**
   * Signs in as a person and follows the redirect, the way a browser does.
   * The account every test in this file starts with is the default.
   */
  signIn(email?: string, password?: string): Promise<Visit>;
  /** The identifier in this browser's session cookie, or null. */
  sessionToken(): string | null;
  /** The same browser sending one exact cookie header instead of its jar. */
  withRawCookie(cookie: string): Browser;
  /** The same browser claiming its page came from somewhere else. */
  from(origin: string): Browser;
  /**
   * The same browser behind something that adds headers of its own.
   *
   * A terminator in front of the cabinet is not a browser and cannot be driven
   * as one, so the headers it would add are put on the request here.
   */
  sending(headers: Record<string, string>): Browser;
  close(): Promise<void>;
}

interface Running {
  readonly harnessed: Harness;
  readonly gateway: Served;
  readonly browser: Browser;
  /**
   * Where the cabinet under test is listening.
   *
   * A test that has to name an origin needs the host and the port the cabinet
   * is actually answering on, because an origin the browser claims is compared
   * against the `Host` header of the same request.
   */
  readonly url: string;
  /** The component the cabinet under test signs people in against. */
  readonly identity: Identity;
  /**
   * Empties the two merchant columns on one account.
   *
   * What it makes is the row on the deployed server: an account written before
   * an account named the merchant it signs in for. No door in the cabinet
   * produces one, because every one of them writes the merchant in the same act
   * that writes the account.
   */
  readonly forgetMerchant: (email: string) => void;
  /** The rows the component wrote, for the two assertions that read one. */
  readonly rows: Record<string, Record<string, unknown>[]>;
  /**
   * The payout address the stand-in for that route is holding.
   *
   * The route itself is being added on another branch, so what this cabinet
   * talks to for it is not the real gateway. What these tests can hold is the
   * cabinet's half — that an address a merchant typed was sent, and that one
   * refused on the page never was. What actually goes on the wire is held in
   * `gateway.test.ts` against a server that records it.
   */
  /** Every message the cabinet handed over while this test ran. */
  readonly mails: Message[];
  /** A second browser on the same cabinet, for two people or two devices. */
  another(): Promise<Browser>;
  /** Takes the gateway away, once. One test does this on purpose. */
  stopGateway(): Promise<void>;
}

let open: Running | null = null;

/** What one test asks of the cabinet it stands up. */
interface Starting {
  readonly base?: string;
  readonly gateway?: Record<string, string>;
  readonly cabinet?: Record<string, string>;
  /**
   * How the route that makes a merchant answers.
   *
   * Stubbed rather than real for the tests that are about what the cabinet does
   * with an answer of each shape. Left alone, the real registrar goes to the
   * real gateway — which is where a real key made for a cabinet comes from, and
   * the only way to get an account row that holds one.
   */
  readonly registrar?: Registrar;
  /**
   * The real client, with some of its calls answered by the test instead.
   *
   * A decorator rather than a replacement, so that everything a test is not
   * about still goes to the real gateway. What it is for is the answers the
   * gateway will not give on command: a call that is refused, or one that
   * nothing answers at all.
   */
  readonly client?: (real: GatewayClient) => GatewayClient;
  /**
   * The real component, with some of its calls answered by the test instead.
   *
   * The same shape as the client above and for the same reason. One thing the
   * store cannot be asked for is a write that fails, and what the cabinet does
   * when the fresh key cannot be written onto a row is the case that decides
   * whether somebody is locked out of their own cabinet.
   */
  readonly identity?: (real: Identity) => Identity;
}

/**
 * Headers a hop writes for itself and must not carry to the next one.
 */
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "content-encoding",
]);

/**
 * A server standing at the gateway's public address, forwarding everything to
 * the gateway itself.
 *
 * It exists because one thing the cabinet can ask the gateway for goes back out
 * of the front door: a test purchase is walked over real HTTP against
 * `PUBLIC_BASE_URL`, which is the address a stranger's agent would call. That
 * address has to be in the gateway's configuration before the gateway is built,
 * and the port the gateway takes is not known until after — so something has to
 * be listening at a known address first and be pointed at the gateway
 * afterwards. Every other test pays one idle socket for it, which is cheaper
 * than a second way of standing a cabinet up.
 */
interface Storefront {
  readonly url: string;
  aimAt(gateway: string): void;
  close(): Promise<void>;
}

const forwardingTo = async (): Promise<Storefront> => {
  let gateway: string | null = null;

  const server = createServer((request, response) => {
    void (async () => {
      if (gateway === null) {
        response.statusCode = 502;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (HOP_HEADERS.has(name) || value === undefined) continue;
        headers[name] = Array.isArray(value) ? (value[0] ?? "") : value;
      }

      const answered = await fetch(`${gateway}${request.url ?? "/"}`, {
        method: request.method,
        headers,
        ...(body.length === 0 ? {} : { body }),
      });
      response.statusCode = answered.status;
      answered.headers.forEach((value, name) => {
        if (HOP_HEADERS.has(name)) return;
        response.setHeader(name, value);
      });
      response.end(Buffer.from(await answered.arrayBuffer()));
    })().catch((thrown: unknown) => {
      response.statusCode = 502;
      response.end(String(thrown));
    });
  });

  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    aimAt: (at) => {
      gateway = at;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

const started = async (options: Starting = {}): Promise<Running> => {
  const storefront = await forwardingTo();
  const harnessed = await harness({
    PAY_TO_ADDRESS: PAY_TO,
    // The same facilitator the cabinet below is configured with, so the two
    // halves of one stack agree about whether anything settles. They did not
    // before: the cabinet said sandbox and the gateway behind it said test,
    // which is a shape no deployment has and which makes the gateway ask for a
    // funded wallet it has no way to be given here.
    FACILITATOR_URL: "sandbox:scripted",
    PUBLIC_BASE_URL: storefront.url,
    ...options.gateway,
  });
  const gateway = await serve(harnessed);
  storefront.aimAt(gateway.url);
  const basePath = options.base ?? "";
  const mails: Message[] = [];
  const { browser, url, identity, forgetMerchant, rows } = await visiting(
    gateway.url,
    basePath,
    mails,
    options,
  );
  let stopped = false;

  open = {
    harnessed,
    gateway,
    browser,
    url,
    identity,
    forgetMerchant,
    rows,
    mails,
    another: async () => await attachedTo(url, basePath),
    async stopGateway() {
      if (stopped) {
        return;
      }
      stopped = true;
      await storefront.close();
      await gateway.close();
      await harnessed.stop();
    },
  };
  return open;
};

/**
 * A server that accepts the connection and then says nothing, ever.
 *
 * The worst shape a gateway fails in, and the only one that costs wall time: a
 * refused connection comes back at once, while this holds the caller until the
 * caller gives up. One test points a cabinet at it to find out how long that is.
 */
let silent: Server | null = null;
const silentGateway = async (): Promise<string> => {
  const server = createServer(() => {
    // Deliberately no answer: the point is that the caller is the one that
    // has to stop waiting.
  });
  silent = server;
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent gateway did not take a port");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  await open?.browser.close();
  await open?.identity.close();
  await open?.stopGateway();
  open = null;
  silent?.closeAllConnections();
  silent?.close();
  silent = null;
});

/** The cabinet on a port, and a cookie jar of one. */
async function visiting(
  gatewayUrl: string,
  basePath: string,
  mails: Message[],
  options: Starting,
): Promise<{
  browser: Browser;
  url: string;
  identity: Identity;
  forgetMerchant: (email: string) => void;
  rows: Record<string, Record<string, unknown>[]>;
}> {
  // No merchant key in the environment, which is the point: the cabinet builds
  // its client from the key on the row of whoever is signed in, so what these
  // tests drive is the real client against the real gateway with the key the
  // harness seeded (ADR-0014 §2).
  //
  // The database address is one nothing connects to, and nothing does: the
  // component under test keeps its rows in memory here. It is still required,
  // because a cabinet started without one is a cabinet that can draw a sign-in
  // form and never accept one.
  const config = loadConfig({
    GATEWAY_URL: gatewayUrl,
    DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
    AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
    PAYMENT_NETWORK: "eip155:84532",
    FACILITATOR_URL: "sandbox:scripted",
    ...(basePath === "" ? {} : { BASE_PATH: basePath }),
    ...(options.cabinet ?? {}),
  });
  const { identity, forgetMerchant, rows } = await withIdentity(config, async (message) => {
    mails.push(message);
  });
  const app = buildApp(config, {
    identity: options.identity === undefined ? identity : options.identity(identity),
    ...(options.registrar === undefined ? {} : { registrar: options.registrar }),
    // Built from the configured address and given the deadline it was asked
    // for, so that a test which points the cabinet somewhere else — at nothing
    // at all, or at a server that never answers — is answered the way a
    // deployment would be, and so that how long the cabinet is willing to wait
    // is its own decision and not this seam's.
    gatewayFor: (key: string, answerWithinMs?: number) => {
      const real = gatewayFor(config.gatewayUrl, key, answerWithinMs);
      return options.client === undefined ? real : options.client(real);
    },
  });
  // On the address it is called at, rather than on the wildcard: the gateway's
  // own harness says at length what a wildcard bind costs, and this cabinet is
  // called the same way from the same worker.
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const url = `http://127.0.0.1:${port}`;
  const browser = await attachedTo(url, basePath);
  return {
    url,
    identity,
    forgetMerchant,
    rows,
    browser: {
      ...browser,
      // Closing one that is already closed is not an error. A test that stands
      // several cabinets up and takes each down as it finishes still meets the
      // sweep afterwards, and a second close that threw would fail the test for
      // tidying up after itself.
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) =>
            error === undefined ||
            (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
              ? resolve()
              : reject(error),
          );
        }),
    },
  };
}

/**
 * A browser pointed at a cabinet that is already listening, with a cookie jar
 * of its own.
 *
 * Separate from `visiting` because two of the tests build their own cabinet —
 * one whose gateway client answers as the test says — and everything about
 * being a browser is the same for both.
 */
async function attachedTo(url: string, basePath: string): Promise<Browser> {
  const jar = new Map<string, string>();

  const call = async (
    method: string,
    path: string,
    form?: Record<string, string>,
    sent: {
      readonly cookie?: string;
      readonly origin?: string;
      readonly extra?: Record<string, string>;
      readonly raw?: { readonly contentType: string; readonly body: string };
    } = {},
  ): Promise<Visit> => {
    const cookie = sent.cookie ?? [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const answered = await fetch(`${url}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie === "" ? {} : { cookie }),
        ...(sent.origin === undefined ? {} : { origin: sent.origin }),
        ...(sent.extra ?? {}),
        ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        ...(sent.raw === undefined ? {} : { "content-type": sent.raw.contentType }),
      },
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
      ...(sent.raw === undefined ? {} : { body: sent.raw.body }),
    });

    for (const line of answered.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (at === -1) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value === "") {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }

    return {
      status: answered.status,
      headers: answered.headers,
      html: await answered.text(),
      to: answered.headers.get("location"),
    };
  };

  const browser: Browser = {
    get: (path) => call("GET", path),
    post: (path, form) => call("POST", path, form ?? {}),
    postRaw: (path, contentType, body) =>
      call("POST", path, undefined, { raw: { contentType, body } }),
    async signIn(email = PERSON, password = PASSWORD) {
      const posted = await call("POST", `${basePath}/sign-in`, { email, password });
      return posted.to === null ? posted : call("GET", posted.to);
    },
    sessionToken: () => jar.get(COOKIE) ?? null,
    withRawCookie: (raw) => ({
      ...browser,
      get: (path) => call("GET", path, undefined, { cookie: raw }),
      post: (path, form) => call("POST", path, form ?? {}, { cookie: raw }),
    }),
    from: (origin) => ({
      ...browser,
      get: (path) => call("GET", path, undefined, { origin }),
      post: (path, form) => call("POST", path, form ?? {}, { origin }),
    }),
    sending: (extra) => ({
      ...browser,
      get: (path) => call("GET", path, undefined, { extra }),
      post: (path, form) => call("POST", path, form ?? {}, { extra }),
    }),
    close: async () => undefined,
  };

  return browser;
}

/**
 * One request written straight onto a socket, with nothing added to it.
 *
 * `fetch` sends headers of its own — an accept, a user agent, an encoding — and
 * they count against the 16 KB of headers the runtime will read. A test about
 * how many cookies one request can carry cannot be written with it, because
 * what it would be measuring is those headers. This sends a request line, a
 * Host, the cookies, and nothing else.
 */
const overASocket = (
  url: string,
  path: string,
  cookie: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
          `Cookie: ${cookie}\r\nConnection: close\r\n\r\n`,
      );
    });
    let said = "";
    socket.on("data", (chunk: Buffer) => {
      said += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      resolve({
        status: Number(said.split(" ")[1] ?? 0),
        body: readable(said.split("\r\n\r\n").slice(1).join("\r\n\r\n")),
      });
    });
  });

const publish = async (gateway: Served, card: Card): Promise<string> => {
  const answered = await gateway.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: { authorization: `Bearer ${KEY}` },
  });
  expect(answered.status).toBe(200);
  return (answered.body as { id: string }).id;
};

/** Whether an agent could buy this product right now. */
const purchasable = async (gateway: Served, itemId: string): Promise<boolean> =>
  (await gateway.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } })).status === 402;

/**
 * Takes the name buyers read off the merchant every test in this file signs in
 * as.
 *
 * Through the store rather than through the route, and that is not a shortcut:
 * the route refuses to take a name away on purpose, so no door in the cabinet
 * leads back to this state. What it makes is the merchant a person has in the
 * minute after they register, which is the state the screens below exist for.
 */
const unname = async (running: Running): Promise<void> => {
  await running.harnessed.store.setServiceName(
    running.harnessed.merchant.id,
    null,
    running.harnessed.now(),
  );
};

/** What the gateway has this merchant listed as, read out of its store. */
const listedAs = async (running: Running): Promise<string | null> =>
  (await running.harnessed.store.merchantById(running.harnessed.merchant.id))?.serviceName ?? null;

/** Where the gateway would pay this merchant, read out of the same row. */
const paidInto = async (running: Running): Promise<string | null> =>
  (await running.harnessed.store.merchantById(running.harnessed.merchant.id))?.payoutWallet ?? null;

describe("getting into the cabinet", () => {
  it("shows a visitor with no session the sign-in and nothing else at all", async () => {
    // ADR-0009 §5: the gate denies by default, and every address answers the
    // same way whether or not there is a page behind it. A 404 for an address
    // the cabinet does not serve would let a stranger read off which ones it
    // does, and a route added later would have to remember to be guarded.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);

    for (const path of ["/", "/cards", "/orders", "/receipts", "/keys", "/password", "/nowhere"]) {
      const answered = await browser.get(path);
      expect(answered.status, path).toBe(303);
      expect(answered.to, path).toBe("/sign-in");
    }

    // And nothing a form could ask for happens either. The negative control is
    // the fact, not the answer: selling is still open afterwards.
    const forged = await browser.post("/selling/pause");
    expect(forged.status).toBe(303);
    expect(forged.to).toBe("/sign-in");
    expect(await purchasable(gateway, itemId)).toBe(true);

    expect(readable((await browser.get("/sign-in")).html)).toContain("Sign in");
  });

  it("takes an address and a password and shows the cards", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);

    const cards = await browser.signIn();

    expect(cards.status).toBe(200);
    expect(readable(cards.html)).toContain("A room for the night");
    // And the page says who is looking at it, which is the whole point of there
    // being a person in the system rather than a key.
    expect(readable(cards.html)).toContain(PERSON);
  });

  it("shows each person the catalogue of their own merchant and not of the other one", async () => {
    // ADR-0014 §2, and the promise the whole change exists for. The cabinet used
    // to reach the gateway with one key read at start-up, so a second account was
    // a second person looking at the first merchant's money. The key comes off
    // the row of whoever is signed in now, and this is against the real gateway
    // with two merchants really seeded — a cabinet that still held one key would
    // draw the same catalogue for both people and fail here.
    const { browser, gateway, harnessed, identity, another } = await started();
    const theirs = await harnessed.addMerchant("The other merchant");
    await publish(gateway, roomCard);
    await gateway.call("POST", "/v0/catalog/publish", {
      body: { ...esimCard, title: "A plan the other merchant sells" },
      headers: { authorization: `Bearer ${theirs.key}` },
    });
    await identity.make("theirs@example.com", PASSWORD, { id: theirs.id, key: theirs.key });

    const mine = readable((await browser.signIn()).html);
    const otherBrowser = await another();
    const other = readable((await otherBrowser.signIn("theirs@example.com")).html);

    expect(mine).toContain("A room for the night");
    expect(mine).not.toContain("A plan the other merchant sells");
    expect(other).toContain("A plan the other merchant sells");
    expect(other).not.toContain("A room for the night");
  });

  it("refuses an account made before accounts had a merchant, and says what to run", async () => {
    // The one account on a deployed server predates the column, so it has no key
    // and there is not a single screen it can be shown. Served an empty cabinet
    // it would read as a merchant whose catalogue had been emptied; answered with
    // an exception it would read as a broken cabinet. It is neither, and the
    // sentence says which command makes an account that works.
    const { browser, identity, forgetMerchant } = await started();
    await identity.make(BEFORE_MERCHANTS, PASSWORD, THE_MERCHANT);
    forgetMerchant(BEFORE_MERCHANTS);

    const refused = await browser.post("/sign-in", {
      email: BEFORE_MERCHANTS,
      password: PASSWORD,
    });

    expect(refused.status).toBe(403);
    const text = readable(refused.html);
    expect(text).toMatch(/before/i);
    expect(text).toContain("account add");
    // And nobody was signed in on the way past.
    expect(refused.headers.getSetCookie()).toStrictEqual([]);
    expect((await browser.get("/cards")).to).toBe("/sign-in");
  });

  it("stops an account that lost its merchant from using a session it already had", async () => {
    // A session outlives a deployment, so somebody signed in on the cabinet as
    // it was before this change arrives at the gate holding a live session for
    // an account with no key on it. The gate is where that has to be caught: a
    // handler below it would reach for a key that is not there.
    const { browser, identity, forgetMerchant } = await started();
    await browser.signIn();
    const held = browser.sessionToken() ?? "";
    // The deployment happens under them: the columns their cabinet was drawing
    // every screen from are emptied while they are signed in.
    forgetMerchant(PERSON);

    const answered = await browser.get("/cards");

    expect(answered.status).toBe(403);
    expect(readable(answered.html)).toContain("account add");
    // And the session goes, which is the half that keeps this from being a
    // trap. Left alive it stands in front of both doors out: this gate answers
    // every address, and both the sign-in and the registration send a visitor
    // who has a session back to their cards — which land here again.
    await expect(stillASession(identity, held)).resolves.toBe(false);
    const after = browser.withRawCookie(`${COOKIE}=${held}`);
    expect((await after.get("/register")).status).toBe(200);
    expect((await after.get("/sign-in")).status).toBe(200);
  });

  it("answers a wrong password and an address nobody has in exactly the same way", async () => {
    // Different answers would make this form a list of who has an account here.
    const { browser } = await started();

    const wrongPassword = await browser.post("/sign-in", {
      email: PERSON,
      password: "not-the-password",
    });
    const noSuchPerson = await browser.post("/sign-in", {
      email: "stranger@example.com",
      password: PASSWORD,
    });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchPerson.status).toBe(401);
    expect(readable(wrongPassword.html)).toBe(readable(noSuchPerson.html));
    expect(readable(wrongPassword.html)).toMatch(/do not match/i);
    // Neither of them signed anybody in.
    expect(wrongPassword.headers.getSetCookie()).toStrictEqual([]);
    expect((await browser.get("/cards")).to).toBe("/sign-in");
  });

  it("refuses a sign-in with a field missing rather than treating it as empty", async () => {
    const { browser } = await started();

    for (const form of [{ email: PERSON }, { password: PASSWORD }, {}]) {
      const refused = await browser.post("/sign-in", form as Record<string, string>);
      expect(refused.status).toBe(400);
      expect(refused.headers.getSetCookie()).toStrictEqual([]);
    }
  });

  it("refuses a sign-in that is not a form rather than saying the cabinet is broken", async () => {
    // Express leaves `body` undefined when the content type is not the one the
    // form parser handles, so reading a field off it throws — and a request
    // that is merely malformed lands on the page that says something here is
    // broken, with a stack trace in the log for every scanner that ever posts
    // JSON at this address.
    const { browser } = await started();
    // Signed in, or the password page is answered by the gate and this would
    // never reach the handler it is about. It did not, at first: the mutation
    // that undoes the fix survived, because a 303 from the gate is not a 500.
    await browser.signIn();

    for (const at of ["/sign-in", "/password"]) {
      const answered = await browser.postRaw(at, "application/json", '{"email":"x"}');
      expect(answered.status, at).not.toBe(500);
      expect(answered.to, at).toBeNull();
      expect(readable(answered.html), at).not.toContain("broken");
    }
  });

  it("refuses a body larger than any of its forms without calling itself broken", async () => {
    // The body parser runs above the gate, so a visitor with no session reaches
    // it — and a refusal that lands on the internal-error page is both a wrong
    // message and a way for a stranger to put a stack trace in the log on every
    // request. Answered as what it is instead.
    const { browser } = await started();

    const answered = await browser.postRaw(
      "/sign-in",
      "application/x-www-form-urlencoded",
      `email=${"x".repeat(30_000)}`,
    );

    expect(answered.status).toBe(413);
    const text = readable(answered.html);
    expect(text).not.toContain("broken");
    expect(text).toMatch(/larger/i);
  });

  it("puts no key and no password into the cookie, and none on any page", async () => {
    // The whole reason this decision exists: a merchant's API key used to be
    // typed into a form and kept in a browser. Nothing here may carry one.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);

    const signedIn = await browser.signIn();
    const token = browser.sessionToken() ?? "";

    expect(token).not.toBe("");
    expect(token).not.toContain(KEY);
    expect(token).not.toContain(PASSWORD);
    for (const page of [signedIn, await browser.get("/orders"), await browser.get("/receipts")]) {
      expect(page.html).not.toContain(KEY);
      expect(page.html).not.toContain(PASSWORD);
    }
  });

  it("keeps the session out of reach of a script and of another site", async () => {
    const { browser } = await started();

    const signedIn = await browser.post("/sign-in", { email: PERSON, password: PASSWORD });
    const cookie = signedIn.headers.getSetCookie().join(" ");

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it("marks the cookie Secure where the cabinet is served over https, and only there", async () => {
    // The one line a deployment has to change, and the one most likely to be
    // forgotten: without it a merchant's session travels in the clear. It is
    // off by default because the cabinet is developed over plain http, where a
    // Secure cookie is never sent back and nobody can sign in at all.
    const overHttps = await started({ cabinet: { COOKIE_SECURE: "true" } });
    const marked = await overHttps.browser.post("/sign-in", {
      email: PERSON,
      password: PASSWORD,
    });

    expect(marked.headers.getSetCookie().join(" ")).toMatch(/;\s*Secure/i);
    await overHttps.browser.close();
    await overHttps.identity.close();
    await overHttps.stopGateway();

    const overHttp = await started();
    const plain = await overHttp.browser.post("/sign-in", { email: PERSON, password: PASSWORD });

    expect(plain.headers.getSetCookie().join(" ")).not.toMatch(/;\s*Secure/i);
  });

  it("gives a session twelve hours and not a day, an hour or a year", async () => {
    // ADR-0009 §6. The store honours whatever it is handed and the contract
    // suite says so; this is the only place the number itself is written down,
    // and a typo in it is a session that lasts a year.
    const { browser } = await started();
    const signedIn = await browser.post("/sign-in", { email: PERSON, password: PASSWORD });
    const at = Date.now();
    const twelveHours = 12 * 60 * 60 * 1_000;

    // What the browser is told to keep the cookie for.
    const maxAge = /Max-Age=(\d+)/i.exec(signedIn.headers.getSetCookie().join(" "))?.[1];
    expect(Number(maxAge)).toBe(twelveHours / 1_000);

    // And what the row says, which is the one that decides: a browser can be
    // told anything about a cookie and the cabinet still asks the store.
    expect(expiryOfTheSession() - at).toBeGreaterThan(twelveHours - 60_000);
    expect(expiryOfTheSession() - at).toBeLessThan(twelveHours + 60_000);
  });

  it("does not move that deadline further off every time a page is opened", async () => {
    // A sliding window would mean a session that never ends as long as a tab
    // stays in front of somebody, which is the case twelve hours exists to
    // catch — a browser left open on a machine other people use.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    // The value and not the row. The store hands back the object it is holding,
    // so keeping the row would compare it with itself and pass whatever the
    // cabinet did.
    const before = expiryOfTheSession();
    expect(before).toBeGreaterThan(0);

    await browser.get("/cards");
    await browser.get("/orders");

    expect(expiryOfTheSession()).toBe(before);
  });

  it("keeps a person signed in when the key their cabinet holds stops working", async () => {
    // The promise ADR-0009 was written for, held against the real gateway now
    // that a key is a row there too. Before that decision, the key in the
    // cabinet was the person's password: taking it away signed the human out
    // and broke the merchant's own code in the same instant, and neither could
    // be done alone. Here the gateway really stops accepting the key — the same
    // act ADR-0014 §5 puts behind a control on the keys screen — and the
    // session does not notice.
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    await harnessed.disableKey(harnessed.merchant.keyId);
    const after = await browser.get("/cards");

    // Still signed in: the session is a row of the cabinet's and has nothing to
    // do with what the gateway thinks of a key.
    expect(after.to).toBeNull();
    expect(after.status).toBe(502);
    expect(readable(after.html)).toMatch(/key/i);
    expect(after.headers.getSetCookie().join(" ")).not.toContain(`${COOKIE}=;`);
    // And it does not send them round the one loop that looks like a way out.
    // The cabinet does replace this key, at every sign-in — with the key it is
    // already holding, which is the one the gateway has just stopped taking. So
    // signing in again cannot be the advice.
    expect(readable(after.html)).toMatch(/signing in again does not help/i);
  });

  it("clears the old cookie that used to hold a live merchant key", async () => {
    // Everybody who ever signed into the previous cabinet has one of these in
    // their browser, and it is a working API key. Nothing reads it any more, so
    // leaving it would merely be untidy — except that what it holds is the
    // credential this whole decision exists to get out of browsers.
    const { browser } = await started();

    const gate = await browser.get("/sign-in");

    expect(gate.headers.getSetCookie().join(" ")).toContain("coinslot_key=;");
    // And the identifier the old cabinet issued, which nothing answers to any
    // more. Left alone it is a value every browser keeps sending forever.
    expect(gate.headers.getSetCookie().join(" ")).toContain("coinslot_session=;");
  });

  it("turns away a sign-in posted from another site", async () => {
    // Signing somebody into an account of the attacker's choosing is a way of
    // getting a merchant to do their work in a session somebody else can read.
    const { browser } = await started();

    const forged = await browser
      .from("https://evil.example.com")
      .post("/sign-in", { email: PERSON, password: PASSWORD });

    expect(forged.status).toBe(403);
    expect(forged.headers.getSetCookie()).toStrictEqual([]);
  });

  it("signs a merchant out, and the session they left with is dead", async () => {
    // Clearing the cookie is not signing out. Anybody who copied the cookie —
    // out of a shared machine, out of a proxy log, out of a browser somebody
    // else has since sat down at — would still be signed in with it.
    const { browser, gateway, identity } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    const token = browser.sessionToken() ?? "";

    await browser.post("/sign-out");

    expect((await browser.get("/cards")).to).toBe("/sign-in");
    // The row is gone, and replaying the exact cookie gets nowhere.
    await expect(stillASession(identity, token)).resolves.toBe(false);
    const replayed = await browser.withRawCookie(`${COOKIE}=${token}`).get("/cards");
    expect(replayed.to).toBe("/sign-in");
  });

  it("signs a merchant out even when another cookie of this name arrives first", async () => {
    // A browser sends cookies of one name longest-path first and, among equal
    // paths, oldest first, so the merchant's own is not necessarily the one
    // this handler sees first. Ending only the first identifier the request
    // carried would leave the session alive behind a sign-out that said it had
    // worked — the exact case a shared machine is signed out of.
    const { browser, gateway, identity } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    const token = browser.sessionToken() ?? "";
    // A value under this name that belongs to nobody, arriving first.
    const planted = `${"b".repeat(32)}.${"c".repeat(43)}`;

    const out = await browser
      .withRawCookie(`${COOKIE}=${planted}; ${COOKIE}=${token}`)
      .post("/sign-out");

    expect(out.to).toBe("/sign-in");
    await expect(stillASession(identity, token)).resolves.toBe(false);
    expect((await browser.withRawCookie(`${COOKIE}=${token}`).get("/cards")).to).toBe("/sign-in");
  });

  it("hangs every link and form off the path it is mounted at", async () => {
    // ADR-0005 §1 puts the cabinet at /cabinet behind one origin. A page that
    // linked to /cards from /cabinet/cards would send the merchant somewhere
    // that answers nothing.
    const { browser, gateway } = await started({ base: "/cabinet" });
    await publish(gateway, roomCard);

    const signedIn = await browser.post("/cabinet/sign-in", {
      email: PERSON,
      password: PASSWORD,
    });
    const page = await browser.get(signedIn.to ?? "/cabinet/cards");

    // The session cookie hangs off the mount point too, and that is the half
    // no link on the page can show. Behind Caddy this origin also carries the
    // gateway's own /v0, so a cookie scoped to `/` would be attached to every
    // request an agent makes to the money path — which is the one thing
    // ADR-0005 §2 exists to keep a person's session away from. The name of the
    // cookie depends on it as well: server.ts declines the `__Host-` prefix
    // precisely because that prefix would force this back to `/`.
    expect(signedIn.headers.getSetCookie().join(" ")).toMatch(/;\s*Path=\/cabinet\s*(?:;|$)/i);

    expect((await browser.get("/cabinet/")).to).toBe("/cabinet/cards");
    // And without the trailing slash, which is what a person types and what
    // Caddy passes through as its own exact path.
    expect((await browser.get("/cabinet")).to).toBe("/cabinet/cards");
    expect(page.html).toContain('href="/cabinet/orders"');
    expect(page.html).toContain('action="/cabinet/selling/pause"');
    expect(page.html).toContain('href="/cabinet/coinslot.css"');
  });

  it("sends a stranger at the bare mount point to the sign-in, not to a page", async () => {
    // The address a person types first. Above the gate this used to read the
    // cookie itself; below it, it is guarded by being below it — and this is
    // the assertion that says so for the one address most likely to be typed.
    const { browser } = await started({ base: "/cabinet" });

    expect((await browser.get("/cabinet")).to).toBe("/cabinet/sign-in");
    expect((await browser.get("/cabinet/")).to).toBe("/cabinet/sign-in");
  });

  it("serves one stylesheet whose three theme states define the same tokens", async () => {
    // One visual language in tokens rather than repeated per page (the web
    // surface decision).
    //
    // The property that matters is not that a dark block exists — an empty one
    // would satisfy that — but that no colour is defined *only* inside it. A
    // token declared in the media query and nowhere else is a colour with no
    // value at all in the light theme, and the page renders with whatever the
    // browser falls back to.
    //
    // There are three states rather than two since the landing grew a switch:
    // nothing chosen follows the operating system, and a choice overrides it.
    // That means the dark values are written out twice, because a media query
    // cannot be part of a selector and one block cannot serve both conditions.
    // Twice is where drift lives, so the two are compared by value and not
    // merely by which tokens they name — a dark background that got a nudge in
    // one of them and not the other is exactly the edit nobody would notice.
    const { browser } = await started();

    const sheet = await browser.get("/coinslot.css");
    const followingTheSystem =
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/.exec(
        sheet.html,
      );
    const chosen = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(sheet.html);
    const light = /:root\s*\{([^}]*)\}/.exec(sheet.html);

    const tokensIn = (block: string | undefined): string[] =>
      [...(block ?? "").matchAll(/(--[a-z-]+)\s*:/g)].map((found) => found[1] ?? "").sort();
    /** The declarations of a block, as text a comparison can be made on. */
    const declarationsIn = (block: string | undefined): string[] =>
      (block ?? "")
        .split(";")
        .map((one) => one.replaceAll(/\s+/g, " ").trim())
        .filter((one) => one.startsWith("--"))
        .sort();

    expect(sheet.headers.get("content-type")).toContain("text/css");
    expect(followingTheSystem?.[1], "no dark block for a system that asks for one").toBeTruthy();
    expect(chosen?.[1], "no dark block for a reader who chose it").toBeTruthy();

    const painted = tokensIn(followingTheSystem?.[1]);
    expect(painted.length).toBeGreaterThan(5);
    // Every token the dark theme paints is painted by the light theme too.
    expect(tokensIn(light?.[1])).toEqual(expect.arrayContaining(painted));
    // And the two ways of asking for dark paint it identically.
    expect(declarationsIn(chosen?.[1])).toStrictEqual(declarationsIn(followingTheSystem?.[1]));
  });

  it("answers a health probe at the root and under the path it is mounted at", async () => {
    // Caddy passes /cabinet through unstripped, so a probe arrives at
    // /cabinet/healthz; a container health check asks at the root. A 404 to
    // either reads as a dead process.
    const { browser } = await started({ base: "/cabinet" });

    expect((await browser.get("/healthz")).status).toBe(200);
    expect((await browser.get("/cabinet/healthz")).status).toBe(200);
  });

  it("serves the shared visual language rather than a copy of it", async () => {
    // ADR-0005 §6 asks for one visual language across the three surfaces, in
    // one stylesheet. This branch carried a second copy of it for a while, with
    // the palette from before the contrast fix — which is how one visual
    // language quietly becomes two that look almost alike, and why the check is
    // that the bytes are the shared file's rather than that they resemble it.
    const { browser } = await started();
    const shared = readFileSync(
      new URL("../../landing/public/styles/tokens.css", import.meta.url),
      "utf8",
    );

    const sheet = await browser.get("/coinslot.css");

    expect(sheet.html).toContain(shared);
    // And the cabinet's own file declares no colour of its own, or the shared
    // one would stop being where the palette lives. Comments are stripped
    // first: this file names the tokens it uses in prose, and prose is not a
    // declaration.
    const own = readFileSync(new URL("./coinslot.css", import.meta.url), "utf8").replaceAll(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(own).not.toMatch(/--(?:bg|surface|raised|line|fg|muted|accent|ok|warn)\s*:/);
  });

  it("fetches nothing from anywhere while it does it", async () => {
    // A merchant's private console must not tell a third party the origin of
    // every visit, and the local stack is meant to come up with no network at
    // all — a render-blocking font host would decide what it looks like.
    const { browser } = await started();

    const sheet = await browser.get("/coinslot.css");

    expect(sheet.html).not.toContain("@import");
    expect(sheet.html).not.toMatch(/https?:\/\//);
  });
});

describe("registering", () => {
  const FORM = {
    email: "fresh@example.com",
    password: "a-password-of-their-own",
    invitation: "the-invitation-we-handed-out",
  };

  /**
   * A registrar that answers as the test says and remembers what it was asked.
   *
   * The successful answer carries the key the harness seeded, so a registration
   * that goes through leaves an account whose screens are drawn from the real
   * gateway — which is what makes the redirect at the end of it worth anything.
   */
  const registrarAnswering = (
    answer: Answer<RegisteredMerchant>,
  ): Registrar & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      register: async (invitation) => {
        asked.push(invitation);
        return answer;
      },
    };
  };

  const madeAMerchant = (): Answer<RegisteredMerchant> => ({
    ok: true,
    document: { merchant_id: "mer_the_merchant", secret: KEY },
  });

  /** The gateway refusing, which is a wrong invitation and a closed door alike. */
  const refused = (why: string): Answer<RegisteredMerchant> => ({ ok: false, status: 403, why });

  it("makes a merchant, writes the account and signs the person in where they stand", async () => {
    // ADR-0014 §1: one form, one act, and what comes back is a session. A
    // registration that ended at the sign-in page would be a password typed
    // twice for no reason.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser, gateway, identity } = await started({ registrar });
    await publish(gateway, roomCard);

    const registered = await browser.post("/register", FORM);

    expect(registered.status).toBe(303);
    expect(registrar.asked).toStrictEqual([FORM.invitation]);
    // The account is there, pointed at the merchant the gateway made, and the
    // password typed into the form is the one that works.
    const made = await identity.byEmail(FORM.email);
    expect(made?.merchant).toStrictEqual({ id: "mer_the_merchant", key: KEY });
    expect((await identity.signIn(FORM.email, FORM.password)).ok).toBe(true);
    // And they are signed in already: the next page is a real screen drawn from
    // the real gateway, not another form.
    expect(browser.sessionToken()).not.toBeNull();
    const cards = await browser.get("/cards");
    expect(cards.status).toBe(200);
    expect(readable(cards.html)).toContain(FORM.email);
  });

  it("sends the person who has just registered to the screen that asks for their name", async () => {
    // The name buyers read is not on this form any more, and the reason is what
    // decides where they land next: it is a public answer demanded at the one
    // moment a merchant knows least. Asked on a screen of its own it has room
    // to say what it is for, and a merchant who has nothing to say yet can walk
    // past it.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser } = await started({ registrar });

    const registered = await browser.post("/register", FORM);

    expect(registered.status).toBe(303);
    expect(registered.to).toBe("/choose-name");
  });

  it("answers a refused invitation and a closed door with one sentence, not two", async () => {
    // ADR-0014 §3: wrong code and a registration that is not open answer the
    // same way at the gateway, and a screen that turned the gateway's two
    // sentences into two of its own would undo that at the last step.
    const wrong = await started({
      registrar: registrarAnswering(refused("that code is not one we accept")),
    });
    const one = await wrong.browser.post("/register", { ...FORM, invitation: "not-the-code" });
    await wrong.browser.close();
    await wrong.identity.close();
    await wrong.stopGateway();

    const closed = await started({
      registrar: registrarAnswering(refused("registration is closed")),
    });
    const other = await closed.browser.post("/register", FORM);

    expect(one.status).toBe(other.status);
    expect(readable(one.html)).toBe(readable(other.html));
    expect(one.headers.getSetCookie()).toStrictEqual([]);
  });

  it("refuses an address that already has an account without saying that is why", async () => {
    // The sign-in next door takes the same time for an address nobody has as
    // for one whose password is wrong, so that its timing does not say who has
    // an account here. A registration that answered "that address is taken" in
    // its own words would be the same question answered outright, so the
    // refusal is the one the invitation gets and nothing else.
    const { browser } = await started({ registrar: registrarAnswering(madeAMerchant()) });

    const taken = await browser.post("/register", { ...FORM, email: PERSON });
    const bad = await started({ registrar: registrarAnswering(refused("no")) });
    const invitation = await bad.browser.post("/register", FORM);

    expect(taken.status).toBe(invitation.status);
    expect(readable(taken.html)).toBe(readable(invitation.html));
    expect(taken.headers.getSetCookie()).toStrictEqual([]);
  });

  it("tells nobody without an invitation which addresses have accounts", async () => {
    // The promise that survives being looked at: the address is only reached
    // after the gateway has accepted the invitation, so somebody without one
    // gets the same answer for an address that exists and one that does not.
    const registrar = registrarAnswering(refused("no"));
    const { browser } = await started({ registrar });

    const known = await browser.post("/register", { ...FORM, email: PERSON });
    const unknown = await browser.post("/register", { ...FORM, email: "nobody@example.com" });

    expect(readable(known.html)).toBe(readable(unknown.html));
    expect(known.status).toBe(unknown.status);
    // Both went to the gateway, which is the half of this the page cannot show.
    // Looking the address up first would answer the taken one without asking
    // anybody — same words, and back sooner every time. The sign-in next door
    // spends a derivation on an address nobody has for exactly this reason, and
    // this form must not be the cheaper way to ask the same question.
    expect(registrar.asked.length).toBe(2);
  });

  it("does not say it worked when the merchant was made and the account was not", async () => {
    // ADR-0014 §1 calls this litter rather than damage — the address is free
    // and the next attempt makes a new merchant — but the person on the other
    // end must not be told it went through.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser, identity } = await started({ registrar });
    // The account is made and the merchant cannot be written onto it, which is
    // the one order these two can fail in: the account has nothing to name
    // until the merchant exists at the gateway.
    identity.register = async () => ({ ok: false, why: "undone" });

    const failed = await browser.post("/register", FORM);

    expect(failed.status).toBe(500);
    // The page says both halves of what happened: a merchant exists, and there
    // is no account naming it — with the next step, which is to register again.
    const text = readable(failed.html);
    expect(text).toMatch(/created and your account was not/i);
    expect(text).toMatch(/register again/i);
    // And nothing that would let them believe otherwise: no session, and the
    // address still free, which is what makes the second attempt work.
    expect(failed.headers.getSetCookie()).toStrictEqual([]);
    expect(failed.to).toBeNull();
    expect(browser.sessionToken()).toBeNull();
  });

  it("refuses a form with a field missing, and asks the gateway for nothing", async () => {
    // Every one of the three is required, and a merchant is not made for a form
    // that was never going to produce an account. Litter that can be avoided by
    // reading the form is litter nobody has to argue about afterwards.
    //
    // It was four until the name a merchant sells under moved off this form:
    // it is a public answer nobody can give on the day they arrive, and it is
    // asked for once the account exists.

    const registrar = registrarAnswering(madeAMerchant());
    const { browser, identity } = await started({ registrar });

    for (const missing of ["email", "password", "invitation"] as const) {
      const { [missing]: _absent, ...rest } = FORM;
      const answered = await browser.post("/register", rest);
      expect(answered.status, missing).toBe(400);
      expect(readable(answered.html), missing).toMatch(/every|all three|each/i);
      expect(answered.headers.getSetCookie(), missing).toStrictEqual([]);
    }
    expect(registrar.asked).toStrictEqual([]);
    await expect(identity.byEmail(FORM.email)).resolves.toBeNull();
  });

  it("asks for three things and no longer for the name buyers read", async () => {
    // The form that collects a public, unchangeable-feeling answer at the one
    // moment a merchant knows least collects "some stuff", and "some stuff" is
    // what then sits beside their products. The field is gone from here; where
    // it went is said on the screen after this one.
    const { browser } = await started({ registrar: registrarAnswering(madeAMerchant()) });

    const form = await browser.get("/register");

    expect(form.status).toBe(200);
    expect(form.html).toContain('name="email"');
    expect(form.html).toContain('name="password"');
    expect(form.html).toContain('name="invitation"');
    expect(form.html).not.toContain('name="name"');
  });

  it("refuses a password too short to be worth having, before making anything", async () => {
    const registrar = registrarAnswering(madeAMerchant());
    const { browser } = await started({ registrar });

    const answered = await browser.post("/register", { ...FORM, password: "short" });

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/12 characters/);
    expect(registrar.asked).toStrictEqual([]);
  });

  it("refuses something that is not an address before it makes a merchant", async () => {
    const registrar = registrarAnswering(madeAMerchant());
    const { browser } = await started({ registrar });

    const answered = await browser.post("/register", { ...FORM, email: "not-an-address" });

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/address/i);
    expect(registrar.asked).toStrictEqual([]);
  });

  it("says on the page what the address is for, and what confirming it buys", async () => {
    // A merchant who registers has shown they hold an invitation and not that
    // they hold the address they typed, and the account works either way. What
    // waits on confirming it is being sent a new password — so the form says
    // that rather than leaving it to be discovered on the day it matters.
    const { browser } = await started({ registrar: registrarAnswering(madeAMerchant()) });

    const form = readable((await browser.get("/register")).html);

    expect(form).toMatch(/works straight away/i);
    expect(form).toMatch(/confirm/i);
    expect(form).toMatch(/new password/i);
  });

  it("is reachable without a session, and is linked from the sign-in", async () => {
    // ADR-0009 §5 puts every other address behind the gate. This one cannot be:
    // somebody registering has no session by definition. The sign-in's own
    // comment used to say a link here would be a door onto a corridor that was
    // never built — the corridor is built.
    const { browser } = await started({ registrar: registrarAnswering(madeAMerchant()) });

    const form = await browser.get("/register");
    const signIn = await browser.get("/sign-in");

    expect(form.status).toBe(200);
    expect(readable(form.html)).toMatch(/register/i);
    expect(signIn.html).toContain('href="/register"');
  });

  it("puts neither the password nor the merchant's key on the page or in the log", async () => {
    // The key comes back from the gateway once and goes onto the row. A page or
    // a log carrying it would be the secret loose in exactly the two places
    // ADR-0014 §2 says it must not reach.
    const said: string[] = [];
    const collect = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(collect);
    const error = vi.spyOn(console, "error").mockImplementation(collect);
    try {
      const { browser, gateway } = await started({
        registrar: registrarAnswering(madeAMerchant()),
      });
      await publish(gateway, roomCard);

      const registered = await browser.post("/register", FORM);
      const after = await browser.get("/cards");

      expect(registered.html).not.toContain(KEY);
      expect(registered.html).not.toContain(FORM.password);
      expect(after.html).not.toContain(KEY);
      expect(said.join("\n")).not.toContain(KEY);
      expect(said.join("\n")).not.toContain(FORM.password);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("turns away a registration posted from another site", async () => {
    // A public form that makes a merchant is worth the same second lock every
    // other form here has: a page elsewhere must not be able to make somebody's
    // browser register an account the page's author then signs into.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser } = await started({ registrar });

    const forged = await browser.from("https://evil.example.com").post("/register", FORM);

    expect(forged.status).toBe(403);
    expect(registrar.asked).toStrictEqual([]);
  });

  it("sends somebody who is already signed in to their cards rather than a second merchant", async () => {
    // On the post as well as on the form, and the post is the one that matters.
    // A second registration makes a second merchant at the gateway that nothing
    // afterwards names, and swaps the session for one belonging to it — so the
    // cabinet they come back to is a different, empty merchant, and the one
    // they were selling as is reachable only by signing in again.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser, identity } = await started({ registrar });
    await browser.signIn();

    const form = await browser.get("/register");
    const posted = await browser.post("/register", FORM);

    expect(form.status).toBe(303);
    expect(form.to).toBe("/cards");
    expect(posted.status).toBe(303);
    expect(posted.to).toBe("/cards");
    expect(registrar.asked).toStrictEqual([]);
    await expect(identity.byEmail(FORM.email)).resolves.toBeNull();
  });

  it("does not send somebody to check a good invitation when the gateway is the problem", async () => {
    // 403 is the only answer that means the invitation was not accepted. A
    // route that is not there in a bad deployment answers 404 and a gateway
    // that is down answers 500 — folded into the refusal, both would tell
    // everybody handed a good invitation to go and check it, and the log line
    // an operator reads would say the same wrong thing.
    for (const status of [404, 500, 0]) {
      const running = await started({
        registrar: registrarAnswering({ ok: false, status, why: "no such route" }),
      });
      const answered = await running.browser.post("/register", FORM);

      expect(answered.status, `${status}`).toBe(502);
      const text = readable(answered.html);
      expect(text, `${status}`).toMatch(/nothing you typed is at fault/i);
      expect(text, `${status}`).not.toMatch(/invitation may not be one we accept/i);

      await running.browser.close();
      await running.identity.close();
      await running.stopGateway();
    }
  });
});

describe("choosing the name buyers read", () => {
  it("asks for the name on a screen of its own, with room to say what it is for", async () => {
    // The whole reason the field left the registration form. Here it can say
    // what the name does, show what one looks like, and promise that it can be
    // changed — none of which fits beside a password box, and all of which
    // decides whether what arrives is a name or "some stuff".
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const screen = await running.browser.get("/choose-name");
    const text = readable(screen.html);

    expect(screen.status).toBe(200);
    expect(screen.html).toContain('name="seller_name"');
    // What it is for, in terms somebody who has never seen a catalogue can act
    // on: buyers read it, beside the products.
    expect(text).toMatch(/buyers/i);
    // One example of what a name looks like.
    expect(text).toMatch(/eSIM/i);
    // The rule the catalogue holds it to, before anybody types rather than
    // after a refusal.
    expect(text).toMatch(/32 characters/);
    // That it can be changed, and where.
    expect(text).toMatch(/change/i);
    expect(screen.html).toContain('href="/settings"');
    // And a way past it, for somebody who has not decided.
    expect(screen.html).toContain('href="/cards"');
  });

  it("writes the name and takes the merchant on to their cards", async () => {
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const chosen = await running.browser.post("/choose-name", { seller_name: "Bright Data Plans" });

    expect(chosen.status).toBe(303);
    expect(chosen.to).toBe("/cards");
    expect(await listedAs(running)).toBe("Bright Data Plans");
  });

  it("lets a merchant walk past it, and says on their cards what that costs", async () => {
    // Skipping is allowed because a name demanded before somebody can answer it
    // is a name nobody means. What is not allowed is skipping it silently: a
    // merchant whose code then publishes a card meets a refusal, and the
    // cabinet says so before that happens.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const cards = await running.browser.get("/cards");
    const text = readable(cards.html);

    expect(cards.status).toBe(200);
    expect(text).toMatch(/cannot go on sale/i);
    expect(cards.html).toContain('href="/settings"');
    expect(await listedAs(running)).toBeNull();
  });

  it("refuses a name the catalogue that lists it would not carry, and says the rule", async () => {
    // The catalogue's rule is thirty-two characters of ordinary keyboard
    // characters with no space at either end. A name outside it is refused by
    // the gateway with a sentence written for whoever reads an API response;
    // refused here, the person is told the rule in the words of the screen they
    // are looking at, and nothing is written.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    for (const name of ["x".repeat(33), "Кириллица", "  "]) {
      const answered = await running.browser.post("/choose-name", { seller_name: name });
      expect(answered.status, name).toBe(400);
      expect(readable(answered.html), name).toMatch(/not saved|name is needed/i);
      expect(await listedAs(running), name).toBeNull();
    }
  });

  it("refuses a post with no name in it at all, and says the field is the one thing needed", async () => {
    // The field can arrive empty or not arrive, and a form posted by something
    // that is not this page does the second. Both are somebody who has typed no
    // name, and the screen says so rather than writing an empty one.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const answered = await running.browser.post("/choose-name");

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/name is needed/i);
    // And it still says the way past, because that is what somebody with
    // nothing to type needs.
    expect(answered.html).toContain('href="/cards"');
    expect(await listedAs(running)).toBeNull();
  });

  it("takes the space off a name rather than refusing it for one", async () => {
    // A space at the front of a form field is a typing accident, and the rule
    // that refuses it exists because a padded name survives the catalogue
    // untouched and makes two spellings of one word. Trimming it gives the
    // person the name they meant.
    const running = await started();
    await unname(running);
    await running.browser.signIn();

    const chosen = await running.browser.post("/choose-name", {
      seller_name: "  Bright Data Plans  ",
    });

    expect(chosen.status).toBe(303);
    expect(await listedAs(running)).toBe("Bright Data Plans");
  });

  it("is behind the gate, like every other screen in the cabinet", async () => {
    const running = await started();

    const screen = await running.browser.get("/choose-name");
    const posted = await running.browser.post("/choose-name", { seller_name: "Anybody At All" });

    expect(screen.to).toBe("/sign-in");
    expect(posted.to).toBe("/sign-in");
  });
});

describe("the settings screen", () => {
  it("is reachable from every screen a merchant works on", async () => {
    // It holds the name today and it is where the next such thing goes, so a
    // merchant has to be able to find it without being sent a link.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys"]) {
      const screen = await browser.get(path);
      expect(screen.status, path).toBe(200);
      expect(screen.html, path).toContain('href="/settings"');
    }
  });

  it("shows the name this merchant is listed under", async () => {
    const { browser, harnessed } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");

    expect(screen.status).toBe(200);
    expect(screen.html).toContain(`value="${harnessed.merchant.name}"`);
  });

  it("changes the name, and the gateway has the new one afterwards", async () => {
    const running = await started();
    await running.browser.signIn();

    const saved = await running.browser.post("/settings", { seller_name: "Bright Data Plans" });

    expect(saved.status).toBe(303);
    expect(saved.to).toBe("/settings");
    expect(await listedAs(running)).toBe("Bright Data Plans");
    const after = await running.browser.get("/settings");
    expect(after.html).toContain('value="Bright Data Plans"');
  });

  it("refuses to take the name away, and says what to do instead", async () => {
    // A merchant who wants to stop being listed stops their selling, which
    // leaves their cards where they are and lets them start again. Emptying the
    // name would leave the cards on sale under nobody, so the route refuses it
    // and the screen says the thing that actually works.
    const running = await started();
    await running.browser.signIn();

    for (const form of [{ seller_name: "" }, {}] as Record<string, string>[]) {
      const emptied = await running.browser.post("/settings", form);
      expect(emptied.status).toBe(400);
      expect(readable(emptied.html)).toMatch(/stop.*selling/i);
      expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
    }
  });

  it("offers no control that removes the name", async () => {
    // Not a gap somebody should fill in later: the refusal is the rule, and a
    // button that provoked it would be a control whose whole result is a
    // refusal page.
    const { browser } = await started();
    await browser.signIn();

    const text = readable((await browser.get("/settings")).html);

    expect(text).toMatch(/cannot|never/i);
    expect(text).toMatch(/stop.*selling/i);
    // And the rule, on the page rather than only in a refusal.
    expect(text).toMatch(/32 characters/);
  });

  it("refuses a name outside the rule and leaves the one there was", async () => {
    const running = await started();
    await running.browser.signIn();

    const answered = await running.browser.post("/settings", { seller_name: "x".repeat(33) });

    expect(answered.status).toBe(400);
    // What was refused, and that nothing was written — the second half is the
    // one a merchant cannot see for themselves, and the page still shows what
    // they are actually listed under.
    expect(readable(answered.html)).toMatch(/not saved/i);
    expect(readable(answered.html)).toContain(running.harnessed.merchant.name);
    expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
  });

  it("answers an emptied box with the control that does what they meant", async () => {
    // Emptying this box is a merchant trying to stop being listed. The route
    // refuses it either way, so the question is which sentence they read: the
    // rule the catalogue keeps, which is about a name they did not type, or
    // what to do instead. Told the rule, somebody tries a shorter name; told
    // about the selling switch, they find the control that leaves their cards
    // where they can put them back.
    const running = await started();
    await running.browser.signIn();

    const answered = await running.browser.post("/settings", { seller_name: "   " });

    expect(answered.status).toBe(400);
    expect(readable(answered.html)).toMatch(/stop your selling/i);
    // And not the other sentence, which is the one the mutation that found this
    // gap swapped in: both refuse, and only one of them is an answer.
    expect(readable(answered.html)).not.toMatch(/not a name the catalogue will carry/i);
    expect(await listedAs(running)).toBe(running.harnessed.merchant.name);
  });

  it("says the gateway would not answer rather than drawing a page with no name on it", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.stopGateway();

    const screen = await running.browser.get("/settings");

    expect(screen.status).toBe(502);
    expect(readable(screen.html)).toMatch(/did not answer/i);
  });
});

describe("the account on the settings screen", () => {
  it("keeps the person's own account under a heading of its own", async () => {
    // The screen has two subjects: the name buyers read beside the products,
    // and the account the merchant signs in with. They are not the same kind of
    // thing and a merchant should not have to read both to find out which half
    // they came for, so each one is under a heading that names it.
    const { browser } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");
    const headings = [...screen.html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((found) => found[1] ?? "");
    const saying = headings.join(" | ");

    expect(
      headings.some((heading) => /sold under|buyers/i.test(heading)),
      saying,
    ).toBe(true);
    expect(
      headings.some((heading) => /account|sign in/i.test(heading)),
      saying,
    ).toBe(true);
  });

  it("names the address in the section rather than only in the corner", async () => {
    // The corner says who is signed in on every page, and that is a label. The
    // section is where the address is the subject, so it says it in its own
    // right — a section about somebody's account that never names the account
    // leaves them reading the corner to work out whose settings these are.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const named = (html: string): number => readable(html).split(PERSON).length - 1;

    expect(named((await browser.get("/cards")).html)).toBe(1);
    expect(named((await browser.get("/settings")).html)).toBe(2);
  });

  it("leads to the password screen rather than carrying a second copy of the form", async () => {
    // Changing a password asks for the current one and ends every session that
    // person has, and that belongs on the page built for it. What settings owes
    // is the way in.
    const { browser } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");

    expect(screen.status).toBe(200);
    expect(screen.html).toContain('action="/password"');
    // And nothing on this page takes a password. A second form that did would
    // be a second place for the rule about the current one to be got wrong.
    expect(screen.html).not.toContain('type="password"');

    const followed = await browser.get("/password");
    expect(followed.status).toBe(200);
    expect(readable(followed.html)).toMatch(/current password/i);
  });

  it("says a confirmed address can be sent a link that replaces a lost password", async () => {
    const { browser, mails } = await started();
    await browser.signIn();
    await browser.post("/confirm");
    const link = /token=(\S+)/.exec(mails.at(-1)?.body ?? "")?.[1] ?? "";
    expect(link).not.toBe("");
    await browser.get(`/confirm?token=${link}`);

    const text = readable((await browser.get("/settings")).html);

    expect(text).toMatch(/we can send you a link/i);
    expect(text).not.toMatch(/cannot send you a link/i);
  });

  it("says an address nobody has answered from cannot be sent one, and who can help", async () => {
    // The half a merchant cannot see for themselves. An unconfirmed address
    // costs nothing until the day the password is gone, and on that day the
    // account is opened by somebody else or not at all — so the page says so
    // while there is still time to fix it, and says who to ask if there is not.
    const { browser } = await started();
    await browser.signIn();

    const text = readable((await browser.get("/settings")).html);

    expect(text).toMatch(/cannot send you a link/i);
    expect(text).not.toMatch(/we can send you a link/i);
    expect(text).toMatch(/gave you the address of this site/i);
  });

  it("names the control that fixes it by the words written on that control", async () => {
    // The two links are different things — one confirms the address, the other
    // replaces a password — and nobody reading this page knows that. So a
    // section saying "we cannot send you a link" a few lines under a button
    // saying "Send me the link" reads as a page arguing with itself, and the
    // fix is for the section to name the button rather than for the page to
    // carry a second one.
    //
    // The label is read off the page rather than written out here, so renaming
    // the button breaks this instead of quietly leaving a sentence pointing at
    // a control that no longer says that.
    const { browser } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");
    const label = /action="\/confirm">\s*<button type="submit">([^<]+)<\/button>/.exec(
      screen.html,
    )?.[1];

    expect(label, "the confirm button is on an unconfirmed merchant's page").toBeDefined();
    expect(readable(screen.html)).toContain(`Press ${label} at the top of this page`);
  });
});

describe("the address a merchant's money arrives at", () => {
  /**
   * An address of the right shape that is nobody's: the digits run 0 to 9 and
   * then the letters a to f, twice over. A fixture rather than somewhere money
   * could sensibly be sent.
   *
   * Two spellings of the same one. The lower-case form is what a block explorer
   * prints and what half the tooling in this world hands somebody; the other is
   * the mixed-case spelling a wallet displays, which is a checksum over the
   * address itself. The second is computed from the first rather than typed out
   * here, because a checksum written by hand into a fixture is a checksum that
   * can be wrong — and a wrong one would make these tests pass against a
   * gateway that had stopped checking.
   */
  const LOWER = "0x0123456789abcdef0123456789abcdef01234567";
  const AS_A_WALLET_SHOWS_IT = checksummedAddressOf(LOWER);

  it("is asked for on the settings screen", async () => {
    // The block is one line on that screen and this is what holds it there: a
    // merchant with nowhere to be paid has to be able to find the box without
    // being sent a link to it.
    const { browser } = await started();
    await browser.signIn();

    const screen = await browser.get("/settings");

    expect(screen.status).toBe(200);
    expect(screen.html).toContain('name="payout_wallet"');
    expect(readable(screen.html)).toMatch(/where your money arrives/i);
  });

  it("is saved, and the whole of it is on the page afterwards", async () => {
    const running = await started();
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: AS_A_WALLET_SHOWS_IT,
    });

    expect(saved.status).toBe(303);
    expect(saved.to).toBe("/settings");
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
    // And read back whole rather than shortened, because the shortening is the
    // presentation under which a wrong address and the right one look the same.
    const after = await running.browser.get("/settings");
    expect(after.html.replaceAll(/<[^>]*>/g, "")).toContain(AS_A_WALLET_SHOWS_IT);
  });

  it("shows an address pasted in lower case the way the merchant's wallet shows it", async () => {
    // The spelling is the gateway's to decide and it decides on the wallet's,
    // because that is the one a person recognises without comparing character
    // by character — which on this field is the only checking anybody does. So
    // a merchant who pasted the lower-case spelling a block explorer gave them
    // reads their own wallet's spelling back, and the page never asks anybody
    // to believe that two strings are one address.
    const running = await started();
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", { payout_wallet: LOWER });

    expect(saved.status).toBe(303);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
    expect((await running.browser.get("/settings")).html.replaceAll(/<[^>]*>/g, "")).toContain(
      AS_A_WALLET_SHOWS_IT,
    );
  });

  it("refuses a spelling whose capitals disagree with the rest and says which it is", async () => {
    // The failure this box exists to catch. Forty characters of the right shape
    // whose capitals do not check out mean a character in the address is wrong,
    // and a wrong address is another perfectly good one belonging to somebody
    // else. A refusal reading "that is not an address" would be untrue here and
    // would leave a merchant re-reading a spelling that looks fine.
    const mangled = `0x${AS_A_WALLET_SHOWS_IT.slice(2).toUpperCase()}`;
    expect(mangled, "the fixture has capitals a wallet would not print").not.toBe(
      AS_A_WALLET_SHOWS_IT,
    );
    const running = await started();
    await running.browser.signIn();
    const before = await paidInto(running);

    const answered = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: mangled,
    });

    expect(answered.status).toBe(400);
    // Unchanged rather than absent: the merchant this harness seeds is already
    // being paid somewhere, and what a refusal has to leave alone is wherever
    // that is.
    expect(await paidInto(running)).toBe(before);
    const text = readable(answered.html);
    expect(text).toMatch(/capital letters/i);
    expect(text).toMatch(/not saved/i);
  });

  it("takes the space off what was pasted rather than refusing it", async () => {
    // An address is copied out of a wallet, and a wallet hands it over with a
    // newline on the end about as often as not. Refusing that is refusing a
    // merchant who did exactly the right thing.
    const running = await started();
    await running.browser.signIn();

    const saved = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: `  ${AS_A_WALLET_SHOWS_IT}\n`,
    });

    expect(saved.status).toBe(303);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
  });

  it("refuses an address of the wrong shape and sends nothing", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.browser.post("/settings/payout-wallet", {
      payout_wallet: AS_A_WALLET_SHOWS_IT,
    });

    const answered = await running.browser.post("/settings/payout-wallet", {
      payout_wallet: `${AS_A_WALLET_SHOWS_IT}0`,
    });

    expect(answered.status).toBe(400);
    // What was refused, that nothing was written, and — the half a merchant
    // cannot see for themselves — where their money still goes.
    expect(readable(answered.html)).toMatch(/not saved/i);
    expect(answered.html.replaceAll(/<[^>]*>/g, "")).toContain(AS_A_WALLET_SHOWS_IT);
    expect(await paidInto(running)).toBe(AS_A_WALLET_SHOWS_IT);
  });

  it("refuses an empty box and says what to paste into it", async () => {
    const running = await started();
    await running.browser.signIn();
    const before = await paidInto(running);

    for (const form of [{ payout_wallet: "" }, {}] as Record<string, string>[]) {
      const answered = await running.browser.post("/settings/payout-wallet", form);
      expect(answered.status).toBe(400);
      expect(readable(answered.html)).toMatch(/address is needed/i);
      // An empty box is the shape a merchant reaches for who wants to stop
      // being paid here, and it is the one this cannot do: where the money goes
      // is what it was.
      expect(await paidInto(running)).toBe(before);
    }
  });

  it("says the gateway would not answer rather than drawing a page with no address on it", async () => {
    const running = await started();
    await running.browser.signIn();
    await running.stopGateway();

    const screen = await running.browser.get("/settings");

    expect(screen.status).toBe(502);
    expect(readable(screen.html)).toMatch(/did not answer/i);
  });
});

describe("a merchant who has chosen no name", () => {
  it("is told on every screen they work on that nothing of theirs can go on sale", async () => {
    const running = await started();
    await publish(running.gateway, roomCard);
    await unname(running);
    await running.browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts"]) {
      const screen = await running.browser.get(path);
      const text = readable(screen.html);
      expect(screen.status, path).toBe(200);
      expect(text, path).toMatch(/cannot go on sale/i);
    }
    // And the page it sends them to is the one that fixes it: a sentence with
    // nowhere to go is a sentence that leaves a merchant hunting.
    const settings = await running.browser.get("/settings");
    expect(settings.status).toBe(200);
    expect(settings.html).toContain('name="seller_name"');
  });

  it("is told nothing of the sort once the name is chosen", async () => {
    // A banner that never leaves is a banner nobody reads, and this one is
    // about a state a merchant can be out of in one form post.
    const running = await started();
    await publish(running.gateway, roomCard);
    await running.browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts"]) {
      const text = readable((await running.browser.get(path)).html);
      expect(text, path).not.toMatch(/cannot go on sale/i);
    }
  });

  it("reads the refusal their own code meets in the cabinet's words, not the gateway's", async () => {
    // The refusal a merchant's code gets names the route that fixes it, because
    // it is written for whoever is holding the response. A person in a cabinet
    // cannot make that call and should not be told to: the screen says what the
    // missing thing is and points at the page that sets it.
    const running = await started();
    await unname(running);
    const refused = await running.gateway.call("POST", "/v0/catalog/publish", {
      body: roomCard,
      headers: { authorization: `Bearer ${KEY}` },
    });
    const finding = (refused.body as { error: { problems: { code: string; message: string }[] } })
      .error.problems[0];
    await running.browser.signIn();

    const cards = await running.browser.get("/cards");
    const text = readable(cards.html);

    // The gateway really did refuse, for this reason, in those words.
    expect(refused.status).toBe(422);
    expect(finding?.code).toBe("no_seller_name");
    expect(finding?.message).toContain("POST /v0/seller-name");
    // And the cabinet says the same thing without sending anybody to a route.
    expect(text).toMatch(/cannot go on sale/i);
    expect(cards.html).toContain('href="/settings"');
    expect(text).not.toContain("POST /v0/seller-name");
  });
});

describe("the way out to the documentation", () => {
  it("is on every screen a merchant works on, and leaves the cabinet's mount point", async () => {
    // The documentation was linked from the landing and from nowhere else, so a
    // merchant already inside the cabinet had to leave it by hand to read a
    // line of it. And it is beside the cabinet on one origin rather than under
    // it (deploy/Caddyfile): a link that took the mount point along would send
    // them to /cabinet/docs/, which is an address nothing answers.
    const { browser, gateway } = await started({ base: "/cabinet" });
    await publish(gateway, roomCard);
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys", "/settings"]) {
      const screen = await browser.get(`/cabinet${path}`);
      expect(screen.status, path).toBe(200);

      // Found by where it goes rather than by what it is called, and read for
      // the words on it. An anchor with nothing between its tags is a link
      // nobody can see or press, and would satisfy a check for the address
      // alone.
      const out = /<a[^>]+href="\/docs\/"[^>]*>([^<]+)<\/a>/.exec(screen.html);
      expect(out?.[1]?.trim(), `${path} has no readable link to the documentation`).toBeTruthy();
    }
  });
});

describe("the cards screen", () => {
  it("gives each card the whole address an agent buys it at, and it is one that works", async () => {
    // The one thing a merchant cannot work out from this screen without it:
    // where their product actually is. It is the whole address rather than an
    // identifier to assemble one from, and it carries our catalog identifier
    // rather than the merchant's own — the two are different strings, and a
    // merchant who pasted theirs into it would be handed a 404 by a gateway
    // that is working perfectly.
    const running = await started({ cabinet: { PUBLIC_BASE_URL: "https://shop.example.com" } });
    const itemId = await publish(running.gateway, roomCard);
    await running.browser.signIn();

    const screen = await running.browser.get("/cards");
    const shown = /https:\/\/shop\.example\.com(\/x402\/\S+?\/purchase)/.exec(
      readable(screen.html),
    );

    expect(shown?.[1], "the cards screen names the address").toBe(`/x402/${itemId}/purchase`);
    // And it is not a template that happens to match: an agent asking at that
    // very path is answered with the payment challenge rather than a 404.
    expect(await purchasable(running.gateway, itemId)).toBe(true);
    // Text and not a link. Pressing it asks without paying, which is answered
    // in a header with no page behind it — a merchant who clicked would read a
    // blank window as their card being broken.
    expect(screen.html).not.toContain('href="https://shop.example.com/x402/');
  });

  it("shows each card with its key, price, delivery and state", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await publish(gateway, esimCard);

    const text = readable((await browser.signIn()).html);

    expect(text).toContain("A room for the night");
    expect(text).toContain("SKU 100/1");
    expect(text).toContain("80.00 USD");
    expect(text).toContain("immediate");
    expect(text).toContain("eSIM Europe, 5 GB for 30 days");
    expect(text).toContain("8.00 USD");
    expect(text).toContain("later");
    expect(text).toContain("Delivery within 4 hours");
    expect(text).toContain("selling");
  });

  it("shows every promise a card makes, not the first one it finds", async () => {
    // A card can both have its price asked at purchase and owe a delivery
    // inside a window. Showing only the first leaves the merchant reading a row
    // that never mentions the deadline they are answerable for.
    const { browser, gateway } = await started();
    await publish(gateway, {
      ...esimCard,
      merchant_item_id: "esim-live-priced",
      price_check: "handler",
      fulfill_deadline_seconds: 3_600,
    });

    const text = readable((await browser.signIn()).html);

    expect(text).toContain("Price asked at purchase");
    expect(text).toContain("delivery within 1 hour");
  });

  it("says so plainly when a merchant has published nothing", async () => {
    const { browser } = await started();

    const text = readable((await browser.signIn()).html);

    expect(text).toContain("not published a card yet");
  });

  it("puts a merchant's own text on the page as text, whatever is in it", async () => {
    // A card title is text somebody else wrote. The contract lets it hold any
    // printable character, so a title with a bracket or an ampersand in it must
    // arrive on the page as those characters rather than as markup — a merchant
    // whose product is called "Tom & Jerry <the box set>" should see their
    // product, not a page that stopped rendering halfway down the row.
    const { browser, gateway } = await started();
    await publish(gateway, {
      ...roomCard,
      merchant_item_id: "a&b<c>",
      title: 'Tom & Jerry <the "box set">',
    });

    const page = (await browser.signIn()).html;

    // Not one character of the title reaches the page as markup...
    expect(page).not.toContain("Jerry <");
    expect(page).not.toContain("a&b");
    expect(page).toContain("Tom &amp; Jerry &lt;the &quot;box set&quot;&gt;");
    // ...and a merchant still reads their own product's name, unchanged.
    expect(readable(page)).toContain('Tom & Jerry <the "box set">');
    expect(readable(page)).toContain("a&b<c>");
  });

  it("pauses one card, and that card stops selling", async () => {
    // The promise the whole screen exists for: the state on the page and what
    // an agent's purchase runs into are the same fact.
    const { browser, gateway } = await started();
    const room = await publish(gateway, roomCard);
    const esim = await publish(gateway, esimCard);
    await browser.signIn();

    const paused = await browser.post(`/cards/${encodeURIComponent(room)}/pause`);
    const text = readable((await browser.get("/cards")).html);

    expect(paused.to).toBe("/cards");
    expect(text).toContain("paused");
    expect(text).toContain("Resume");
    expect(await purchasable(gateway, room)).toBe(false);
    // The negative control: the switch is per card, so the other one still
    // sells and is still the only thing in the public catalog.
    expect(await purchasable(gateway, esim)).toBe(true);
    expect((await gateway.call("GET", "/x402/catalog")).body).toMatchObject({
      items: [{ title: "eSIM Europe, 5 GB for 30 days" }],
    });
  });

  it("puts a paused card back on sale", async () => {
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    await browser.post(`/cards/${encodeURIComponent(itemId)}/pause`);

    await browser.post(`/cards/${encodeURIComponent(itemId)}/resume`);

    expect(await purchasable(gateway, itemId)).toBe(true);
    expect(readable((await browser.get("/cards")).html)).toContain("Pause");
  });

  it("stops all selling from one control, and starts it again", async () => {
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    await browser.post("/selling/pause");
    const stopped = readable((await browser.get("/cards")).html);

    expect(stopped).toContain("All selling is stopped");
    expect(stopped).toContain("Start selling again");
    expect(await purchasable(gateway, itemId)).toBe(false);

    await browser.post("/selling/resume");

    expect(await purchasable(gateway, itemId)).toBe(true);
    expect(readable((await browser.get("/cards")).html)).toContain("Stop all selling");
  });

  it("tells a merchant which switch is holding a card off sale", async () => {
    // With everything stopped, a card the merchant did not pause themselves
    // reads paused too, and pressing resume on it would change nothing a
    // merchant can see. The screen says which switch is holding it rather than
    // offering a control that does nothing.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    await browser.post("/selling/pause");
    const html = (await browser.get("/cards")).html;

    expect(readable(html)).toContain("All selling is stopped");
    expect(html).not.toContain(">Resume<");
  });

  it("leaves a card paused when it is published again", async () => {
    // A merchant editing a price is not asking for a product they took off sale
    // to go back on it.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    await browser.post(`/cards/${encodeURIComponent(itemId)}/pause`);

    await publish(gateway, { ...roomCard, price: { amount: "90.00", currency: "USD" } });
    const text = readable((await browser.get("/cards")).html);

    expect(text).toContain("90.00 USD");
    expect(text).toContain("paused");
    expect(await purchasable(gateway, itemId)).toBe(false);
  });
});

/**
 * The markup of one card's test-purchase form, cut out of the page.
 *
 * The assertions about what a form asks for are per card, and a page with two
 * cards on it carries two forms — so a search of the whole page would find the
 * other card's boxes and call them this card's.
 */
const walkFormFor = (html: string, itemId: string): string => {
  const at = html.indexOf(`/cards/${itemId}/test-purchase"`);
  expect(at, `no test purchase form for ${itemId}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<form", at), html.indexOf("</form>", at));
};

/** The gateway's own answer to the same call, for comparing sentences against. */
const gatewaySaysAbout = async (
  gateway: Served,
  itemId: string,
): Promise<{ message: string; retryable: boolean }> => {
  const answered = await gateway.call("POST", `/v0/cards/${itemId}/test-purchase`, {
    body: { params: {} },
    headers: asMerchant,
  });
  return (answered.body as { error: { message: string; retryable: boolean } }).error;
};

describe("walking a test purchase from the cards screen", () => {
  it("offers the walk on a card that is on sale and on no card that is paused", async () => {
    // A paused card is refused at the price call, so a button on it offers a
    // merchant a walk whose ending is already known — and hides the one thing
    // they would have to do first, which is put the card back on sale.
    const { browser, gateway } = await started();
    const selling = await publish(gateway, lockerCard);
    const paused = await publish(gateway, {
      ...lockerCard,
      merchant_item_id: "locker-night",
      title: "A locker overnight",
    });
    await browser.signIn();
    await browser.post(`/cards/${encodeURIComponent(paused)}/pause`);

    const page = (await browser.get("/cards")).html;

    expect(page).toContain(`/cards/${selling}/test-purchase`);
    expect(page).not.toContain(`/cards/${paused}/test-purchase`);

    // And with all selling stopped, on no card at all — including the one the
    // merchant never paused themselves. That card still reads paused to a
    // purchase while its own switch is off, which is the whole reason the
    // contract carries two fields, and a control drawn from the wrong one of
    // them offers a walk that is refused at the price call.
    await browser.post("/selling/pause");
    expect((await browser.get("/cards")).html).not.toContain("test-purchase");
  });

  it("asks for the values that card's own params declare, and for nothing else", async () => {
    const { browser, gateway } = await started();
    const tour = await publish(gateway, tourCard);
    const bicycle = await publish(gateway, bicycleCard);
    await browser.signIn();

    const page = (await browser.get("/cards")).html;
    const asked = walkFormFor(page, tour);

    expect(asked).toContain('name="email"');
    expect(asked).toContain('name="party"');
    // The card's own words for its own questions, and the mark on the one it
    // says it cannot be bought without.
    expect(readable(asked)).toMatch(/Where to send the ticket\s+required/);
    expect(readable(asked)).toContain("How many are coming");
    expect(readable(asked)).not.toMatch(/How many are coming\s+required/);
    // The boxes come from this card and not from a list written out here, nor
    // from the declarations of every card on the page.
    expect(asked).not.toContain('name="returned_at"');
    expect(walkFormFor(page, bicycle)).not.toContain('name="email"');
    // And a card that declares nothing is one press with nothing to fill in.
    const locker = await publish(gateway, lockerCard);
    const alone = walkFormFor((await browser.get("/cards")).html, locker);
    expect(alone).not.toContain("<input");
  });

  it("walks the purchase and shows every door, the order it opened and the goods", async () => {
    // The whole promise: a merchant presses one button and comes away holding
    // evidence about the public storefront rather than our word for it.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, lockerCard);
    await browser.signIn();
    const handled: Order[] = [];

    const worker = workUntilStopped(harnessed, {
      onOrder: (order) => {
        handled.push(order);
        return { delivered: { access_code: "LOCKER-14" } };
      },
    });
    let walked: Visit;
    try {
      walked = await browser.post(`/cards/${encodeURIComponent(itemId)}/test-purchase`);
    } finally {
      await worker.stop();
    }

    expect(walked.status).toBe(200);
    const text = readable(walked.html);
    // Every door, at the address a stranger's agent would have called: the
    // catalog, the purchase — twice, because the price call and the signed
    // retry are two knocks on the same door — and the order's own status door.
    const orderId = handled[0]?.id ?? "";
    expect(text).toContain("/x402/catalog");
    expect(text.split(`/x402/${itemId}/purchase`)).toHaveLength(3);
    expect(text).toContain(`/x402/orders/${orderId}/status`);
    // The outcome, in words that do not read as a walk that stopped.
    expect(text).toContain("nothing left to do");
    expect(text).not.toContain("did not get through");
    // The goods exactly as the buyer received them.
    expect(text).toContain("access_code");
    expect(text).toContain("LOCKER-14");
    // And the order, as a way to the screen the merchant will find it on.
    expect(text).toContain(orderId);
    expect(walked.html).toContain('href="/orders"');
    expect(readable((await browser.get("/orders")).html)).toContain(orderId);
  });

  it("carries the values the merchant typed into their own card's questions", async () => {
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, tourCard);
    await browser.signIn();
    const handled: Order[] = [];

    const worker = workUntilStopped(harnessed, {
      onOrder: (order) => {
        handled.push(order);
        return { delivered: { ticket_code: "TOUR-3" } };
      },
    });
    try {
      await browser.post(`/cards/${encodeURIComponent(itemId)}/test-purchase`, {
        email: "guide@example.com",
        party: "3",
      });
    } finally {
      await worker.stop();
    }

    // The number arrives as the number the card declared and not as the text a
    // form posts, or a card asking for one could never be walked from here.
    expect(handled[0]?.params).toStrictEqual({ email: "guide@example.com", party: 3 });
  });

  it("ends a card whose goods come later at accepted, and does not draw that as a failure", async () => {
    // The ending most easily misread. An asynchronous card cannot hand the
    // goods over inside the purchase, so a page that called this a walk which
    // did not get through would send a merchant hunting for a fault on the day
    // their card worked exactly as it says it does.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, {
      ...esimCard,
      merchant_item_id: "esim-eu-1",
      title: "eSIM Europe, 1 GB for 7 days",
      price: { amount: "2.00", currency: "USD" },
    });
    await browser.signIn();

    const worker = workUntilStopped(harnessed, { onOrder: () => ({ accepted: {} }) });
    let walked: Visit;
    try {
      walked = await browser.post(`/cards/${encodeURIComponent(itemId)}/test-purchase`);
    } finally {
      await worker.stop();
    }

    const text = readable(walked.html);
    expect(walked.status).toBe(200);
    expect(text).not.toContain("did not get through");
    expect(text).not.toContain("nothing left to do");
    expect(text).toContain("the goods are owed");
    // And no goods are claimed, because on this card there are none yet.
    expect(text).not.toContain("iccid");
  });

  it("says where the walk stopped when nobody is running the worker", async () => {
    // The commonest thing a merchant gets wrong, and the reason the button
    // exists at all.
    const { browser, gateway } = await started({
      gateway: {
        QUOTE_RESPONSE_MS: "100",
        SYNC_RESPONSE_MS: "200",
        SETTLE_RESPONSE_MS: "100",
        SYNC_BUDGET_MS: "500",
      },
    });
    const itemId = await publish(gateway, lockerCard);
    await browser.signIn();

    const walked = await browser.post(`/cards/${encodeURIComponent(itemId)}/test-purchase`);
    const text = readable(walked.html);

    // A walk that did not finish is a page and never an error: "it stopped
    // here, and this is what the storefront said" is the answer they came for.
    expect(walked.status).toBe(200);
    expect(text).toContain("did not get through");
    expect(text).not.toContain("nothing left to do");
    // And it claims no goods, because nobody delivered any.
    expect(text).not.toContain("access_code");
  });

  it("shows the gateway's own sentence when the walk is refused before it starts", async () => {
    // A card priced above what the site's test buyer may spend at once. The
    // sentence names both numbers, and it is carried over word for word rather
    // than paraphrased here — the same call made by hand comes back with it.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    const refused = await browser.post(`/cards/${encodeURIComponent(itemId)}/test-purchase`);
    const said = await gatewaySaysAbout(gateway, itemId);

    expect(refused.status).toBe(409);
    expect(said.retryable).toBe(false);
    expect(readable(refused.html)).toContain(said.message);
    // Nothing about waiting, because the envelope says this one does not pass.
    expect(readable(refused.html)).not.toContain("can be tried again");
  });

  it("says a refusal passes with time where the envelope says it does", async () => {
    const { browser, gateway, harnessed } = await started({
      gateway: { TEST_PURCHASE_PER_HOUR: "1" },
    });
    const itemId = await publish(gateway, lockerCard);
    await browser.signIn();

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "LOCKER-1" } }),
    });
    try {
      await browser.post(`/cards/${encodeURIComponent(itemId)}/test-purchase`);
    } finally {
      await worker.stop();
    }
    const refused = await browser.post(`/cards/${encodeURIComponent(itemId)}/test-purchase`);
    const said = await gatewaySaysAbout(gateway, itemId);

    expect(refused.status).toBe(429);
    expect(said.retryable).toBe(true);
    const text = readable(refused.html);
    expect(text).toContain(said.message);
    // Told this was final, a merchant would go looking for a fault that is a
    // delay. How long is not said here: nothing on this side knows.
    expect(text).toContain("can be tried again");
  });

  it("offers no test purchase where the money is real, and says where they are walked", async () => {
    // The buyer belongs to us and so does what it spends, so this walk exists
    // on the test site and nowhere else. A button here would be a dead end
    // dressed as the last step of an integration.
    const { browser, gateway } = await started({
      cabinet: {
        PAYMENT_NETWORK: "eip155:8453",
        FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      },
    });
    await publish(gateway, lockerCard);
    await browser.signIn();

    const page = (await browser.get("/cards")).html;

    expect(page).not.toContain("test-purchase");
    expect(readable(page)).toContain(SITES.test);
  });
});

describe("a merchant who has left", () => {
  // Nothing in the pilot sets this, so it is reached through the store — the
  // same reason `sellingFor`'s departed branch is tested directly. What is
  // asserted is the page, because the gateway was fixed in round one and the
  // fold that undoes the fix lives here.
  it("is not offered a button that puts them back on sale", async () => {
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const page = (await browser.get("/cards")).html;
    const text = readable(page);

    expect(text).toContain("left");
    // No selling control of any kind, not merely not the resume one: offering
    // "stop all selling" to a merchant who has already gone is the same
    // confusion wearing the other label, and both were reachable from one fold.
    expect(page).not.toContain("/selling/resume");
    expect(page).not.toContain("/selling/pause");
    expect(text).not.toContain("Start selling again");
    expect(text).not.toContain("Stop all selling");
    // And it does not tell them their accepted orders are playing out, which is
    // what a pause means and a departure does not.
    expect(text).not.toContain("play out as usual");
    expect(text).toContain("closed with you");
  });

  it("is told what the gateway said, not that the gateway is down", async () => {
    // The gateway answers 409 with a reason. Rendered as "the gateway did not
    // answer", a merchant goes and checks a service that is running.
    const { browser, gateway, harnessed } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const refused = await browser.post("/selling/resume");

    expect(refused.status).toBe(409);
    const text = readable(refused.html);
    expect(text).toContain("this merchant has left");
    expect(text).not.toContain("did not answer");
  });
});

describe("the orders screen", () => {
  it("shows a finished order with its state in the merchant's words", async () => {
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const text = readable((await browser.get("/orders")).html);

    expect(text).toContain("delivered");
    expect(text).toContain("A room for the night");
    expect(text).toContain("80.00 USD");
    // The wire's own words must not reach a person.
    expect(text).not.toContain("in_progress");
    expect(text).not.toContain("merchant_item_id");
  });

  it("tells the open orders from all of them", async () => {
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const all = readable((await browser.get("/orders")).html);
    const openOnly = readable((await browser.get("/orders?open=true")).html);

    expect(all).toContain("A room for the night");
    // The sale is over, so it is not in the open list — and the empty list says
    // so rather than looking like a screen that failed to load.
    expect(openOnly).toContain("Nothing is open");
    expect(openOnly).toContain("Every order you have is finished");
  });

  it("does not tell a merchant nothing is owed while an order is still running", async () => {
    // The sentence this pins was wrong twice before. An order under way has, in
    // the asynchronous mode, already taken the buyer's money against goods that
    // have not gone out — so "none of them is owed money or goods by you" is a
    // claim the code cannot make. What it can say is scoped to the two endings
    // it actually counts.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await browser.signIn();

    const text = readable((await browser.get("/orders?open=true")).html);

    expect(text).toContain("awaiting fulfilment");
    expect(text).not.toContain("owed money or goods");
    expect(text).toContain("None of them owes a refund");
  });

  it("says which orders it cannot show at all", async () => {
    // A purchase that closed before anybody named a price for it is absent from
    // this list by construction — the row every order is drawn in carries the
    // price it sold at. Absence that is never mentioned is the truncation the
    // fifth gate asks about.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/orders")).html);

    expect(text).toContain("closed before anybody named a price");
    expect(text).toContain("Nothing was charged for them");
  });

  it("says there are no orders rather than showing an empty table", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    expect(readable((await browser.get("/orders")).html)).toContain("No orders yet");
  });

  it("calls out an order that owes a refund, and says what the merchant does about it", async () => {
    // The one open state that costs the merchant money. A screen that listed it
    // among the rest would leave a debt to be noticed rather than shown.
    const { browser, gateway, harnessed } = await started({
      gateway: { DEFAULT_ASYNC_FULFILLMENT_MS: "40" },
    });
    const itemId = await publish(gateway, {
      ...esimCard,
      fulfill_deadline_seconds: undefined,
    });
    // The money moves at the purchase in this mode; the merchant takes the
    // order on and then lets the delivery window run out.
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await vi.waitFor(
      async () => {
        const listed = (
          await gateway.call("GET", "/v0/orders?open=true", {
            headers: { authorization: `Bearer ${KEY}` },
          })
        ).body as { orders: { status: string }[] };
        expect(listed.orders.map((order) => order.status)).toContain("refund_due");
      },
      { timeout: 2_000, interval: 5 },
    );

    await browser.signIn();
    const text = readable((await browser.get("/orders?open=true")).html);

    expect(text).toContain("refund due");
    expect(text).toContain("1 order needs you");
    expect(text).toContain("You return it from your own wallet");
    // And nowhere on the page is the wire's own word for it. `refund_due` is
    // what a program branches on; a merchant reads a sentence.
    expect(text).not.toContain("refund_due");
  });
});

describe("the receipts screen", () => {
  it("shows a receipt with its amount, its outcome and both moments", async () => {
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).toContain("A room for the night");
    expect(text).toContain("80.00 USD");
    expect(text).toContain("delivered");
    // Both moments, which is the whole reason a receipt carries two of them.
    // "Price set" and not "Bought": the moment is when we fixed the price for
    // the sale, and on a card whose price is checked at the purchase the buyer
    // pays some time after that.
    expect(text).toContain("Price set");
    expect(text).toContain("Price true as of");
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    // And the moment the money actually moved, which is neither of those two
    // and is the column a merchant matches wallet transfers against.
    // Counted rather than named, because a header with no cell under it would
    // satisfy a check that only looked for the word: a receipt row carries
    // three moments, and dropping one leaves two.
    expect(text).toContain("Paid");
    const row = text.slice(text.indexOf("rcp_"));
    expect(row.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g)).toHaveLength(3);
    // And the summary above the table, which counts what it can stand behind.
    expect(text).toContain("Delivered 1 of 1 receipt");
  });

  it("marks money that was never real as what it is", async () => {
    // Stage one marks every order as a test, so today this is every row on the
    // screen. A ledger of payments that never happened, laid out as a ledger of
    // payments, is the worst thing this page could be.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const receipts = readable((await browser.get("/receipts")).html);
    const orders = readable((await browser.get("/orders")).html);

    expect(receipts).toContain("Every receipt here is a test purchase");
    expect(receipts).toContain("no money moved");
    expect(orders).toContain("Every order here is a test purchase");
    // The mark is on the sum itself as well as in the sentence above the
    // table. The sentence alone stops carrying it the moment one real payment
    // lands beside the tests, which is exactly when telling them apart starts
    // to matter.
    expect(receipts).toContain("80.00 USD test");
    expect(orders).toContain("80.00 USD test");
    // And it never calls the summary a record of takings.
    expect(receipts).not.toContain("paid in USD");
  });

  it("counts nothing it cannot count, and says what is missing instead", async () => {
    // This gateway writes a receipt only when goods are released, so a purchase
    // that has been paid for and not delivered has none. Any tile counting
    // those would read nought forever — and a nought is a positive claim that
    // there is none, printed on the screen a merchant reads for money they are
    // owed. The page says so in words and names where those orders are.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).not.toContain("Refund due");
    expect(text).not.toContain("Awaiting fulfilment");
    expect(text).not.toContain("nothing outstanding");
    // The sentence itself, not only the explanation under it. A page that says
    // nothing is missing and then explains what is missing has still told a
    // merchant, in the line they will actually read, that this is the money.
    expect(text).toContain("This is not the whole of the money");
    expect(text).toContain("has no receipt yet");
    expect(text).toContain("Both are on Orders");
  });

  it("does not claim a receipt appears when the money moves", async () => {
    // The sentence this replaces was falsified by the money path itself: in the
    // asynchronous mode the payment executes at the purchase and the receipt is
    // written only when the goods go out, so a merchant told otherwise looks
    // for a payment on a page that cannot show it yet.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, esimCard);
    await buyOverHttp(harnessed, gateway, itemId, { onOrder: () => ({ accepted: {} }) });
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    // The money moved at the purchase and there is no receipt for it.
    expect((await gateway.call("GET", "/v0/receipts", { headers: asMerchant })).body).toStrictEqual(
      {
        receipts: [],
      },
    );
    expect(text).not.toContain("the moment a payment goes through");
    expect(text).toContain("released");
    // And the orders screen does show it, which is where the receipts page says
    // to look.
    expect(readable((await browser.get("/orders?open=true")).html)).toContain("8.00 USD");
  });

  it("says nothing has been sold rather than showing a summary of nothing", async () => {
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).toContain("No receipts yet");
    expect(text).toContain("nothing sold yet");
  });

  it("does not add money up", async () => {
    // Amounts are exact decimal strings on the wire precisely so that nothing
    // turns a price into a float. A total computed on this page would be the
    // one number on the screen that had been through one.
    const { browser, gateway, harnessed } = await started();
    const itemId = await publish(gateway, roomCard);
    await buyOverHttp(harnessed, gateway, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await browser.signIn();

    const text = readable((await browser.get("/receipts")).html);

    expect(text).not.toMatch(/total/i);
    // The currencies present are a fact; a sum of them would be the one number
    // on the screen that had been through a float. "Priced" rather than "paid",
    // because in stage one none of it was paid with real money.
    expect(text).toContain("priced in USD");
  });
});

describe("the keys screen", () => {
  /**
   * The key the cabinet's own calls are made with, which is on no row here.
   *
   * The gateway answers a cabinet's `GET /v0/keys` with the keys the merchant
   * issued for their own code and names this one as `this_call` beside them —
   * an identifier that matches nothing in the list. So it is an identifier
   * here and not a row, which is what the screen is drawn against.
   */
  const CABINET_KEY = "key_the_cabinet_is_using";
  /** A key something is calling with, which is the ordinary row. */
  const NIGHTLY: MerchantKey = {
    id: "key_the_nightly_job",
    label: "the nightly job",
    created_at: "2026-08-20T09:00:00.000Z",
    last_used_at: "2026-08-27T02:15:00.000Z",
    disabled_at: null,
  };
  /** A key with no call recorded against it, which is two situations at once. */
  const ANOTHER: MerchantKey = {
    id: "key_the_workers_use",
    label: "the worker on the small box",
    created_at: "2026-08-24T11:30:00.000Z",
    last_used_at: null,
    disabled_at: null,
  };
  const REVOKED: MerchantKey = {
    id: "key_the_laptop_had",
    label: "the laptop that went missing",
    created_at: "2026-07-01T08:00:00.000Z",
    last_used_at: null,
    disabled_at: "2026-08-26T17:45:00.000Z",
  };
  const SECRET = "the-secret-shown-once-and-never-again";

  /** The three key routes answered by the test, the rest by the real gateway. */
  const withKeys = (
    listed: readonly MerchantKey[] = [NIGHTLY, ANOTHER, REVOKED],
  ): {
    readonly disabled: string[];
    readonly issued: string[];
    readonly client: (real: GatewayClient) => GatewayClient;
  } => {
    const disabled: string[] = [];
    const issued: string[] = [];
    const keys: MerchantKeyList = { keys: [...listed], this_call: CABINET_KEY };
    return {
      disabled,
      issued,
      client: (real) => ({
        ...real,
        keys: async () => ({ ok: true, document: keys }),
        issueKey: async (label) => {
          issued.push(label);
          return {
            ok: true,
            document: {
              key: {
                id: "key_the_new_one",
                label,
                created_at: NOW,
                last_used_at: null,
                disabled_at: null,
              },
              secret: SECRET,
            },
          };
        },
        disableKey: async (keyId) => {
          disabled.push(keyId);
          return { ok: true, document: { ...ANOTHER, disabled_at: NOW } };
        },
      }),
    };
  };
  const NOW = "2026-08-28T12:00:00.000Z";

  it("lists the keys this merchant has, the working ones and the revoked ones", async () => {
    // ADR-0010 made a key a row so that one can be revoked without touching any
    // other. A list that quietly dropped the revoked ones would answer "which
    // key did I turn off last week" with silence, on the screen where that is
    // the question somebody has.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const text = readable((await browser.get("/keys")).html);

    expect(text).toContain("the nightly job");
    expect(text).toContain("the worker on the small box");
    expect(text).toContain("the laptop that went missing");
    expect(text).toMatch(/revoked/i);
    expect(text).toContain("2026-08-26");
  });

  it("offers the control against every key on the list that still works", async () => {
    // Every row here is a key the merchant issued for their own code, and the
    // key this cabinet calls with is not one of them — the gateway lists it
    // nowhere and names it beside the list instead. So there is no row this
    // screen has to leave a blank against: a control missing from one of them
    // would be a key the merchant could not revoke from the only page that
    // revokes keys.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;

    expect(page).toContain(`/keys/${NIGHTLY.id}/disable`);
    expect(page).toContain(`/keys/${ANOTHER.id}/disable`);
    // And the identifier the gateway named beside the list is not treated as a
    // row: nothing on the page is drawn from it.
    expect(page).not.toContain(CABINET_KEY);
  });

  it("offers no control at all against a key that is already revoked", async () => {
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;

    expect(page).not.toContain(`/keys/${REVOKED.id}/disable`);
  });

  /**
   * What one key's row says in the column whose header this matches.
   *
   * Read through the header rather than by counting cells, so a column added
   * beside this one does not quietly move what is being read.
   */
  const inColumn = (html: string, keyId: string, header: RegExp): string => {
    const heading = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    const headers = [...heading.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((cell) =>
      readable(cell[1] ?? ""),
    );
    const at = headers.findIndex((word) => header.test(word));
    if (at < 0) {
      throw new Error(`no column of this table is headed ${header}: ${headers.join(", ")}`);
    }
    const row = (html.match(/<tr[\s\S]*?<\/tr>/g) ?? []).find((one) => one.includes(keyId));
    if (row === undefined) {
      throw new Error(`no row of this table is the key ${keyId}`);
    }
    return readable([...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][at]?.[1] ?? "");
  };

  it("says when each key was last called, and stops there when it cannot", async () => {
    // The column the screen is worth opening for: which of these keys is safe
    // to revoke. A key something is calling with says when, in the format every
    // other instant on these screens is written in.
    //
    // The empty one is where this screen can do harm. The gateway did not check
    // whether anybody has called with that key — it wrote down the calls it
    // saw — and a key older than the writing carries the same blank as a key
    // nobody has ever used. Nothing on the wire tells the two apart, so the
    // words must not either. Which words they are is a person's choice; that
    // they claim only a missing record is the promise, and "never" is the word
    // this cell reaches for when it forgets which of the two it may say.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;
    const called = inColumn(page, NIGHTLY.id, /last/i);
    const quiet = inColumn(page, ANOTHER.id, /last/i);

    expect(called).toBe("2026-08-27 02:15:00 UTC");
    expect(quiet).not.toBe("");
    expect(quiet).toMatch(/record/i);
    expect(quiet).not.toMatch(/never/i);
    // And it is not the day the key was made wearing this column's hat. That is
    // the one instant the screen has to hand when it has no call to show, and
    // putting it here would be a date a merchant reads as a call — the exact
    // lie the migration refused to write into the row.
    expect(quiet).not.toBe(inColumn(page, ANOTHER.id, /made/i));
  });

  it("says under the table that an empty last call is two situations", async () => {
    // The words the removed field was carrying. A merchant reading "No calls
    // recorded" beside a key they issued in June has to be able to find out
    // that we began recording this recently and that their oldest keys show
    // the same thing either way — otherwise the honest phrase in the cell is
    // read as the confident one, which is where it started.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const text = readable((await browser.get("/keys")).html);

    expect(text).toMatch(/began recording|started recording/i);
    expect(text).toMatch(/cannot tell you which|which it is/i);
  });

  it("issues a key, shows its secret once, and says that is the only time", async () => {
    // The same promise the command makes and for the same reason: nothing keeps
    // a readable copy, so a merchant who does not copy it has to issue another.
    // Saying so on the page is the difference between that being a nuisance and
    // being a surprise.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const issued = await browser.post("/keys", { label: "the second worker" });

    expect(keys.issued).toStrictEqual(["the second worker"]);
    expect(issued.status).toBe(200);
    expect(issued.html).toContain(SECRET);
    expect(readable(issued.html)).toMatch(/only time|once/i);
    // And it is gone from every page after it: the list is drawn from documents
    // that do not carry a secret at all.
    expect((await browser.get("/keys")).html).not.toContain(SECRET);
  });

  it("refuses to issue a key with no name, without asking the gateway", async () => {
    // A key with no name is a key nobody can tell from another, on the screen
    // whose whole job is telling them apart before revoking one.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const refused = await browser.post("/keys", { label: "   " });

    expect(refused.status).toBe(400);
    expect(readable(refused.html)).toMatch(/name/i);
    expect(keys.issued).toStrictEqual([]);
  });

  it("disables one key and comes back to the list", async () => {
    // Answered with a redirect rather than a page, like every other switch
    // here, so that a merchant who reloads does not press it again.
    const keys = withKeys();
    const { browser } = await started({ client: keys.client });
    await browser.signIn();

    const off = await browser.post(`/keys/${ANOTHER.id}/disable`);

    expect(keys.disabled).toStrictEqual([ANOTHER.id]);
    expect(off.status).toBe(303);
    expect(off.to).toBe("/keys");
  });

  it("writes down who issued a key and who revoked one, and neither secret", async () => {
    // ADR-0009 §7: every action that changes something names the person who did
    // it. Issuing and revoking a key are two of the most consequential, and the
    // secret itself must not travel with the sentence — a log goes places the
    // database does not.
    const said: string[] = [];
    const collect = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(collect);
    try {
      const { browser } = await started({ client: withKeys().client });
      await browser.signIn();

      await browser.post("/keys", { label: "the second worker" });
      await browser.post(`/keys/${ANOTHER.id}/disable`);

      const written = said.join("\n");
      expect(written).toMatch(/issued a key/i);
      expect(written).toMatch(/revoked the key|disabled the key/i);
      for (const line of written.split("\n").filter((one) => /key/.test(one))) {
        expect(line, line).toContain(PERSON);
      }
      expect(written).not.toContain(SECRET);
      expect(written).not.toContain(KEY);
    } finally {
      log.mockRestore();
    }
  });

  it("does not let the name of a key write a line of its own in the log", async () => {
    // The contract leaves a key's name unbounded and open to any alphabet on
    // purpose, so what arrives here is whatever a merchant typed. A name
    // carrying a newline and a plausible sentence after it would put a second
    // line into the one record of who stopped the selling (ADR-0009 §7) — in
    // this cabinet's voice, under a name of the writer's choosing, and
    // indistinguishable from a line the cabinet wrote.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts) => said.push(parts.map(String).join(" ")));
    try {
      const keys = withKeys();
      const { browser } = await started({ client: keys.client });
      await browser.signIn();

      await browser.post("/keys", {
        label: "a worker\n[cabinet] someone.else@example.com stopped all selling",
      });

      const written = said.join("\n");
      expect(written).toContain("issued a key");
      // Every line of the log still names the person who was signed in. The
      // name a merchant typed is on one of those lines and is not a line: what
      // they wrote is shown rather than obeyed, so somebody reading the record
      // afterwards sees an odd-looking key name and not a second event.
      for (const line of written.split("\n")) {
        expect(line, line).toContain(PERSON);
      }
      expect(written).toContain("\\x0a");
      expect(
        written.split("\n").filter((one) => one.startsWith("[cabinet] someone.else@example.com")),
      ).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("says on this screen too that nobody has confirmed the address", async () => {
    // ADR-0014 §4 is a promise about every screen that shows the address. The
    // chrome is shared, so this holds only because it is drawn the same way —
    // and a screen that took its own top bar would be the one that quietly
    // dropped it.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const text = readable((await browser.get("/keys")).html);

    expect(text).toContain(PERSON);
    expect(text).toMatch(/not confirmed/i);
  });

  it("says what the gateway said when it refuses to disable a key", async () => {
    // The rules about which keys can be switched off live in the route, and the
    // screen drawing a control is a courtesy rather than the guard. A merchant
    // who reaches the address by hand — for a key that is another merchant's,
    // or one that never existed — is told what the gateway answered rather than
    // being shown a page that says nothing happened. Against the real gateway,
    // so the sentence on the page is the gateway's own and not a test's idea of
    // it.
    const { browser } = await started();
    await browser.signIn();

    const refused = await browser.post("/keys/key_nobody_has/disable");

    expect(refused.status).toBe(404);
    expect(readable(refused.html)).toContain("there is no such key");
  });

  it("draws a working screen for a merchant who has issued no keys of their own", async () => {
    // The first screen every merchant registered through the form sees. The
    // cabinet does not sign in with a key from this list and never has one
    // here, so an empty list is the ordinary state of somebody who has not put
    // Coinslot into their own code yet — and a page telling them their own
    // starting state cannot happen is a page that has lied to every new
    // merchant. Against the real gateway, because "the list is empty" is the
    // gateway's answer and not this test's.
    const { browser } = await started({ gateway: { REGISTRATION_INVITATION: INVITATION } });
    await browser.post("/register", { ...FRESH, invitation: INVITATION });

    const seen = await browser.get("/keys");
    const text = readable(seen.html);

    expect(seen.status).toBe(200);
    expect(text).not.toMatch(/cannot happen/i);
    // A screen and not a dead end: the one control that gets a merchant out of
    // this state is on it.
    expect(seen.html).toContain('action="/keys"');
    // And it does not count rows that are not there as though some of them
    // worked.
    expect(text).not.toMatch(/\b0 of the 0\b/);
  });
});

describe("what every screen says about the address", () => {
  it("puts the address behind a link to the settings and not to the password form", async () => {
    // The one place on every page that says "this is you" leads to where the
    // account is looked after. It used to go straight to the password form,
    // which is a thing somebody does rarely and never the thing they mean when
    // they press their own name.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys", "/settings"]) {
      const answered = await browser.get(path);
      expect(answered.html, path).toContain(`href="/settings">${PERSON}</a>`);
      expect(answered.html, path).not.toContain(`href="/password">${PERSON}`);
    }
  });

  it("says on every screen that nobody has confirmed it, and offers the one control", async () => {
    // A merchant reading their own address in the corner of every page must not
    // build on it until somebody has answered from it. It is on every screen
    // rather than on one, because what an unconfirmed address costs its owner
    // only shows up on the day they have lost their password — which is a day
    // they cannot reach a settings screen.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/keys"]) {
      const answered = await browser.get(path);
      expect(readable(answered.html), path).toContain(PERSON);
      expect(readable(answered.html), path).toMatch(/not confirmed/i);
      // And the way out of it is on the same page, not somewhere else.
      expect(answered.html, path).toContain('action="/confirm"');
    }
  });

  it("stops saying it once somebody has answered from the address", async () => {
    // The negative control for the line above, and a promise of its own: a
    // banner that never leaves is a banner nobody reads.
    const { browser, gateway, mails } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    await browser.post("/confirm");
    const link = /token=(\S+)/.exec(mails.at(-1)?.body ?? "")?.[1] ?? "";
    expect(link).not.toBe("");
    await browser.get(`/confirm?token=${link}`);

    for (const path of ["/cards", "/orders", "/receipts", "/keys"]) {
      const answered = await browser.get(path);
      expect(readable(answered.html), path).toContain(PERSON);
      expect(readable(answered.html), path).not.toMatch(/not confirmed/i);
      expect(answered.html, path).not.toContain('action="/confirm"');
    }
  });
});

describe("when something goes wrong that the merchant has to get out of", () => {
  /**
   * A cabinet whose gateway answers however this test says.
   *
   * The three paths below cannot be reached through a real gateway: it cannot
   * be made to turn away a key it has just accepted, and it cannot be made to
   * answer in a shape its own contract refuses. `buildApp` takes the client as
   * a parameter for exactly this, and what is asserted is the page the merchant
   * lands on — the seam is scaffolding, not the subject.
   */
  const cabinetAnswering = async (
    reply: () => Promise<Answer<never>>,
  ): Promise<{ browser: Browser; close: () => Promise<void> }> => {
    const answer = async () => await reply();
    const config = loadConfig({
      GATEWAY_URL: "http://127.0.0.1:1",
      DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
      AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
    });
    const { identity } = await withIdentity(config, async () => undefined);
    const app = buildApp(config, {
      identity,
      gatewayFor: () =>
        ({
          cards: answer,
          pauseCard: answer,
          setSelling: answer,
          orders: answer,
          receipts: answer,
          sellerName: answer,
          setSellerName: answer,
          // The two the sign-in makes about this cabinet's own key answer the
          // same way as everything else here. A merchant whose gateway is
          // refusing every call is refused these too, and what the tests below
          // are about is the page they land on afterwards — so the sign-in that
          // gets them there has to survive it.
          issueCabinetKey: answer,
          forgetCabinetKey: answer,
        }) as never,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      browser: await attachedTo(`http://127.0.0.1:${port}`, ""),
      close: async () => {
        await identity.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      },
    };
  };

  it("does not sign a person out when it is the cabinet's own key the gateway refuses", async () => {
    // The key is the cabinet's configuration now, not the person's password
    // (ADR-0009 §4). Signing them out over a 401 would send them to type a
    // password that cannot fix it, and they would land straight back here — a
    // loop with no way out and nothing said about the actual fault.
    const { browser, close } = await cabinetAnswering(async () => ({
      ok: false,
      status: 401,
      why: "this call is behind the merchant's key",
    }));
    try {
      const met = await browser.signIn();

      expect(met.status).toBe(502);
      const text = readable(met.html);
      expect(text).toMatch(/key/i);
      expect(text).not.toContain("Sign in");
      // Still signed in: the person is fine, the cabinet is not.
      expect(browser.sessionToken()).not.toBeNull();
      expect(met.headers.getSetCookie().join(" ")).not.toContain(`${COOKIE}=;`);
    } finally {
      await close();
    }
  });

  it("does not tell a merchant nothing was changed when it cannot know that", async () => {
    // A call that reached the gateway, did what it was asked, and answered in a
    // shape the contract does not recognise lands on the error page. The pause
    // has already happened; a page saying otherwise would send the merchant to
    // press it again.
    const { browser, close } = await cabinetAnswering(async () => {
      throw new Error("the answer was not a document this contract knows");
    });
    try {
      await browser.signIn();

      const answered = await browser.post("/selling/pause");

      expect(answered.status).toBe(500);
      const text = readable(answered.html);
      expect(text).toContain("Something in the cabinet is broken");
      expect(text).not.toContain("Nothing was changed");
    } finally {
      await close();
    }
  });

  it("says there is no such page rather than answering an address with nothing", async () => {
    // Only to somebody who is signed in. A stranger is told nothing about which
    // addresses exist here (ADR-0009 §5), which is the test above this one.
    const { browser } = await started();
    await browser.signIn();

    const answered = await browser.get("/nowhere");

    expect(answered.status).toBe(404);
    expect(readable(answered.html)).toContain("There is no such page");
  });

  it("treats a cookie it cannot read as nobody being signed in", async () => {
    // A cookie value that is not valid percent-encoding used to throw past
    // every route onto the error page — whose only control leads to a page that
    // throws again, with the cookie HttpOnly and no way to clear it from there.
    const { browser } = await started();

    for (const raw of [
      `${COOKIE}=%zz`,
      `${COOKIE}=`,
      "=nonsense",
      `${COOKIE}=made-up-identifier`,
    ]) {
      const answered = await browser.withRawCookie(raw).get("/cards");
      expect(answered.status, raw).toBe(303);
      expect(answered.to, raw).toBe("/sign-in");
    }
  });

  it("cannot be signed out by a second cookie somebody planted", async () => {
    // A page on a sibling subdomain can set a cookie of this name on a broader
    // path, and the browser then sends two of them. The cabinet can only clear
    // the one on its own path, so a rule that refused on the mere presence of a
    // second would lock the merchant out for good — every redirect and every
    // fresh sign-in would meet the planted cookie again, and anybody able to
    // set a cookie could take away the control that stops their selling.
    const { browser } = await started();
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    expect(mine).not.toBe("");

    for (const raw of [
      `${COOKIE}=${mine}; ${COOKIE}=somebody-elses`,
      `${COOKIE}=somebody-elses; ${COOKIE}=${mine}`,
      `${COOKIE}=a; ${COOKIE}=b; ${COOKIE}=${mine}`,
    ]) {
      const answered = await browser.withRawCookie(raw).get("/cards");
      expect(answered.status, raw).toBe(200);
      expect(readable(answered.html), raw).toContain(PERSON);
    }
  });

  it("still signs its merchant in under every cookie of this name a request can carry", async () => {
    // There is no cap on how many values under this name are considered, and
    // there must not be: a browser sends cookies of one name longest-path first
    // and then oldest first, so somebody able to plant them could push the
    // merchant's own past a cap and lock them out of the control that stops
    // their selling. A cap anywhere below what a request can actually carry
    // would pass a test built to a smaller number, so this one is built to the
    // runtime's own ceiling.
    //
    // That ceiling is why the request is written onto a socket by hand. Node
    // stops reading a request's headers at 16 KB; one cookie of this name and
    // shape is 99 bytes and the separator adds two, and a request carrying
    // nothing but a request line and a Host header buys 161 of them — measured
    // rather than worked out, and the arithmetic agrees. `fetch` sends headers
    // of its own — an accept, a user agent, an encoding — and buys fewer, so
    // what it would measure is those headers.
    //
    // What this costs is not what it used to. The old arrangement asked the
    // database about every value at once, in one query; the component looks a
    // session up one identifier at a time, and there is no batch to ask. What
    // stands in front of that is its signature: a value under this name that
    // was not signed with this cabinet's secret is refused before the store is
    // read at all, so a pile of planted junk is a pile of comparisons and not a
    // pile of queries. `identity.db-test.ts` measures that against a real
    // database, which is the only place a query can be counted honestly.
    const { browser, url } = await started();
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    const carrying = (count: number): string =>
      [
        ...Array.from(
          { length: count - 1 },
          (_, at) => `${`${at}`.padStart(32, "a")}.${"b".repeat(43)}`,
        ),
        mine,
      ]
        .map((value) => `${COOKIE}=${value}`)
        .join("; ");
    const most = await overASocket(url, "/cards", carrying(161));

    // The merchant is still the person asking, with 160 planted cookies in
    // front of their own.
    expect(most.status).toBe(200);
    expect(most.body).toContain(PERSON);

    // And one more than that is not the cabinet's problem: the runtime refuses
    // to read the headers at all, so nothing here ever sees it.
    const tooMany = await overASocket(url, "/cards", carrying(162));

    expect(tooMany.status).toBe(431);
  });

  it("is one person's cabinet when both live cookies are that person's", async () => {
    // What a change of mount point leaves in a browser: the cookie from the old
    // path and the cookie from the new one, both this person's and both alive.
    // There is no ambiguity in that to refuse, and refusing it would end a
    // session the merchant is sitting in for a reason that is ours.
    const { browser, another } = await started();
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    const telephone = await another();
    await telephone.signIn();
    const also = telephone.sessionToken() ?? "";

    expect(mine).not.toBe(also);
    const answered = await browser
      .withRawCookie(`${COOKIE}=${mine}; ${COOKIE}=${also}`)
      .get("/cards");

    expect(answered.status).toBe(200);
    expect(readable(answered.html)).toContain(PERSON);
    // And neither session was ended on the way: both still work on their own.
    expect((await browser.withRawCookie(`${COOKIE}=${mine}`).get("/cards")).status).toBe(200);
    expect((await browser.withRawCookie(`${COOKIE}=${also}`).get("/cards")).status).toBe(200);
  });

  it("ends both sessions rather than choosing when they belong to two people", async () => {
    // The case where the ambiguity actually matters: working inside a session
    // somebody else opened would put the wrong person on the one record of who
    // stopped the selling (ADR-0009 §7). Nobody is signed in.
    //
    // And the sessions are ended, which is the half that decides whether this
    // rule is safe to have. The cabinet cannot take a cookie out of a browser —
    // a cookie set for a broader domain or a broader path survives everything
    // this process can send — so a rule that only refused would meet the
    // planted session again on every redirect and every fresh sign-in, and the
    // merchant would never reach the control that stops their selling again.
    // Ending them means the planted value stops being a session, and the next
    // sign-in works.
    const { browser, another, identity } = await started();
    await identity.make(OTHER, PASSWORD, THE_MERCHANT);
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    const somebody = await another();
    await somebody.signIn(OTHER);
    const theirs = somebody.sessionToken() ?? "";

    expect(mine).not.toBe(theirs);
    const answered = await browser
      .withRawCookie(`${COOKIE}=${mine}; ${COOKIE}=${theirs}`)
      .get("/cards");

    expect(answered.status).toBe(303);
    expect(answered.to).toBe("/sign-in");
    // Neither is a session any more, so the plant is spent rather than waiting.
    expect((await browser.withRawCookie(`${COOKIE}=${mine}`).get("/cards")).to).toBe("/sign-in");
    expect((await browser.withRawCookie(`${COOKIE}=${theirs}`).get("/cards")).to).toBe("/sign-in");
    // And the merchant gets back in, which is the whole point of ending them:
    // the dead cookie is still in the browser and no longer decides anything.
    const back = await browser.signIn();
    expect(back.status).toBe(200);
    const carrying = await browser
      .withRawCookie(`${COOKIE}=${theirs}; ${COOKIE}=${browser.sessionToken() ?? ""}`)
      .get("/cards");
    expect(carrying.status).toBe(200);
    expect(readable(carrying.html)).toContain(PERSON);
  });

  it("turns away a form post that came from another site", async () => {
    // The session this form rides on can stop all selling. SameSite=Strict is
    // the main lock; this is the second, because SameSite is scoped to the
    // registrable domain and a sibling subdomain is "same site".
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    const forged = await browser.from("https://evil.example.com").post("/selling/pause");

    expect(forged.status).toBe(403);
    expect(await purchasable(gateway, itemId)).toBe(true);
  });

  it("lets a merchant in whatever the terminator in front of it says about the scheme", async () => {
    // The failure this pins happened on the first real deployment, and it made
    // the site unusable: a browser signing in at https://coinslot.nuanu.ai was
    // told its form came from somewhere else. The check used to build the
    // origin it expected out of `X-Forwarded-Proto`, so whatever is in front
    // decided whether a merchant could sign in, and when that header did not
    // say what the browser said, every form post on the site was refused — the
    // sign-in included, which is a cabinet nobody can get into.
    //
    // The sign-in is what this drives for exactly that reason: it is the post
    // that has to work before any other one can. Each case below is a shape
    // that header can arrive in, and none of them may keep a merchant out.
    const { browser, url } = await started();
    const asHttps = `https://${new URL(url).host}`;
    const credentials = { email: PERSON, password: PASSWORD };

    const behindTls = await browser
      .sending({ origin: asHttps, "x-forwarded-proto": "https" })
      .post("/sign-in", credentials);
    expect(behindTls.status).toBe(303);
    expect(behindTls.to).toBe("/cards");

    // The one that was actually broken: an https origin with nothing in the
    // request saying so. This is a terminator that sets no forwarded header,
    // and it used to be the refusal that locked the site.
    const nothingForwarded = await browser
      .sending({ origin: asHttps })
      .post("/sign-in", credentials);
    expect(nothingForwarded.status).toBe(303);
    expect(nothingForwarded.to).toBe("/cards");

    // Run on its own with no terminator at all, which is how it is developed
    // and how every test here drives it.
    const onItsOwn = await browser
      .sending({ origin: `http://${new URL(url).host}` })
      .post("/sign-in", credentials);
    expect(onItsOwn.status).toBe(303);

    // A chain that terminates TLS early and disagrees with itself end to end.
    const throughAChain = await browser
      .sending({ origin: asHttps, "x-forwarded-proto": "https, http" })
      .post("/sign-in", credentials);
    expect(throughAChain.status).toBe(303);

    // And the scheme disagreeing outright, which the earlier version refused
    // and this one does not. What that costs is written where the check is: a
    // page on the http origin of the same host cannot carry a session anyway,
    // because the cookie is Secure wherever the cabinet is served over https.
    const overHttp = await browser
      .sending({ origin: `http://${new URL(url).host}`, "x-forwarded-proto": "https" })
      .post("/sign-in", credentials);
    expect(overHttp.status).toBe(303);
  });

  it("still refuses a form from another host, whatever it claims about the scheme", async () => {
    // The negative control for the test above. Loosening the check to the host
    // must not loosen it to everybody: this is the reason the check exists at
    // all, because SameSite is scoped to the registrable domain and a sibling
    // subdomain is "same site" to it.
    const { browser, url } = await started();
    const credentials = { email: PERSON, password: PASSWORD };

    for (const origin of [
      "https://evil.example.com",
      // A sibling subdomain, which SameSite would let through.
      `https://elsewhere.${new URL(url).hostname}`,
      // The host as a prefix of a longer one, which a text comparison that
      // used `startsWith` would wave through.
      `https://${new URL(url).hostname}.evil.example.com`,
      // An opaque origin, which a sandboxed document sends.
      "null",
    ]) {
      const forged = await browser.sending({ origin }).post("/sign-in", credentials);
      expect(forged.status, origin).toBe(403);
      expect(readable(forged.html), origin).toContain("did not come from the cabinet");
    }
  });

  it("writes down what it compared, because the other person it refuses is honest", async () => {
    // This refusal reaches two people. One is guessing, and the page tells them
    // nothing on purpose. The other is a merchant who did nothing wrong and now
    // cannot sign in, and until this line existed there was no way to tell the
    // two apart — the check turned an honest browser away on the live site and
    // the only evidence anywhere was a screenshot somebody sent.
    const said: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...parts: unknown[]) => said.push(parts.map(String).join(" ")));
    try {
      const { browser, url } = await started();

      await browser
        .sending({ origin: "https://evil.example.com" })
        .post("/sign-in", { email: PERSON, password: PASSWORD });

      const line = said.find((one) => one.includes("form post was refused")) ?? "";
      // Both halves of the comparison, because either one alone leaves the
      // reader guessing which of the two was wrong.
      expect(line).toContain("evil.example.com");
      expect(line).toContain(new URL(url).host);
    } finally {
      log.mockRestore();
    }
  });
});

describe("when the gateway will not answer", () => {
  it("says the gateway did not answer rather than showing an empty catalog", async () => {
    // "Nothing answered" and "you have no cards" are different news, and only
    // one of them means the merchant should do something.
    const { browser, gateway, stopGateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    await stopGateway();

    const answered = await browser.get("/cards");

    expect(answered.status).toBe(502);
    expect(readable(answered.html)).toContain("The gateway did not answer");
  });
});

describe("a session that is ended while somebody is looking at a page", () => {
  it("stops the open tab from doing anything, and does not do what it asked", async () => {
    // The reason a session is a row at all (ADR-0009 §3). Before this, ending
    // one meant rotating the merchant's key — which also stops the merchant's
    // own code, in the same instant.
    const { browser, gateway, identity } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    expect((await browser.get("/cards")).status).toBe(200);

    await identity.endEverySessionFor(PERSON);

    const refused = await browser.post("/selling/pause");
    expect(refused.status).toBe(303);
    expect(refused.to).toBe("/sign-in");
    // The negative control is the fact rather than the answer: the switch the
    // tab pressed did not move.
    expect(await purchasable(gateway, itemId)).toBe(true);
    expect((await browser.get("/cards")).to).toBe("/sign-in");
  });

  it("leaves the person's other session alone", async () => {
    // One session at a time is the promise. Ending every one of them at once is
    // what the merchant key already did, and it is what this replaces.
    const { browser, gateway, another, identity } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    const telephone = await another();
    await telephone.signIn();

    await identity.signOut(`${COOKIE}=${browser.sessionToken() ?? ""}`);

    expect((await browser.get("/cards")).to).toBe("/sign-in");
    expect((await telephone.get("/cards")).status).toBe(200);
  });

  it("refuses a session whose time is up, without anybody ending it", async () => {
    // Twelve hours from the moment it opens, never extended (ADR-0009 §6). The
    // cookie in the browser is untouched and still carries a good signature;
    // what has run out is the row, and the row is what decides.
    const { browser } = await started();
    await browser.signIn();
    expect((await browser.get("/cards")).status).toBe(200);

    for (const session of sessionRows()) {
      session.expiresAt = new Date(Date.now() - 60_000);
    }

    const answered = await browser.get("/cards");

    expect(answered.status).toBe(303);
    expect(answered.to).toBe("/sign-in");
  });

  it("is a fresh session every time, so signing in twice does not reuse one identifier", async () => {
    const { browser, another } = await started();
    await browser.signIn();
    const first = browser.sessionToken();
    const telephone = await another();
    await telephone.signIn();

    expect(first).not.toBeNull();
    expect(telephone.sessionToken()).not.toBe(first);
  });
});

describe("changing a password from inside the cabinet", () => {
  it("takes the new one, and the old one stops working", async () => {
    // The password a person starts with is one we generated and handed over
    // through some channel or other. Without this page it stays that password
    // for as long as the account exists.
    const { browser } = await started();
    await browser.signIn();

    const changed = await browser.post("/password", {
      current: PASSWORD,
      fresh: "a-password-of-their-own",
    });

    expect(changed.status).toBe(303);
    expect((await browser.signIn(PERSON, PASSWORD)).status, "the old password").toBe(401);
    expect((await browser.signIn(PERSON, "a-password-of-their-own")).status).toBe(200);
  });

  it("ends every session that person had, including the one that changed it", async () => {
    // A password is changed because the old one is not trusted. Every session
    // opened with it has to go, and the person is asked for the new one.
    const { browser, another } = await started();
    await browser.signIn();
    const telephone = await another();
    await telephone.signIn();

    await browser.post("/password", { current: PASSWORD, fresh: "a-password-of-their-own" });

    expect((await telephone.get("/cards")).to).toBe("/sign-in");
    expect((await browser.get("/cards")).to).toBe("/sign-in");
    // Not one row left, including the one the component opens in place of the
    // session it just ended. A person who has changed their password is signed
    // out everywhere, and the listing that counts their open sessions has to
    // say so rather than reporting one nobody holds.
    expect(sessionRows()).toHaveLength(0);
    // And the new one works.
    expect((await browser.signIn(PERSON, "a-password-of-their-own")).status).toBe(200);
  });

  it("refuses to change it without the current one", async () => {
    // Otherwise an unattended tab is a way to take the account, not merely to
    // use it while it is open.
    const { browser } = await started();
    await browser.signIn();

    const refused = await browser.post("/password", {
      current: "not-the-password",
      fresh: "a-password-of-their-own",
    });

    expect(refused.status).toBe(401);
    expect(readable(refused.html)).toMatch(/current password/i);
    // Still the old one, and still signed in.
    expect((await browser.get("/cards")).status).toBe(200);
  });

  it("refuses a new password too short to be worth having", async () => {
    // There is no rate limit on the sign-in form by choice (ADR-0009), and a
    // floor on the password is the other half of that argument.
    const { browser } = await started();
    await browser.signIn();

    const refused = await browser.post("/password", { current: PASSWORD, fresh: "short" });

    expect(refused.status).toBe(400);
    expect(readable(refused.html)).toMatch(/12 characters/);
    expect((await browser.get("/cards")).status).toBe(200);
  });

  it("never puts either password on the page it answers with", async () => {
    const { browser } = await started();
    await browser.signIn();

    const refused = await browser.post("/password", { current: PASSWORD, fresh: "short" });

    expect(refused.html).not.toContain(PASSWORD);
    expect(refused.html).not.toContain("short");
  });
});

describe("confirming the address on an account", () => {
  /** The link out of the last message the cabinet handed over. */
  const linkIn = (mails: Message[]): string => {
    const found = /(https?:\/\/\S+)/.exec(mails.at(-1)?.body ?? "");
    return found?.[1] ?? "";
  };

  it("sends a link when the merchant asks for one, and takes it when they follow it", async () => {
    // Nothing waits for a message: the account has been working since it was
    // made. What this buys its owner is the one thing that needs it, which is
    // being sent a new password when they lose this one.
    const { browser, gateway, mails, identity } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    const asked = await browser.post("/confirm");

    expect(asked.status).toBe(303);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe(PERSON);
    // The address is still unconfirmed until somebody follows the link. Asking
    // is not answering.
    expect((await identity.byEmail(PERSON))?.confirmed).toBe(false);

    const followed = await browser.get(
      new URL(linkIn(mails)).pathname + new URL(linkIn(mails)).search,
    );

    expect(followed.status).toBe(200);
    expect(readable(followed.html)).toMatch(/confirmed/i);
    expect((await identity.byEmail(PERSON))?.confirmed).toBe(true);
  });

  it("says a link that is not one of ours does not work, and confirms nobody", async () => {
    // A page that said "confirmed" whatever it was handed would leave a
    // merchant believing they can be sent a new password when they cannot.
    const { browser, mails, identity } = await started();
    await identity.make(OTHER, PASSWORD, THE_MERCHANT);
    await browser.signIn();
    await browser.post("/confirm");
    const link = new URL(linkIn(mails));

    const invented = await browser.get(`${link.pathname}?token=not-one-of-ours`);
    const empty = await browser.get(link.pathname);

    expect(invented.status).toBe(400);
    expect(readable(invented.html)).toMatch(/does not work/i);
    expect(empty.status).toBe(400);
    // Nobody was confirmed by any of it — not the person who asked, and not the
    // second person on this cabinet.
    expect((await identity.byEmail(PERSON))?.confirmed).toBe(false);
    expect((await identity.byEmail(OTHER))?.confirmed).toBe(false);
  });

  it("says the address is confirmed when the same link is followed twice", async () => {
    // The link is worth an hour rather than one use, and the second click is a
    // person double-checking or a mail client following it for them. Refusing
    // it would tell somebody their address is not confirmed when it is.
    const { browser, mails, identity } = await started();
    await browser.signIn();
    await browser.post("/confirm");
    const link = new URL(linkIn(mails));

    await browser.get(link.pathname + link.search);
    const again = await browser.get(link.pathname + link.search);

    expect(again.status).toBe(200);
    expect(readable(again.html)).toMatch(/confirmed/i);
    expect((await identity.byEmail(PERSON))?.confirmed).toBe(true);
  });

  it("does not send a second message to somebody who has already confirmed", async () => {
    // The control is gone from the page by then, so this is about the address
    // rather than the button — and about not spending a sender's reputation on
    // messages nobody asked for.
    const { browser, mails } = await started();
    await browser.signIn();
    await browser.post("/confirm");
    const link = new URL(linkIn(mails));
    await browser.get(link.pathname + link.search);

    await browser.post("/confirm");

    expect(mails).toHaveLength(1);
  });

  it("is not something a page on another site can ask for on a merchant's behalf", async () => {
    const { browser, mails } = await started();
    await browser.signIn();

    const forged = await browser.from("https://evil.example.com").post("/confirm");

    expect(forged.status).toBe(403);
    expect(mails).toStrictEqual([]);
  });
});

describe("a password nobody can remember any more", () => {
  const linkIn = (mails: Message[]): URL => {
    const found = /(https?:\/\/\S+)/.exec(mails.at(-1)?.body ?? "");
    return new URL(found?.[1] ?? "http://127.0.0.1/none");
  };

  /** Confirms this browser's address, which is what recovery waits on. */
  const confirmed = async (browser: Browser, mails: Message[]): Promise<void> => {
    await browser.signIn();
    await browser.post("/confirm");
    const link = linkIn(mails);
    await browser.get(link.pathname + link.search);
    mails.length = 0;
    await browser.post("/sign-out");
  };

  it("sends a link that sets a new password and ends every session they had", async () => {
    // The first thing in this cabinet that stops needing somebody at a
    // terminal. A merchant who has lost their password gets back in on their
    // own, and every session opened with the old one goes — because the reason
    // to replace a password is that the old one is not trusted.
    const { browser, another, mails } = await started();
    await confirmed(browser, mails);
    const telephone = await another();
    await telephone.signIn();
    expect((await telephone.get("/cards")).status).toBe(200);

    const asked = await browser.post("/password/forgot", { email: PERSON });
    expect(asked.status).toBe(200);
    expect(mails).toHaveLength(1);

    const link = linkIn(mails);
    const form = await browser.get(link.pathname + link.search);
    expect(form.status).toBe(200);
    const token = /name="token" value="([^"]+)"/.exec(form.html)?.[1] ?? "";
    expect(token).not.toBe("");

    const set = await browser.post("/password/new", { token, fresh: "a-password-of-their-own" });

    expect(set.status).toBe(303);
    expect(set.to).toBe("/sign-in");
    // The new one works, the old one does not, and the session on the other
    // device is over.
    expect((await browser.signIn(PERSON, "a-password-of-their-own")).status).toBe(200);
    expect((await telephone.get("/cards")).to).toBe("/sign-in");
    expect((await browser.signIn(PERSON, PASSWORD)).status).toBe(401);
  });

  it("answers the same way whether or not the address has an account here", async () => {
    // Otherwise the form is a way of asking who sells here, put in front of
    // anybody who finds the hostname.
    const { browser, mails } = await started();

    const known = await browser.post("/password/forgot", { email: PERSON });
    const unknown = await browser.post("/password/forgot", { email: "nobody@example.com" });

    expect(known.status).toBe(unknown.status);
    expect(readable(known.html)).toBe(readable(unknown.html));
    // And neither of them sent anything, because the address on this cabinet
    // has not been confirmed either.
    expect(mails).toStrictEqual([]);
  });

  it("sends nothing to an address nobody has answered from", async () => {
    // A link that replaces a password, sent to an address whose owner has never
    // shown they can read it, would hand the account to whoever was typed into
    // the form at registration. The page says the same thing either way, so
    // there is nothing here for anybody to read off the answer.
    const { browser, mails } = await started();

    const asked = await browser.post("/password/forgot", { email: PERSON });

    expect(asked.status).toBe(200);
    expect(readable(asked.html)).toMatch(/has an account here and has been confirmed/i);
    expect(mails).toStrictEqual([]);
  });

  it("refuses a link that has been used, and does not set a second password with it", async () => {
    const { browser, mails } = await started();
    await confirmed(browser, mails);
    await browser.post("/password/forgot", { email: PERSON });
    const form = await browser.get(linkIn(mails).pathname + linkIn(mails).search);
    const token = /name="token" value="([^"]+)"/.exec(form.html)?.[1] ?? "";
    await browser.post("/password/new", { token, fresh: "a-password-of-their-own" });

    const again = await browser.post("/password/new", { token, fresh: "a-second-password-here" });

    expect(again.status).toBe(400);
    expect(readable(again.html)).toMatch(/does not work/i);
    expect((await browser.signIn(PERSON, "a-second-password-here")).status).toBe(401);
    expect((await browser.signIn(PERSON, "a-password-of-their-own")).status).toBe(200);
  });

  it("refuses a new password too short to be worth having, and keeps the link alive", async () => {
    // Spending somebody's only link on a password the cabinet was never going
    // to take would send them back to the form to ask for another one.
    const { browser, mails } = await started();
    await confirmed(browser, mails);
    await browser.post("/password/forgot", { email: PERSON });
    const form = await browser.get(linkIn(mails).pathname + linkIn(mails).search);
    const token = /name="token" value="([^"]+)"/.exec(form.html)?.[1] ?? "";

    const refused = await browser.post("/password/new", { token, fresh: "short" });

    expect(refused.status).toBe(400);
    expect(readable(refused.html)).toMatch(/12 characters/);
    const set = await browser.post("/password/new", { token, fresh: "a-password-of-their-own" });
    expect(set.status).toBe(303);
  });

  it("does not spend the link merely by drawing the page it lands on", async () => {
    // A mail client that fetches every link in a message to build a preview
    // would otherwise burn somebody's only way back in before they read it.
    const { browser, mails } = await started();
    await confirmed(browser, mails);
    await browser.post("/password/forgot", { email: PERSON });
    const link = linkIn(mails);

    await browser.get(link.pathname + link.search);
    await browser.get(link.pathname + link.search);
    const form = await browser.get(link.pathname + link.search);
    const token = /name="token" value="([^"]+)"/.exec(form.html)?.[1] ?? "";

    expect(
      (await browser.post("/password/new", { token, fresh: "a-password-of-their-own" })).status,
    ).toBe(303);
  });

  it("is reachable without a session, and is linked from the sign-in", async () => {
    // Every other address is behind the gate. This one cannot be: the person
    // who needs it is the person who cannot sign in.
    const { browser } = await started();

    const gate = await browser.get("/sign-in");
    const form = await browser.get("/password/forgot");

    expect(gate.html).toContain('href="/password/forgot"');
    expect(form.status).toBe(200);
    expect(readable(form.html)).toMatch(/new password/i);
  });

  it("sends nobody to a form with no link behind it", async () => {
    // A page that took a password and had nothing to do with it would be a
    // password typed into nothing.
    const { browser } = await started();

    const bare = await browser.get("/password/new");

    expect(bare.status).toBe(303);
    expect(bare.to).toBe("/password/forgot");
  });

  it("keeps the link out of the address bar once the page is drawn", async () => {
    // The value travels on in a hidden field instead. In the address it would
    // be in the browser's history, in whatever the next page is told about
    // where the visitor came from, and in the log of anything in front of this
    // cabinet.
    const { browser, mails } = await started();
    await confirmed(browser, mails);
    await browser.post("/password/forgot", { email: PERSON });
    const link = linkIn(mails);
    const token = link.searchParams.get("token") ?? "";

    const form = await browser.get(link.pathname + link.search);

    expect(form.html).toContain(`name="token" value="${token}"`);
    // The form posts to an address with nothing in its query.
    expect(form.html).toContain('action="/password/new"');
  });

  it("turns away a form posted from another site", async () => {
    const { browser, mails } = await started();

    const forged = await browser
      .from("https://evil.example.com")
      .post("/password/forgot", { email: PERSON });

    expect(forged.status).toBe(403);
    expect(mails).toStrictEqual([]);
  });
});

describe("what the cabinet writes down about what people do", () => {
  /** Everything the process said while `during` ran. */
  const logged = async (during: () => Promise<void>): Promise<string> => {
    const lines: string[] = [];
    const collect = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(collect);
    const error = vi.spyOn(console, "error").mockImplementation(collect);
    try {
      await during();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    return lines.join("\n");
  };

  it("names the person who changed something, not just that something changed", async () => {
    // ADR-0009 §7. This is not an audit trail and the decision says so — but a
    // merchant asking who stopped their selling has to be answerable at all,
    // and with one key and no person there was nothing to answer with.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();

    const said = await logged(async () => {
      await browser.post("/selling/pause");
      await browser.post(`/cards/${encodeURIComponent(itemId)}/pause`);
      await browser.post(`/cards/${encodeURIComponent(itemId)}/resume`);
      await browser.post("/selling/resume");
    });

    // All four switches, not one of them: the ADR says every action that
    // changes something names the person, and a merchant asking who put their
    // selling back on is asking the same question as who stopped it.
    expect(said).toMatch(/stopped all selling/i);
    expect(said).toMatch(/started selling again/i);
    expect(said).toMatch(/paused the card/i);
    expect(said).toMatch(/resumed the card/i);
    for (const line of said.split("\n").filter((one) => /selling|card/.test(one))) {
      expect(line, line).toContain(PERSON);
    }
    expect(said).toContain(itemId);
  });

  it("writes down neither a password, nor a session identifier, nor the merchant key", async () => {
    // A log goes places the environment does not: a terminal, a file, whatever
    // collects it. Any of these three in there is the credential loose again.
    const { browser, gateway } = await started();
    const itemId = await publish(gateway, roomCard);

    // Read out inside the journey and not after it. Taken afterwards it is
    // null, because the last two steps end the session — and an assertion
    // guarded by "if we have one" is an assertion that never runs. That is how
    // this test passed while the cabinet logged the identifier on every
    // sign-in, and it is the reason for the plain `expect` below.
    let token = "";

    const said = await logged(async () => {
      await browser.post("/sign-in", { email: PERSON, password: "not-the-password" });
      await browser.signIn();
      token = browser.sessionToken() ?? "";
      await browser.post("/selling/pause");
      await browser.post(`/cards/${encodeURIComponent(itemId)}/pause`);
      await browser.post("/password", { current: PASSWORD, fresh: "a-password-of-their-own" });
      await browser.post("/sign-out");
    });

    expect(token).not.toBe("");
    expect(said).not.toContain(token);
    expect(said).not.toContain(PASSWORD);
    expect(said).not.toContain("a-password-of-their-own");
    expect(said).not.toContain("not-the-password");
    expect(said).not.toContain(KEY);
  });

  it("does not write down an address somebody merely typed at the sign-in", async () => {
    // The email box is where a password lands when somebody types into the
    // wrong field, and a refused sign-in that echoed it would put that password
    // in the log. An address we do have an account for is named, because that
    // is a real account being attacked.
    const { browser } = await started();

    const said = await logged(async () => {
      await browser.post("/sign-in", { email: "hunter2-typed-in-the-wrong-box", password: "x" });
      await browser.post("/sign-in", { email: PERSON, password: "not-the-password" });
    });

    expect(said).not.toContain("hunter2-typed-in-the-wrong-box");
    expect(said).toContain(PERSON);
  });
});

describe("the key the cabinet signs in with", () => {
  /**
   * A merchant who registered for themselves, whose row holds a real key made
   * for a cabinet.
   *
   * Every other account in this file was seeded with the harness's own key,
   * which is one of the merchant's own — the shape a deployment only reaches
   * when somebody at a terminal made the account, and one the gateway refuses
   * both of these calls to. So these tests go in through the form, against the
   * real gateway, and what comes back onto the row is the real thing.
   */
  const aRegisteredMerchant = async (over: Starting = {}): Promise<Running> => {
    const running = await started({
      ...over,
      gateway: { REGISTRATION_INVITATION: INVITATION, ...over.gateway },
    });
    const made = await running.browser.post("/register", { ...FRESH, invitation: INVITATION });
    if (made.status !== 303) {
      throw new Error(`the registration did not go through: ${made.status}`);
    }
    return running;
  };

  /** The key the cabinet would call as this person with, off their row. */
  const keyOnTheRowOf = (email: string): string => {
    const row = (open?.rows.cabinet_accounts ?? []).find((one) => one.email === email);
    const key = row?.merchantKey;
    if (typeof key !== "string" || key === "") {
      throw new Error(`there is no account for ${email} with a key on it`);
    }
    return key;
  };

  /**
   * Whether the gateway still takes that key, asked of the gateway itself.
   *
   * Not "is it on a row" and not "did the cabinet think it worked": a key is
   * alive or dead at the gateway, and that is the fact both halves of this turn
   * on — the one that got somebody in has to work, and the one before it has to
   * have stopped.
   */
  const theGatewayTakes = async (key: string): Promise<boolean> =>
    (await gatewayFor(open?.gateway.url ?? "", key).keys()).ok;

  /** Everything the process said while `during` ran. */
  const said = async (during: () => Promise<void>): Promise<string> => {
    const lines: string[] = [];
    const collect = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(collect);
    const error = vi.spyOn(console, "error").mockImplementation(collect);
    try {
      await during();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    return lines.join("\n");
  };

  it("writes a key made a moment ago onto the row, over the one that was there", async () => {
    // ADR-0014 §2. A copy of this cabinet's database is a set of keys, and this
    // is what decides how long they are worth having: until the person they
    // belong to signs in again.
    const { another } = await aRegisteredMerchant();
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const written = await said(async () => {
      await device.signIn(FRESH.email, FRESH.password);
    });

    const now = keyOnTheRowOf(FRESH.email);
    expect(now).not.toBe(before);
    // And it is a key, not a string that looks like one: the gateway takes it.
    expect(await theGatewayTakes(now)).toBe(true);
    // Neither of them is written down anywhere on the way. ADR-0014 §2 makes
    // the row the one place this value lives, and a sign-in that put a working
    // key into the log would be the credential loose in the one place a
    // database is not — a log goes to a terminal, a file, whatever collects it.
    expect(written).not.toContain(before);
    expect(written).not.toContain(now);
  });

  it("takes the key that was on the row away, and spares the one that replaced it", async () => {
    // Forgetting the old key is the half that makes the replacement worth
    // anything: a key left behind at every sign-in is a pile of live
    // credentials nobody is holding. What it must never take is the key that
    // is now on the row.
    const { another } = await aRegisteredMerchant();
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    await device.signIn(FRESH.email, FRESH.password);

    expect(await theGatewayTakes(before)).toBe(false);
    expect(await theGatewayTakes(keyOnTheRowOf(FRESH.email))).toBe(true);
  });

  it("leaves the browser that was already signed in able to go on working", async () => {
    // Two devices, one account. The key is read off the row on every request
    // rather than kept anywhere, so the session that was open before the swap
    // reaches the gateway with the key the swap wrote — it does not have to
    // notice that anything happened.
    const { browser, another } = await aRegisteredMerchant();

    const device = await another();
    await device.signIn(FRESH.email, FRESH.password);

    const seen = await browser.get("/keys");
    expect(seen.status).toBe(200);
  });

  it("lets a person in on the key they had when no fresh one could be made", async () => {
    // The first of the three steps, cut. Nothing was made, so nothing is
    // written and nothing is forgotten: they sign in as they always did, and
    // the gateway being unwell is not allowed to be a locked door.
    const { another } = await aRegisteredMerchant({
      client: (real) => ({
        ...real,
        issueCabinetKey: async () => ({ ok: false, status: 0, why: "nothing answered" }),
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const inside = await device.signIn(FRESH.email, FRESH.password);

    expect(inside.status).toBe(200);
    expect(keyOnTheRowOf(FRESH.email)).toBe(before);
    expect(await theGatewayTakes(before)).toBe(true);
  });

  it("clears up after itself, and not after the sign-in that won, when the write is lost", async () => {
    // The second step, lost rather than broken, which is what a sign-in beaten
    // to the row by another one meets. The key on the row belongs to whoever
    // won and must not be touched; the key this sign-in made is on no row and
    // can never reach one, so it is exactly what this sign-in has to put beyond
    // use. Getting this backwards is the whole locked-out failure: forget the
    // key on the row and its owner has nothing left that works.
    const madeHere: string[] = [];
    const { another } = await aRegisteredMerchant({
      identity: (real) => ({ ...real, replaceMerchantKey: async () => false }),
      client: (real) => ({
        ...real,
        issueCabinetKey: async () => {
          const made = await real.issueCabinetKey();
          if (made.ok) {
            madeHere.push(made.document);
          }
          return made;
        },
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const inside = await device.signIn(FRESH.email, FRESH.password);

    expect(inside.status).toBe(200);
    expect(keyOnTheRowOf(FRESH.email)).toBe(before);
    expect(await theGatewayTakes(before)).toBe(true);
    // And the key it made and could not use is gone rather than left alive for
    // nobody.
    expect(madeHere).toHaveLength(1);
    expect(await theGatewayTakes(madeHere[0] ?? "")).toBe(false);
    // The screens really are drawn, which is the same fact from the other side:
    // the cabinet reaches the gateway with what is on the row.
    expect((await device.get("/keys")).status).toBe(200);
  });

  it("keeps the fresh key when forgetting the old one is the step that failed", async () => {
    // The third step, cut. The row names the key that was just made and it
    // works; the old one is still alive, which is one credential nobody holds
    // and nothing will come back for — the price of a call that cannot reach
    // anybody else's key, and cheaper than the lockout that price buys off.
    const { another } = await aRegisteredMerchant({
      client: (real) => ({
        ...real,
        forgetCabinetKey: async () => ({ ok: false, status: 0, why: "nothing answered" }),
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const inside = await device.signIn(FRESH.email, FRESH.password);

    expect(inside.status).toBe(200);
    const now = keyOnTheRowOf(FRESH.email);
    expect(now).not.toBe(before);
    expect(await theGatewayTakes(now)).toBe(true);
  });

  it("signs a person in with the gateway not there at all, and writes down why", async () => {
    // Nothing about signing in belongs to the gateway: the password, the
    // session and the row are all this cabinet's. A person shut out of their
    // own account because a service they never asked about is down would be
    // this replacement costing more than it buys. The line in the log is how
    // anybody finds out the key has stopped being replaced.
    const { browser } = await started({ cabinet: { GATEWAY_URL: "http://127.0.0.1:1" } });

    const posted: Visit[] = [];
    const written = await said(async () => {
      posted.push(await browser.post("/sign-in", { email: PERSON, password: PASSWORD }));
    });

    expect(posted[0]?.status).toBe(303);
    expect(keyOnTheRowOf(PERSON)).toBe(KEY);
    expect(written).toContain(PERSON);
    expect(written).toMatch(/key/i);
    // And what it says about it is never the key itself.
    expect(written).not.toContain(KEY);
  });

  /**
   * One sign-in, stopped at a step until the test lets it go.
   *
   * Two of these are what makes a race a test rather than a hope: the two
   * sign-ins below are made to interleave at exactly the moment that decides
   * whether anybody is locked out, instead of being started together and
   * watched.
   */
  interface Step {
    readonly reached: Promise<void>;
    readonly arrive: () => void;
    readonly go: Promise<void>;
    readonly release: () => void;
  }

  const aStep = (): Step => {
    let arrive: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const go = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { reached, arrive: () => arrive(), go, release: () => release() };
  };

  it("leaves a working key on the row when one sign-in runs inside another", async () => {
    // The second interleaving, and the one a conditional write alone does not
    // reach. The first sign-in wins the row and is then held between writing
    // and putting its old key beyond use. The second signs in inside that gap:
    // it reads the key the first just wrote, gets one of its own, and wins its
    // own write honestly, because by then the row does hold what it read. If
    // the first is able to reach anything but the key in its own hand, it takes
    // away the key the second has just written — and the account is left naming
    // something the gateway has forgotten, with no way back in but a terminal.
    //
    // Its own timeout, and shorter than the file's: the two sign-ins are held
    // in front of each other on purpose, so an arrangement that never lets one
    // of them go fails by waiting rather than by an assertion. The gateway is
    // in this process, so ten seconds is not a slow machine — it is a deadlock.
    const first = aStep();
    let held = false;
    const { another } = await aRegisteredMerchant({
      client: (real) => ({
        ...real,
        forgetCabinetKey: async () => {
          if (!held) {
            held = true;
            first.arrive();
            await first.go;
          }
          return await real.forgetCabinetKey();
        },
      }),
    });

    const a = await another();
    const b = await another();

    // The first device signs in and stops with the row already moved onto its
    // fresh key, holding the old one and not yet done with it.
    const signingInA = a.signIn(FRESH.email, FRESH.password);
    await first.reached;

    // The second signs in from end to end inside that gap.
    await b.signIn(FRESH.email, FRESH.password);

    first.release();
    await signingInA;

    expect(await theGatewayTakes(keyOnTheRowOf(FRESH.email))).toBe(true);
  }, 10_000);

  it("leaves a working key on the row when two sign-ins race for it", async () => {
    // Two devices, or a form posted twice. Both sign-ins read the same key off
    // the row, so both believe they are replacing it. Only one can, and the
    // other must not go on as though it had: a sign-in that wrote nothing and
    // then put the row's key beyond use would leave the account holding
    // something the gateway has forgotten. Nothing after that helps — every
    // screen answers 502, and signing in again asks for a fresh key with the
    // one being refused, so the way back in is a terminal.
    //
    // What is asserted is not who won. It is the only thing anybody is locked
    // out by: the key the row names opens the gateway's door.
    //
    // Its own timeout, and shorter than the file's, for the reason the test
    // beside it has one: the two sign-ins are held in front of each other on
    // purpose, so an arrangement that never lets one of them go fails by
    // waiting rather than by an assertion. The gateway is in this process, so
    // ten seconds is not a slow machine — it is a deadlock.
    const first = aStep();
    const second = aStep();
    let stopped = 0;
    const stopHere = async (): Promise<void> => {
      const mine = stopped === 0 ? first : second;
      stopped += 1;
      mine.arrive();
      await mine.go;
    };

    const { another } = await aRegisteredMerchant({
      identity: (real) => ({
        ...real,
        replaceMerchantKey: async (...asked: Parameters<Identity["replaceMerchantKey"]>) => {
          await stopHere();
          return await real.replaceMerchantKey(...asked);
        },
      }),
    });

    const a = await another();
    const b = await another();

    // The first device signs in, asks the gateway for a key of its own, and
    // stops in front of the row.
    const signingInA = a.signIn(FRESH.email, FRESH.password);
    await first.reached;

    // The second signs in while the row still says what the first read. It gets
    // a key of its own too, and stops in the same place.
    const signingInB = b.signIn(FRESH.email, FRESH.password);
    await second.reached;

    // The first goes through: it moves the row onto its key and puts the key it
    // arrived with beyond use.
    first.release();
    await signingInA;

    // And now the second writes.
    second.release();
    await signingInB;

    expect(await theGatewayTakes(keyOnTheRowOf(FRESH.email))).toBe(true);
  }, 10_000);

  it("does not call a key written when there was no account to write it onto", async () => {
    // What forgetting a key is allowed to happen after. The store takes a write for a
    // row it does not have and changes nothing — no throw, nothing to notice —
    // and a caller that read that as "written" would go on to forget the key
    // the row still names, taking away the only one that works. So the answer
    // is read back from what the write returned rather than from its silence.
    const { identity } = await started();

    expect(await identity.replaceMerchantKey("no-such-account", KEY, "a-key-long-enough")).toBe(
      false,
    );
  });

  it("refuses the write when the row stopped holding the key that was read off it", async () => {
    // The write and the choice of which key this sign-in has finished with are
    // one act, and this is where they are joined: the row moves from the key
    // that was read to the fresh one, or it does not move at all. Two sign-ins
    // holding the same read cannot both win, so the one that loses knows the
    // key it is done with is its own — which is the whole of what keeps it from
    // taking away the winner's.
    const { identity } = await started();
    const person = await identity.byEmail(PERSON);

    const won = await identity.replaceMerchantKey(person?.id ?? "", KEY, "the-first-fresh-key");
    const lost = await identity.replaceMerchantKey(person?.id ?? "", KEY, "the-second-fresh-key");

    expect(won).toBe(true);
    expect(lost).toBe(false);
    // And the loser really did not write: the row still holds the winner's key
    // rather than the last one that was tried.
    expect(keyOnTheRowOf(PERSON)).toBe("the-first-fresh-key");
  });

  it("lets a person in when the gateway answers something the contract refuses", async () => {
    // The third way this can go wrong, and the only one that arrives as a
    // throw: the client holds every answer to the contract's schema, so a
    // gateway answering a key document with no key in it raises rather than
    // returning a refusal. `gateway.test.ts` holds that it raises; this holds
    // that a person signing in never finds out.
    const { another } = await aRegisteredMerchant({
      client: (real) => ({
        ...real,
        issueCabinetKey: async () => {
          throw new Error("the answer was not a document this contract knows");
        },
      }),
    });
    const before = keyOnTheRowOf(FRESH.email);

    const device = await another();
    const inside = await device.signIn(FRESH.email, FRESH.password);

    expect(inside.status).toBe(200);
    expect(keyOnTheRowOf(FRESH.email)).toBe(before);
    expect(await theGatewayTakes(before)).toBe(true);
  });

  it("does not spend a screen's worth of waiting on a gateway that says nothing", async () => {
    // The worst case: the connection is accepted and then held open. A screen
    // gets ten seconds before the cabinet gives up, because somebody is looking
    // at it and would rather wait than reload. A sign-in is not that — the two
    // calls behind it are the cabinet looking after its own credential, and
    // nobody asked for them — so the wait is its own, and shorter.
    const { browser } = await started({ cabinet: { GATEWAY_URL: await silentGateway() } });

    const began = Date.now();
    const posted = await browser.post("/sign-in", { email: PERSON, password: PASSWORD });
    const took = Date.now() - began;

    expect(posted.status).toBe(303);
    expect(took).toBeLessThan(9_000);
  }, 30_000);
});
