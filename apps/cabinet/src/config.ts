/**
 * What the cabinet has no right to start without.
 *
 * The environment is an external boundary like any other, so it goes through a
 * zod schema (ADR-0003 §5) and the process names every problem at once rather
 * than one per restart.
 *
 * There is no database address here and there never will be. ADR-0005 §3 says
 * the cabinet reaches the gateway through the public API with a merchant's key
 * and holds no connection of its own: if a screen cannot be drawn from the API,
 * the merchant would have hit the same wall.
 */

import { z } from "zod";

const absentOrWrong = (whenWrong: string) => (issue: { input: unknown }) =>
  issue.input === undefined ? "the variable is not set" : whenWrong;

const environmentSchema = z.object({
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
    .regex(/^(?:|\/[^\s?#]*[^\s?#/])$/, 'must be empty or a path such as "/cabinet"')
    .default(""),

  /**
   * Whether the session cookie is marked Secure.
   *
   * It defaults to off because the cabinet is developed over plain http on
   * localhost, where a Secure cookie is simply never sent back and the merchant
   * cannot sign in at all. Anywhere the cabinet is reachable over https this is
   * on, and the deployment that forgets it is handing a merchant's key to
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
  };
}
