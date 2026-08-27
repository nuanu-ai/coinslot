/**
 * The cabinet's own HTTP surface: three screens, a sign-in, and the four
 * switches that stop and start selling.
 *
 * It is server-rendered with no client framework and no build step, which is
 * ADR-0005 §4. Every page is one GET and every change is one form post
 * followed by a redirect, so the browser's back button, its reload and its
 * find-in-page all work without anything being written to make them.
 *
 * Nothing here decides anything about a card, an order or the money. Each
 * handler is a translation between one request and one or two calls on the
 * gateway's public API, and the pages are drawn from what those calls answered
 * (ADR-0005 §3). A screen that cannot be drawn is API the merchant does not
 * have either — which is the whole point of the cabinet holding no database.
 */

import { readFileSync } from "node:fs";
import express, { type Express, type Request, type Response } from "express";
import type { CabinetConfig } from "./config.js";
import { type Answer, type GatewayClient, gatewayFor } from "./gateway.js";
import { bare, escaped } from "./html.js";
import { cardsScreen, ordersScreen, receiptsScreen } from "./screens.js";
import { signInScreen } from "./sign-in.js";

/** The name the session cookie travels under. */
const SESSION = "coinslot_key";

/**
 * How long a merchant stays signed in.
 *
 * A working day and a bit, so a merchant who signed in at nine is still signed
 * in at six and one who left a browser open over a weekend is not. It is a
 * number in one place rather than a constant beside the cookie, and it is here
 * rather than in the configuration because nothing about a deployment changes
 * what it should be.
 */
const SESSION_HOURS = 12;

/** The stylesheet, read once at startup: it never changes while we run. */
const STYLESHEET = readFileSync(new URL("./coinslot.css", import.meta.url), "utf8");

/**
 * The whole cabinet on an express app.
 *
 * `connect` is a parameter with the real client as its default so that a test
 * can drive the pages without a gateway on a socket. Nothing but a test ever
 * passes anything else, and what a deployment runs is the client that speaks
 * the contract's route table.
 */
export function buildApp(
  config: CabinetConfig,
  connect: (key: string) => GatewayClient = (key) => gatewayFor(config.gatewayUrl, key),
): Express {
  const app = express();
  const base = config.basePath;

  app.disable("x-powered-by");
  // No `trust proxy` here on purpose: nothing in the cabinet reads the client's
  // address or whether the connection was secure, so trusting a forwarding
  // header would make a spoofable header authoritative for no benefit at all.
  // The forms are the only thing a browser posts here, and they are small.
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(sameOrigin);

  // Under one origin the cabinet is reached at BASE_PATH, so that is where a
  // probe looks; at the bare root it is what a container health check asks for.
  // Both, because a probe answering 404 reads as a dead process.
  for (const path of new Set(["/healthz", `${base}/healthz`])) {
    app.get(path, (_request, response) => {
      response.json({ ok: true });
    });
  }

  app.get(`${base}/coinslot.css`, (_request, response) => {
    response.type("text/css").send(STYLESHEET);
  });

  app.get(`${base}/`, (request, response) => {
    response.redirect(303, keyIn(request) === null ? `${base}/sign-in` : `${base}/cards`);
  });

  app.get(`${base}/sign-in`, (request, response) => {
    if (keyIn(request) !== null) {
      response.redirect(303, `${base}/cards`);
      return;
    }
    response.type("html").send(signInScreen(base));
  });

  app.post(`${base}/sign-in`, async (request, response) => {
    const key = String((request.body as { key?: unknown })?.key ?? "");
    if (key === "") {
      response.status(400).type("html").send(signInScreen(base, "Enter your merchant key."));
      return;
    }

    // The key is tried against the API before it is kept. A cabinet that
    // accepted anything typed into the box would sign a merchant in and then
    // show them three screens of nothing, which reads as "you have no cards".
    const tried = await connect(key).cards();
    if (!tried.ok) {
      response
        .status(tried.status === 401 ? 401 : 502)
        .type("html")
        .send(
          signInScreen(
            base,
            tried.status === 401
              ? "That key was not accepted. It is the key your gateway is configured with."
              : `The gateway did not answer: ${tried.why}`,
          ),
        );
      return;
    }

    response.cookie(SESSION, key, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      path: base === "" ? "/" : base,
      maxAge: SESSION_HOURS * 60 * 60 * 1_000,
    });
    response.redirect(303, `${base}/cards`);
  });

  app.post(`${base}/sign-out`, (_request, response) => {
    response.clearCookie(SESSION, { path: base === "" ? "/" : base });
    response.redirect(303, `${base}/sign-in`);
  });

  app.get(`${base}/cards`, (request, response) =>
    signedIn(request, response, base, connect, async (gateway) => {
      const cards = await gateway.cards();
      if (!cards.ok) {
        return trouble(response, base, cards);
      }
      response.type("html").send(cardsScreen(base, cards.document));
    }),
  );

  app.get(`${base}/orders`, (request, response) =>
    signedIn(request, response, base, connect, async (gateway) => {
      // Only the exact word narrows the list, which is what the contract says
      // and what a merchant reconciling their books relies on.
      const open = request.query.open === "true";
      const [cards, orders] = await Promise.all([gateway.cards(), gateway.orders(open)]);
      if (!cards.ok) {
        return trouble(response, base, cards);
      }
      if (!orders.ok) {
        return trouble(response, base, orders);
      }
      response.type("html").send(ordersScreen(base, cards.document, orders.document, open));
    }),
  );

  app.get(`${base}/receipts`, (request, response) =>
    signedIn(request, response, base, connect, async (gateway) => {
      const [cards, receipts] = await Promise.all([gateway.cards(), gateway.receipts()]);
      if (!cards.ok) {
        return trouble(response, base, cards);
      }
      if (!receipts.ok) {
        return trouble(response, base, receipts);
      }
      response.type("html").send(receiptsScreen(base, cards.document, receipts.document));
    }),
  );

  for (const [verb, paused] of [
    ["pause", true],
    ["resume", false],
  ] as const) {
    app.post(`${base}/cards/:item_id/${verb}`, (request, response) =>
      signedIn(request, response, base, connect, async (gateway) => {
        const switched = await gateway.pauseCard(request.params.item_id ?? "", paused);
        if (!switched.ok) {
          return trouble(response, base, switched);
        }
        // Back to the list rather than answering the post with a page: a
        // merchant who then reloads must not press the switch again.
        response.redirect(303, `${base}/cards`);
      }),
    );

    app.post(`${base}/selling/${verb}`, (request, response) =>
      signedIn(request, response, base, connect, async (gateway) => {
        const switched = await gateway.setSelling(!paused);
        if (!switched.ok) {
          return trouble(response, base, switched);
        }
        response.redirect(303, `${base}/cards`);
      }),
    );
  }

  app.use((_request, response) => {
    response.status(404).type("html").send(problemPage(base, "There is no such page."));
  });

  app.use(
    (thrown: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
      if (response.headersSent) {
        next(thrown);
        return;
      }
      // A defect. The merchant is told that something here is broken and
      // nothing about what: an error text assembled out of an exception makes
      // claims about our internals to somebody who cannot act on them.
      // What is not said here: whether anything was changed. A call that
      // reached the gateway, did what it was asked and then answered in a shape
      // the contract does not recognise lands in this handler, and the change
      // has already happened — so "nothing was changed" would be a claim this
      // handler has no way to check, made to somebody about their own catalog.
      console.error("[cabinet] a request failed", thrown);
      response
        .status(500)
        .type("html")
        .send(
          problemPage(
            base,
            "Something in the cabinet is broken. Check the page you were on before deciding whether it went through.",
          ),
        );
    },
  );

  return app;
}

/**
 * Turns away a form post that came from somewhere else.
 *
 * The session cookie is a live API key and the forms it authorises include
 * "stop all selling", so a page on another site must not be able to make a
 * merchant's browser submit one. SameSite=Strict on the cookie is the first
 * answer and the main one; this is the second, and it exists because SameSite
 * is scoped to the registrable domain rather than to the origin — the day
 * anything at all is served from a sibling subdomain, that page is "same site"
 * and can forge every switch here.
 *
 * A missing Origin is allowed through. Browsers send it on every cross-origin
 * form post, which is the case being refused; what they historically omit it
 * on is same-origin navigation, and refusing an absent header would turn away
 * the merchant's own browser and every command-line client along with it. This
 * is a cheap second lock, not the lock.
 */
function sameOrigin(request: Request, response: Response, next: () => void): void {
  const origin = request.headers.origin;
  if (request.method !== "POST" || origin === undefined) {
    next();
    return;
  }

  const asked = request.headers.host;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    host = "";
  }

  if (asked !== undefined && host === asked) {
    next();
    return;
  }
  // Nothing about which origin would have worked: that is an answer to
  // somebody who is guessing, and this refusal is only ever seen by them.
  response
    .status(403)
    .type("html")
    .send(problemPage("", "This form did not come from the cabinet."));
}

/**
 * Runs `draw` with a client bound to this merchant's key, or sends them to
 * sign in.
 *
 * A key that the gateway turns away lands here as a 401 from whichever call
 * was made, and the merchant is sent back to the sign-in with the cookie
 * cleared — a key that was revoked while a tab was open would otherwise leave
 * them clicking a cabinet that answers nothing.
 */
async function signedIn(
  request: Request,
  response: Response,
  base: string,
  connect: (key: string) => GatewayClient,
  draw: (gateway: GatewayClient) => Promise<void>,
): Promise<void> {
  const key = keyIn(request);
  if (key === null) {
    response.redirect(303, `${base}/sign-in`);
    return;
  }
  await draw(connect(key));
}

/** What a merchant is shown when the gateway would not answer. */
function trouble(response: Response, base: string, answer: Answer<unknown>): void {
  if (answer.ok) {
    return;
  }
  if (answer.status === 401) {
    response.clearCookie(SESSION, { path: base === "" ? "/" : base });
    response.redirect(303, `${base}/sign-in`);
    return;
  }
  // The gateway's own sentence, not one invented here, and nothing is claimed
  // about what did or did not happen beyond what it said.
  response
    .status(502)
    .type("html")
    .send(problemPage(base, `The gateway did not answer: ${answer.why}`));
}

function problemPage(base: string, said: string): string {
  return bare(
    base,
    "Something went wrong",
    `<div class="gate"><form method="get" action="${escaped(base)}/cards">
<h1>Coinslot</h1>
<p>${escaped(said)}</p>
<button type="submit">Try again</button>
</form></div>`,
  );
}

/**
 * The merchant's key out of the session cookie, or null.
 *
 * The cookie header is parsed here rather than by a middleware, because one
 * cookie read in one place is smaller than a dependency and this is the only
 * cookie the cabinet has.
 */
function keyIn(request: Request): string | null {
  const header = request.headers.cookie;
  if (header === undefined) {
    return null;
  }
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at === -1) {
      continue;
    }
    if (pair.slice(0, at).trim() !== SESSION) {
      continue;
    }
    // A cookie value that is not valid percent-encoding throws here, and an
    // unreadable cookie is "not signed in" rather than a broken cabinet. Left
    // to throw, it reached the error page — whose only control leads to a page
    // that throws again, with the cookie HttpOnly and no way for a merchant to
    // clear it from the page they are stuck on.
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      return null;
    }
    return value === "" ? null : value;
  }
  return null;
}
