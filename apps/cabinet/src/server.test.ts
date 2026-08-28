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
 * The assertions are about what a merchant can see and do — a state beside a
 * card, a control that pauses it, a purchase that is refused afterwards. They
 * are deliberately not about markup: a page that changed its class names has
 * not broken a promise to anybody.
 *
 * The one thing that is not real here is the account store: it is the in-memory
 * one, because `pnpm test` works without a database. It keeps the same promises
 * the Postgres one does, and `accounts.db-test.ts` runs the same conformance
 * suite against a real database to say so.
 */

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import type { Card, MerchantKey, MerchantKeyList, RegisteredMerchant } from "@coinslot/contracts";
import { buyOverHttp, type Harness, harness, type Served, serve } from "@coinslot/gateway/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Accounts, memoryAccounts } from "./accounts.js";
import { loadConfig } from "./config.js";
import { fingerprintOf, hashPassword, passwordMatches } from "./credentials.js";
import { type Answer, type GatewayClient, gatewayFor, type Registrar } from "./gateway.js";
import { buildApp } from "./server.js";
import { sessionFor } from "./testing/accounts-contract.js";

const KEY = "a-merchant-key-long-enough";
const asMerchant = { authorization: `Bearer ${KEY}` };
const PAY_TO = "0x0000000000000000000000000000000000000001";

/** The name the session cookie travels under. */
const COOKIE = "coinslot_session";

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
 * A session identifier shaped like one this cabinet issues, for the one test
 * that has to plant a live session rather than sign in for it.
 *
 * The shape matters: a value that is not shaped like an identifier we would
 * have issued is never looked up at all, so a made-up word would test the
 * cookie filter rather than the gate.
 */
const BEFORE_MERCHANTS = "a".repeat(43);
const PASSWORD = "a-password-nobody-guesses";
/**
 * Derived once for the whole file. A scrypt derivation is a tenth of a second
 * by design, and every test here makes an account; done per test it would be
 * the slowest thing in the suite for no extra promise kept.
 */
const PASSWORD_HASH = await hashPassword(PASSWORD);

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

/** The store a cabinet under test signs people in against, with two accounts. */
const withAccounts = async (): Promise<Accounts> => {
  const accounts = memoryAccounts();
  await accounts.add(PERSON, PASSWORD_HASH, new Date(), THE_MERCHANT);
  await accounts.add(OTHER, PASSWORD_HASH, new Date(), THE_MERCHANT);
  return accounts;
};

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
  /** The store the cabinet under test signs people in against. */
  readonly accounts: Accounts;
  /** A second browser on the same cabinet, for two people or two devices. */
  another(): Promise<Browser>;
  /** Takes the gateway away, once. One test does this on purpose. */
  stopGateway(): Promise<void>;
}

let open: Running | null = null;

const started = async (
  options: {
    readonly base?: string;
    readonly gateway?: Record<string, string>;
    readonly cabinet?: Record<string, string>;
    /**
     * How the route that makes a merchant answers.
     *
     * Stubbed rather than real, and this is the one seam in this file that is
     * not: the gateway route behind it is being added on another branch, so
     * what these tests hold is the cabinet's half — what it does with an answer
     * of each shape. What it makes of a successful one is checked against the
     * real gateway anyway, because the key such an answer carries is the key
     * the harness seeded, so the screens that follow the redirect are drawn
     * from real documents.
     */
    readonly registrar?: Registrar;
    /**
     * The real client, with some of its calls answered by the test instead.
     *
     * A decorator rather than a replacement, so that everything a test is not
     * about still goes to the real gateway. The three key routes are what this
     * is for: they are being added on another branch, so the cabinet's half of
     * them is what can be held here, while the sign-in and the screens either
     * side of the one under test stay real.
     */
    readonly client?: (real: GatewayClient) => GatewayClient;
  } = {},
): Promise<Running> => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...options.gateway });
  const gateway = await serve(harnessed);
  const accounts = await withAccounts();
  const basePath = options.base ?? "";
  const { browser, url } = await visiting(
    gateway.url,
    basePath,
    accounts,
    options.cabinet,
    options.registrar,
    options.client,
  );
  let stopped = false;

  open = {
    harnessed,
    gateway,
    browser,
    url,
    accounts,
    another: async () => await attachedTo(url, basePath),
    async stopGateway() {
      if (stopped) {
        return;
      }
      stopped = true;
      await gateway.close();
      await harnessed.stop();
    },
  };
  return open;
};

afterEach(async () => {
  await open?.browser.close();
  await open?.accounts.close();
  await open?.stopGateway();
  open = null;
});

/** The cabinet on a port, and a cookie jar of one. */
async function visiting(
  gatewayUrl: string,
  basePath: string,
  accounts: Accounts,
  environment: Record<string, string> = {},
  registrar?: Registrar,
  client?: (real: GatewayClient) => GatewayClient,
): Promise<{ browser: Browser; url: string }> {
  // No merchant key in the environment, which is the point: the cabinet builds
  // its client from the key on the row of whoever is signed in, so what these
  // tests drive is the real client against the real gateway with the key the
  // harness seeded (ADR-0014 §2).
  const app = buildApp(
    loadConfig({
      GATEWAY_URL: gatewayUrl,
      DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
      ...(basePath === "" ? {} : { BASE_PATH: basePath }),
      ...environment,
    }),
    {
      accounts,
      ...(registrar === undefined ? {} : { registrar }),
      ...(client === undefined
        ? {}
        : { gatewayFor: (key: string) => client(gatewayFor(gatewayUrl, key)) }),
    },
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const url = `http://127.0.0.1:${port}`;
  const browser = await attachedTo(url, basePath);
  return {
    url,
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

/**
 * A store that keeps a note of what the cabinet asked it about sessions.
 *
 * The cabinet under test is built on this store rather than beside it, so what
 * a test reads is the cabinet's own behaviour and not the test's arithmetic.
 * Each entry is one question, and what is in it is the identifiers that
 * question carried.
 */
const counting = (accounts: Accounts): { asked: (readonly string[])[]; cabinet: Accounts } => {
  const asked: (readonly string[])[] = [];
  return {
    asked,
    cabinet: {
      ...accounts,
      whose: (fingerprints, now) => {
        asked.push(fingerprints);
        return accounts.whose(fingerprints, now);
      },
    },
  };
};

/**
 * The page's text with the tags taken out, so a test reads what a person does.
 *
 * The entities are decoded after the tags are stripped, and the ampersand last
 * of all: decoded first, a page carrying the literal text `&lt;` would come out
 * as a bracket and this would report markup where there is none.
 */
const readable = (html: string): string =>
  html
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();

const publish = async (gateway: Served, card: Card): Promise<string> => {
  const answered = await gateway.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: { authorization: `Bearer ${KEY}` },
  });
  expect(answered.status).toBe(200);
  return (answered.body as { ok: { id: string } }).ok.id;
};

/** Whether an agent could buy this product right now. */
const purchasable = async (gateway: Served, itemId: string): Promise<boolean> =>
  (await gateway.call("POST", `/v0/items/${itemId}/purchase`, { body: { params: {} } })).status ===
  402;

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
    const { browser, gateway, harnessed, accounts, another } = await started();
    const theirs = await harnessed.addMerchant("The other merchant");
    await publish(gateway, roomCard);
    await gateway.call("POST", "/v0/catalog/publish", {
      body: { ...esimCard, title: "A plan the other merchant sells" },
      headers: { authorization: `Bearer ${theirs.key}` },
    });
    await accounts.add("theirs@example.com", PASSWORD_HASH, new Date(), {
      id: theirs.id,
      key: theirs.key,
    });

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
    const { browser, accounts } = await started();
    await accounts.add("older@example.com", PASSWORD_HASH, new Date(), null);

    const refused = await browser.post("/sign-in", {
      email: "older@example.com",
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
    const { browser, accounts } = await started();
    await accounts.add("older@example.com", PASSWORD_HASH, new Date(), null);
    const person = await accounts.byEmail("older@example.com");
    const at = new Date();
    await accounts.open(
      fingerprintOf(BEFORE_MERCHANTS),
      person?.id ?? "",
      at,
      new Date(+at + 12 * 60 * 60 * 1_000),
    );

    const answered = await browser.withRawCookie(`${COOKIE}=${BEFORE_MERCHANTS}`).get("/cards");

    expect(answered.status).toBe(403);
    expect(readable(answered.html)).toContain("account add");
    // And the session goes, which is the half that keeps this from being a
    // trap. Left alive it stands in front of both doors out: this gate answers
    // every address, and both the sign-in and the registration send a visitor
    // who has a session back to their cards — which land here again.
    await expect(
      sessionFor(accounts, fingerprintOf(BEFORE_MERCHANTS), new Date()),
    ).resolves.toBeNull();
    const after = browser.withRawCookie(`${COOKIE}=${BEFORE_MERCHANTS}`);
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
    await overHttps.accounts.close();
    await overHttps.stopGateway();

    const overHttp = await started();
    const plain = await overHttp.browser.post("/sign-in", { email: PERSON, password: PASSWORD });

    expect(plain.headers.getSetCookie().join(" ")).not.toMatch(/;\s*Secure/i);
  });

  it("gives a session twelve hours and not a day, an hour or a year", async () => {
    // ADR-0009 §6. The store honours whatever it is handed and the contract
    // suite says so; this is the only place the number itself is written down,
    // and a typo in it is a session that lasts a year.
    const { browser, accounts } = await started();
    const signedIn = await browser.post("/sign-in", { email: PERSON, password: PASSWORD });
    const at = Date.now();
    const held = fingerprintOf(browser.sessionToken() ?? "");
    const twelveHours = 12 * 60 * 60 * 1_000;

    // What the browser is told to keep the cookie for.
    const maxAge = /Max-Age=(\d+)/i.exec(signedIn.headers.getSetCookie().join(" "))?.[1];
    expect(Number(maxAge)).toBe(twelveHours / 1_000);

    // And what the store will answer, which is the one that decides. A minute
    // of slack on each side, because the session opened a moment before `at`.
    await expect(
      sessionFor(accounts, held, new Date(at + twelveHours - 60_000)),
    ).resolves.not.toBeNull();
    await expect(
      sessionFor(accounts, held, new Date(at + twelveHours + 60_000)),
    ).resolves.toBeNull();
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
    // And it says there is no page here that fixes it, which is true: rotating
    // the key a cabinet holds is named in ADR-0014 §5 as not built.
    expect(readable(after.html)).toMatch(/no page in this cabinet/i);
  });

  it("clears the old cookie that used to hold a live merchant key", async () => {
    // Everybody who ever signed into the previous cabinet has one of these in
    // their browser, and it is a working API key. Nothing reads it any more, so
    // leaving it would merely be untidy — except that what it holds is the
    // credential this whole decision exists to get out of browsers.
    const { browser } = await started();

    const gate = await browser.get("/sign-in");

    expect(gate.headers.getSetCookie().join(" ")).toContain("coinslot_key=;");
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
    const { browser, gateway, accounts } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    const token = browser.sessionToken() ?? "";

    await browser.post("/sign-out");

    expect((await browser.get("/cards")).to).toBe("/sign-in");
    // The row is gone, and replaying the exact cookie gets nowhere.
    await expect(sessionFor(accounts, fingerprintOf(token), new Date())).resolves.toBeNull();
    const replayed = await browser.withRawCookie(`${COOKIE}=${token}`).get("/cards");
    expect(replayed.to).toBe("/sign-in");
  });

  it("signs a merchant out even when another cookie of this name arrives first", async () => {
    // A browser sends cookies of one name longest-path first and, among equal
    // paths, oldest first, so the merchant's own is not necessarily the one
    // this handler sees first. Ending only the first identifier the request
    // carried would leave the session alive behind a sign-out that said it had
    // worked — the exact case a shared machine is signed out of.
    const { browser, gateway, accounts } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    const token = browser.sessionToken() ?? "";
    // Shaped like one of ours, so it is looked up rather than skipped, and
    // belonging to nobody.
    const planted = "b".repeat(43);

    const out = await browser
      .withRawCookie(`${COOKIE}=${planted}; ${COOKIE}=${token}`)
      .post("/sign-out");

    expect(out.to).toBe("/sign-in");
    await expect(sessionFor(accounts, fingerprintOf(token), new Date())).resolves.toBeNull();
    expect((await browser.withRawCookie(`${COOKIE}=${token}`).get("/cards")).to).toBe("/sign-in");
  });

  it("hangs every link and form off the path it is mounted at", async () => {
    // ADR-0005 §1 puts the cabinet at /cabinet behind one origin. A page that
    // linked to /cards from /cabinet/cards would send the merchant somewhere
    // that answers nothing.
    const { browser, gateway } = await started({ base: "/cabinet" });
    await publish(gateway, roomCard);

    const page = await browser.signIn();

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

  it("serves one stylesheet whose two themes define the same tokens", async () => {
    // ADR-0005 §6: one visual language in tokens rather than repeated per page.
    //
    // The property that matters is not that a dark block exists — an empty one
    // would satisfy that — but that no colour is defined *only* inside it. A
    // token declared in the media query and nowhere else is a colour that has
    // no value at all in the light theme, and the page renders with whatever
    // the browser falls back to. So the two blocks are read out and compared.
    const { browser } = await started();

    const sheet = await browser.get("/coinslot.css");
    const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(
      sheet.html,
    );
    const light = /:root\s*\{([^}]*)\}/.exec(sheet.html);
    const tokensIn = (block: string | undefined): string[] =>
      [...(block ?? "").matchAll(/(--[a-z-]+)\s*:/g)].map((found) => found[1] ?? "").sort();

    expect(sheet.headers.get("content-type")).toContain("text/css");
    expect(dark?.[1], "no dark block").toBeTruthy();

    const painted = tokensIn(dark?.[1]);
    expect(painted.length).toBeGreaterThan(5);
    // Every token the dark theme paints is painted by the light theme too.
    expect(tokensIn(light?.[1])).toEqual(expect.arrayContaining(painted));
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
    name: "A merchant with a name",
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
  ): Registrar & { asked: { name: string; invitation: string }[] } => {
    const asked: { name: string; invitation: string }[] = [];
    return {
      asked,
      register: async (name, invitation) => {
        asked.push({ name, invitation });
        return answer;
      },
    };
  };

  const madeAMerchant = (): Answer<RegisteredMerchant> => ({
    ok: true,
    document: {
      merchant_id: "mer_the_merchant",
      name: FORM.name,
      key: {
        id: "key_the_first_one",
        label: "the first key",
        created_at: "2026-08-28T09:00:00.000Z",
        disabled_at: null,
      },
      secret: KEY,
    },
  });

  /** The gateway refusing, which is a wrong invitation and a closed door alike. */
  const refused = (why: string): Answer<RegisteredMerchant> => ({ ok: false, status: 403, why });

  it("makes a merchant, writes the account and signs the person in where they stand", async () => {
    // ADR-0014 §1: one form, one act, and what comes back is a session. A
    // registration that ended at the sign-in page would be a password typed
    // twice for no reason.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser, gateway, accounts } = await started({ registrar });
    await publish(gateway, roomCard);

    const registered = await browser.post("/register", FORM);

    expect(registered.status).toBe(303);
    expect(registered.to).toBe("/cards");
    expect(registrar.asked).toStrictEqual([{ name: FORM.name, invitation: FORM.invitation }]);
    // The account is there, pointed at the merchant the gateway made, and the
    // password typed into the form is the one that works.
    const made = await accounts.byEmail(FORM.email);
    expect(made?.merchant).toStrictEqual({ id: "mer_the_merchant", key: KEY });
    await expect(passwordMatches(FORM.password, made?.passwordHash ?? "")).resolves.toBe(true);
    // And they are signed in already: the next page is a real screen drawn from
    // the real gateway, not another form.
    expect(browser.sessionToken()).not.toBeNull();
    const cards = await browser.get("/cards");
    expect(cards.status).toBe(200);
    expect(readable(cards.html)).toContain(FORM.email);
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
    await wrong.accounts.close();
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
    // The sign-in next door derives against a decoy so that its timing does not
    // say who has an account here. A registration that answered "that address is
    // taken" in its own words would be the same question answered outright, so
    // the refusal is the one the invitation gets and nothing else.
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
    const { browser, accounts } = await started({ registrar });
    accounts.add = async () => {
      throw new Error("the cabinet's account was not answered by the database");
    };

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
    await expect(accounts.byEmail(FORM.email)).resolves.toBeNull();
  });

  it("refuses a form with a field missing, and asks the gateway for nothing", async () => {
    // Every one of the four is required, and a merchant is not made for a form
    // that was never going to produce an account. Litter that can be avoided by
    // reading the form is litter nobody has to argue about afterwards.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser, accounts } = await started({ registrar });

    for (const missing of ["email", "password", "name", "invitation"] as const) {
      const { [missing]: _absent, ...rest } = FORM;
      const answered = await browser.post("/register", rest);
      expect(answered.status, missing).toBe(400);
      expect(readable(answered.html), missing).toMatch(/every|all four|each/i);
      expect(answered.headers.getSetCookie(), missing).toStrictEqual([]);
    }
    expect(registrar.asked).toStrictEqual([]);
    await expect(accounts.byEmail(FORM.email)).resolves.toBeNull();
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

  it("says on the page that nobody has confirmed the address", async () => {
    // ADR-0014 §4. Nothing is sent anywhere, so a merchant who registers has
    // shown they hold an invitation and not that they hold the address they
    // typed. Every screen that shows the address says so, and this is the first
    // of them.
    const { browser } = await started({ registrar: registrarAnswering(madeAMerchant()) });

    const form = readable((await browser.get("/register")).html);

    expect(form).toMatch(/not confirmed|nobody confirms|no.*sent to it/i);
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
    const { browser, accounts } = await started({ registrar });
    await browser.signIn();

    const form = await browser.get("/register");
    const posted = await browser.post("/register", FORM);

    expect(form.status).toBe(303);
    expect(form.to).toBe("/cards");
    expect(posted.status).toBe(303);
    expect(posted.to).toBe("/cards");
    expect(registrar.asked).toStrictEqual([]);
    await expect(accounts.byEmail(FORM.email)).resolves.toBeNull();
  });

  it("refuses a name the catalogue that lists it would not carry, and says the rule", async () => {
    // The name goes into a discovery catalogue whose rule is 32 characters of
    // ordinary keyboard characters. A name outside it is refused by the gateway
    // with a 400, which this screen would have to guess at; refused here, the
    // person is told the rule and no merchant is made for an attempt that was
    // never going to succeed.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser } = await started({ registrar });

    for (const name of ["x".repeat(33), "Кириллица", "a name with a  bell in it", "", "   "]) {
      const answered = await browser.post("/register", { ...FORM, name });
      expect(answered.status, name).toBe(400);
      expect(readable(answered.html), name).toMatch(/32 characters|four is needed/);
    }
    expect(registrar.asked).toStrictEqual([]);
  });

  it("takes the space off a name rather than refusing it for one", async () => {
    // A space at the front of a form field is a typing accident, and the rule
    // that refuses it exists because a padded name survives the catalogue
    // untouched and makes two spellings of one word. Trimming it satisfies the
    // rule and gives the person the name they meant; refusing it would be this
    // form being pedantic about something it can simply fix.
    const registrar = registrarAnswering(madeAMerchant());
    const { browser } = await started({ registrar });

    const made = await browser.post("/register", { ...FORM, name: "  A merchant with a name  " });

    expect(made.status).toBe(303);
    expect(registrar.asked).toStrictEqual([
      { name: "A merchant with a name", invitation: FORM.invitation },
    ]);
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
      await running.accounts.close();
      await running.stopGateway();
    }
  });
});

describe("the cards screen", () => {
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
    expect((await gateway.call("GET", "/v0/catalog")).body).toMatchObject({
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
  const THIS_CALL: MerchantKey = {
    id: "key_the_cabinet_is_using",
    label: "the cabinet",
    created_at: "2026-08-20T09:00:00.000Z",
    disabled_at: null,
  };
  const ANOTHER: MerchantKey = {
    id: "key_the_workers_use",
    label: "the worker on the small box",
    created_at: "2026-08-24T11:30:00.000Z",
    disabled_at: null,
  };
  const REVOKED: MerchantKey = {
    id: "key_the_laptop_had",
    label: "the laptop that went missing",
    created_at: "2026-07-01T08:00:00.000Z",
    disabled_at: "2026-08-26T17:45:00.000Z",
  };
  const SECRET = "the-secret-shown-once-and-never-again";

  /** The three key routes answered by the test, the rest by the real gateway. */
  const withKeys = (
    listed: readonly MerchantKey[] = [THIS_CALL, ANOTHER, REVOKED],
  ): {
    readonly disabled: string[];
    readonly issued: string[];
    readonly client: (real: GatewayClient) => GatewayClient;
  } => {
    const disabled: string[] = [];
    const issued: string[] = [];
    const keys: MerchantKeyList = { keys: [...listed], this_call: THIS_CALL.id };
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
              key: { id: "key_the_new_one", label, created_at: NOW, disabled_at: null },
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

    expect(text).toContain("the cabinet");
    expect(text).toContain("the worker on the small box");
    expect(text).toContain("the laptop that went missing");
    expect(text).toMatch(/revoked/i);
    expect(text).toContain("2026-08-26");
  });

  it("does not offer to disable the key this cabinet is holding", async () => {
    // ADR-0014 §5: the gateway refuses that call, and one click would otherwise
    // stand between a merchant and a cabinet that answers every page with "the
    // gateway will not take this key" — with the way back through a terminal
    // they do not have. So the control is not there to press, and the row says
    // why rather than leaving a blank.
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;

    expect(page).not.toContain(`/keys/${THIS_CALL.id}/disable`);
    expect(page).toContain(`/keys/${ANOTHER.id}/disable`);
    expect(readable(page)).toMatch(/this cabinet is using/i);
  });

  it("offers no control at all against a key that is already revoked", async () => {
    const { browser } = await started({ client: withKeys().client });
    await browser.signIn();

    const page = (await browser.get("/keys")).html;

    expect(page).not.toContain(`/keys/${REVOKED.id}/disable`);
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
    // The route holds the rule about the cabinet's own key, and the screen not
    // offering the control is a courtesy rather than the guard. A merchant who
    // reaches the address anyway is told what the gateway answered rather than
    // being shown a page that says nothing happened.
    const { browser } = await started({
      client: (real) => ({
        ...real,
        keys: async () => ({
          ok: true,
          document: { keys: [THIS_CALL], this_call: THIS_CALL.id },
        }),
        disableKey: async () => ({
          ok: false,
          status: 409,
          why: "a merchant cannot disable the key their cabinet is holding",
        }),
      }),
    });
    await browser.signIn();

    const refused = await browser.post(`/keys/${THIS_CALL.id}/disable`);

    expect(refused.status).toBe(409);
    expect(readable(refused.html)).toContain("cannot disable the key their cabinet is holding");
  });
});

describe("what every screen says about the address", () => {
  it("says the address on it is not confirmed by anybody", async () => {
    // ADR-0014 §4. Nothing is sent anywhere and nobody has shown they hold the
    // address they typed, so a merchant reading their own address in the corner
    // of every page must not build on it — a password lost is answered by
    // asking us, not by a link in their mail.
    const { browser, gateway } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();

    for (const path of ["/cards", "/orders", "/receipts", "/password"]) {
      const text = readable((await browser.get(path)).html);
      expect(text, path).toContain(PERSON);
      expect(text, path).toMatch(/not confirmed/i);
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
    const accounts = await withAccounts();
    const app = buildApp(
      loadConfig({
        GATEWAY_URL: "http://127.0.0.1:1",
        DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
      }),
      {
        accounts,
        gatewayFor: () =>
          ({
            cards: answer,
            pauseCard: answer,
            setSelling: answer,
            orders: answer,
            receipts: answer,
          }) as never,
      },
    );
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      browser: await attachedTo(`http://127.0.0.1:${port}`, ""),
      close: async () => {
        await accounts.close();
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

  it("asks the store nothing about a cookie that is not shaped like a session", async () => {
    // A browser carrying a pile of junk under this name must be a pile of
    // strings and not a pile of queries. There is no cap on how many are
    // considered — a cap is a way to push the merchant's own cookie out of
    // sight and lock them out — so the shape is what does the work, and it
    // costs nothing.
    //
    // Both halves of the shape, because a value of the right length with a
    // character we never write is exactly what somebody planting cookies would
    // reach for once the length alone stopped working.
    const { browser, accounts } = await started();
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    const { asked, cabinet } = counting(accounts);
    const own = await visiting("http://127.0.0.1:1", "", cabinet);
    try {
      const junk = [
        // Too short, and too long, and the right length spelled wrong.
        ...Array.from({ length: 20 }, (_, at) => `planted-${at}`),
        ...Array.from({ length: 20 }, (_, at) => `${"A".repeat(43)}${at}`),
        "!".repeat(43),
        `${"A".repeat(42)}+`,
        `${"A".repeat(42)}/`,
        `${"A".repeat(42)}=`,
        `${"A".repeat(42)}.`,
      ].map((value) => `${COOKIE}=${value}`);
      await own.browser.withRawCookie(`${junk.join("; ")}; ${COOKIE}=${mine}`).get("/cards");

      // The merchant's own identifier and nothing else reached the store.
      expect(asked.flat()).toStrictEqual([fingerprintOf(mine)]);
    } finally {
      await own.browser.close();
    }
  });

  it("asks about every identifier a request carried, in one question and with no cap", async () => {
    // Two promises at once, and the second is why this is written over a socket
    // rather than through `fetch`.
    //
    // The first: however many identifiers arrive, they are one question to the
    // database. Asked one at a time this was that many sequential round trips
    // on a route a stranger can reach, and ten such requests occupy a pool of
    // ten connections where ten ordinary requests occupy ten.
    //
    // The second: there is no cap on how many are considered. A cap is a way
    // in, because a browser sends cookies of one name longest-path first and
    // then oldest first, so somebody able to plant cookies could push the
    // merchant's own past it and lock them out of the control that stops their
    // selling. A cap anywhere below what a request can actually carry would
    // pass a test built to a smaller number, so this one is built to the
    // runtime's own ceiling: Node stops reading a request's headers at 16 KB,
    // one cookie of this name and shape is 60 bytes and the separator adds two,
    // and a request carrying nothing else buys 263 of them. `fetch` sends
    // headers of its own and buys 262, which is why the request here is written
    // onto the socket by hand.
    const { browser, accounts, gateway } = await started();
    await browser.signIn();
    const mine = browser.sessionToken() ?? "";
    const { asked, cabinet } = counting(accounts);
    const own = await visiting(gateway.url, "", cabinet);
    const carrying = (count: number): string =>
      [...Array.from({ length: count - 1 }, (_, at) => `${`${at}`.padStart(43, "a")}`), mine]
        .map((value) => `${COOKIE}=${value}`)
        .join("; ");
    try {
      const most = await overASocket(own.url, "/cards", carrying(263));

      // The merchant is still the person asking, with 262 planted cookies in
      // front of their own, and it cost one question.
      expect(most.status).toBe(200);
      expect(most.body).toContain(PERSON);
      expect(asked.length).toBe(1);
      expect(asked[0]?.length).toBe(263);

      // And one more than that is not the cabinet's problem: the runtime
      // refuses to read the headers at all, so nothing here ever sees it.
      const tooMany = await overASocket(own.url, "/cards", carrying(264));

      expect(tooMany.status).toBe(431);
      expect(asked.length).toBe(1);
    } finally {
      await own.browser.close();
    }
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
    const { browser, another } = await started();
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
    const { browser, gateway, accounts } = await started();
    const itemId = await publish(gateway, roomCard);
    await browser.signIn();
    expect((await browser.get("/cards")).status).toBe(200);

    await accounts.endEveryFor(PERSON);

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
    const { browser, gateway, another, accounts } = await started();
    await publish(gateway, roomCard);
    await browser.signIn();
    const telephone = await another();
    await telephone.signIn();

    await accounts.end(fingerprintOf(browser.sessionToken() ?? ""));

    expect((await browser.get("/cards")).to).toBe("/sign-in");
    expect((await telephone.get("/cards")).status).toBe(200);
  });

  it("refuses a session whose time is up, without anybody ending it", async () => {
    // Twelve hours from the moment it opens, never extended (ADR-0009 §6). The
    // row is written by the cabinet, so this is the cabinet's own clock being
    // read rather than a test's idea of one: the session is opened directly
    // with a moment in the past and the browser is handed its identifier.
    const { browser, accounts } = await started();
    const person = await accounts.byEmail(PERSON);
    const long_ago = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    await accounts.open(
      fingerprintOf("a-stale-identifier"),
      person?.id ?? "",
      long_ago,
      new Date(+long_ago + 12 * 60 * 60 * 1_000),
    );

    const answered = await browser.withRawCookie(`${COOKIE}=a-stale-identifier`).get("/cards");

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
    expect(said).not.toContain(PASSWORD_HASH);
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
