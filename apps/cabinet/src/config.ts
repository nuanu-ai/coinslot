/**
 * What the cabinet has no right to start without.
 *
 * The environment is an external boundary like any other, so it goes through a
 * zod schema (ADR-0003 §5) and the process names every problem at once rather
 * than one per restart.
 *
 * There is a database address here and there is exactly one thing it is for:
 * the people who sign into the cabinet and the sessions they are signed in
 * with (ADR-0009). ADR-0005 §3 still holds for everything else — every card,
 * order and receipt on every screen comes from the public API, because the
 * reason that section gives is dogfooding: a screen the cabinet cannot draw is
 * API the merchant does not have either.
 *
 * There is no merchant key here, and its absence is the point rather than an
 * omission. The cabinet used to read one at start-up and use it for the life of
 * the process, which made every screen show that one merchant's money whoever
 * was signed in. The key is on the row of the person signed in now (ADR-0014
 * §2), so a deployment has one less thing to set and one more thing to back up.
 *
 * The one secret left in here is read and never printed. The sentence this file
 * throws names the variable that is wrong and not the value it held, because a
 * startup failure goes to a log and a log goes places the environment does not.
 */

import { z } from "zod";

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

const environmentSchema = z.object({
  /**
   * Where the cabinet's own accounts and sessions live.
   *
   * The same Postgres as everything else (ADR-0003 §6), and two tables of the
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
});

export interface CabinetConfig {
  readonly port: number;
  readonly gatewayUrl: string;
  readonly basePath: string;
  readonly cookieSecure: boolean;
  readonly databaseUrl: string;
}

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

  return {
    port: parsed.data.PORT,
    // A trailing slash on the gateway address and the leading slash on every
    // contract path would make every call a double slash, which some proxies
    // route somewhere else entirely.
    gatewayUrl: parsed.data.GATEWAY_URL.replace(/\/+$/, ""),
    basePath: parsed.data.BASE_PATH,
    cookieSecure: parsed.data.COOKIE_SECURE,
    databaseUrl: parsed.data.DATABASE_URL,
  };
}
