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
  looksLikeSessionToken,
  MINIMUM_PASSWORD_LENGTH,
  newSessionToken,
  passwordMatches,
} from "./credentials.js";
import { type Answer, type GatewayClient, gatewayFor } from "./gateway.js";
import { bare, escaped } from "./html.js";
import { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
import { passwordScreen, signInScreen } from "./sign-in.js";

/**
 * The name the session cookie travels under.
 *
 * Not `__Host-coinslot_session`, and that is a decision rather than an
 * oversight. A browser refuses to store a cookie under that prefix if it
 * carries a `Domain` or if its `Path` is anything but `/`, which is exactly
 * what would stop a page elsewhere on the registrable domain planting a cookie
 * of this name that the browser then sends here.
 *
 * The `Path` half is what rules it out. Behind Caddy the cabinet is mounted at
 * `/cabinet` on an origin it shares with the landing, the documentation and the
 * gateway's own `/v0` (deploy/Caddyfile), so taking the prefix means widening
 * this cookie to the whole origin — which puts a person's session on the money
 * path, the one thing ADR-0005 §2 exists to keep it off. At an empty BASE_PATH
 * the path is already `/` and the prefix would be available, but only where the
 * cookie is also `Secure`: the name would then depend on two configuration
 * values, and no deployment described in this repository sets both of them that
 * way, so it would be a branch that exists only in its own test.
 *
 * `__Secure-` is available and buys nothing here. It stops a page served over
 * http from setting the cookie, and the page this is about is served over https
 * from a neighbour of ours.
 *
 * What is left open by not taking the prefix is written down in ADR-0009 rather
 * than left to be discovered: a page that can set a cookie for this domain can
 * put a session of its own in front of a visitor who has none, and the cabinet
 * will believe it and write that name in the log.
 */
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
 * What an account with no merchant on it is told, wherever it turns up.
 *
 * There is one such account and it is on a deployed server: it was made before
 * an account named its merchant, so there is no key on its row and not one
 * screen in this cabinet can be drawn for it. The two things it must not be
 * answered with are an empty cabinet, which reads as a catalogue somebody
 * emptied, and an exception, which reads as a broken cabinet. So it is told
 * what it is and what fixes it — a command somebody with the merchant's key
 * runs — and the registration link on the same page covers the other reader,
 * who has no merchant at the gateway at all.
 */
const NO_MERCHANT =
  "This account was made before an account named the merchant it signs in for, so there is" +
  " nothing here for it to show. Somebody holding that merchant's key makes a new account with" +
  " `account add <address> <merchant>`; a merchant with an invitation and no account can" +
  " register below.";

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
   * How the gateway is reached on behalf of one merchant, with the real client
   * as the default.
   *
   * A function of the key rather than a client, because the key is not the
   * cabinet's any more: it is on the row of whoever is signed in, so a client is
   * built per request and two people signed into one cabinet are two merchants
   * (ADR-0014 §2). Only a test ever passes anything else, and what a deployment
   * runs is the client that speaks the contract's route table.
   */
  readonly gatewayFor?: (key: string) => GatewayClient;
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
  const clientFor = parts.gatewayFor ?? ((key: string) => gatewayFor(config.gatewayUrl, key));
  const cookiePath = base === "" ? "/" : base;

  /**
   * The gateway as this request's merchant, built from the key on their row.
   *
   * Only ever called below the gate, which is what makes the merchant's absence
   * a defect here rather than a case: the gate refuses an account that has no
   * key on it, with a sentence saying what to do, precisely so that no handler
   * below has to hold an opinion about a cabinet with nothing to draw.
   */
  const gatewayAs = (request: Request): GatewayClient => {
    const merchant = whoIs(request).merchant;
    if (merchant === null) {
      throw new Error(
        "a handler below the gate ran for an account with no merchant on it, which means the" +
          " gate let one through — this is a defect in how the routes are ordered, not a" +
          " visitor's problem",
      );
    }
    return clientFor(merchant.key);
  };

  const forget = (response: Response): void => {
    response.clearCookie(SESSION, { path: cookiePath });
  };

  app.disable("x-powered-by");
  // No `trust proxy` here: nothing in the cabinet reads the client's address,
  // and express's own handling of the forwarding headers would put a spoofable
  // value behind `request.ip` and `request.secure` where nobody reading a
  // handler would think to doubt it. One forwarding header is read, in exactly
  // one place, and that place says what it trusts and why — see
  // `sameOriginUnder`. The forms are the only thing a browser posts here, and
  // they are small.
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
    // `?? {}` and not a cast alone: express leaves `body` undefined when the
    // content type is not the one the form parser handles, and reading a field
    // off that throws — so a request that is merely malformed would land on the
    // page that says something in the cabinet is broken, with a stack trace in
    // the log for every scanner that ever posts JSON at this address.
    const form = (request.body ?? {}) as { email?: unknown; password?: unknown };
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

    if (person.merchant === null) {
      // The password was right and there is still nothing to show: this is the
      // account made before an account named its merchant, and no screen in the
      // cabinet can be drawn without a key. Said rather than served empty,
      // because an empty cabinet reads as a catalogue somebody emptied.
      console.log(
        `[cabinet] a sign-in for ${person.email} was refused: the account has no merchant`,
      );
      response.status(403).type("html").send(signInScreen(base, NO_MERCHANT));
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
        if (person.merchant === null) {
          // A session outlives a deployment, so somebody signed in on the
          // cabinet as it was before an account named its merchant arrives here
          // holding one. They are told the same thing the sign-in tells them
          // rather than redirected to it: they have a live session, and sending
          // them to type a password that will be accepted and then refused is a
          // longer way to the same sentence.
          //
          // The session is left alone. Ending it would take away the one thing
          // that still works about the account for no gain, and nothing this
          // person can reach does anything with a merchant.
          response.status(403).type("html").send(signInScreen(base, NO_MERCHANT));
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
    //
    // Every identifier the request carried, not one of them. A browser sends
    // cookies of one name longest-path first and then oldest first, so the one
    // this person is signed in on is not necessarily the first — ending only
    // that would be a sign-out that said it had worked and left the session
    // alive. What the gate has established is that every live session here
    // belongs to one person, so this ends that person's sessions on this
    // browser and nothing else; the rest are identifiers nothing answers to.
    //
    // This is the one place a request's identifiers are still one call each,
    // and it is deliberate: it is below the gate, so a stranger cannot reach
    // it, and a person signing themselves out of their own browser is not
    // somebody to buy a batch delete for.
    const person = whoIs(request);
    for (const token of tokensIn(request)) {
      await accounts.end(fingerprintOf(token));
    }
    console.log(`[cabinet] ${person.email} signed out`);
    forget(response);
    response.redirect(303, `${base}/sign-in`);
  });

  app.get(`${base}/password`, (request, response) => {
    response.type("html").send(passwordScreen(base, whoIs(request).email, MINIMUM_PASSWORD_LENGTH));
  });

  app.post(`${base}/password`, async (request, response) => {
    const person = whoIs(request);
    const form = (request.body ?? {}) as { current?: unknown; fresh?: unknown };
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
    const cards = await gatewayAs(request).cards();
    if (!cards.ok) {
      return trouble(response, base, cards);
    }
    response.type("html").send(cardsScreen(viewing(request, base), cards.document));
  });

  app.get(`${base}/orders`, async (request, response) => {
    // Only the exact word narrows the list, which is what the contract says
    // and what a merchant reconciling their books relies on.
    const open = request.query.open === "true";
    const gateway = gatewayAs(request);
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
    const gateway = gatewayAs(request);
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
      const switched = await gatewayAs(request).pauseCard(itemId, paused);
      if (!switched.ok) {
        return trouble(response, base, switched);
      }
      noted(whoIs(request), `${paused ? "paused" : "resumed"} the card ${itemId}`);
      // Back to the list rather than answering the post with a page: a
      // merchant who then reloads must not press the switch again.
      response.redirect(303, `${base}/cards`);
    });

    app.post(`${base}/selling/${verb}`, async (request, response) => {
      const switched = await gatewayAs(request).setSelling(!paused);
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
      // A body larger than any of these forms. It arrives from a visitor and
      // not from a defect, so it is answered as what it is rather than as a
      // broken cabinet — and without a stack, because a stranger who can post
      // at this address must not be able to fill the log with them. The body
      // parser runs above the gate, which is why a visitor with no session
      // reaches this at all.
      if (tooLarge(thrown)) {
        response
          .status(413)
          .type("html")
          .send(problemPage(base, "That was larger than any form on this page sends."));
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
    //
    // The first value in the header and not the last, which is worth arguing
    // because the reverse looks safer. What this is compared against is the
    // `Origin` a browser sent, and that names the scheme the browser used at
    // the edge of the chain — which is the leftmost value, by what the header
    // means. The last value is the scheme between the final two hops, and
    // preferring it would answer "this form did not come from the cabinet" to
    // an honest merchant behind a chain that terminates TLS early.
    //
    // The usual argument for the last value is that a chain which appends
    // rather than replaces leaves a client's own claim leftmost. It does not
    // reach this check: the only attacker this refusal is for is a page in a
    // browser, a page cannot put a header on a form post at all, and a `fetch`
    // that sets one is held for a preflight this cabinet answers with a
    // redirect and no CORS headers, which browsers refuse. A client that can
    // set `X-Forwarded-Proto` can also leave `Origin` off, and this middleware
    // waves that through by design.
    //
    // What the fallback costs when the header is absent is worth knowing
    // before it happens: over https with a terminator that sets nothing, the
    // scheme reads "http", every origin then mismatches, and every form post
    // on the site — the sign-in included — is refused.
    const forwarded = request.headers["x-forwarded-proto"];
    const said = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const scheme = said?.split(",")[0]?.trim();
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
 * Whose session this request arrived on, having asked the store — and, where it
 * cannot be answered, the one act that keeps the question from coming back.
 *
 * Null covers every way of not being signed in and does not distinguish them:
 * no cookie, a cookie that is not readable, an identifier nothing was ever
 * opened under, a session that has been ended, and one whose twelve hours are
 * up. They are one answer to the visitor, and there is nothing any of them
 * should be told beyond the sign-in page.
 *
 * A browser can send several cookies of one name, and that is the case the rest
 * of this is shaped around. A page anywhere on the registrable domain can set a
 * `coinslot_session` at a broader domain or a broader path, and the browser
 * then sends it here beside the merchant's own. The cabinet cannot take it
 * back: `forget` clears the name on the path and the host this process serves,
 * and nothing it can send removes a cookie somebody else scoped more widely.
 *
 * So a value that is not a live session is ignored rather than refused. A rule
 * that turned the mere presence of a second cookie into a refusal would meet
 * the planted one again on every redirect and every fresh sign-in, and the
 * merchant would be locked out of the control that stops their selling for as
 * long as that cookie lived — which is for good.
 *
 * Live sessions that all belong to one person are that person. Two of somebody's
 * own cookies is what a change of mount point leaves behind in a browser, and
 * there is no ambiguity in it to refuse.
 *
 * Live sessions belonging to more than one person is the case where the cabinet
 * genuinely cannot tell who is asking, and answering it wrongly would put the
 * wrong name on the one record of who stopped the selling (ADR-0009 §7). Nobody
 * is signed in — and every one of those sessions is ended, which is the half
 * that matters. The cabinet cannot take the cookie out of the browser, but it
 * can stop it being a session: the next request carries a value nothing answers
 * to, the merchant signs in again, and the plant is spent. Refusing without
 * ending would be the lockout above wearing the clothes of caution, and it is
 * what this code used to do.
 */
async function whoseSession(request: Request, accounts: Accounts): Promise<Account | null> {
  const live = await accounts.whose(tokensIn(request).map(fingerprintOf), new Date());
  if (live.length === 0) {
    return null;
  }

  const owners = new Set(live.map((session) => session.account.id));
  if (owners.size === 1) {
    return live[0]?.account ?? null;
  }

  for (const session of live) {
    await accounts.end(session.fingerprint);
  }
  // Named, because this is not a thing that happens by accident: somebody put a
  // second person's live session in front of this browser, and whoever reads
  // the log afterwards should be able to see when.
  console.log(
    `[cabinet] a request carried live sessions of ${owners.size} different people` +
      ` (${[...new Set(live.map((session) => session.account.email))].sort().join(", ")});` +
      " every one of them was ended and nobody was signed in",
  );
  return null;
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
    // The key is on the row of whoever is signed in (ADR-0014 §2), so this is
    // still not a person who should sign in again: their password is right and
    // typing it again cannot make the gateway accept a key it has stopped
    // accepting. Signing them out here would send them to do exactly that and
    // land them straight back on this page, with nothing said about the fault.
    //
    // What is said instead is the whole truth, including the part that is
    // uncomfortable: rotating the key a cabinet is holding is named in
    // ADR-0014 §5 as not built, so there is no page in here that fixes this.
    response
      .status(502)
      .type("html")
      .send(
        problemPage(
          base,
          "The gateway will not accept the key stored for this account, so none of these" +
            " screens can be drawn. Nothing you do here changes that, and there is no page in" +
            " this cabinet that replaces the key it signs in with — a new account has to be" +
            " made for this merchant, by somebody holding a key the gateway still accepts." +
            " Your sign-in itself is unaffected.",
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

/**
 * Whether this is the body parser refusing a body, rather than a defect.
 *
 * `body-parser` marks its own refusals with a `type`, which is what this reads;
 * the status it carries is not enough on its own, because an exception from
 * anywhere else can have one too.
 */
function tooLarge(thrown: unknown): boolean {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    "type" in thrown &&
    (thrown as { type: unknown }).type === "entity.too.large"
  );
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
function tokensIn(request: Request): readonly string[] {
  const header = request.headers.cookie;
  if (header === undefined) {
    return [];
  }

  const found = new Set<string>();
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
      continue;
    }
    // Only values shaped like an identifier we would have issued, which costs
    // nothing and means a pile of planted junk under this name is a pile of
    // strings rather than a pile of queries.
    //
    // There is deliberately no cap on how many are considered. Any cap is a way
    // in: a browser sends cookies with the longest path first and, among equal
    // paths, the oldest first, so somebody able to plant cookies could push the
    // merchant's own past the cap and lock them out of the control that stops
    // their selling.
    //
    // What is left is bounded by the runtime rather than by us, and the bound
    // was measured rather than assumed. Node stops reading a request's headers
    // at 16 KB; one cookie of this name and shape is 60 bytes and the separator
    // adds two; over a raw socket carrying nothing but a request line and a
    // Host header, 263 of them are read and 264 is answered 431 and never
    // reaches this code. A client that sends the headers a browser sends buys
    // fewer — through `fetch`, 262.
    //
    // That number used to matter, because each identifier was a separate
    // question to the database: ten such requests bought two and a half
    // thousand round trips through a pool of ten connections, where ten
    // ordinary requests buy ten. `whose` now takes every identifier at once, so
    // reading who a request belongs to is one query whatever arrives, and the
    // bound is a fact about the runtime rather than something being relied on.
    // The one place a count still costs anything is the sign-out, which ends
    // each identifier it was given; that route is below the gate.
    if (looksLikeSessionToken(value)) {
      found.add(value);
    }
  }
  return [...found];
}
