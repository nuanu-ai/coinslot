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
 * A whole number of milliseconds above zero, with a default.
 *
 * Every waiting the order machine knows about is one of these, and every one
 * of them arrives from here. That is the rule this file exists to keep: a
 * number invented further down — in a handler, in the queue, in the edge —
 * would be a decision nobody took, made at the moment someone needed a
 * constant. Zero is refused along with the rest, because a deadline of zero is
 * a deadline that has already run out on every order ever created.
 */
const durationMs = (fallback: number) =>
  z
    .string({ error: absentOrWrong("must be a whole number of milliseconds above zero") })
    .regex(/^\d+$/, "must be a whole number of milliseconds above zero")
    .transform(Number)
    .refine((value) => value > 0, "must be a whole number of milliseconds above zero")
    .default(fallback);

const countAbove = (fallback: number) =>
  z
    .string({ error: absentOrWrong("must be a whole number above zero") })
    .regex(/^\d+$/, "must be a whole number above zero")
    .transform(Number)
    .refine((value) => value > 0, "must be a whole number above zero")
    .default(fallback);

/**
 * The environment is just as much an external boundary as someone else's HTTP
 * request, so it goes through a zod schema (ADR-0003 §5). A gateway that
 * started with a half-empty configuration will discover that on the very first
 * payment, and the one to discover it will not be the gateway but the buyer.
 *
 * The defaults are sandbox defaults and they are written here rather than in
 * the code that reads them. The two that have none are the two nobody can
 * guess for us: which database this is and which key opens the merchant's
 * door.
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

  /**
   * The merchant's key, the stage-one minimum of the pilot plan. One merchant,
   * one key. The length floor is not security theatre: the comparison this key
   * goes through is constant-time over equal lengths, and a key short enough to
   * guess makes the care taken over the comparison pointless.
   */
  MERCHANT_API_KEY: z
    .string({ error: absentOrWrong("must be a string") })
    .min(16, "must be at least 16 characters"),

  /** How long we wait for the merchant to say what the goods cost. */
  QUOTE_RESPONSE_MS: durationMs(5_000),
  /** How long a price the merchant has named stays good. */
  QUOTE_TTL_MS: durationMs(30_000),
  /** How long we wait to be told whether the charge went through. */
  SETTLE_RESPONSE_MS: durationMs(2_000),
  /** How long the merchant has to answer a synchronous order with the goods. */
  SYNC_RESPONSE_MS: durationMs(8_000),
  /**
   * The ceiling the portal promises the agent for a synchronous purchase. It is
   * a promise rather than a clock: no deadline in the machine carries this
   * number, and what it does is bound the two that do.
   */
  SYNC_BUDGET_MS: durationMs(10_000),
  /** How long a confirmed order waits for the agent's payment. */
  PAYMENT_AFTER_CONFIRMATION_MS: durationMs(300_000),
  /** What a card that names no confirmation deadline of its own is held to. */
  DEFAULT_CONFIRMATION_RESPONSE_MS: durationMs(3_600_000),
  /** What a card that names no delivery deadline of its own is held to. */
  DEFAULT_ASYNC_FULFILLMENT_MS: durationMs(86_400_000),

  REDELIVERY_BASE_DELAY_MS: durationMs(500),
  /**
   * How much each wait grows on the one before it. One is allowed and means a
   * flat retry; below one the waits would shrink towards zero, which is a
   * merchant already in trouble being hammered.
   */
  REDELIVERY_FACTOR: z
    .string({ error: absentOrWrong("must be at least 1") })
    .regex(/^\d+(?:\.\d+)?$/, "must be at least 1")
    .transform(Number)
    .refine((value) => value >= 1, "must be at least 1")
    .default(2),
  REDELIVERY_MAX_DELAY_MS: durationMs(30_000),
  REDELIVERY_MAX_ATTEMPTS: countAbove(5),

  /** How long the gateway holds a worker's poll open (ADR-0004 §1). */
  WORKER_POLL_WAIT_MS: durationMs(25_000),
  /** The most envelopes one poll answers with, whatever the worker asked for. */
  WORKER_POLL_MAX_ENVELOPES: countAbove(32),

  FACILITATOR_URL: z.url().default("https://x402.org/facilitator"),
  /** A CAIP-2 chain, the way x402 v2 writes networks. */
  PAYMENT_NETWORK: z
    .string()
    .regex(/^[^:\s]+:[^:\s]+$|^[a-z-]+$/, "must be a network name")
    .default("base-sepolia"),
  /** Where the money goes. Absent until a real payment is to be taken. */
  PAY_TO_ADDRESS: z.string().min(1).optional(),
  CDP_API_KEY_ID: z.string().min(1).optional(),
  CDP_API_KEY_SECRET: z.string().min(1).optional(),
});

/** Every waiting the order machine is given, in milliseconds. */
export interface DeadlineConfig {
  readonly quoteResponseMs: number;
  readonly quoteTtlMs: number;
  readonly settleResponseMs: number;
  readonly syncResponseMs: number;
  /** The promised ceiling the two synchronous waits have to fit inside. */
  readonly syncBudgetMs: number;
  readonly paymentAfterConfirmationMs: number;
  readonly defaultConfirmationResponseMs: number;
  readonly defaultAsyncFulfillmentMs: number;
}

export interface RedeliveryConfig {
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
}

export interface WorkerConfig {
  readonly pollWaitMs: number;
  readonly pollMaxEnvelopes: number;
}

export interface PaymentConfig {
  readonly facilitatorUrl: string;
  readonly network: string;
  readonly payTo: string | null;
  readonly cdpApiKeyId: string | null;
  readonly cdpApiKeySecret: string | null;
}

/** The gateway configuration — what the process has no right to start without. */
export interface GatewayConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly merchantApiKey: string;
  readonly deadlines: DeadlineConfig;
  readonly redelivery: RedeliveryConfig;
  readonly worker: WorkerConfig;
  readonly payment: PaymentConfig;
}

/**
 * The arithmetic between the numbers, checked here because nowhere later is
 * anybody looking.
 *
 * Both of these are configurations that fail on a sale rather than at startup,
 * and both fail quietly: the first breaks a promise the portal made to the
 * agent, and the second sells a synchronous product that can never be
 * delivered in time. Refusing to start is the loud version of the same news.
 */
function arithmeticProblems(deadlines: DeadlineConfig): string[] {
  const problems: string[] = [];
  const { syncResponseMs, settleResponseMs, syncBudgetMs, quoteResponseMs } = deadlines;

  // `docs/research/16-order-state-machine.md`: in the synchronous mode the
  // agent's worst case is the merchant's answer plus the charge, because the
  // goods come back on the first clock and the money moves on the second.
  const worstCase = syncResponseMs + settleResponseMs;
  if (worstCase > syncBudgetMs) {
    problems.push(
      `the synchronous budget is ${syncBudgetMs}ms and the answer (${syncResponseMs}ms) and ` +
        `the charge (${settleResponseMs}ms) inside it come to ${worstCase}ms`,
    );
  }

  // The synchronous deadline runs from the purchase itself, so whatever is
  // spent waiting for a price is spent out of it.
  if (quoteResponseMs >= syncResponseMs) {
    problems.push(
      `the wait for the merchant's price is ${quoteResponseMs}ms out of the ${syncResponseMs}ms ` +
        "synchronous answer, which leaves nothing to deliver in",
    );
  }

  return problems;
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

  const environmentValues = parsed.data;

  const deadlines: DeadlineConfig = {
    quoteResponseMs: environmentValues.QUOTE_RESPONSE_MS,
    quoteTtlMs: environmentValues.QUOTE_TTL_MS,
    settleResponseMs: environmentValues.SETTLE_RESPONSE_MS,
    syncResponseMs: environmentValues.SYNC_RESPONSE_MS,
    syncBudgetMs: environmentValues.SYNC_BUDGET_MS,
    paymentAfterConfirmationMs: environmentValues.PAYMENT_AFTER_CONFIRMATION_MS,
    defaultConfirmationResponseMs: environmentValues.DEFAULT_CONFIRMATION_RESPONSE_MS,
    defaultAsyncFulfillmentMs: environmentValues.DEFAULT_ASYNC_FULFILLMENT_MS,
  };

  const problems = arithmeticProblems(deadlines);
  if (problems.length > 0) {
    throw new Error(
      `The gateway cannot start, the deadlines do not add up — ${problems.join("; ")}`,
    );
  }

  return {
    databaseUrl: environmentValues.DATABASE_URL,
    port: environmentValues.PORT,
    merchantApiKey: environmentValues.MERCHANT_API_KEY,
    deadlines,
    redelivery: {
      baseDelayMs: environmentValues.REDELIVERY_BASE_DELAY_MS,
      factor: environmentValues.REDELIVERY_FACTOR,
      maxDelayMs: environmentValues.REDELIVERY_MAX_DELAY_MS,
      maxAttempts: environmentValues.REDELIVERY_MAX_ATTEMPTS,
    },
    worker: {
      pollWaitMs: environmentValues.WORKER_POLL_WAIT_MS,
      pollMaxEnvelopes: environmentValues.WORKER_POLL_MAX_ENVELOPES,
    },
    payment: {
      facilitatorUrl: environmentValues.FACILITATOR_URL,
      network: environmentValues.PAYMENT_NETWORK,
      payTo: environmentValues.PAY_TO_ADDRESS ?? null,
      cdpApiKeyId: environmentValues.CDP_API_KEY_ID ?? null,
      cdpApiKeySecret: environmentValues.CDP_API_KEY_SECRET ?? null,
    },
  };
}
