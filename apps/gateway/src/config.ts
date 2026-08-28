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

/**
 * The domain Coinbase's facilitator answers on, and the reason it is a domain
 * rather than one address.
 *
 * The published endpoint is `https://api.cdp.coinbase.com/platform/v2/x402`,
 * but the same facilitator is also reached at a staging host and with a
 * trailing slash, and each of those is a deployment that needs credentials
 * exactly as much as the canonical spelling does. A rule that read one exact
 * string would let every other spelling past the door below and hand it to a
 * facilitator that answers nothing unsigned — the failure arriving at the first
 * purchase instead of at startup, which is what the door exists to prevent.
 *
 * Matched on the host and only on the host. A path is not evidence of anything
 * and a prefix match on the whole address would take `cdp.coinbase.com.evil.example`
 * for Coinbase and send it credentials, which is the one mistake here that
 * costs more than a broken deployment.
 */
const CDP_FACILITATOR_DOMAIN = "cdp.coinbase.com";

/**
 * Whether this address is Coinbase's facilitator, which takes no request
 * without credentials.
 *
 * It is the facilitator the pilot settles through, because a product is listed
 * in the Bazaar catalog only after a payment settles through this one
 * (ADR-0001). Every other address — the x402.org testnet facilitator, anything
 * self-hosted — is unauthenticated as far as this gateway knows, and is handed
 * nothing.
 */
export const isCdpFacilitator = (facilitatorUrl: string): boolean => {
  if (!URL.canParse(facilitatorUrl)) {
    return false;
  }
  const { hostname } = new URL(facilitatorUrl);
  return hostname === CDP_FACILITATOR_DOMAIN || hostname.endsWith(`.${CDP_FACILITATOR_DOMAIN}`);
};

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
 * How long the SDK's worker will wait for a poll before it abandons the request
 * and reports the poll failed — `POLL_DEADLINE_MS` in
 * `packages/sdk/src/worker.ts`, which derives it from the window that worker
 * asks for.
 *
 * It is written down here rather than imported: the gateway depends on the
 * contracts and on the core machine, and not on its own client library, so
 * importing it would point the server at the SDK to learn a number. The price
 * of writing it down is that the two can drift apart in silence, and what is
 * paid against that is a comment on each side of the seam naming the other —
 * this one, and the paragraph above `POLL_DEADLINE_MS`.
 *
 * Nothing reads this at run time. It is where the ceiling's number comes from
 * rather than the thing the ceiling protects, and the refusal says so out loud
 * so that an operator who runs into the ceiling is not left guessing.
 */
const SDK_WORKER_POLL_DEADLINE_MS = 50_000;

/**
 * The longest window a deployment may tell the gateway to hold a poll open for.
 *
 * The window below is what a poll that named no window of its own is held for
 * (`http/routes.ts`, `poll_worker`), and it is also the cap on what a poll that
 * did name one can ask for. A worker that names its window is safe from this
 * number by arithmetic — the gateway holds the smaller of the two — so what the
 * ceiling protects is the poll that named none: held past the deadline of the
 * worker waiting on it, it is cut off from the far end, once per poll, with
 * nothing on this side reporting anything wrong.
 *
 * Ten seconds under the deadline, and the headroom is not decoration. The
 * worker's clock starts when it sends the request and this one starts when the
 * request lands, so the far end is always already spending: the connection, the
 * proxies in front of us, the queue's own polling granularity, and the answer's
 * journey back all fall inside the gap. A ceiling set at the deadline itself
 * would lose that race every time.
 *
 * It is a bound and not a target. The default is well under it, and everything
 * between the two is somebody's deliberate choice.
 */
const WORKER_POLL_WAIT_CEILING_MS = 40_000;

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
   * Set to nothing reads the same as never set, and that is the one spelling
   * that matters to whoever unsets it. A deployment says this in a file the
   * process is handed rather than by deleting a line — `SANDBOX_MERCHANT_KEY=`
   * with nothing after it — and the reading where an empty string is a key of
   * length zero refuses the value and stops the process, so an operator who
   * did exactly what the paragraph above asks would find the gateway will not
   * start. There is no reading in which nothing is a key.
   *
   * The length floor is a floor on what a sandbox is allowed to hand out, not
   * on what a real key looks like: a real one is generated with thirty-two
   * bytes behind it and never chosen by anybody.
   */
  SANDBOX_MERCHANT_KEY: z
    .string({ error: absentOrWrong("must be a string") })
    .transform((value) => (value === "" ? null : value))
    .refine(
      (value) => value === null || value.length >= 16,
      "must be at least 16 characters, or empty to seed nothing",
    )
    .nullable()
    .default(null),

  /**
   * The code that stands in the door of registration, or nothing at all.
   *
   * Registration takes no key, because nobody registering has one yet, and this
   * is what stands there instead: one value a person is given along with the
   * address of the site (ADR-0014 §3). Absent, the gateway takes no
   * registrations — and it says so in exactly the words and the status a wrong
   * code gets, so the form is not a way of asking whether registration is open
   * here at all.
   *
   * Set to nothing reads the same as never set, and that spelling is the one
   * that matters to whoever closes registration: a deployment does it by
   * handing the process `REGISTRATION_INVITATION=` in a file rather than by
   * deleting a line, and there is no reading in which nothing is a code
   * somebody could present.
   *
   * Blank and padded values are refused rather than trimmed. The code is
   * compared exactly as written, so a space at either end is a door nobody can
   * open while the configuration reads as though registration were on —
   * repairing it would be us deciding what somebody meant to type, and refusing
   * at start-up is the same news in front of the person who typed it.
   *
   * There is no length floor here, unlike the sandbox key below, and the
   * omission is deliberate: this is a door rather than a lock (ADR-0014 §3),
   * and a number would be a claim about strength that the decision does not
   * make. What it buys is that the pilot's sandbox cannot be filled with a
   * stranger's cards by whoever finds the hostname.
   */
  REGISTRATION_INVITATION: z
    .string({ error: absentOrWrong("must be a string") })
    .transform((value) => (value === "" ? null : value))
    .refine(
      (value) => value === null || /^\S(?:[\s\S]*\S)?$/u.test(value),
      "must not be blank or padded with spaces, because it is compared exactly as written; set it to nothing to take no registrations",
    )
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
   * How long an order may sit paid for before the sweep decides its envelope
   * reached nobody and sends it out again (ADR-0013).
   *
   * Every sale spends some of this window there — an order is paid from the
   * moment the money is in until a worker draws it — so what the number buys is
   * the difference between a merchant who is merely between polls and one whose
   * envelope was never written. Too short and every busy merchant is handed
   * duplicates; too long and an order paid for reaches nobody until its own
   * fulfillment deadline turns it into a debt.
   */
  SWEEP_DISPATCH_GRACE_MS: durationMs(5 * 60 * 1_000),
  /**
   * How many of the payment layer's own words are kept on one order. They are
   * what an operator reconciles a silent charge from, and they arrive on an
   * unauthenticated route, so the list is bounded and what fell off it is
   * counted rather than dropped quietly.
   */
  PAYMENT_WORDS_KEPT: countAbove(20),

  /**
   * How long the gateway holds a worker's poll open (ADR-0004 §1).
   *
   * Bounded above, and what the bound is for is the poll that named no window
   * of its own: that one is held for this number, and nothing here knows when
   * its caller gives up. See `WORKER_POLL_WAIT_CEILING_MS`; the refusal names
   * that caller rather than the SDK's worker, which is safe from this number by
   * arithmetic and would be the wrong reason to give.
   */
  WORKER_POLL_WAIT_MS: durationMs(25_000).refine(
    (value) => value <= WORKER_POLL_WAIT_CEILING_MS,
    `must be at most ${WORKER_POLL_WAIT_CEILING_MS}ms — a poll that named no window of its own is ` +
      "held for this long, and the gateway does not know when the client behind it stops waiting; " +
      `the ceiling keeps that below the ${SDK_WORKER_POLL_DEADLINE_MS}ms at which this project's own ` +
      "worker abandons a poll, which is the only published figure for what a worker here sits through",
  ),
  /** The most envelopes one poll answers with, whatever the worker asked for. */
  WORKER_POLL_MAX_ENVELOPES: countAbove(32),

  /**
   * Where this gateway answers from, which is what a payment challenge names as
   * the thing being paid for. Behind a reverse proxy — the process that ends the
   * agent's TLS connection and passes the request on to us — the address this
   * process sees is not the address the agent called, so it is configuration
   * rather than something read off the request.
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
   * Everything else about this value is refused rather than repaired, and the
   * difference from the slash is that none of it has a reading that was meant.
   * A trim would be us deciding somebody did not mean what they typed; a
   * refusal at start-up is the same news in front of the person who typed it.
   *
   * A query or a fragment lands in the middle of every resource address, which
   * then answers nothing and is still what a listing would be keyed on. So does
   * a space. A scheme written in capitals is kept exactly as written and costs
   * the listing itself: the validation endpoint this repository talks to
   * answers 400 to any resource that does not begin with a lower-case `https`,
   * so such a gateway is absent from the catalog with nothing anywhere saying
   * why. And a user name and password in front of the host would be handed to
   * every agent that asks what a product costs, because this string goes
   * straight into the challenge.
   *
   * Three spellings are left alone and it is worth knowing which: a host in
   * capitals, a host with a trailing dot, and a host written in a script other
   * than Latin. Each makes a second spelling of one product the same way, and
   * each also has a legitimate reading — so settling them is a decision about
   * how far this variable is normalised, and nobody has taken it.
   */
  PUBLIC_BASE_URL: z
    .url()
    .refine(
      (value) => /^https?:\/\//.test(value),
      "must begin with http:// or https:// in lower case, because this string is used exactly as written",
    )
    .refine(
      (value) => !/[?#]/.test(value),
      "must not carry a query or a fragment: a path is joined onto this, so either would end up in the middle of every address",
    )
    .refine(
      (value) => !/\s/.test(value),
      "must not carry a space: this is an address an agent is told to come back to",
    )
    .refine(
      (value) => !/^https?:\/\/[^/@]*@/.test(value),
      "must not carry a user name and password: this address is published to every agent that asks a price",
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
  /** The code registration is behind, or nothing at all, which closes it. */
  readonly registrationInvitation: string | null;
  readonly publicBaseUrl: string;
  /** How many times a reminder that failed is delivered again. */
  readonly reminderAttempts: number;
  readonly reminderRetryDelayMs: number;
  /** How long an order waits when a hand-over met a charge in flight. */
  readonly settleInFlightRetryMs: number;
  /** How long a claim on a payment is kept. */
  readonly claimRetentionMs: number;
  /** How long a paid order may sit before the sweep sends it out again. */
  readonly sweepDispatchGraceMs: number;
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

  // The mirror of the door above, and the one that costs money rather than
  // tidiness. Coinbase's facilitator answers nothing unsigned, so a deployment
  // pointed at it without credentials verifies nothing and settles nothing: the
  // gateway would come up looking healthy, take a purchase, and fail at the
  // charge, in front of a buyer. The names are listed one by one because which
  // of the two is missing is the whole of what an operator needs to fix it.
  if (isCdpFacilitator(environmentValues.FACILITATOR_URL)) {
    const missing = [
      ...(environmentValues.CDP_API_KEY_ID === undefined ? ["CDP_API_KEY_ID"] : []),
      ...(environmentValues.CDP_API_KEY_SECRET === undefined ? ["CDP_API_KEY_SECRET"] : []),
    ];
    if (missing.length > 0) {
      problems.push(
        `FACILITATOR_URL is ${JSON.stringify(environmentValues.FACILITATOR_URL)}, which is Coinbase's ` +
          `facilitator and takes no request without credentials, and ${missing.join(" and ")} ` +
          `${missing.length === 1 ? "is" : "are"} not set — nothing would be verified and nothing ` +
          "would be settled, and the first to find that out would be a buyer",
      );
    }
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
    registrationInvitation: environmentValues.REGISTRATION_INVITATION,
    publicBaseUrl: environmentValues.PUBLIC_BASE_URL,
    reminderAttempts: environmentValues.REMINDER_ATTEMPTS,
    reminderRetryDelayMs: environmentValues.REMINDER_RETRY_DELAY_MS,
    settleInFlightRetryMs: environmentValues.SETTLE_IN_FLIGHT_RETRY_MS,
    claimRetentionMs: environmentValues.CLAIM_RETENTION_MS,
    sweepDispatchGraceMs: environmentValues.SWEEP_DISPATCH_GRACE_MS,
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
