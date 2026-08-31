/**
 * Who is signed into the cabinet, and everything that follows from that.
 *
 * ADR-0009 hands the whole of it to Better Auth, running in this process
 * against this cabinet's own Postgres: the passwords, the sessions, the link
 * that confirms an address and the link that replaces a forgotten password.
 * What is written here is not a second implementation of any of that. It is the
 * translation between the cabinet's handlers and the component's server-side
 * API, plus the two things the component has no opinion about — which merchant
 * an account signs in for, and what to do when a browser arrives holding more
 * than one cookie of the same name.
 *
 * The component's own HTTP routes are deliberately not mounted anywhere. Every
 * call in this file is made from one of our handlers, with a body we built out
 * of a form we parsed, and the cookie it produces is passed on by us. Three
 * things follow from that and each is worth having. The cabinet keeps working
 * with no JavaScript, which is ADR-0005 §4 and is why the screens are forms in
 * the first place. There is no JSON surface for anybody to find, so the
 * merchant's key — which is a column on the same row as the address, and which
 * the component would happily include in a session document — has nowhere to
 * come out. And the one-time links we send are ours, pointing at pages in this
 * cabinet, rather than at endpoints that do not exist.
 *
 * The store behind it is chosen by whoever builds this. A deployment gives it
 * drizzle over Postgres; the cabinet's own tests give it the component's memory
 * store, so `pnpm test` stays free, offline and deterministic while still
 * driving the real component.
 */

import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { getCookies } from "better-auth/cookies";
import { createLocalAccountIssuer } from "better-auth/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { CabinetConfig } from "./config.js";
import { MINIMUM_PASSWORD_LENGTH } from "./credentials.js";
import { type Message, type Postman, postmanFor } from "./mail.js";
import { accounts, credentials, sessions, verifications } from "./schema.js";

/**
 * The merchant an account belongs to, and the key it reaches the gateway with.
 *
 * The key is the secret exactly as the gateway issued it, which makes this a
 * secret at rest. ADR-0014 §2 argues why that is accepted and what it does not
 * buy, and the short of it is that it is the same secret that used to sit in the
 * cabinet's environment, moved from a file into a row so that it can be revoked
 * one merchant at a time. What follows from it is a rule for everything above
 * this file: this value never reaches a page, a log or the text of an error.
 */
export interface AccountMerchant {
  readonly id: string;
  readonly key: string;
}

/** A person who can sign in, as the rest of the cabinet needs to know them. */
export interface Person {
  readonly id: string;
  /** Lower case and trimmed, which is how it is stored and how it is looked up. */
  readonly email: string;
  /**
   * Whether anybody has shown they can read mail sent to that address.
   *
   * Every screen says which it is, and one thing turns on it: an unconfirmed
   * address cannot be sent a new password. Nothing else in the cabinet asks.
   */
  readonly confirmed: boolean;
  /**
   * Whose cabinet this is, or null for an account made before there were any.
   *
   * Null is not a state anybody can sign in from — there is no key to draw a
   * single screen with — and the sign-in says so in a sentence naming what to
   * run instead.
   */
  readonly merchant: AccountMerchant | null;
}

/** What the command line prints about an account, which is never its password. */
export interface AccountSummary {
  readonly email: string;
  readonly createdAt: Date;
  /** How many of that person's sessions have not expired. */
  readonly sessions: number;
  /**
   * The identifier of the merchant this account's screens show, or null.
   *
   * The identifier and not the key. One is the answer to "which catalogue is
   * this person looking at", which is the question somebody reading the listing
   * has; the other is a secret, and this listing is printed to a terminal.
   */
  readonly merchant: string | null;
  /** Whether the address has been confirmed, which is what recovery needs. */
  readonly confirmed: boolean;
}

/** A session opened, with the header lines that put it in a browser. */
export interface Opened {
  readonly person: Person;
  /** `Set-Cookie` lines exactly as the component wrote them. */
  readonly cookies: readonly string[];
}

/** What a sign-in came to. */
export type SignIn =
  | { readonly ok: true; readonly opened: Opened }
  /** The address and the password do not name an account. */
  | { readonly ok: false; readonly why: "refused" }
  /** They do, and there is no merchant on it, so no screen can be drawn. */
  | { readonly ok: false; readonly why: "no-merchant" };

/** What a registration came to. */
export type Registration =
  | { readonly ok: true; readonly opened: Opened }
  /** The address already has an account. */
  | { readonly ok: false; readonly why: "taken" }
  /**
   * The account was made and the merchant could not be written onto it, and
   * the account has been taken away again so the address is free.
   */
  | { readonly ok: false; readonly why: "undone" }
  /** The same, and taking it away failed too, so the address is not free. */
  | { readonly ok: false; readonly why: "stranded" };

export interface Identity {
  /**
   * The names the component's cookies travel under.
   *
   * Read from the component rather than written out here, so that the cabinet
   * clears exactly what it sets. There is more than one: beside the session
   * itself the component keeps two of its own, and a sign-out that cleared only
   * the first would leave the others in the browser for good.
   */
  readonly cookieNames: readonly string[];
  /** The floor under a password somebody chooses for themselves. */
  readonly shortestPassword: number;

  signIn(email: string, password: string): Promise<SignIn>;
  /**
   * Makes an account for a merchant that already exists, and signs it in.
   *
   * The merchant is written in the same act rather than added afterwards. If
   * that second write fails the account is taken away again, because an account
   * with no merchant on it is one somebody can sign into and see nothing at all
   * with — and the address it holds is one nobody else can register.
   */
  register(email: string, password: string, merchant: AccountMerchant): Promise<Registration>;
  /**
   * Moves an account's row from the key that was read off it to a fresh one.
   *
   * ADR-0014 §2: the key is made afresh at every sign-in, so that a copy of
   * this database is a set of keys that stops working rather than one that
   * works for good. The merchant is not touched — it is the same merchant,
   * reached with another of their keys.
   *
   * `expected` is what the caller read off the row before it asked the gateway
   * for `fresh`, and the write happens only while the row still holds it. That
   * condition is the whole point and it is the database's own, one statement:
   * a read followed by a write is the same gap in a smaller costume, and the
   * gap is what two sign-ins fall through. Two callers holding the same read
   * cannot both win.
   *
   * True is this row moved, and it is also the caller's right to sweep the
   * older keys away — the write and that right are one act, because a caller
   * that swept without having written would be taking away the key the row
   * actually names. False is every other outcome, whatever the reason: another
   * sign-in got there first, somebody put a different key on the row from a
   * terminal, or the row is not there at all. It is answered rather than
   * thrown because the caller has to carry on — the row names a key that
   * works, and signing somebody in matters more than replacing it.
   */
  replaceMerchantKey(personId: string, expected: string, fresh: string): Promise<boolean>;
  /**
   * Whose session this cookie header carries, having asked the component.
   *
   * Null covers every way of not being signed in and does not distinguish them.
   */
  whoIs(cookieHeader: string | undefined): Promise<Person | null>;
  /** Ends every session this header carries, and answers how many that was. */
  signOut(cookieHeader: string | undefined): Promise<number>;
  /**
   * Changes a password, ending every session including the one that asked.
   *
   * The two refusals are told apart because the screen has a different sentence
   * for each, and neither of them says anything a visitor could not read off
   * the form itself: the length rule is printed on the page.
   */
  changePassword(
    cookieHeader: string | undefined,
    current: string,
    fresh: string,
  ): Promise<"changed" | "wrong-current" | "too-short">;
  /**
   * Sends a link that replaces a forgotten password, if there is anybody to
   * send it to and their address has been confirmed.
   *
   * It answers nothing, on purpose. What the screen says has to be the same
   * sentence whether or not that address has an account here, so there is
   * nothing for a caller to branch on and nothing for it to leak.
   */
  askForANewPassword(email: string): Promise<void>;
  /** Spends a link and sets the password on it. False when the link is spent. */
  setPasswordFrom(token: string, password: string): Promise<boolean>;
  /** Sends the link that confirms an address, to whoever is signed in. */
  askToConfirm(email: string): Promise<void>;
  /** Spends a confirmation link. False when it is not one we handed out. */
  confirm(token: string): Promise<boolean>;

  /** Makes an account without signing anybody in, for the command. */
  make(email: string, password: string, merchant: AccountMerchant): Promise<Person | null>;
  /** Sets a password from the command, ending every session that person had. */
  replacePassword(email: string, password: string): Promise<boolean>;
  byEmail(email: string): Promise<Person | null>;
  endEverySessionFor(email: string): Promise<number>;
  list(now: Date): Promise<readonly AccountSummary[]>;
  close(): Promise<void>;
}

/**
 * One address, however it was typed.
 *
 * Applied here rather than above, so that no caller can be the one that
 * forgets. A person who signs in as "Dmitry@Example.com " is the person whose
 * account was made as "dmitry@example.com". The component lower-cases on its
 * own; the trim is ours, because a trailing space in a form field is a thing
 * people actually type.
 */
export const emailAs = (raw: string): string => raw.trim().toLowerCase();

/**
 * How long a person stays signed in, from the moment they sign in.
 *
 * A working day and a bit, so somebody who signed in at nine is still signed in
 * at six and somebody who left a browser open over a weekend is not. It is
 * never extended, which is what `disableSessionRefresh` below buys: a sliding
 * window would mean a session that never ends as long as a tab stays in front
 * of somebody, which is the case it exists to catch.
 */
const SESSION_HOURS = 12;

/** How long a link we send is worth following. */
const LINK_MINUTES = 60;

/**
 * What the component is given, beyond the configuration.
 *
 * The store is a parameter because the cabinet's own tests run against the
 * component's memory store and a deployment runs against Postgres, and both are
 * the same component with the same behaviour in front of them.
 */
export interface IdentityParts {
  /** The database the four tables live in, or nothing for the memory store. */
  readonly pool?: Pool;
  /**
   * The rows the memory store keeps, when there is no database.
   *
   * Handed in rather than made here so that a caller can look at what the
   * component wrote and can put a row into a state no call would produce — an
   * account with no merchant on it, which is a real row on a deployed server
   * and cannot be made through any door the cabinet has. Ignored entirely when
   * a pool is given.
   */
  readonly rows?: Record<string, Record<string, unknown>[]>;
  /** Where a message goes, with the configured sender as the default. */
  readonly postman?: Postman;
}

export function identityFor(config: CabinetConfig, parts: IdentityParts = {}): Identity {
  const postman = parts.postman ?? postmanFor(config);
  const base = `${config.publicBaseUrl}${config.basePath}`;

  const options = {
    // The component builds no address the cabinet uses — every link in every
    // message is written below, out of the token it hands us — but it will not
    // start without one, and one that disagreed with the links would be a
    // second answer to "where is this cabinet" waiting to be picked up.
    baseURL: base,
    secret: config.authSecret,
    // Switched off rather than left at its default, which is ADR-0009's own
    // sentence about it: a default we depend on can change under us, and
    // `pnpm test` refuses any request that leaves this process, so a version
    // that started phoning home would fail the suite rather than the merchant.
    telemetry: { enabled: false },
    database:
      parts.pool === undefined
        ? memoryAdapter(parts.rows ?? { user: [], session: [], account: [], verification: [] })
        : drizzleAdapter(drizzle(parts.pool), {
            provider: "pg",
            // Keyed by the table names below rather than by the component's own
            // words for them, because that is what it looks these up under once
            // the tables have been given names of ours.
            schema: {
              cabinet_accounts: accounts,
              cabinet_sessions: sessions,
              cabinet_credentials: credentials,
              cabinet_verifications: verifications,
            },
          }),
    emailAndPassword: {
      enabled: true,
      // Registering signs the person in where they stand (ADR-0009): a
      // registration that ends at a sign-in page is a password typed twice for
      // no reason.
      autoSignIn: true,
      // Nothing waits for a message. An account works the day it is made and
      // what its owner lacks until the address is confirmed is recovery.
      requireEmailVerification: false,
      minPasswordLength: MINIMUM_PASSWORD_LENGTH,
      // A password is replaced because the old one is not trusted, and a session
      // opened with it is exactly what must not outlive it.
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: LINK_MINUTES * 60,
      sendResetPassword: async ({ user, token }) => {
        // The one place confirming an address buys anything. A link sent to an
        // address nobody has proved they can read is a link to whoever
        // registered with somebody else's address, and it replaces a password.
        // The token is made either way and simply expires unfollowed, so the
        // screen that asked for it can answer identically in both cases.
        if (user.emailVerified !== true) {
          console.log(
            "[cabinet] a new password was asked for, for an address nobody has confirmed;" +
              " nothing was sent",
          );
          return;
        }
        await postman(newPasswordMessage(user.email, `${base}/password/new?token=${token}`));
      },
    },
    emailVerification: {
      expiresIn: LINK_MINUTES * 60,
      // Not on sign-up. A merchant registering is signed in and shown a banner;
      // the message is sent when they press the control on it, so that a
      // registration does not depend on anybody's mail working.
      sendOnSignUp: false,
      sendOnSignIn: false,
      sendVerificationEmail: async ({ user, token }) => {
        await postman(confirmMessage(user.email, `${base}/confirm?token=${token}`));
      },
    },
    user: {
      modelName: "cabinet_accounts",
      additionalFields: {
        // `input: false` says these are never taken from anything a person
        // typed. They are written by the cabinet, from what the gateway
        // answered, in the one place a registration is completed.
        merchantId: { type: "string", required: false, input: false },
        merchantKey: { type: "string", required: false, input: false },
      },
    },
    session: {
      modelName: "cabinet_sessions",
      expiresIn: SESSION_HOURS * 60 * 60,
      disableSessionRefresh: true,
    },
    account: { modelName: "cabinet_credentials" },
    verification: { modelName: "cabinet_verifications" },
    advanced: {
      // So that the cookie says whose it is in a browser that may be holding
      // cookies from the landing and the documentation on the same origin.
      cookiePrefix: "coinslot",
      defaultCookieAttributes: {
        // Scoped to the cabinet's own path rather than the whole origin, which
        // is ADR-0009: behind Caddy the cabinet shares an origin with the
        // landing, the documentation and the gateway's `/v0`, and a session
        // widened to the origin would ride along on every call to the money
        // path. That is also why the name cannot take the `__Host-` prefix,
        // which a browser only stores at a path of `/`.
        path: config.basePath === "" ? "/" : config.basePath,
        sameSite: "strict",
        httpOnly: true,
        secure: config.cookieSecure,
      },
    },
  } satisfies BetterAuthOptions;

  const auth = betterAuth(options);
  // The names and the four settings of every cookie the component sets, worked
  // out from the same options object it was built with. Reading them off the
  // options rather than writing them out again is what keeps the cabinet
  // clearing exactly what the component sets, on exactly the path it set it.
  const cookies = getCookies(options);
  const sessionCookie = cookies.sessionToken.name;

  const contextOf = async () => await auth.$context;

  const personFrom = (user: {
    id: string;
    email: string;
    emailVerified: boolean;
    merchantId?: unknown;
    merchantKey?: unknown;
  }): Person => {
    const id =
      typeof user.merchantId === "string" && user.merchantId !== "" ? user.merchantId : null;
    const key =
      typeof user.merchantKey === "string" && user.merchantKey !== "" ? user.merchantKey : null;
    return {
      id: user.id,
      email: user.email,
      confirmed: user.emailVerified === true,
      // Both columns or neither. A row with one of them filled in is a row
      // nothing can be done with — an identifier with no key draws no screen,
      // and a key with no identifier names nothing — so it reads as an account
      // with no merchant, which is a state the sign-in has a sentence for.
      merchant: id === null || key === null ? null : { id, key },
    };
  };

  /**
   * Every value a request carried under the session cookie's name.
   *
   * The header is parsed here rather than by a middleware, because this is the
   * only cookie the cabinet reads and one cookie read in one place is smaller
   * than a dependency.
   *
   * A browser can send several cookies of one name, and that is the case this
   * exists for. A page anywhere on the registrable domain can set a cookie of
   * this name at a broader domain or a broader path, and the browser then sends
   * it here beside the merchant's own; nothing the cabinet can send takes it
   * back. So every value is kept and each is asked about separately — a rule
   * that refused a request for carrying two would meet the planted one again on
   * every redirect and every fresh sign-in, and the merchant would be locked out
   * of the control that stops their selling for as long as that cookie lived,
   * which is for good.
   *
   * There is deliberately no cap on how many are considered, for the same
   * reason. Any cap is a way in: a browser sends cookies with the longest path
   * first and, among equal paths, the oldest first, so somebody able to plant
   * cookies could push the merchant's own past the cap. What bounds this is the
   * runtime, which stops reading a request's headers at 16 KB — and what makes
   * the bound cheap is that the component checks its own signature over a value
   * before it goes anywhere near the database, so a pile of planted junk under
   * this name costs a pile of comparisons and not one query.
   */
  const valuesIn = (cookieHeader: string | undefined): readonly string[] => {
    if (cookieHeader === undefined) {
      return [];
    }
    const found = new Set<string>();
    for (const pair of cookieHeader.split(";")) {
      const at = pair.indexOf("=");
      if (at === -1 || pair.slice(0, at).trim() !== sessionCookie) {
        continue;
      }
      const value = pair.slice(at + 1).trim();
      if (value !== "") {
        found.add(value);
      }
    }
    return [...found];
  };

  /** One cookie header carrying exactly one of those values. */
  const asHeaders = (value: string): Headers =>
    new Headers({ cookie: `${sessionCookie}=${value}` });

  /**
   * Every live session this header carries, with the cookie it came in on.
   *
   * The value is kept beside the person because the one call that needs a
   * session — changing a password — has to hand the component a cookie rather
   * than an identifier, and picking one out of the header a second time would
   * be a second chance to pick a different one.
   */
  const liveOnesIn = async (
    cookieHeader: string | undefined,
  ): Promise<readonly { value: string; token: string; person: Person }[]> => {
    const live: { value: string; token: string; person: Person }[] = [];
    for (const value of valuesIn(cookieHeader)) {
      const found = await auth.api.getSession({ headers: asHeaders(value) });
      if (found !== null) {
        live.push({ value, token: found.session.token, person: personFrom(found.user) });
      }
    }
    return live;
  };

  const endSession = async (token: string): Promise<void> => {
    await (await contextOf()).internalAdapter.deleteSession(token);
  };

  return {
    // Read off the component rather than written out here, so the cabinet
    // clears exactly what the component sets. Every one of them: beside the
    // session there are two more, and clearing only the first would leave the
    // others in a browser for good.
    cookieNames: [
      cookies.sessionToken.name,
      cookies.sessionData.name,
      cookies.dontRememberToken.name,
    ],
    shortestPassword: MINIMUM_PASSWORD_LENGTH,

    async signIn(email, password) {
      // The refusal is caught around the call and turned into one answer.
      // The component already answers a wrong password and an address nobody
      // has identically and in the same time — it derives against the password
      // it was given even when there is nobody to compare it to — and nothing
      // here unpacks that back into two.
      const signed = await orNull(
        auth.api.signInEmail({
          returnHeaders: true,
          body: { email: emailAs(email), password },
        }),
      );
      if (signed === null) {
        return { ok: false, why: "refused" };
      }

      const person = personFrom(signed.response.user);
      if (person.merchant === null) {
        // The password was right and there is still nothing to show. The
        // session the component just opened is ended rather than handed over:
        // an account that cannot draw a screen must not leave a live session
        // behind it, because that session is then the thing standing in front
        // of both doors out.
        await endSession(signed.response.token);
        return { ok: false, why: "no-merchant" };
      }
      return { ok: true, opened: { person, cookies: signed.headers.getSetCookie() } };
    },

    async register(email, password, merchant) {
      const made = await orNull(
        auth.api.signUpEmail({
          returnHeaders: true,
          // The component asks for a display name and nothing in this cabinet
          // has one to give: a person here is their address, and the one name a
          // merchant chooses is the name buyers read, which lives at the
          // gateway and is not this. An empty string rather than a copy of the
          // address, because a copy would be a second place the address is
          // written and a value somebody later mistakes for a chosen one.
          body: { email: emailAs(email), password, name: "" },
        }),
      );
      if (made === null) {
        // The address already has an account. It is the only way this call
        // fails on a form the cabinet has already checked, and the screen that
        // shows it does not say which of its two refusals happened.
        return { ok: false, why: "taken" };
      }

      const id = made.response.user.id;
      const internal = (await contextOf()).internalAdapter;
      try {
        await internal.updateUser(id, { merchantId: merchant.id, merchantKey: merchant.key });
      } catch (thrown) {
        console.error(
          "[cabinet] an account was made and its merchant could not be written",
          thrown,
        );
        try {
          // Taken away rather than left. An account with no merchant on it
          // cannot draw a screen, and the address it holds is one nobody else
          // can register — so leaving it turns a failed registration into a
          // person who needs somebody at a terminal to get their address back.
          await internal.deleteUser(id);
        } catch (alsoThrown) {
          console.error("[cabinet] and the account could not be taken away again", alsoThrown);
          return { ok: false, why: "stranded" };
        }
        return { ok: false, why: "undone" };
      }

      return {
        ok: true,
        opened: {
          person: { ...personFrom(made.response.user), merchant },
          cookies: made.headers.getSetCookie(),
        },
      };
    },

    async replaceMerchantKey(personId, expected, fresh) {
      try {
        // The component's own `updateUser` takes an identifier and nothing
        // else, so this goes to the adapter under it, where a write carries as
        // many conditions as it is given. Both of them matter: the row is this
        // person's, and it still holds what the caller read. Over Postgres that
        // is one `update ... where id = $1 and merchant_key = $2`; over the
        // store the tests run on it is the same filter. What is skipped by
        // going around `updateUser` is a refresh of sessions held in secondary
        // storage, which this cabinet does not have — there is no second store
        // configured, and a session here is a row like any other.
        const written = await (await contextOf()).adapter.update<{ merchantKey?: unknown }>({
          model: "user",
          where: [
            { field: "id", value: personId },
            { field: "merchantKey", value: expected },
          ],
          update: { merchantKey: fresh },
        });
        // Read back from what the write answered rather than assumed from the
        // absence of a throw. A conditional write that matched nothing is a
        // write that did not happen, and it says so by answering with no row
        // rather than by failing.
        return written?.merchantKey === fresh;
      } catch (thrown) {
        console.error("[cabinet] a fresh gateway key could not be written onto a row", thrown);
        return false;
      }
    },

    async whoIs(cookieHeader) {
      const live = await liveOnesIn(cookieHeader);
      if (live.length === 0) {
        return null;
      }
      const owners = new Set(live.map((one) => one.person.id));
      if (owners.size === 1) {
        return live[0]?.person ?? null;
      }

      // The cabinet genuinely cannot tell who is asking, and answering it
      // wrongly would put the wrong name on the one record of who stopped the
      // selling. Nobody is signed in — and every one of those sessions is
      // ended, which is the half that matters: the cabinet cannot take a cookie
      // out of a browser, but it can stop it being a session, so the next
      // request carries a value nothing answers to and the plant is spent.
      for (const one of live) {
        await endSession(one.token);
      }
      console.log(
        `[cabinet] a request carried live sessions of ${owners.size} different people` +
          ` (${[...new Set(live.map((one) => one.person.email))].sort().join(", ")});` +
          " every one of them was ended and nobody was signed in",
      );
      return null;
    },

    async signOut(cookieHeader) {
      // The rows go, not merely the cookies. Clearing a cookie asks the browser
      // to forget something; anybody who copied the value still holds a session.
      // Every identifier the request carried, not the first one: a browser sends
      // cookies of one name longest-path first, so the one this person is signed
      // in on is not necessarily the first, and ending only that would be a
      // sign-out that said it had worked and left the session alive.
      const live = await liveOnesIn(cookieHeader);
      for (const one of live) {
        await endSession(one.token);
      }
      return live.length;
    },

    async changePassword(cookieHeader, current, fresh) {
      const mine = (await liveOnesIn(cookieHeader))[0];
      if (mine === undefined) {
        // Only reachable below the gate, which has already established there is
        // a live session here. Answered as a wrong password rather than thrown,
        // because the alternative is a page saying the cabinet is broken to
        // somebody whose session ended between two requests.
        return "wrong-current";
      }
      try {
        await auth.api.changePassword({
          headers: asHeaders(mine.value),
          body: { currentPassword: current, newPassword: fresh, revokeOtherSessions: true },
        });
      } catch (thrown) {
        if (!(thrown instanceof APIError)) {
          throw thrown;
        }
        return tooShort(thrown) ? "too-short" : "wrong-current";
      }
      // Every session that person had, including the one that asked and the
      // fresh one the component hands back in its place. The screen promises
      // exactly this — "it ends every session you have, on this device and any
      // other" — and a password changed because the old one is not trusted is
      // the reason to keep that promise rather than the convenient half of it.
      await (await contextOf()).internalAdapter.deleteUserSessions(mine.person.id);
      return "changed";
    },

    async askForANewPassword(email) {
      try {
        await auth.api.requestPasswordReset({ body: { email: emailAs(email) } });
      } catch (thrown) {
        // The one place a failure really is swallowed, and it has to be. The
        // screen says the same sentence whatever happened, because a form that
        // answered differently for an address nobody has would be a way of
        // asking who sells here — so there is nothing a caller could do with
        // this, and the log is where it goes.
        console.error("[cabinet] a new password could not be asked for", thrown);
      }
    },

    async setPasswordFrom(token, password) {
      const set = await orNull(auth.api.resetPassword({ body: { token, newPassword: password } }));
      return set !== null;
    },

    async askToConfirm(email) {
      // The component's own refusal is swallowed and nothing else is. It
      // refuses an address it has already confirmed, which is a person pressing
      // a control that should not have been on their page any more; a database
      // that will not answer is a different thing, and the merchant who pressed
      // the button is entitled to be told that something here is broken rather
      // than sent back to a page that looks as though it worked.
      await orNull(auth.api.sendVerificationEmail({ body: { email: emailAs(email) } }));
    },

    async confirm(token) {
      return (await orNull(auth.api.verifyEmail({ query: { token } }))) !== null;
    },

    async make(email, password, merchant) {
      const made = await this.register(email, password, merchant);
      if (!made.ok) {
        return null;
      }
      // The command makes an account for somebody else to sign in as, so the
      // session the component opened along the way belongs to nobody and is
      // ended here rather than left in a table for twelve hours.
      await (await contextOf()).internalAdapter.deleteUserSessions(made.opened.person.id);
      return made.opened.person;
    },

    async replacePassword(email, password) {
      const context = await contextOf();
      const found = await context.internalAdapter.findUserByEmail(emailAs(email), {
        includeAccounts: true,
      });
      if (found === null) {
        return false;
      }
      const hashed = await context.password.hash(password);
      const hasOne = found.accounts.some((one) => one.providerId === "credential");
      if (hasOne) {
        await context.internalAdapter.updatePassword(found.user.id, hashed);
      } else {
        // An account with no password at all, which is what a row carried over
        // from the cabinet as it was before this component looks like: the
        // person is there and the way of signing in is not. Making one is the
        // command doing its whole job rather than reporting success over an
        // update that matched no rows.
        await context.internalAdapter.linkAccount({
          userId: found.user.id,
          providerId: "credential",
          // The namespace the component keeps its own ways of signing in under,
          // asked for rather than written out: it is the value every one of its
          // own routes writes, and a row under a different one is a password
          // the sign-in would never look at.
          issuer: createLocalAccountIssuer("credential"),
          accountId: found.user.id,
          password: hashed,
        });
      }
      // Every session that person had. The password is being replaced because
      // the old one is lost or not trusted, and a session opened with it is
      // what must not outlive it.
      await context.internalAdapter.deleteUserSessions(found.user.id);
      return true;
    },

    async byEmail(email) {
      const found = await (await contextOf()).internalAdapter.findUserByEmail(emailAs(email));
      return found === null ? null : personFrom(found.user);
    },

    async endEverySessionFor(email) {
      const context = await contextOf();
      const found = await context.internalAdapter.findUserByEmail(emailAs(email));
      if (found === null) {
        return 0;
      }
      const open = await context.internalAdapter.listSessions(found.user.id);
      await context.internalAdapter.deleteUserSessions(found.user.id);
      return open.length;
    },

    async list(now) {
      const context = await contextOf();
      const everybody = await context.internalAdapter.listUsers();
      const rows: AccountSummary[] = [];
      for (const one of everybody) {
        const person = personFrom(one as never);
        const open = await context.internalAdapter.listSessions(person.id);
        rows.push({
          email: person.email,
          createdAt: (one as { createdAt: Date }).createdAt,
          sessions: open.filter((session) => session.expiresAt > now).length,
          // The identifier alone. Spreading the person here instead would put
          // the key on a summary that is printed to a terminal.
          merchant: person.merchant?.id ?? null,
          confirmed: person.confirmed,
        });
      }
      // Sorted here rather than by the database, so that the order a person
      // reads off a terminal is the same on whatever server. A database sorts
      // by its own collation, and the disagreement is real rather than
      // theoretical: on Postgres 17, `C` and `en-US-x-icu` put
      // `renée@example.com` on opposite sides of `renz@example.com`.
      return rows.sort((one, other) => one.email.localeCompare(other.email));
    },

    async close() {
      await parts.pool?.end();
    },
  };
}

/**
 * The answer, or null where the component refused — and nothing else.
 *
 * The distinction is the whole of this function. A refusal is the component
 * saying no to what it was given, and the caller turns it into one sentence on
 * a screen; anything else is the machinery under it failing, and there is no
 * sentence for that which is not a lie. A database that is not there would
 * otherwise come back as "that address already has an account", which sends a
 * merchant to look for an account they do not have while the cabinet is the
 * thing that is broken — and it is what this cabinet did on the first run
 * outside its own tests.
 *
 * The component marks its own refusals by throwing this one type. Everything
 * else goes up, where the error page says something here is broken and the log
 * gets the exception.
 */
async function orNull<T>(answering: Promise<T>): Promise<T | null> {
  try {
    return await answering;
  } catch (thrown) {
    if (thrown instanceof APIError) {
      return null;
    }
    throw thrown;
  }
}

/**
 * Whether the component refused a password change because the new password is
 * too short, rather than because the current one was wrong.
 *
 * The code and not the sentence: the component's own words are English written
 * for a developer reading a JSON answer, and what the screen shows is ours. A
 * refusal this does not recognise is treated as the current password being
 * wrong, which is the answer that tells the person less.
 */
function tooShort(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null || !("body" in thrown)) {
    return false;
  }
  const body = (thrown as { body: unknown }).body;
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    (body as { code: unknown }).code === "PASSWORD_TOO_SHORT"
  );
}

/**
 * The message that replaces a forgotten password.
 *
 * Short, and it says the two things a person needs before they click: how long
 * the link is worth following, and what to do if they did not ask for it. The
 * second matters because the form that sends this takes an address from
 * anybody — so the person reading it may be somebody who was typed in by
 * mistake, and the honest instruction to them is to do nothing.
 */
const newPasswordMessage = (to: string, link: string): Message => ({
  to,
  subject: "A new password for your Coinslot account",
  body: [
    "Somebody asked for a new password for the Coinslot account at this address.",
    "",
    "Open this to choose one. It works once and stops working after an hour:",
    "",
    `    ${link}`,
    "",
    "If that was not you, nothing has happened and there is nothing to do.",
    "Your password has not changed and nobody has been signed in.",
    "",
    "Nobody reads replies to this address.",
  ].join("\n"),
});

/** The message that confirms an address. */
const confirmMessage = (to: string, link: string): Message => ({
  to,
  subject: "Confirm your address for Coinslot",
  body: [
    "Open this to confirm that this address reaches you. It stops working an hour",
    "after it is sent:",
    "",
    `    ${link}`,
    "",
    "Your Coinslot account already works without this. What confirming buys is",
    "that a password you have lost can be replaced by a link sent here.",
    "",
    "If you did not ask for this, nothing has happened and there is nothing to do.",
    "",
    "Nobody reads replies to this address.",
  ].join("\n"),
});
