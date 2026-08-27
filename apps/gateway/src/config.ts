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

/**
 * The address that selects the scripted facilitator: the gateway verifies and
 * settles against nothing, and every payment it accepts is pretend.
 *
 * It is a value of `FACILITATOR_URL` rather than a flag beside it, so a
 * configuration cannot hold a real facilitator and the sandbox at once
 * (ADR-0008). The scheme is one nobody can reach, which is what makes a typo a
 * refusal at startup instead of an address that quietly does not answer.
 */
export const SANDBOX_FACILITATOR = "sandbox:scripted";

/** Whether this gateway settles against nothing. */
export const isSandboxFacilitator = (facilitatorUrl: string): boolean =>
  facilitatorUrl === SANDBOX_FACILITATOR;

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
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
   * A key to make sure exists when this process starts, so that a sandbox comes
   * up selling from one command and nobody has to run anything by hand.
   *
   * This is not the key the door checks against — there is no such variable any
   * more (ADR-0010). Keys are rows: this one is written into the row for the
   * merchant everything in a database of this age belongs to, if it is not
   * there already, and after that the door reads it the way it reads every
   * other key. What it buys is the sandbox in `compose.yaml`, where the same
   * string is also given to the cabinet and to the merchant process, next to
   * the database password and for the same reason.
   *
   * Unset it anywhere that is not a sandbox. A key in an environment is a key
   * that cannot be revoked without a deployment, which is the thing keys became
   * rows in order to fix, and a key nobody typed is a key nobody meant to
   * issue. Absent, this process writes nothing and every key is one somebody
   * made deliberately.
   *
   * The length floor is a floor on what a sandbox is allowed to hand out, not
   * on what a real key looks like: a real one is generated with thirty-two
   * bytes behind it and never chosen by anybody.
   */
  SANDBOX_MERCHANT_KEY: z
    .string({ error: absentOrWrong("must be a string") })
    .min(16, "must be at least 16 characters")
    .nullable()
    .default(null),

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

  /**
   * How long the gateway waits for a handler to answer a delivery before it
   * reports the delivery as unanswered. It is not a deadline on the order: the
   * machine takes that report, works out whether another attempt could still
   * land inside the order's own deadline, and answers with a retry or with an
   * ending.
   */
  HANDLER_ANSWER_MS: durationMs(3_000),

  /**
   * How many times a reminder that failed is delivered again. A reminder is the
   * only thing that ever declares an overdue order, so losing one to a store
   * that was briefly unreachable costs a refund nobody marks; delivering it
   * forever would turn a defect into a loop.
   */
  REMINDER_ATTEMPTS: countAbove(3),
  /** How long the queue waits before delivering a failed reminder again. */
  REMINDER_RETRY_DELAY_MS: durationMs(5_000),
  /**
   * How long an order waits before it is offered to a worker again, when the
   * machine turned the hand-over away because a charge on that order was being
   * executed at the time. It is not the redelivery of a failed delivery — that
   * one is the machine's own arithmetic — and it is not the reminder retry.
   */
  SETTLE_IN_FLIGHT_RETRY_MS: durationMs(1_000),
  /**
   * How long a claim on a payment is kept. What it guards is the window between
   * a payment being verified and the charge being executed; after that the token
   * itself refuses the same authorisation twice. The route that makes claims
   * takes no key, so they cannot be kept forever.
   */
  CLAIM_RETENTION_MS: durationMs(30 * 24 * 60 * 60 * 1_000),
  /**
   * How many of the payment layer's own words are kept on one order. They are
   * what an operator reconciles a silent charge from, and they arrive on an
   * unauthenticated route, so the list is bounded and what fell off it is
   * counted rather than dropped quietly.
   */
  PAYMENT_WORDS_KEPT: countAbove(20),

  /** How long the gateway holds a worker's poll open (ADR-0004 §1). */
  WORKER_POLL_WAIT_MS: durationMs(25_000),
  /** The most envelopes one poll answers with, whatever the worker asked for. */
  WORKER_POLL_MAX_ENVELOPES: countAbove(32),

  /**
   * Where this gateway answers from, which is what a payment challenge names as
   * the thing being paid for. Behind a terminator the address the process sees
   * is not the address an agent called, so it is configuration rather than
   * something read off the request.
   *
   * A path is joined onto this string, and everything below follows from that.
   *
   * The trailing slash is taken off here, once. A base written with one
   * produces an address with two slashes in the middle of it — a second
   * spelling of one product, which a discovery catalog reads as a second
   * resource. Whoever wrote the variable cannot be expected to know that, and
   * the two spellings are one deployment: the one place that can settle it is
   * here.
   *
   * A query or a fragment is refused rather than repaired, and the difference
   * from the slash is that neither has a reading that was meant. Joined the
   * same way they land in the middle of every resource address, which then
   * answers nothing at all and is still what a listing would be keyed on. A
   * trim would be us deciding somebody did not mean what they typed; a refusal
   * at start-up is the same news in front of the person who typed it.
   */
  PUBLIC_BASE_URL: z
    .url()
    .refine(
      (value) => !value.includes("?"),
      "must not carry a query: a path is joined onto this, so a query would end up in the middle of every address",
    )
    .refine(
      (value) => !value.includes("#"),
      "must not carry a fragment: a path is joined onto this, so a fragment would end up in the middle of every address",
    )
    .default("http://localhost:3000")
    .transform((value) => value.replace(/\/+$/, "")),

  /**
   * The facilitator, or the one address that means there is no chain behind
   * this gateway at all (ADR-0008). It is one field with one value on purpose:
   * a deployment that names a real facilitator cannot also be in the sandbox,
   * because there is no second flag to disagree with the first.
   */
  FACILITATOR_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(
      (value) => value === SANDBOX_FACILITATOR || isHttpUrl(value),
      `must be an http address of a facilitator, or "${SANDBOX_FACILITATOR}" for a gateway with no chain behind it`,
    )
    .default("https://x402.org/facilitator"),
  /**
   * The chain, written the way x402 version two writes one: a CAIP-2
   * identifier. The default is Base Sepolia, the test network — a gateway that
   * defaulted to a chain where the money is real would make going live
   * something that happens by forgetting a variable.
   */
  PAYMENT_NETWORK: z
    .string()
    .regex(/^[^:\s]+:[^:\s]+$/, "must be a CAIP-2 chain such as eip155:84532")
    .default("eip155:84532"),
  /**
   * How long a challenge stays payable, in seconds. It is the number the
   * payment authorisation itself is signed against, so it belongs to the
   * protocol rather than to the order machine.
   */
  PAYMENT_TIMEOUT_SECONDS: countAbove(300),
  /**
   * Where the money goes. Absent until a real payment is to be taken, and held
   * to the shape of the chain it is on when it is there: this address goes
   * straight into the challenge that invites an agent to pay it, and a
   * truncated paste would invite them to pay nobody.
   */
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
  /** How long a delivery may go unanswered before it is reported unanswered. */
  readonly handlerAnswerMs: number;
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
  readonly timeoutSeconds: number;
  readonly payTo: string | null;
  readonly cdpApiKeyId: string | null;
  readonly cdpApiKeySecret: string | null;
}

/** The gateway configuration — what the process has no right to start without. */
export interface GatewayConfig {
  readonly databaseUrl: string;
  readonly port: number;
  /** A key the sandbox is seeded with at start-up, or nothing at all. */
  readonly sandboxMerchantKey: string | null;
  readonly publicBaseUrl: string;
  /** How many times a reminder that failed is delivered again. */
  readonly reminderAttempts: number;
  readonly reminderRetryDelayMs: number;
  /** How long an order waits when a hand-over met a charge in flight. */
  readonly settleInFlightRetryMs: number;
  /** How long a claim on a payment is kept. */
  readonly claimRetentionMs: number;
  /** How many of the payment layer's own words one order keeps. */
  readonly paymentWordsKept: number;
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
    handlerAnswerMs: environmentValues.HANDLER_ANSWER_MS,
  };

  const problems = arithmeticProblems(deadlines);
  const payTo = environmentValues.PAY_TO_ADDRESS ?? null;
  const network = environmentValues.PAYMENT_NETWORK;

  // An address on an EVM chain has one shape. Everything else money-adjacent in
  // this file is held to its shape; the address the money actually goes to was
  // held to "not empty", which starts the gateway on a truncated paste and puts
  // it in front of every agent that asks what a product costs.
  // The mistake worth catching here is a production environment file copied
  // onto a sandbox. A facilitator's credentials exist only to talk to a real
  // facilitator, so beside an address that settles against nothing they are
  // somebody's leftovers and not a choice (ADR-0008).
  //
  // PAY_TO_ADDRESS is deliberately not part of this: the payment challenge
  // cannot be built without one (`http/x402.ts`), so a sandbox that refused it
  // could not sell anything, which is the whole reason the sandbox exists.
  if (
    isSandboxFacilitator(environmentValues.FACILITATOR_URL) &&
    (environmentValues.CDP_API_KEY_ID !== undefined ||
      environmentValues.CDP_API_KEY_SECRET !== undefined)
  ) {
    problems.push(
      `FACILITATOR_URL is ${JSON.stringify(SANDBOX_FACILITATOR)}, which settles against nothing, ` +
        "and CDP_API_KEY_ID or CDP_API_KEY_SECRET is set — those talk to a real facilitator, " +
        "so one of the two is left over from somewhere else",
    );
  }

  if (payTo !== null && network.startsWith("eip155:") && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    problems.push(
      `PAY_TO_ADDRESS is ${JSON.stringify(payTo)}, which is not an address on ${network}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`The gateway cannot start, the numbers do not add up — ${problems.join("; ")}`);
  }

  return {
    databaseUrl: environmentValues.DATABASE_URL,
    port: environmentValues.PORT,
    sandboxMerchantKey: environmentValues.SANDBOX_MERCHANT_KEY,
    publicBaseUrl: environmentValues.PUBLIC_BASE_URL,
    reminderAttempts: environmentValues.REMINDER_ATTEMPTS,
    reminderRetryDelayMs: environmentValues.REMINDER_RETRY_DELAY_MS,
    settleInFlightRetryMs: environmentValues.SETTLE_IN_FLIGHT_RETRY_MS,
    claimRetentionMs: environmentValues.CLAIM_RETENTION_MS,
    paymentWordsKept: environmentValues.PAYMENT_WORDS_KEPT,
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
      network,
      timeoutSeconds: environmentValues.PAYMENT_TIMEOUT_SECONDS,
      payTo,
      cdpApiKeyId: environmentValues.CDP_API_KEY_ID ?? null,
      cdpApiKeySecret: environmentValues.CDP_API_KEY_SECRET ?? null,
    },
  };
}
