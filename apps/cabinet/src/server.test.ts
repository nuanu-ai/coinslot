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
import type { Card } from "@coinslot/contracts";
import { buyOverHttp, type Harness, harness, type Served, serve } from "@coinslot/gateway/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Accounts, memoryAccounts } from "./accounts.js";
import { loadConfig } from "./config.js";
import { fingerprintOf, hashPassword } from "./credentials.js";
import type { Answer } from "./gateway.js";
import { buildApp } from "./server.js";

const KEY = "a-merchant-key-long-enough";
const asMerchant = { authorization: `Bearer ${KEY}` };
const PAY_TO = "0x0000000000000000000000000000000000000001";

/** The name the session cookie travels under. */
const COOKIE = "coinslot_session";

/** The person whose account every test in this file signs in as. */
const PERSON = "dmitry@example.com";
const PASSWORD = "a-password-nobody-guesses";
/**
 * Derived once for the whole file. A scrypt derivation is a tenth of a second
 * by design, and every test here makes an account; done per test it would be
 * the slowest thing in the suite for no extra promise kept.
 */
const PASSWORD_HASH = await hashPassword(PASSWORD);

/** The store a cabinet under test signs people in against, with one account. */
const withOneAccount = async (): Promise<Accounts> => {
  const accounts = memoryAccounts();
  await accounts.add(PERSON, PASSWORD_HASH, new Date());
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
  close(): Promise<void>;
}

interface Running {
  readonly harnessed: Harness;
  readonly gateway: Served;
  readonly browser: Browser;
  /** The store the cabinet under test signs people in against. */
  readonly accounts: Accounts;
  /** A second browser on the same cabinet, for two people or two devices. */
  another(): Promise<Browser>;
  /** Takes the gateway away, once. One test does this on purpose. */
  stopGateway(): Promise<void>;
}

let open: Running | null = null;

const started = async (
  options: { readonly base?: string; readonly gateway?: Record<string, string> } = {},
): Promise<Running> => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...options.gateway });
  const gateway = await serve(harnessed);
  const accounts = await withOneAccount();
  const basePath = options.base ?? "";
  const { browser, url } = await visiting(gateway.url, basePath, accounts);
  let stopped = false;

  open = {
    harnessed,
    gateway,
    browser,
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
): Promise<{ browser: Browser; url: string }> {
  const app = buildApp(
    loadConfig({
      GATEWAY_URL: gatewayUrl,
      DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
      MERCHANT_API_KEY: KEY,
      ...(basePath === "" ? {} : { BASE_PATH: basePath }),
    }),
    { accounts },
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
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
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
    close: async () => undefined,
  };

  return browser;
}

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

    for (const path of ["/", "/cards", "/orders", "/receipts", "/password", "/nowhere"]) {
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
    await expect(accounts.whose(fingerprintOf(token), new Date())).resolves.toBeNull();
    const replayed = await browser.withRawCookie(`${COOKIE}=${token}`).get("/cards");
    expect(replayed.to).toBe("/sign-in");
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
    await harnessed.store.setSelling("departed");

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
    await harnessed.store.setSelling("departed");

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
    expect(text).toContain("Bought");
    expect(text).toContain("Price true as of");
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    // And the moment the money actually moved, which is not when the purchase
    // happened and is the column a merchant matches wallet transfers against.
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
    const accounts = await withOneAccount();
    const app = buildApp(
      loadConfig({
        GATEWAY_URL: "http://127.0.0.1:1",
        DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
        MERCHANT_API_KEY: KEY,
      }),
      {
        accounts,
        gateway: {
          cards: answer,
          pauseCard: answer,
          setSelling: answer,
          orders: answer,
          receipts: answer,
        } as never,
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
    });

    expect(said).toContain(PERSON);
    expect(said).toMatch(/stopped all selling/i);
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
