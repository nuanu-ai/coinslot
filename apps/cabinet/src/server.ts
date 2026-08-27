/**
 * The cabinet's own HTTP surface: three screens, a sign-in, a password, and the
 * four switches that stop and start selling.
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
 * have either.
 *
 * Who is allowed in is one middleware and not a check per handler, and that is
 * ADR-0009 §5. The gate sits above every route below it, so a page added later
 * is guarded because it is a page rather than because somebody remembered — and
 * a visitor with no session is answered identically at every address, including
 * the ones that do not exist, so the cabinet's inventory of pages is not
 * something a stranger can read off it.
 */

import { readFileSync } from "node:fs";
import express, { type Express, type Request, type Response } from "express";
import type { Account, Accounts } from "./accounts.js";
import type { CabinetConfig } from "./config.js";
import {
  fingerprintOf,
  hashPassword,
  MINIMUM_PASSWORD_LENGTH,
  newSessionToken,
  passwordMatches,
} from "./credentials.js";
import { type Answer, type GatewayClient, gatewayFor } from "./gateway.js";
import { bare, escaped } from "./html.js";
import { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
import { passwordScreen, signInScreen } from "./sign-in.js";

/** The name the session cookie travels under. */
const SESSION = "coinslot_session";

/**
 * The cookie the cabinet used to keep a live merchant key in.
 *
 * Nothing reads it any more. It is cleared at the sign-in because everybody who
 * ever signed into the old cabinet still has one in their browser, and what it
 * holds is exactly the credential ADR-0009 exists to get out of browsers.
 */
const RETIRED_SESSION = "coinslot_key";

/**
 * How long a person stays signed in, from the moment they sign in.
 *
 * A working day and a bit, so somebody who signed in at nine is still signed in
 * at six and somebody who left a browser open over a weekend is not. It is
 * never extended: a sliding window would mean a session that never ends as long
 * as a tab stays in front of somebody, which is the case it exists to catch.
 *
 * It is a number here rather than in the configuration because nothing about a
 * deployment changes what it should be, and ADR-0009 §6 names what would: a
 * merchant working from a machine other people use.
 */
const SESSION_HOURS = 12;

/**
 * The stylesheet the cabinet serves: the shared visual language, then the
 * cabinet's own layout. Read once at startup — neither changes while we run.
 *
 * ADR-0005 §6 wants one visual language across the three surfaces, held in one
 * stylesheet rather than repeated per page, and that file is the landing's
 * `styles/tokens.css` — served by Caddy at /styles/tokens.css on the same
 * origin as all three. The cabinet reads it off disk and serves it inside its
 * own response rather than linking that address, for one reason: the cabinet
 * has to render correctly when it is run on its own, without Caddy in front of
 * it, which is how it is developed and how every one of its tests drives it. A
 * link to an absolute path that only exists behind the proxy would leave the
 * pages with no palette at all in exactly the situation somebody is looking at
 * them closely.
 *
 * What matters is that it is one file on disk and not a copy. This branch did
 * carry a copy, with the palette from before the contrast fix, which is how one
 * visual language quietly becomes two that look almost alike.
 */
const TOKENS_AT = new URL("../../landing/public/styles/tokens.css", import.meta.url);
const TOKENS = readTokens();

function readTokens(): string {
  try {
    return readFileSync(TOKENS_AT, "utf8");
  } catch (thrown) {
    // An ENOENT here is a packaging mistake — a workspace pruned to the
    // cabinet's own dependencies, which the landing is not one of — and the
    // bare exception names a path and nothing about why anybody wanted it. The
    // configuration goes to lengths to name every problem at once; this is the
    // same courtesy for the one file it does not read.
    throw new Error(
      `The cabinet cannot start: it serves the shared visual language from ${TOKENS_AT.pathname},` +
        " which is not there. That file is the landing's styles/tokens.css, and ADR-0005 §6 makes" +
        " it the one place the three surfaces take their palette from — so the cabinet ships" +
        ` beside it rather than carrying a copy. ${String(thrown)}`,
    );
  }
}
const STYLESHEET = `${TOKENS}\n${readFileSync(new URL("./coinslot.css", import.meta.url), "utf8")}`;

/** What the cabinet is built out of, beyond its configuration. */
export interface CabinetParts {
  /** Where the people who sign in, and their sessions, are kept. */
  readonly accounts: Accounts;
  /**
   * How the gateway is reached, with the real client as the default.
   *
   * One client for the life of the process, because there is one key and it is
   * the cabinet's own configuration now rather than a visitor's cookie. Only a
   * test ever passes anything else, and what a deployment runs is the client
   * that speaks the contract's route table.
   */
  readonly gateway?: GatewayClient;
}

/**
 * Whose session a request arrived on.
 *
 * A map keyed by the request rather than a field written onto it: express hands
 * every middleware the same object and a property added to it is a property no
 * type knows about, so the next reader of this file would have to take the
 * cabinet's word for who is signed in.
 */
const people = new WeakMap<Request, Account>();

/** The whole cabinet on an express app. */
export function buildApp(config: CabinetConfig, parts: CabinetParts): Express {
  const app = express();
  const base = config.basePath;
  const accounts = parts.accounts;
  const gateway = parts.gateway ?? gatewayFor(config.gatewayUrl, config.merchantApiKey);
  const cookiePath = base === "" ? "/" : base;

  const forget = (response: Response): void => {
    response.clearCookie(SESSION, { path: cookiePath });
  };

  app.disable("x-powered-by");
  // No `trust proxy` here on purpose: nothing in the cabinet reads the client's
  // address or whether the connection was secure, so trusting a forwarding
  // header would make a spoofable header authoritative for no benefit at all.
  // The forms are the only thing a browser posts here, and they are small.
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(sameOriginUnder(base));

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

  app.get(`${base}/sign-in`, async (request, response) => {
    // Cleared here rather than anywhere else, because this is the one page
    // everybody who used the old cabinet lands on next.
    response.clearCookie(RETIRED_SESSION, { path: cookiePath });

    if ((await whoseSession(request, accounts)) !== null) {
      response.redirect(303, `${base}/cards`);
      return;
    }
    response.type("html").send(signInScreen(base));
  });

  app.post(`${base}/sign-in`, async (request, response) => {
    const form = request.body as { email?: unknown; password?: unknown };
    const email = typeof form.email === "string" ? form.email : "";
    const password = typeof form.password === "string" ? form.password : "";
    if (email.trim() === "" || password === "") {
      response
        .status(400)
        .type("html")
        .send(signInScreen(base, "Enter your address and your password."));
      return;
    }

    const person = await accounts.byEmail(email);
    // The comparison happens whether or not there is an account, and that is
    // the point of passing it a null: an answer that came back at once for an
    // address nobody has would make this form a list of who has an account.
    const right = await passwordMatches(password, person?.passwordHash ?? null);
    if (person === null || !right) {
      // The address is named only when we have an account for it. The email box
      // is where a password lands when somebody types into the wrong field, and
      // a refusal that echoed whatever was typed would put that password in the
      // log; an address we do know is a real account being attacked and is
      // worth saying.
      console.log(
        person === null
          ? "[cabinet] a sign-in was refused: no account at the address given"
          : `[cabinet] a sign-in for ${person.email} was refused: wrong password`,
      );
      response
        .status(401)
        .type("html")
        .send(signInScreen(base, "That address and password do not match an account."));
      return;
    }

    // A fresh identifier every time. Nothing here can adopt an identifier the
    // visitor arrived holding, which is what makes a session handed to somebody
    // in a link impossible rather than merely unlikely.
    const token = newSessionToken();
    const now = new Date();
    await accounts.open(
      fingerprintOf(token),
      person.id,
      now,
      new Date(+now + SESSION_HOURS * 60 * 60 * 1_000),
    );
    response.cookie(SESSION, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      path: cookiePath,
      maxAge: SESSION_HOURS * 60 * 60 * 1_000,
    });
    console.log(`[cabinet] ${person.email} signed in`);
    response.redirect(303, `${base}/cards`);
  });

  /**
   * The gate. Everything below this line needs a session; everything above it
   * is the sign-in, the stylesheet and the health probe.
   *
   * A visitor without one is answered the same way at every address, which is
   * why this is a middleware and not a check inside each handler: a page added
   * below is guarded by being below, and a stranger cannot tell which addresses
   * this cabinet serves from which it does not.
   */
  app.use((request, response, next) => {
    void (async () => {
      try {
        const person = await whoseSession(request, accounts);
        if (person === null) {
          // The cookie is cleared on the way out, so somebody whose session was
          // ended lands on a sign-in they can use rather than being bounced
          // through this gate again on every click.
          forget(response);
          response.redirect(303, `${base}/sign-in`);
          return;
        }
        people.set(request, person);
        next();
      } catch (thrown) {
        next(thrown);
      }
    })();
  });

  app.get(`${base}/`, (_request, response) => {
    response.redirect(303, `${base}/cards`);
  });

  app.post(`${base}/sign-out`, async (request, response) => {
    // The row goes, not merely the cookie. Clearing a cookie asks the browser
    // to forget something; anybody who copied the value still holds a session.
    const token = tokenIn(request);
    if (token !== null) {
      await accounts.end(fingerprintOf(token));
    }
    console.log(`[cabinet] ${whoIs(request).email} signed out`);
    forget(response);
    response.redirect(303, `${base}/sign-in`);
  });

  app.get(`${base}/password`, (request, response) => {
    response.type("html").send(passwordScreen(base, whoIs(request).email, MINIMUM_PASSWORD_LENGTH));
  });

  app.post(`${base}/password`, async (request, response) => {
    const person = whoIs(request);
    const form = request.body as { current?: unknown; fresh?: unknown };
    const current = typeof form.current === "string" ? form.current : "";
    const fresh = typeof form.fresh === "string" ? form.fresh : "";

    // The current password first, so that somebody who sat down at an
    // unattended tab learns nothing at all — not even what this cabinet asks of
    // a password — without knowing the one that is already set.
    if (!(await passwordMatches(current, person.passwordHash))) {
      response
        .status(401)
        .type("html")
        .send(
          passwordScreen(
            base,
            person.email,
            MINIMUM_PASSWORD_LENGTH,
            "That is not your current password.",
          ),
        );
      return;
    }
    if (fresh.length < MINIMUM_PASSWORD_LENGTH) {
      response
        .status(400)
        .type("html")
        .send(
          passwordScreen(
            base,
            person.email,
            MINIMUM_PASSWORD_LENGTH,
            `A new password has to be at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
          ),
        );
      return;
    }

    // Every session that person had goes with it, including this one. A
    // password is changed because the old one is not trusted, and a session
    // opened with it is exactly what must not outlive it.
    await accounts.setPassword(person.email, await hashPassword(fresh));
    console.log(`[cabinet] ${person.email} changed their password; every session of theirs ended`);
    forget(response);
    response.redirect(303, `${base}/sign-in`);
  });

  app.get(`${base}/cards`, async (request, response) => {
    const cards = await gateway.cards();
    if (!cards.ok) {
      return trouble(response, base, cards);
    }
    response.type("html").send(cardsScreen(viewing(request, base), cards.document));
  });

  app.get(`${base}/orders`, async (request, response) => {
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
    response
      .type("html")
      .send(ordersScreen(viewing(request, base), cards.document, orders.document, open));
  });

  app.get(`${base}/receipts`, async (request, response) => {
    const [cards, receipts] = await Promise.all([gateway.cards(), gateway.receipts()]);
    if (!cards.ok) {
      return trouble(response, base, cards);
    }
    if (!receipts.ok) {
      return trouble(response, base, receipts);
    }
    response
      .type("html")
      .send(receiptsScreen(viewing(request, base), cards.document, receipts.document));
  });

  for (const [verb, paused] of [
    ["pause", true],
    ["resume", false],
  ] as const) {
    app.post(`${base}/cards/:item_id/${verb}`, async (request, response) => {
      const itemId = request.params.item_id ?? "";
      const switched = await gateway.pauseCard(itemId, paused);
      if (!switched.ok) {
        return trouble(response, base, switched);
      }
      noted(whoIs(request), `${paused ? "paused" : "resumed"} the card ${itemId}`);
      // Back to the list rather than answering the post with a page: a
      // merchant who then reloads must not press the switch again.
      response.redirect(303, `${base}/cards`);
    });

    app.post(`${base}/selling/${verb}`, async (request, response) => {
      const switched = await gateway.setSelling(!paused);
      if (!switched.ok) {
        return trouble(response, base, switched);
      }
      noted(whoIs(request), paused ? "stopped all selling" : "started selling again");
      response.redirect(303, `${base}/cards`);
    });
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
 * The forms this protects include "stop all selling" and the sign-in itself, so
 * a page on another site must not be able to make a browser submit one — not
 * the switches, because that is a merchant's selling, and not the sign-in,
 * because signing somebody into an account of the attacker's choosing is a way
 * of getting them to do their work in a session somebody else can read.
 * SameSite=Strict on the cookie is the first answer and the main one; this is
 * the second, and it exists because SameSite is scoped to the registrable
 * domain rather than to the origin — the day anything at all is served from a
 * sibling subdomain, that page is "same site" and can forge every switch here.
 *
 * A missing Origin is allowed through. Browsers send it on every cross-origin
 * form post, which is the case being refused; what they historically omit it
 * on is same-origin navigation, and refusing an absent header would turn away
 * the merchant's own browser and every command-line client along with it. This
 * is a cheap second lock, not the lock.
 */
function sameOriginUnder(base: string) {
  return (request: Request, response: Response, next: () => void): void => {
    const origin = request.headers.origin;
    if (request.method !== "POST" || origin === undefined) {
      next();
      return;
    }

    // The whole origin and not merely the host. A scheme is part of an origin,
    // and a page served over http on the same host is a different origin from
    // one served over https — which is exactly the distinction this check
    // exists to make, since SameSite does not make it either. The scheme comes
    // from the forwarded header where a terminator set one, because behind
    // Caddy this process speaks http and the browser does not.
    const forwarded = request.headers["x-forwarded-proto"];
    const scheme = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    const asked = request.headers.host;

    if (asked !== undefined && origin === `${scheme ?? "http"}://${asked}`) {
      next();
      return;
    }
    // Nothing about which origin would have worked: that is an answer to
    // somebody who is guessing, and this refusal is only ever seen by them.
    response
      .status(403)
      .type("html")
      .send(problemPage(base, "This form did not come from the cabinet."));
  };
}

/**
 * Whose session this request arrived on, having asked the store.
 *
 * Null covers every way of not being signed in and does not distinguish them:
 * no cookie, a cookie that is not readable, an identifier nothing was ever
 * opened under, a session that has been ended, and one whose twelve hours are
 * up. They are one answer to the visitor, and there is nothing any of them
 * should be told beyond the sign-in page.
 */
async function whoseSession(request: Request, accounts: Accounts): Promise<Account | null> {
  const token = tokenIn(request);
  return token === null ? null : await accounts.whose(fingerprintOf(token), new Date());
}

/**
 * The person this request belongs to.
 *
 * Only ever called below the gate, which is what makes the absence a defect
 * rather than a case: a handler running without a person behind it would be a
 * page reachable by nobody in particular, and it should stop rather than draw
 * something.
 */
function whoIs(request: Request): Account {
  const person = people.get(request);
  if (person === undefined) {
    throw new Error(
      "a handler below the gate ran with no session behind it, which means the gate was" +
        " bypassed — this is a defect in how the routes are ordered, not a visitor's problem",
    );
  }
  return person;
}

/** Who is looking at this page, and where the cabinet is mounted. */
const viewing = (request: Request, base: string): Viewer => ({
  base,
  who: whoIs(request).email,
});

/**
 * One line saying who changed something.
 *
 * ADR-0009 §7 is honest about what this is: a process log, not an audit trail.
 * It rotates, it goes with the container, and it is written by the same process
 * it is a record of. What it answers is "who stopped the selling", which before
 * there was a person in the system could not be answered at all.
 *
 * What never goes in: a password, a session identifier, the merchant key. A log
 * goes places the environment does not.
 */
const noted = (person: Account, did: string): void => {
  console.log(`[cabinet] ${person.email} ${did}`);
};

/** What a merchant is shown when the gateway would not answer. */
function trouble(response: Response, base: string, answer: Answer<unknown>): void {
  if (answer.ok) {
    return;
  }
  if (answer.status === 401) {
    // The key is the cabinet's own configuration now (ADR-0009 §4), so this is
    // a broken cabinet rather than a person who should sign in again. Signing
    // them out here would send them to type a password that cannot fix it and
    // land them straight back on this page, with nothing said about the fault.
    response
      .status(502)
      .type("html")
      .send(
        problemPage(
          base,
          "The gateway did not accept this cabinet's merchant key. Nothing you do here" +
            " changes that: the key the cabinet is configured with has to be one the gateway" +
            " knows. Your sign-in is unaffected.",
        ),
      );
    return;
  }
  if (answer.status === 0) {
    // Nothing answered at all. This is the only case in which "the gateway did
    // not answer" is true, and it is a different thing from a gateway that
    // answered and said no — a merchant told the wrong one of those goes and
    // checks a service that is running.
    response
      .status(502)
      .type("html")
      .send(problemPage(base, `The gateway did not answer: ${answer.why}`));
    return;
  }
  // The gateway answered and refused. Its own sentence, under its own status:
  // nothing is claimed about what did or did not happen beyond what it said.
  response.status(answer.status).type("html").send(problemPage(base, answer.why));
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
 * The session identifier out of the cookie, or null.
 *
 * The cookie header is parsed here rather than by a middleware, because one
 * cookie read in one place is smaller than a dependency and this is the only
 * cookie the cabinet reads.
 *
 * What comes out is 32 random bytes and nothing else — no address, no account,
 * nothing that could be edited into somebody else's identity. Whose session it
 * is is a question for the store.
 */
function tokenIn(request: Request): string | null {
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
