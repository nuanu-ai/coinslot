import { z } from "zod";

/**
 * We tell "the variable is not set" apart from "it is set wrong": the engineer
 * reading a startup error has to see the difference between a line forgotten
 * in the environment and a typo inside it.
 */
function absentOrWrong(whenWrong: string) {
  return (issue: { input: unknown }): string =>
    issue.input === undefined ? "the variable is not set" : whenWrong;
}

function isPostgresUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "postgres:" || protocol === "postgresql:";
}

/**
 * The environment is just as much an external boundary as someone else's HTTP
 * request, so it goes through a zod schema (ADR-0003 §5). A gateway that
 * started with a half-empty configuration will discover that on the very first
 * payment, and the one to discover it will not be the gateway but the buyer.
 */
const environmentSchema = z.object({
  /** One Postgres for everything: orders, receipts, the queue (ADR-0003 §6). */
  DATABASE_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(isPostgresUrl, "must be an address of the form postgres://user@host:port/database"),
  /** The port of the resident process; from outside it is closed off by Caddy. */
  PORT: z
    .string({ error: absentOrWrong("must be a string") })
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .refine((port) => port >= 1 && port <= 65535, "must be within the range 1..65535")
    .default(3000),
});

/** The gateway configuration — what the process has no right to start without. */
export interface GatewayConfig {
  readonly databaseUrl: string;
  readonly port: number;
}

/**
 * Reads the configuration from the environment and names every problem at
 * once rather than the first one it runs into: the engineer bringing the
 * gateway up learns the whole list in one go, not one variable per restart.
 */
export function loadConfig(environment: Record<string, string | undefined>): GatewayConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const variable = issue.path.join(".");
      return variable === "" ? issue.message : `${variable}: ${issue.message}`;
    });

    throw new Error(
      `The gateway cannot start, the configuration is incomplete — ${problems.join("; ")}`,
    );
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
  };
}
