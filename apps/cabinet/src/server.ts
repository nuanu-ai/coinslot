/**
 * The cabinet's own HTTP surface: four screens, a sign-in, a registration, the
 * pages a password is set on, and the four switches that stop and start selling.
 *
 * It is server-rendered with no client framework and no build step, which is
 * ADR-0005 §4. Every page is one GET and every change is one form post
 * followed by a redirect, so the browser's back button, its reload and its
 * find-in-page all work without anything being written to make them. Signing in
 * is a component's job now (ADR-0009) and that did not change: our handlers
 * call its server-side API with a body built out of a form we parsed, and pass
 * on the cookie it produces, so nothing on any of these pages needs JavaScript.
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
import { ServiceNameSchema } from "@coinslot/contracts";
import express, { type Express, type Request, type Response } from "express";
import type { CabinetConfig } from "./config.js";
import {
  type Answer,
  type GatewayClient,
  gatewayFor,
  type Registrar,
  registrarFor,
} from "./gateway.js";
import { bare, escaped } from "./html.js";
import type { Identity, Person } from "./identity.js";
import { keysScreen, newKeyScreen } from "./keys.js";
import { printable } from "./printable.js";
import { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
import {
  confirmedScreen,
  forgotScreen,
  linkSentScreen,
  newPasswordScreen,
  passwordScreen,
  registerScreen,
  signInScreen,
} from "./sign-in.js";

/**
 * The cookies the cabinet used to keep something live in.
 *
 * Nothing reads either any more. `coinslot_key` held a merchant key, which is
 * the credential ADR-0009 exists to get out of browsers, and `coinslot_session`
 * held an identifier of a kind this cabinet no longer issues. Both are cleared
 * at the sign-in, because that is the page everybody who used the old cabinet
 * lands on next, and a value a browser keeps sending forever is one more thing
 * in every request that means nothing.
 */
const RETIRED = ["coinslot_key", "coinslot_session"];

/**
 * What an account with no merchant on it is told, wherever it turns up.
 *
 * There is one such account and it is on a deployed server: it was made before
 * an account named its merchant, so there is no key on its row and not one
 * screen in this cabinet can be drawn for it. The two things it must not be
 * answered with are an empty cabinet, which reads as a catalogue somebody
 * emptied, and an exception, which reads as a broken cabinet.
 *
 * So it is told what it is and what the two ways out are. The person reading it
 * is whoever set the deployment up, because this account is one of ours and not
 * a merchant's, which is why it can name a command at all — and the command is
 * named in full, because half of one is a person at a terminal guessing.
 */
const NO_MERCHANT =
  "This account was made before an account named the merchant it signs in for, so there is" +
  " nothing here for it to show. A new one is made by somebody holding that merchant's key," +
  " with the key piped in rather than typed on the line:" +
  " ... | pnpm --filter @coinslot/cabinet account add <address> <merchant>." +
  " A merchant who has an invitation and no account registers below instead.";

/**
 * The one sentence a registration is refused with, whatever refused it.
 *
 * Three things can stop a registration after the form itself is in order: the
 * invitation is not one the gateway accepts, registration is not open at all,
 * and the address already has an account. The first two answer identically at
 * the gateway by ADR-0014 §3, and the third joins them here — the sign-in next
 * door takes the same time for an address nobody has as for one whose password
 * is wrong, so that the form says nothing about who has an account, and a
 * registration that answered "that address is taken" in words would be that
 * same question answered outright.
 *
 * So the sentence names both of the things the person can act on and says
 * nothing about which of them happened. That is a real cost to somebody who
 * mistyped their invitation and now has two things to check, and it is the
 * cheaper of the two costs.
 */
const REGISTRATION_REFUSED =
  "This registration did not go through, and there are two things that stop one: the invitation" +
  " may not be one we accept, and the address may already have an account here. Check the" +
  " invitation you were given, and if the address is yours from an earlier registration, sign in" +
  " with it instead.";

/**
 * A shape an address has to have before a merchant is made for it.
 *
 * Deliberately not an attempt at the real grammar of an address, which is
 * larger than anybody thinks. What it catches is the mistakes somebody actually
 * makes in a form — a missing half, a space in the middle, a bare word. It is
 * the same shape the account command holds an address to, for the same reason.
 */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * What a merchant's name has to be, said in words a person can act on.
 *
 * The rule is the contract's `ServiceNameSchema` and is applied by asking it
 * rather than by writing it out again here: it is the discovery catalogue's own
 * rule, because that catalogue is where this name goes, and a second copy of it
 * in this file would be the copy that goes stale. What is written here is only
 * the sentence, because the schema's messages are one per broken rule and a
 * person filling in a form is better served by being told the whole rule once.
 *
 * It is checked here as well as at the gateway so that a name outside the rule
 * comes back as this sentence rather than as a 400 the screen would have to
 * guess at — and so that no merchant is made for a registration that was never
 * going to succeed.
 */
const NAME_RULE =
  "The name your products are sold under is at most 32 characters, all of them ordinary" +
  " keyboard characters, with no space at either end. That is the rule of the catalogue that" +
  " will list you under it, not ours.";

/** What is wrong with a registration form, in a sentence, or null. */
function whatIsWrongWith(
  form: { email: string; password: string; name: string; invitation: string },
  shortestPassword: number,
): string | null {
  if (form.email === "" || form.password === "" || form.name === "" || form.invitation === "") {
    return "Every one of the four is needed: an address, a password, the name your products are sold under, and your invitation.";
  }
  if (!LOOKS_LIKE_AN_ADDRESS.test(form.email)) {
    return "That is not an address of the shape someone@example.com.";
  }
  if (form.password.length < shortestPassword) {
    return `A password has to be at least ${shortestPassword} characters.`;
  }
  if (!ServiceNameSchema.safeParse(form.name).success) {
    return NAME_RULE;
  }
  return null;
}

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
  /**
   * Who is signed in, and everything that follows from that.
   *
   * The component and the store behind it, wrapped in `identity.ts`. A
   * deployment gives it Postgres; the cabinet's own tests give it the
   * component's memory store, so the suite drives the real component offline.
   */
  readonly identity: Identity;
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
  /**
   * How a merchant is made, which is the one call the cabinet makes with no key.
   *
   * Its own part rather than a method on the client above, because somebody
   * registering is not a merchant yet and there is no key to bind a client to.
   */
  readonly registrar?: Registrar;
}

/**
 * Whose session a request arrived on.
 *
 * A map keyed by the request rather than a field written onto it: express hands
 * every middleware the same object and a property added to it is a property no
 * type knows about, so the next reader of this file would have to take the
 * cabinet's word for who is signed in.
 */
const people = new WeakMap<Request, Person>();

/** The whole cabinet on an express app. */
export function buildApp(config: CabinetConfig, parts: CabinetParts): Express {
  const app = express();
  const base = config.basePath;
  const identity = parts.identity;
  const shortest = identity.shortestPassword;
  const clientFor = parts.gatewayFor ?? ((key: string) => gatewayFor(config.gatewayUrl, key));
  const registrar = parts.registrar ?? registrarFor(config.gatewayUrl);
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

  /**
   * Takes the component's cookies out of the browser.
   *
   * Every name it sets, not the session alone: beside the session itself the
   * component keeps two cookies of its own, and clearing only the first would
   * leave the others in a browser for good.
   */
  const forget = (response: Response): void => {
    for (const name of identity.cookieNames) {
      response.clearCookie(name, { path: cookiePath });
    }
  };

  /**
   * Puts the session the component just opened into the browser.
   *
   * The lines are the component's own, passed on rather than rebuilt: the four
   * settings a merchant's session rests on are decided in one place
   * (`identity.ts`), and a second copy of them here is a second thing to get
   * wrong — most likely the one that only matters in production.
   */
  const carryCookies = (response: Response, cookies: readonly string[]): void => {
    for (const line of cookies) {
      response.append("set-cookie", line);
    }
  };

  app.disable("x-powered-by");
  // No `trust proxy` here: nothing in the cabinet reads the client's address,
  // and express's own handling of the forwarding headers would put a spoofable
  // value behind `request.ip` and `request.secure` where nobody reading a
  // handler would think to doubt it. The forms are the only thing a browser
  // posts here, and they are small.
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
    for (const name of RETIRED) {
      response.clearCookie(name, { path: cookiePath });
    }

    if ((await identity.whoIs(request.headers.cookie)) !== null) {
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

    const signed = await identity.signIn(email, password);

    if (!signed.ok && signed.why === "refused") {
      // The address is named only when we have an account for it, and finding
      // that out is a second question asked after the refusal is already
      // settled — so it costs the same on both roads through here. The email
      // box is where a password lands when somebody types into the wrong field,
      // and a refusal that echoed whatever was typed would put that password in
      // the log; an address we do know is a real account being attacked and is
      // worth saying.
      const known = await identity.byEmail(email);
      console.log(
        known === null
          ? "[cabinet] a sign-in was refused: no account at the address given"
          : `[cabinet] a sign-in for ${known.email} was refused: wrong password`,
      );
      response
        .status(401)
        .type("html")
        .send(signInScreen(base, "That address and password do not match an account."));
      return;
    }

    if (!signed.ok) {
      // The password was right and there is still nothing to show: this is the
      // account made before an account named its merchant, and no screen in the
      // cabinet can be drawn without a key. Said rather than served empty,
      // because an empty cabinet reads as a catalogue somebody emptied. The
      // session the component opened along the way has already been ended.
      console.log("[cabinet] a sign-in was refused: the account has no merchant");
      response.status(403).type("html").send(signInScreen(base, NO_MERCHANT));
      return;
    }

    carryCookies(response, signed.opened.cookies);
    console.log(`[cabinet] ${signed.opened.person.email} signed in`);
    response.redirect(303, `${base}/cards`);
  });

  /**
   * Turns a registration away from somebody who is already signed in.
   *
   * On both the form and the post, and the post is the one that matters. A
   * merchant already has one; a second registration from the same browser makes
   * a second merchant at the gateway that nothing afterwards names, and hands
   * the person a session for it in place of the one they had — so the cabinet
   * they come back to is a different, empty merchant, and the one they were
   * selling as is reachable only by signing in again. Guarding the form alone
   * would leave that a form post away.
   */
  const alreadySignedIn = async (request: Request, response: Response): Promise<boolean> => {
    if ((await identity.whoIs(request.headers.cookie)) === null) {
      return false;
    }
    response.redirect(303, `${base}/cards`);
    return true;
  };

  app.get(`${base}/register`, async (request, response) => {
    if (await alreadySignedIn(request, response)) {
      return;
    }
    response.type("html").send(registerScreen(base, shortest));
  });

  app.post(`${base}/register`, async (request, response) => {
    if (await alreadySignedIn(request, response)) {
      return;
    }
    const form = (request.body ?? {}) as {
      email?: unknown;
      password?: unknown;
      name?: unknown;
      invitation?: unknown;
    };
    const email = typeof form.email === "string" ? form.email.trim() : "";
    const password = typeof form.password === "string" ? form.password : "";
    const name = typeof form.name === "string" ? form.name.trim() : "";
    const invitation = typeof form.invitation === "string" ? form.invitation.trim() : "";

    // Everything about what was typed is settled before the gateway is called,
    // because a merchant made for a form that was never going to produce an
    // account is litter somebody has to argue about later. ADR-0014 §1 accepts
    // that litter where it cannot be avoided; this is where it can.
    const wrong = whatIsWrongWith({ email, password, name, invitation }, shortest);
    if (wrong !== null) {
      response
        .status(400)
        .type("html")
        .send(registerScreen(base, shortest, wrong));
      return;
    }

    // The gateway first, and the address afterwards. Not for the gateway's
    // convenience: it is what keeps this form from answering "that address has
    // an account" to somebody who has no invitation at all. Behind an
    // invitation the gateway has accepted, the address is answered the same way
    // a refused invitation is — one sentence, below.
    const made = await registrar.register(name, invitation);
    if (!made.ok) {
      // 403 is the only status that means the invitation was not accepted, and
      // the route answers it identically for a wrong code and for a gateway
      // with registration closed (ADR-0014 §3) — so this is the one branch that
      // shows the shared sentence, and nothing in it unpacks the gateway's own
      // words into two of ours.
      if (made.status === 403) {
        console.log("[cabinet] a registration was refused by the gateway");
        response
          .status(403)
          .type("html")
          .send(registerScreen(base, shortest, REGISTRATION_REFUSED));
        return;
      }
      // A 400 says the document this cabinet sent is not one the route takes,
      // which is a fault of ours and not of the invitation. The gateway's own
      // sentence names the field, so it is passed through: sending somebody to
      // find a better invitation over a name we should have refused first would
      // be a wrong errand, and every other status is a wrong errand too.
      //
      // Every other status lands below: a route that is not there in a bad
      // deployment answers 404, and a gateway that is down answers 0 or 5xx.
      // Folded into the refusal above, all of those would tell every person
      // handed a good invitation to go and check it.
      console.error(`[cabinet] a registration could not be made: ${made.why}`);
      response
        .status(502)
        .type("html")
        .send(
          registerScreen(
            base,
            shortest,
            made.status === 400
              ? `Nothing was made, and it is this cabinet's own request that was refused: ${made.why}`
              : "Nothing was made: the part of Coinslot that creates a merchant did not answer as" +
                  " it should. Nothing you typed is at fault, and trying again in a moment is the" +
                  " right move.",
          ),
        );
      return;
    }

    const registered = await identity.register(email, password, name, {
      id: made.document.merchant_id,
      key: made.document.secret,
    });

    if (!registered.ok && registered.why === "taken") {
      // The address already has an account. Answered with the sentence a
      // refused invitation gets, and with nothing that distinguishes the two —
      // the sign-in next door takes the same time for an address nobody has as
      // for one whose password is wrong, and this form saying so outright would
      // be that same question answered in words.
      console.log("[cabinet] a registration was refused: that address already has an account");
      response
        .status(403)
        .type("html")
        .send(registerScreen(base, shortest, REGISTRATION_REFUSED));
      return;
    }

    if (!registered.ok) {
      // The merchant exists at the gateway and nothing here names it. ADR-0014
      // §1 calls that litter rather than damage — the next attempt makes a new
      // merchant — but the person in front of this page must not be told it
      // worked. Which of the two sentences they get turns on whether the
      // address is free again, because that is what decides whether trying
      // again is any use to them.
      response
        .status(500)
        .type("html")
        .send(
          registerScreen(
            base,
            shortest,
            registered.why === "undone"
              ? "Your merchant was created and your account was not, so there is nothing here to" +
                  " sign into yet. Nothing was charged and nothing else was changed. Register" +
                  " again: the address is still free, and a fresh merchant is made for it."
              : "Your merchant was created and your account was left half made, so there is" +
                  " nothing here to sign into and that address is not free either. Nothing was" +
                  " charged. Register with another address, or ask whoever gave you the address" +
                  " of this site to clear the first one.",
          ),
        );
      return;
    }

    carryCookies(response, registered.opened.cookies);
    console.log(`[cabinet] ${registered.opened.person.email} registered and signed in`);
    response.redirect(303, `${base}/cards`);
  });

  app.get(`${base}/password/forgot`, (_request, response) => {
    response.type("html").send(forgotScreen(base));
  });

  app.post(`${base}/password/forgot`, async (request, response) => {
    const form = (request.body ?? {}) as { email?: unknown };
    const email = typeof form.email === "string" ? form.email.trim() : "";
    if (email === "") {
      response
        .status(400)
        .type("html")
        .send(forgotScreen(base, "Enter the address on your account."));
      return;
    }

    // Nothing is read from this and nothing branches on it. Whether there is an
    // account at that address, and whether anybody has confirmed it, are both
    // decided inside — and the page below is the same page in every case,
    // because a form that answered either of those questions would be a way of
    // asking who sells here.
    await identity.askForANewPassword(email);
    response.type("html").send(linkSentScreen(base));
  });

  app.get(`${base}/password/new`, (request, response) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    if (token === "") {
      // A visitor at this address with nothing in hand. Sent to ask for a link
      // rather than shown an empty form, which would take a password and have
      // nothing to do with it.
      response.redirect(303, `${base}/password/forgot`);
      return;
    }
    // The link is not spent here. This page only draws the form; the token is
    // handed back with the new password and is checked once, in the post — so a
    // preview fetch by a mail client cannot burn somebody's only link.
    response.type("html").send(newPasswordScreen(base, token, shortest));
  });

  app.post(`${base}/password/new`, async (request, response) => {
    const form = (request.body ?? {}) as { token?: unknown; fresh?: unknown };
    const token = typeof form.token === "string" ? form.token : "";
    const fresh = typeof form.fresh === "string" ? form.fresh : "";

    if (token === "") {
      response.redirect(303, `${base}/password/forgot`);
      return;
    }
    if (fresh.length < shortest) {
      response
        .status(400)
        .type("html")
        .send(
          newPasswordScreen(
            base,
            token,
            shortest,
            `A password has to be at least ${shortest} characters.`,
          ),
        );
      return;
    }

    if (!(await identity.setPasswordFrom(token, fresh))) {
      response
        .status(400)
        .type("html")
        .send(
          newPasswordScreen(
            base,
            token,
            shortest,
            "That link does not work any more. A link can be used once and stops working an hour" +
              " after it is sent. Ask for another one from the sign-in page.",
          ),
        );
      return;
    }

    console.log("[cabinet] a password was replaced by a link, and every session of theirs ended");
    forget(response);
    response.redirect(303, `${base}/sign-in`);
  });

  app.get(`${base}/confirm`, async (request, response) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    const worked = token !== "" && (await identity.confirm(token));
    response
      .status(worked ? 200 : 400)
      .type("html")
      .send(confirmedScreen(base, worked));
  });

  /**
   * The gate. Everything below this line needs a session; everything above it
   * is the sign-in, the registration, the pages a link lands on, the stylesheet
   * and the health probe.
   *
   * A visitor without one is answered the same way at every address, which is
   * why this is a middleware and not a check inside each handler: a page added
   * below is guarded by being below, and a stranger cannot tell which addresses
   * this cabinet serves from which it does not.
   */
  app.use((request, response, next) => {
    void (async () => {
      try {
        const person = await identity.whoIs(request.headers.cookie);
        if (person === null) {
          // The cookies are cleared on the way out, so somebody whose session
          // was ended lands on a sign-in they can use rather than being bounced
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
          // The session goes, and that is the half that keeps this from being a
          // trap. Left alive it is the thing standing in front of both doors
          // out: this gate answers every address, the sign-in and the
          // registration send a signed-in visitor back to their cards, and the
          // cards land here again — so the one instruction the page gives them
          // is a circle. Ending it costs nothing, because the account it
          // belongs to cannot draw a single screen.
          await identity.signOut(request.headers.cookie);
          forget(response);
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
    // The rows go, not merely the cookies. Clearing a cookie asks the browser
    // to forget something; anybody who copied the value still holds a session.
    // Every identifier the request carried, not one of them: a browser sends
    // cookies of one name longest-path first and then oldest first, so the one
    // this person is signed in on is not necessarily the first.
    const person = whoIs(request);
    await identity.signOut(request.headers.cookie);
    console.log(`[cabinet] ${person.email} signed out`);
    forget(response);
    response.redirect(303, `${base}/sign-in`);
  });

  app.post(`${base}/confirm`, async (request, response) => {
    // Asked for from the banner every page carries until the address is
    // confirmed. It answers with the same page a merchant was already looking
    // at rather than a screen of its own, because the whole of what happened is
    // one message going out.
    const person = whoIs(request);
    if (!person.confirmed) {
      await identity.askToConfirm(person.email);
      console.log(`[cabinet] a confirmation link was sent to ${person.email}`);
    }
    response.redirect(303, `${base}/cards`);
  });

  app.get(`${base}/password`, (request, response) => {
    response.type("html").send(passwordScreen(base, whoIs(request).email, shortest));
  });

  app.post(`${base}/password`, async (request, response) => {
    const person = whoIs(request);
    const form = (request.body ?? {}) as { current?: unknown; fresh?: unknown };
    const current = typeof form.current === "string" ? form.current : "";
    const fresh = typeof form.fresh === "string" ? form.fresh : "";

    const changed = await identity.changePassword(request.headers.cookie, current, fresh);
    if (changed === "too-short") {
      response
        .status(400)
        .type("html")
        .send(
          passwordScreen(
            base,
            person.email,
            shortest,
            `A new password has to be at least ${shortest} characters.`,
          ),
        );
      return;
    }
    if (changed === "wrong-current") {
      response
        .status(401)
        .type("html")
        .send(passwordScreen(base, person.email, shortest, "That is not your current password."));
      return;
    }

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

  app.get(`${base}/keys`, async (request, response) => {
    const keys = await gatewayAs(request).keys();
    if (!keys.ok) {
      return trouble(response, base, keys);
    }
    response.type("html").send(keysScreen(viewing(request, base), keys.document));
  });

  app.post(`${base}/keys`, async (request, response) => {
    const form = (request.body ?? {}) as { label?: unknown };
    const label = typeof form.label === "string" ? form.label.trim() : "";
    const gateway = gatewayAs(request);

    if (label === "") {
      // Refused here rather than sent on, because a key with no name is a key
      // nobody can tell from another on the very screen whose job is telling
      // them apart before revoking one. The list is fetched again so the
      // refusal lands on the page they were looking at.
      const keys = await gateway.keys();
      if (!keys.ok) {
        return trouble(response, base, keys);
      }
      response
        .status(400)
        .type("html")
        .send(
          keysScreen(
            viewing(request, base),
            keys.document,
            "Give the key a name, so that you can tell it from the others when you come to revoke one.",
          ),
        );
      return;
    }

    const issued = await gateway.issueKey(label);
    if (!issued.ok) {
      return trouble(response, base, issued);
    }
    // The name and the identifier, never the secret. A log goes places the
    // database does not, and this is the one moment the secret exists outside
    // the merchant's own hands.
    noted(whoIs(request), `issued a key, ${issued.document.key.id}, named "${label}"`);
    // Answered with a page rather than a redirect, which is the one place this
    // cabinet does that. `keys.ts` says why: a redirect cannot carry the secret
    // anywhere it would be safe to read it back from.
    response.type("html").send(newKeyScreen(viewing(request, base), label, issued.document.secret));
  });

  app.post(`${base}/keys/:key_id/disable`, async (request, response) => {
    const keyId = request.params.key_id ?? "";
    const stopped = await gatewayAs(request).disableKey(keyId);
    if (!stopped.ok) {
      // Including the one refusal the screen tries not to provoke: the gateway
      // will not disable the key its caller is holding. The screen offers no
      // control for it, and somebody who reaches this address anyway is told
      // what the gateway said rather than shown a page implying it worked.
      return trouble(response, base, stopped);
    }
    noted(whoIs(request), `revoked the key ${keyId}`);
    response.redirect(303, `${base}/keys`);
  });

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
 * The component that signs people in brings a check of its own, and it does not
 * replace this one. What it brings is the same idea — compare the `Origin`
 * against a list the deployment configures — and it brings it only for its own
 * endpoints, which are not mounted here at all: every call the cabinet makes is
 * from a handler, with no request behind it, so the component's middleware has
 * nothing to inspect and returns at once. Nothing in it puts a value in our
 * forms that a page on another site could not guess, so the switches, the keys
 * and the registration are covered by this and by nothing else.
 *
 * A missing Origin is allowed through. Browsers send it on every cross-origin
 * form post, which is the case being refused; what they historically omit it
 * on is same-origin navigation, and refusing an absent header would turn away
 * the merchant's own browser and every command-line client along with it. This
 * is a cheap second lock, not the lock.
 *
 * What is compared is the host and not the whole origin, and the scheme is
 * deliberately not part of it any more. The earlier version took the scheme out
 * of `X-Forwarded-Proto` and refused an origin that disagreed, and its own
 * comment said what that would cost: over https with a terminator that sets
 * nothing, every form post on the site is refused. On the first real
 * deployment that is what happened — a browser signing in at
 * `https://coinslot.nuanu.ai` was told its form came from somewhere else, while
 * the identical request from a command line was let through. That difference
 * was never explained; what it showed is that the scheme half of this check
 * turns a header set by whatever is in front into a merchant who cannot reach
 * the control that stops their selling.
 *
 * Dropping it costs the distinction between a page served over http and one
 * served over https on the same host, and that distinction is already made
 * where it can be made without trusting anybody: the session cookie is
 * `Secure` wherever the cabinet is served over https (ADR-0009 §3), so a page
 * on the http origin has no session to forge a post with. A guard cannot be
 * the reason a merchant is locked out.
 */
/**
 * Whether an `Origin` names the same host the request was addressed to.
 *
 * Both sides are parsed rather than compared as text, because both can be
 * written more than one way and only one of those ways is the same string. A
 * host header can carry a port, an origin drops the port that is default for
 * its scheme, and an IPv6 literal is full of colons that a hand-written split
 * would cut in the wrong place. `URL` settles all three, and the port is left
 * out of the comparison on purpose: it is not a boundary a browser enforces
 * — a page on another port of the same host is same-site to SameSite — so
 * requiring it to match would only produce refusals a merchant cannot act on.
 *
 * Anything unparseable is not the same host. An `Origin` of `null`, which a
 * sandboxed document sends, lands there and is refused.
 */
const sameHost = (origin: string, host: string): boolean => {
  const hostOf = (value: string): string | null => {
    try {
      return new URL(value).hostname || null;
    } catch {
      return null;
    }
  };
  // The host header is not a URL, so it is made into one before it is read.
  // The scheme in front of it is arbitrary and never compared against anything.
  const here = hostOf(`http://${host}`);
  return here !== null && hostOf(origin) === here;
};

function sameOriginUnder(base: string) {
  return (request: Request, response: Response, next: () => void): void => {
    const origin = request.headers.origin;
    if (request.method !== "POST" || origin === undefined) {
      next();
      return;
    }

    const asked = request.headers.host;

    if (asked !== undefined && sameHost(origin, asked)) {
      next();
      return;
    }
    // The page says nothing about which origin would have worked, because that
    // is an answer to somebody who is guessing. The log says everything,
    // because the other person this refusal reaches is a merchant who did
    // nothing wrong, and until this line existed there was no way to tell the
    // two apart: the check refused an honest browser on the live site and the
    // only evidence anywhere was a screenshot. What is written down is what was
    // compared and nothing else — an origin and a host are not secrets, and
    // both arrive from outside, so both go through the same rendering that
    // strips what a terminal would obey instead of show.
    console.log(
      `[cabinet] a form post was refused: its origin is ${printable(origin)},` +
        ` and it was addressed to ${printable(asked ?? "nothing at all")}`,
    );
    response
      .status(403)
      .type("html")
      .send(problemPage(base, "This form did not come from the cabinet."));
  };
}

/**
 * The person this request belongs to.
 *
 * Only ever called below the gate, which is what makes the absence a defect
 * rather than a case: a handler running without a person behind it would be a
 * page reachable by nobody in particular, and it should stop rather than draw
 * something.
 */
function whoIs(request: Request): Person {
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
const viewing = (request: Request, base: string): Viewer => {
  const person = whoIs(request);
  return { base, who: person.email, confirmed: person.confirmed };
};

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
 *
 * The whole line goes through `printable` rather than the one field that
 * needed it, and that is on purpose. What made it necessary was the name a
 * merchant gives a key, which the contract deliberately leaves unbounded and
 * open to any alphabet — a name carrying a newline and a plausible sentence
 * would write a second line into the one record of who stopped the selling,
 * in this cabinet's voice and under a name of the writer's choosing. Doing it
 * here rather than at that call site means the next thing somebody
 * interpolates is covered by being here, which is the failure the account
 * command's own rendering was written against.
 */
const noted = (person: Person, did: string): void => {
  console.log(printable(`[cabinet] ${person.email} ${did}`));
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
