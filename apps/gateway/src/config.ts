import {
  CDP_FACILITATOR_URL,
  type Environment,
  environmentOf,
  environmentOfKeyPrefix,
  isSandboxFacilitator,
  keyPrefixFor,
  SANDBOX_FACILITATOR,
  type SurfaceMode,
  surfaceModeOf,
} from "@coinslot/core";
import { z } from "zod";

/**
 * The sandbox address and the question about it are the core's, and they are
 * passed straight on from here so that nothing in this package has to know
 * that they moved. The cabinet asks the same question of the same string, and
 * two spellings of one distinguished value is the disagreement the core module
 * exists to remove (ADR-0008, ADR-0020).
 */
export { isSandboxFacilitator, SANDBOX_FACILITATOR };

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

/** Everything Coinbase answers on, of which the facilitator is one host. */
const COINBASE_DOMAIN = "coinbase.com";

/**
 * The host of an address, in the one spelling the comparisons below are written
 * in: lower case, and without the dot that writes a name down to the root.
 *
 * `api.cdp.coinbase.com.` is the same host as `api.cdp.coinbase.com` — the
 * trailing dot is the root label, and it is written by deployments that mean to
 * stop a resolver appending a search domain to it. The URL parser keeps it and
 * lower-cases everything else, so this is where the two spellings become one for
 * a comparison; left apart, the fully qualified spelling would match neither
 * comparison and be handed no credentials at all.
 *
 * The address a running gateway is configured with has already been through
 * `canonicalFacilitatorUrl` before it reaches here, so on that path this finds
 * nothing left to fold. It is still written to stand on its own: this is an
 * exported rule about a host, answerable for any string somebody hands it, and
 * a predicate that quietly returned the wrong answer off the configured path
 * would be one nobody could reuse.
 *
 * Null where the string is not an address, which is a value the callers answer
 * for rather than a case they can forget: an address that cannot be parsed is
 * refused elsewhere by `FACILITATOR_URL`'s own rule.
 */
function hostOf(url: string): string | null {
  if (!URL.canParse(url)) {
    return null;
  }
  return new URL(url).hostname.replace(/\.+$/, "");
}

/** Whether a host is that name or anything under it, and never a look-alike. */
const isUnder = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

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
  const host = hostOf(facilitatorUrl);
  return host !== null && isUnder(host, CDP_FACILITATOR_DOMAIN);
};

/**
 * Whether this address is Coinbase's and yet not the facilitator above.
 *
 * Coinbase answers on more hosts than the one this gateway knows how to sign
 * for, and the difference between the two is the difference between a
 * deployment that works and one that refuses every payment. So the door is
 * written to fail closed: an address under their domain that is not the
 * facilitator's own host stops the gateway at startup instead of quietly
 * building a client with nothing on its requests.
 *
 * A look-alike somebody else registered — `coinbase.com.evil.example` — is not
 * under this domain and is not any of this gateway's business: it asks for
 * nothing, is handed nothing, and starts.
 */
const isOtherCoinbaseHost = (facilitatorUrl: string): boolean => {
  const host = hostOf(facilitatorUrl);
  return host !== null && isUnder(host, COINBASE_DOMAIN) && !isUnder(host, CDP_FACILITATOR_DOMAIN);
};

/**
 * Whether this is the one address a live chain may settle through.
 *
 * Every part of the address is compared, and the reason is that nothing here
 * ever calls this string as it stands: the gateway builds `/verify` and
 * `/settle` under it and hands the result to a client that signs for the host
 * it names. Anything wrong anywhere in it comes up healthy and is discovered
 * at the first buyer.
 *
 * The scheme, because `FACILITATOR_URL` takes `http:` as readily as `https:`
 * and Coinbase is recognised by hostname, so `http://api.cdp.coinbase.com/…`
 * satisfies every other check here and would put both credentials on the wire
 * in the clear. The host, in the one spelling `hostOf` writes every host down
 * to. The port, which has to be the one `https:` already means, because
 * nothing of Coinbase's answers on another — `:443` written out is dropped by
 * the address parser before it reaches this comparison, so the spelling that
 * is merely explicit still passes. A user name and password, which must not be
 * there at all: a request built from an address carrying credentials is
 * refused where it is built, so every call would throw, and the refusal that
 * sends an operator looking would print the password into their log on the way
 * past. The path, with trailing slashes off, because the x402 facilitator
 * client takes those off before it joins `/verify` on — a wrong path under the
 * right host is the failure this whole rule is shaped around, while a trailing
 * slash is the same endpoint and must not be refused. And a query or a
 * fragment, which must be absent, because either would be carried into the
 * middle of every request built under the base.
 *
 * This is a narrower question than `isCdpFacilitator` and does not replace it.
 * That one asks who may be handed credentials, which is a question about a host
 * (ADR-0008); this one asks what a chain where the money is real may settle
 * through, which is a question about one endpoint (ADR-0020).
 */
function isTheLiveFacilitator(facilitatorUrl: string): boolean {
  const host = hostOf(facilitatorUrl);
  if (host === null) {
    return false;
  }
  const given = new URL(facilitatorUrl);
  const wanted = new URL(CDP_FACILITATOR_URL);
  return (
    given.protocol === "https:" &&
    host === wanted.hostname &&
    given.port === "" &&
    given.username === "" &&
    given.password === "" &&
    given.pathname.replace(/\/+$/, "") === wanted.pathname.replace(/\/+$/, "") &&
    given.search === "" &&
    given.hash === ""
  );
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

/**
 * The facilitator's address in the one spelling everything downstream reads.
 *
 * The host is where two spellings of one deployment come from, and the trailing
 * dot is the one that costs money. `https://api.cdp.coinbase.com./…` is the
 * fully qualified name of Coinbase's facilitator: the door above reads it as
 * theirs and lets the gateway start, and then that same string is handed on to
 * the client, which signs a token naming `api.cdp.coinbase.com.` and sends it on
 * a request whose `Host` header carries the dot as well. Whether the far end
 * reads those as one name is not ours to decide, and if it does not, every
 * verify comes back "unknown" and the buyer's agent retries a purchase that can
 * never complete.
 *
 * So it is settled once, here, where the value is read — the same place and for
 * the same reason as the trailing slash on `PUBLIC_BASE_URL`. What comes out of
 * the configuration is the address the door judges, the address the client asks
 * on and the address the signature names, and there is no second spelling left
 * anywhere downstream to disagree with it.
 *
 * Only an http address is touched. `sandbox:scripted` is not one, and anything
 * else that is not one is on its way to being refused by this variable's own
 * rule — repairing either would be answering a question nobody asked.
 */
function canonicalFacilitatorUrl(value: string): string {
  if (!isHttpUrl(value)) {
    return value;
  }
  const url = new URL(value);
  url.hostname = url.hostname.replace(/\.+$/, "");
  return url.href;
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
   * string is also given to the merchant process, next to the database password
   * and for the same reason. Not to the cabinet: it has no merchant key in its
   * configuration at all, and holds one of its own instead, made at every
   * sign-in and typed by nobody (ADR-0014 §2).
   *
   * A deployment sets it too, to a key generated for that host, kept in its own
   * file, and carrying that site's prefix, because the merchant process a stack
   * runs beside the gateway reads its key out of that file and has nothing to
   * present until a row for it exists. A person needs none of this — an
   * invitation makes them a merchant with a key of their own and no terminal
   * (ADR-0014 §3) — so what seeding is for is whatever the stack itself sells
   * as. What to keep in mind is that a key in an environment is a key that
   * cannot be revoked without a deployment, which is the thing keys became rows
   * in order to fix: disabling its row stops it opening anything, and the string
   * is still handed to this process at every start, so a fresh database is
   * seeded off that same line again. So it is unset once nothing presents that
   * key any more — once whatever sells on that host has a key of its own.
   * Absent, this process writes nothing and every key is one somebody made
   * deliberately.
   *
   * Set to nothing reads the same as never set, and that is the one spelling
   * that matters to whoever unsets it. A deployment says this in a file the
   * process is handed rather than by deleting a line — `SANDBOX_MERCHANT_KEY=`
   * with nothing after it — and the reading where an empty string is a key of
   * length zero refuses the value and stops the process, so an operator who
   * did exactly what the paragraph above asks would find the gateway will not
   * start. There is no reading in which nothing is a key.
   *
   * The length floor is a floor on what a stack is allowed to hand out, not on
   * what a real key looks like: a real one is generated with thirty-two bytes
   * behind it and never chosen by anybody. Its prefix says which environment
   * the key belongs to; `loadConfig` checks that separately after it derives
   * the environment from the payment network.
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
   *
   * The host is written down to one spelling on the way through, which is what
   * `canonicalFacilitatorUrl` is for and why it happens here rather than at any
   * of the three places that read this value.
   */
  FACILITATOR_URL: z
    .string({ error: absentOrWrong("must be a string") })
    .refine(
      (value) => value === SANDBOX_FACILITATOR || isHttpUrl(value),
      `must be an http address of a facilitator, or "${SANDBOX_FACILITATOR}" for a gateway with no chain behind it`,
    )
    .default("https://x402.org/facilitator")
    .transform(canonicalFacilitatorUrl),
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
  // The cabinet applies this same rule to its mail key: Compose hands every
  // service a fixed list of names, so an unset credential arrives as its name
  // with nothing after it. A zero-length credential is no credential, not a
  // malformed one that stops a stack whose facilitator asks for neither.
  CDP_API_KEY_ID: emptyIsAbsent(z.string().min(1)),
  CDP_API_KEY_SECRET: emptyIsAbsent(z.string().min(1)),
});

/**
 * A credential set to nothing, read the way a credential nobody set is read.
 *
 * This is not leniency for a malformed secret. Compose has one fixed
 * environment shape for a service, so its spelling of "not for this stack" is
 * an empty value. The rule below then distinguishes that absence from a real,
 * non-empty credential before the facilitator checks make their decision.
 */
function emptyIsAbsent(rule: z.ZodType<string, string>) {
  return z
    .string()
    .optional()
    .transform((given) => (given === undefined || given === "" ? undefined : given))
    .pipe(z.union([z.undefined(), rule]));
}

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
  /** A key this environment is seeded with at start-up, or nothing at all. */
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
  /**
   * Whether this deployment's money is real, derived from the chain and from
   * nothing else. It decides the prefix on every key it issues and the `test`
   * mark on every order and receipt it writes.
   */
  readonly environment: Environment;
  /**
   * What this process is allowed to say it is — a third thing, because a
   * sandbox settles against nothing on a chain whose name says otherwise.
   */
  readonly surfaceMode: SurfaceMode;
}

/**
 * The arithmetic between the numbers, checked here because nowhere later is
 * anybody looking.
 *
 * This is a configuration that fails on a sale rather than at startup, and
 * fails quietly: it breaks a promise the portal made to the agent. Refusing to
 * start is the loud version of the same news.
 *
 * There used to be a second check here, and what it was worth is worth saying.
 * It refused a price wait as long as the synchronous answer, on the ground
 * that the price question was spent out of that answer — which was true only
 * because the answer's clock was wrongly anchored on the opening of the order.
 * The two waits are on separate calls and there is no arithmetic between them:
 * the price is asked and answered on the unpaid call, and the merchant's own
 * clock does not start until a payment has checked out. The check went with
 * the anchoring it described, rather than staying on to refuse a configuration
 * that now works.
 */
function arithmeticProblems(deadlines: DeadlineConfig): string[] {
  const problems: string[] = [];
  const { syncResponseMs, settleResponseMs, syncBudgetMs } = deadlines;

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
  } else if (isOtherCoinbaseHost(environmentValues.FACILITATOR_URL)) {
    // The same door, closed from the other side. Credentials are built for one
    // host and this gateway knows only that one, so any other of Coinbase's is
    // a deployment that would come up with nothing on its requests and be
    // refused at the first charge. Which of the two mistakes it is — a host
    // that moved, or a name typed from memory — is the operator's to tell, and
    // both are cheaper to find here than at a purchase.
    problems.push(
      `FACILITATOR_URL is ${JSON.stringify(environmentValues.FACILITATOR_URL)}, which is a host of ` +
        `Coinbase's that this gateway cannot sign a request for — the facilitator it knows is at ` +
        `${CDP_FACILITATOR_DOMAIN}, and credentials go there and nowhere else. Pointed here it would ` +
        "send none, and a facilitator that takes no request without them refuses every verify and " +
        "every settle in front of a buyer",
    );
  }

  // The chain is read before anything is decided from it, and a chain on
  // neither list ends the process here rather than being sorted into a side.
  // It is pushed onto the same list as the rest so that an operator learns
  // every problem in one restart rather than one variable per restart.
  let chainEnvironment: Environment | null = null;
  try {
    chainEnvironment = environmentOf(network);
  } catch (thrown) {
    problems.push(thrown instanceof Error ? thrown.message : String(thrown));
  }

  // A key in an environment is a key that cannot be revoked without a
  // deployment, which is the thing keys became rows in order to fix. The
  // prefix rule is about which environment a key belongs to and is not a test
  // of whether it is secret — on the public test stack the laptop's default
  // would pass this, which is why the release checks separately that the
  // seeded key is not the value written in this repository.
  const seeded = environmentValues.SANDBOX_MERCHANT_KEY;
  if (chainEnvironment !== null && seeded !== null) {
    const theirs = environmentOfKeyPrefix(seeded);
    if (theirs !== chainEnvironment) {
      problems.push(
        `SANDBOX_MERCHANT_KEY does not carry this environment's prefix — PAYMENT_NETWORK is ` +
          `${JSON.stringify(network)}, which is a ${chainEnvironment} environment, so a key seeded here ` +
          `must begin with ${JSON.stringify(keyPrefixFor(chainEnvironment))}. A key seeded under the ` +
          "other environment's prefix opens nothing, because the door turns it away by its prefix " +
          "before it is looked up",
      );
    }
  }

  // A live chain is allowed exactly one facilitator, and the rule is about the
  // scheme and the path as much as the host.
  //
  // Two of the ways this can be wrong reach a buyer. `sandbox:scripted` on a
  // live chain takes payments that never happened while pointing at a chain
  // where money is real. The unset default is worse because it is silent:
  // FACILITATOR_URL falls back to the public facilitator, so a `.env` copied
  // from the test host with one line changed would start, issue csk_live_
  // keys, show no banner, and settle somewhere the pilot does not settle.
  // Going live must not be something that happens by forgetting a variable.
  //
  // The scheme is here because FACILITATOR_URL accepts http: as readily as
  // https: and Coinbase is recognised by hostname, so
  // `http://api.cdp.coinbase.com/…` satisfies every other check this gateway
  // makes and would put both credentials on the wire in the clear. A bearer
  // token is the whole of the account it was issued to.
  //
  // The path is here because the gateway builds /verify and /settle under
  // whatever base it was given, so a wrong path under the right host starts
  // healthy and fails at the first buyer.
  //
  // Compared by its parts and not as one string. The same deployment is
  // written down several ways — the x402 client takes trailing slashes off the
  // base before joining `/verify` onto it, so `…/x402/` reaches and signs for
  // exactly the same endpoint — and refusing a spelling that works would be
  // this door failing open in the other direction: an operator with a correct
  // live configuration told it is wrong.
  if (chainEnvironment === "live" && !isTheLiveFacilitator(environmentValues.FACILITATOR_URL)) {
    problems.push(
      `PAYMENT_NETWORK is ${JSON.stringify(network)}, where the money is real, and FACILITATOR_URL ` +
        `is ${JSON.stringify(environmentValues.FACILITATOR_URL)} — a live chain settles through ` +
        `${CDP_FACILITATOR_URL} and nothing else, with CDP_API_KEY_ID and CDP_API_KEY_SECRET both ` +
        "set. Nothing else here can verify or settle, and every other value either takes payments " +
        "that never happened or sends credentials somewhere they were not issued for",
    );
  }

  if (payTo !== null && network.startsWith("eip155:") && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    problems.push(
      `PAY_TO_ADDRESS is ${JSON.stringify(payTo)}, which is not an address on ${network}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `The gateway cannot start, these settings do not work together — ${problems.join("; ")}`,
    );
  }

  // Past the throw above, the chain is one of the written ones, so it is asked
  // again rather than carried down here as a null nobody may look at.
  const derivedEnvironment = environmentOf(network);

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
    environment: derivedEnvironment,
    surfaceMode: surfaceModeOf(network, environmentValues.FACILITATOR_URL),
  };
}
