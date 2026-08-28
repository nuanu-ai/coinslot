/**
 * What the cabinet has no right to start without.
 *
 * The environment is an external boundary like any other, so it goes through a
 * zod schema (ADR-0003 §5) and the process names every problem at once rather
 * than one per restart.
 *
 * There is a database address here and there is exactly one thing it is for:
 * the people who sign into the cabinet, their sessions, their passwords and the
 * one-time links they are sent (ADR-0009). ADR-0005 §3 still holds for
 * everything else — every card, order and receipt on every screen comes from
 * the public API, because the reason that section gives is dogfooding: a screen
 * the cabinet cannot draw is API the merchant does not have either.
 *
 * There is no merchant key here, and its absence is the point rather than an
 * omission. The cabinet used to read one at start-up and use it for the life of
 * the process, which made every screen show that one merchant's money whoever
 * was signed in. The key is on the row of the person signed in now (ADR-0014
 * §2), so a deployment has one less thing to set and one more thing to back up.
 *
 * The two secrets left in here are read and never printed. The sentences this
 * file throws name the variable that is wrong and not the value it held, because
 * a startup failure goes to a log and a log goes places the environment does not.
 */

import { z } from "zod";
import { isSandboxMail, SANDBOX_MAIL } from "./mail.js";

const absentOrWrong = (whenWrong: string) => (issue: { input: unknown }) =>
  issue.input === undefined ? "the variable is not set" : whenWrong;

/** The same shape the gateway holds its own database address to. */
function isPostgresUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "postgres:" || protocol === "postgresql:";
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

/**
 * The shortest secret the cabinet will sign a session with.
 *
 * Thirty-two characters is what `openssl rand -base64 32` produces and it is
 * the length the sentence below tells an operator to make. The floor is on what
 * a deployment is allowed to hand us rather than a claim about strength: what it
 * catches is a placeholder somebody left in a file, not a weak choice by
 * somebody who read the sentence.
 */
const SHORTEST_SECRET = 32;

/**
 * Addresses a link in a message must not be built on.
 *
 * A message goes to somebody else's machine, and a link on this list is an
 * address that means "this machine" wherever it is read. It is a real mistake
 * and not a theoretical one: the public address defaults to localhost so that
 * the cabinet runs on a laptop with nothing set, and a deployment that turns
 * mail on without setting it would send every merchant a link into their own
 * computer.
 */
const NOWHERE_ELSE = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

const environmentSchema = z.object({
  /**
   * Where the cabinet's own accounts and sessions live.
   *
   * The same Postgres as everything else (ADR-0003 §6), and four tables of the
   * cabinet's own in it. Without one there is nowhere to look a session up, so
   * every visitor would be a stranger — a cabinet that draws a sign-in form and
   * can never accept one.
   */
  DATABASE_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(isPostgresUrl, "must be an address of the form postgres://user@host:port/database"),

  /** The port the cabinet answers on; from outside it is behind Caddy. */
  PORT: z
    .string({ error: absentOrWrong("must be a string") })
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .refine((port) => port >= 1 && port <= 65535, "must be within the range 1..65535")
    .default(3001),

  /**
   * Where the gateway answers. Every screen is drawn from calls to this, so a
   * cabinet pointed at nothing draws nothing and says so.
   */
  GATEWAY_URL: z.url().default("http://localhost:3000"),

  /**
   * Where the cabinet is mounted, when it is not at the root of its origin.
   *
   * ADR-0005 §1 puts it at `/cabinet` behind Caddy, and every link and form on
   * every page is built from this. Without it the cabinet works at the root and
   * sends a merchant to `/cards` from `/cabinet/cards`, which is a different
   * place and answers nothing.
   */
  BASE_PATH: z
    .string()
    // A second separator after the first is refused, and a backslash counts as
    // one: "//evil.com" is a path to a regular expression and a
    // protocol-relative URL to a browser, and "/\evil.com" is the same URL to
    // every browser there is, because the URL standard treats the two slashes
    // interchangeably. Either would send every redirect and every stylesheet
    // link to another host — with a merchant's session riding along on the
    // redirect they follow. A backslash is refused anywhere in the value for
    // the same reason: nothing in a mount point needs one.
    .regex(/^(?:|\/(?![/\\])[^\s?#\\]*[^\s?#/\\])$/, 'must be empty or a path such as "/cabinet"')
    .default(""),

  /**
   * Whether the session cookie is marked Secure.
   *
   * It defaults to off because the cabinet is developed over plain http on
   * localhost, where a Secure cookie is simply never sent back and nobody can
   * sign in at all. Anywhere the cabinet is reachable over https this is on,
   * and the deployment that forgets it is handing a merchant's session to
   * anybody on the path.
   */
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /**
   * What the cabinet signs a session cookie with.
   *
   * There is no default and there deliberately is not one. The component that
   * signs in for us has its own fallback, and a deployment that leaned on it
   * would be running on a secret written in somebody else's public source — so
   * the cabinet asks for one rather than accepting whatever is there, and stops
   * when there is none.
   *
   * Changing it signs everybody out and nothing worse: a session is still a row
   * that can be ended on its own, so this secret is not the only way to revoke
   * one. What it buys is that a cookie somebody wrote by hand is refused before
   * a single query is made, which is why the value never leaves this process and
   * never appears in a message this file throws.
   */
  AUTH_SECRET: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(
      (value) => value.length >= SHORTEST_SECRET,
      `must be at least ${SHORTEST_SECRET} characters; make one with: openssl rand -base64 32`,
    ),

  /**
   * The address a merchant reaches this cabinet at, from their own machine.
   *
   * It is what the links in our two messages are built on, and that is its only
   * use — nothing else in the cabinet needs to know its own address, because
   * every link on every page is relative. Behind a reverse proxy the address
   * this process sees is not the address the merchant typed, so it is
   * configuration rather than something read off a request.
   *
   * The default is a laptop, which is where the cabinet is developed and where
   * `sandbox:log` prints the link into the terminal of the person who is about
   * to click it. A deployment that sends real mail is refused with this
   * unchanged, below, because every link it sent would point at the reader's own
   * computer.
   */
  PUBLIC_BASE_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(isHttpUrl, "must be an address of the form https://coinslot.example.com")
    .default("http://localhost:3001")
    .transform((value) => value.replace(/\/+$/, "")),

  /**
   * Where a message goes, or the one address that means nowhere at all.
   *
   * One field with one value, the way the gateway names its facilitator: a
   * deployment that names a provider cannot also be in the sandbox, because
   * there is no second flag to disagree with the first. With the sandbox word
   * every message is written to the log with its recipient and its link, so the
   * whole flow walks with no account, no domain and no network.
   */
  MAIL_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(
      (value) => isSandboxMail(value) || isHttpUrl(value),
      `must be the address of a mail provider, or "${SANDBOX_MAIL}" for a cabinet that sends nothing`,
    )
    .default(SANDBOX_MAIL),

  /** What the provider is called with. Nothing to set in the sandbox. */
  MAIL_API_KEY: z.string().min(1).optional(),

  /**
   * What a message says it is from.
   *
   * Nothing reads mail sent back to it — there is no inbox behind this address
   * and no bounce anybody looks at — so ADR-0009 asks that the address itself
   * say so. A deployment that sends real mail has to name one; the sandbox does
   * not, because the log is not delivered to anybody.
   */
  MAIL_FROM: z.string().min(1).optional(),
});

export interface CabinetConfig {
  readonly port: number;
  readonly gatewayUrl: string;
  readonly basePath: string;
  readonly cookieSecure: boolean;
  readonly databaseUrl: string;
  /** What a session cookie is signed with. Never printed, never on a page. */
  readonly authSecret: string;
  /** What the links in the cabinet's two messages are built on. */
  readonly publicBaseUrl: string;
  readonly mailUrl: string;
  readonly mailApiKey: string | null;
  readonly mailFrom: string;
}

/**
 * What a message says it is from when nothing sends one.
 *
 * Only ever used where `MAIL_URL` is the sandbox word, where the message is
 * written to a log rather than delivered. It says out loud that nobody reads
 * replies, which is the same thing the deployed address is asked to say.
 */
const NOBODY_READS_THIS = "Coinslot <no-reply@localhost>";

export function loadConfig(environment: Record<string, string | undefined>): CabinetConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const variable = issue.path.join(".");
      return variable === "" ? issue.message : `${variable}: ${issue.message}`;
    });
    throw new Error(
      `The cabinet cannot start, the configuration is incomplete — ${problems.join("; ")}`,
    );
  }

  const values = parsed.data;
  const sandboxMail = isSandboxMail(values.MAIL_URL);
  const problems: string[] = [];

  // The same door the gateway keeps between its sandbox and a real facilitator:
  // a credential exists only to talk to a provider, so beside an address that
  // sends nothing it is somebody's leftovers rather than a choice. The mistake
  // worth catching is a production environment file copied onto a sandbox,
  // where it would otherwise sit unused until somebody changed one other line.
  if (sandboxMail && values.MAIL_API_KEY !== undefined) {
    problems.push(
      `MAIL_URL is ${JSON.stringify(SANDBOX_MAIL)}, which sends nothing anywhere, and` +
        " MAIL_API_KEY is set — that credential talks to a real provider, so one of the two is" +
        " left over from somewhere else",
    );
  }

  // And the door the other way. A provider address with nothing to authenticate
  // against it is a cabinet that appears to send mail and silently does not,
  // which is the shape of failure a merchant discovers when they have lost a
  // password and are waiting for a link that was never accepted.
  if (!sandboxMail && values.MAIL_API_KEY === undefined) {
    problems.push(
      `MAIL_URL names a mail provider and MAIL_API_KEY is not set, so nothing would be accepted` +
        ` by it; set MAIL_URL to ${JSON.stringify(SANDBOX_MAIL)} for a cabinet that sends nothing`,
    );
  }

  if (!sandboxMail && values.MAIL_FROM === undefined) {
    problems.push(
      "MAIL_URL names a mail provider and MAIL_FROM is not set, so there is no address for a" +
        " message to come from",
    );
  }

  // A real provider on a public address that means "this machine". Every link
  // in every message would point at the reader's own computer, and the merchant
  // reading it would have no way of knowing that is what happened.
  if (!sandboxMail && NOWHERE_ELSE.has(new URL(values.PUBLIC_BASE_URL).hostname)) {
    problems.push(
      `MAIL_URL names a mail provider and PUBLIC_BASE_URL is ${JSON.stringify(values.PUBLIC_BASE_URL)},` +
        " which means this machine wherever it is read — every link sent would point at the" +
        " reader's own computer",
    );
  }

  if (problems.length > 0) {
    throw new Error(`The cabinet cannot start, the mail is not set up — ${problems.join("; ")}`);
  }

  return {
    port: values.PORT,
    // A trailing slash on the gateway address and the leading slash on every
    // contract path would make every call a double slash, which some proxies
    // route somewhere else entirely.
    gatewayUrl: values.GATEWAY_URL.replace(/\/+$/, ""),
    basePath: values.BASE_PATH,
    cookieSecure: values.COOKIE_SECURE,
    databaseUrl: values.DATABASE_URL,
    authSecret: values.AUTH_SECRET,
    publicBaseUrl: values.PUBLIC_BASE_URL,
    mailUrl: values.MAIL_URL,
    mailApiKey: values.MAIL_API_KEY ?? null,
    mailFrom: values.MAIL_FROM ?? NOBODY_READS_THIS,
  };
}
