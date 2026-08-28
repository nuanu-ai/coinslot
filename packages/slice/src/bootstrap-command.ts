/**
 * The bootstrap purchase: the one paid call that puts a product in the catalog.
 *
 * A resource does not appear in Coinbase's Bazaar because somebody submitted it.
 * There is no form and no admin page. It appears when a paid call for that exact
 * resource settles through the CDP facilitator, and it appears per resource
 * rather than per domain — the spike that measured this
 * (`docs/research/04-spike-bazaar-listing.md`) paid for one of four resources on
 * one host and got one listing. So every product a merchant publishes needs its
 * own bootstrap purchase, and that is what this command makes.
 *
 * It then goes and looks. The spike measured about twelve minutes from settle to
 * the resource being readable in the discovery catalog, so this waits, walks the
 * catalog, and reports what it saw. What it will not do is report a listing it
 * did not read: a settle nobody can find in the catalog yet is its own verdict
 * with its own words, and it is not a pass.
 *
 * ## What this spends
 *
 * Real money, on a real chain, from the wallet whose key is in the environment,
 * paid straight to the merchant's own address — nothing passes through us
 * (ADR-0019). Two caps stand in front of it and neither can be got past by
 * accident: `SMOKE_MAX_USD` is the ceiling on one purchase and `SMOKE_TOTAL_USD`
 * the ceiling on the whole run, and both are also handed to the payment client
 * as its own spend control, because the client has a hidden default of $1 a
 * payment that silently kills anything larger before it is ever signed.
 *
 * At the defaults — $0.05 a purchase, $0.50 for the run — a catalog of ten
 * one-cent products costs ten cents, and no run can cost more than fifty. There
 * is no default that spends anything at all: without `--confirm` this reads every
 * challenge, runs every gate, prints what a run would cost and stops before
 * anything is signed.
 *
 * ## Testnet or mainnet, and the question this command is the instrument for
 *
 * The CDP facilitator serves both, and which one a purchase lands on is the
 * gateway's own `PAYMENT_NETWORK` rather than anything set here — this end reads
 * the network out of the challenge and refuses a chain where the money is real
 * unless `SMOKE_ALLOW_MAINNET=1` says so out loud. Pointing this at a testnet
 * deployment costs nothing beyond test tokens.
 *
 * Whether that proves anything is an open question and this command is the
 * instrument for it. Both `docs/research/04-spike-bazaar-listing.md` and
 * `docs/research/00-open-questions.md` ask whether Bazaar indexes a testnet
 * settle at all or lists only mainnet; the one listing anybody has measured was
 * on Base mainnet, and the testnet case has never been run. So a run on Base
 * Sepolia that settles and never appears is exactly the measurement, and the
 * verdict for it says so in as many words rather than reading as a fault.
 *
 *   COINSLOT_SMOKE=1 GATEWAY_URL=https://coinslot.example \
 *     SMOKE_BUYER_KEY=0x… pnpm smoke:bootstrap
 *   COINSLOT_SMOKE=1 GATEWAY_URL=https://coinslot.example \
 *     SMOKE_BUYER_KEY=0x… pnpm smoke:bootstrap itm_4d21bb --confirm
 *
 * The key is read from the environment and from nowhere else. It is never
 * printed, never written down, and never put on a command line: `ps` shows one
 * process's arguments to every other user on the machine, so a key passed that
 * way is a key handed out. An argument that looks like one is refused rather
 * than used.
 *
 * ## Where the verdict actually lives
 *
 * In version two of the protocol the body of a 402 is always `{}`. The reason a
 * payment was refused rides in the base64 `PAYMENT-REQUIRED` header, in its
 * `error` field, and the same header carries both "pay me" and "your payment was
 * rejected". A client that does not read it is blind, and the payment wrapper
 * makes that worse by throwing on its own failures while returning a silent 402
 * on the server's. Both are read here, and a refusal is reported in the
 * facilitator's own words.
 */

import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { findDefaultAsset } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

/** Where the public discovery catalog is read. No key, no cost. */
export const DISCOVERY_ENDPOINT =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

/**
 * How many records one page of the catalog is asked for.
 *
 * Measured against the live endpoint rather than read: `limit` is honoured up to
 * at least a thousand, and `offset` is quantised down to a multiple of the limit
 * — so the walk asks at exact multiples and never at an offset the endpoint
 * would round underneath it. The search and filter parameters are ignored
 * outright, which is why presence is a full walk of fifteen-odd pages and not a
 * query.
 */
export const DISCOVERY_PAGE_SIZE = 1000;

/** A ceiling on the walk, so a catalog that never ends does not run forever. */
const MOST_PAGES = 200;

/** Networks where the money is not real. Everything else is treated as mainnet. */
export const TESTNETS = new Set(["eip155:84532", "eip155:11155111", "eip155:80002"]);

/** The default ceiling on one purchase, and on everything a run may spend. */
export const DEFAULT_MAX_USD = "0.05";
export const DEFAULT_TOTAL_USD = "0.50";

/**
 * How long the catalog is watched, and how often.
 *
 * The spike measured about twelve minutes from settle to a resource being
 * readable in discovery. Thirty minutes covers that with room to spare and then
 * stops: a command that waited indefinitely would turn "not listed yet" into a
 * process nobody ever gets an answer out of.
 */
export const DEFAULT_WAIT_MINUTES = 30;
const WALK_EVERY_MS = 120_000;

/** What a private key looks like, which is the one thing never taken from argv. */
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** One product as the public catalog offers it, read for what this command needs. */
export interface CatalogCard {
  readonly id: string;
  readonly title: string;
  /** What the card asks for at the purchase, by the name it asks under. */
  readonly params: Readonly<Record<string, { readonly required?: boolean | undefined }>>;
}

/**
 * A payment challenge, read without paying, in the fields this command decides on.
 *
 * `decimals` and `symbol` are null where the challenge names an asset the
 * network's own table does not know. That is not a detail: without them there is
 * no dollar amount, so there is nothing to hold against a cap, and a purchase
 * with an amount nobody could check is one this command refuses to make.
 */
export interface Challenge {
  /** The canonical address a listing is keyed on, pinned from `PUBLIC_BASE_URL`. */
  readonly resourceUrl: string;
  readonly payTo: string;
  readonly network: string;
  readonly asset: string;
  /** The price in the token's smallest unit, exactly as the challenge wrote it. */
  readonly amount: string;
  readonly decimals: number | null;
  readonly symbol: string | null;
}

/**
 * What the facilitator said about a payment, and the three are not one thing.
 *
 * In version two the `PAYMENT-REQUIRED` header is the same header for "here is
 * what this costs" and for "your payment was rejected, and here is why" — the
 * `error` field is the whole of the difference. So a header with a reason in it
 * is a verdict; a header without one is a challenge and says nothing about the
 * payment; and no header at all on the leg that carried a signature means the
 * exchange did not get as far as anybody having an opinion.
 *
 * Folded into one nullable string, the middle case reads as the last, and a
 * gateway that answered with a price would be reported as a gateway that never
 * reached its facilitator. That is a sentence about somebody else's system,
 * asserted on no evidence.
 */
export type FacilitatorWord =
  | { readonly heard: "verdict"; readonly error: string }
  | { readonly heard: "no reason" }
  | { readonly heard: "nothing" };

/** What one real paid call came to, before anybody has decided what it means. */
export type PurchaseOutcome =
  | {
      readonly kind: "answered";
      readonly status: number;
      /** Whatever the resource said, unread. */
      readonly body: unknown;
      /** The settlement the payment layer signed onto the answer, where it did. */
      readonly settlement: {
        readonly success: boolean;
        readonly transaction: string;
        readonly errorReason?: string | undefined;
        readonly errorMessage?: string | undefined;
        /** What was actually settled, where the scheme says so. */
        readonly amount?: string | undefined;
      } | null;
      /**
       * What the `PAYMENT-REQUIRED` header on the leg that carried a signature
       * had to say, which is where a refusal actually lives.
       */
      readonly facilitatorSaid: FacilitatorWord;
    }
  /**
   * No signed payment ever left this process, so nothing was charged: the
   * client's own spend control, a network it has no signer for, a gateway that
   * did not answer at all.
   */
  | { readonly kind: "client_refused"; readonly why: string }
  /**
   * A signed payment went out and the exchange did not come back. The money may
   * have moved; nobody here knows.
   */
  | { readonly kind: "unreachable"; readonly why: string };

/** One page of the discovery catalog, read for the two things a walk needs. */
export interface DiscoveryPage {
  readonly total: number;
  readonly resources: readonly string[];
}

/** Everything this command has to go outside for. */
export interface Reach {
  /** The buyer's own public address — never the key, which is never printed. */
  readonly buyerAddress: string;
  catalog(): Promise<readonly CatalogCard[]>;
  challenge(itemId: string): Promise<Challenge>;
  purchase(itemId: string, params: Readonly<Record<string, unknown>>): Promise<PurchaseOutcome>;
  discoveryPage(offset: number, limit: number): Promise<DiscoveryPage>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Everything a run was told, once the settings have been read and held to shape. */
export interface Settings {
  readonly baseUrl: string;
  /** Read from the environment and from nowhere else. Never printed. */
  readonly buyerKey: string;
  readonly maxUsd: string;
  readonly totalUsd: string;
  readonly waitMs: number;
  readonly allowMainnet: boolean;
  readonly confirm: boolean;
  readonly named: readonly string[];
  readonly answers: Readonly<Record<string, unknown>>;
}

/** How the way out is built, once there are settings to build it from. */
export type Outside = (settings: Settings) => Reach;

/**
 * What became of one product, and the four are four different things.
 *
 * `listed` is the only one that is a pass. `settled` is a payment that went
 * through and a catalog that does not show it yet, which proves the money moved
 * and proves nothing about the listing. `refused` is somebody's verdict, in
 * their own words. `not attempted` is a gate of ours, with the reason. And
 * `unresolved` is the one that has to exist: a call that never landed, after
 * which nobody can say whether the buyer was charged.
 */
export type Verdict =
  | { readonly said: "listed"; readonly resource: string; readonly afterMs: number }
  | {
      readonly said: "settled";
      readonly resource: string;
      readonly transaction: string | null;
      readonly walks: number;
      readonly overMs: number;
      readonly why: string;
    }
  | { readonly said: "refused"; readonly why: string }
  | { readonly said: "not attempted"; readonly why: string }
  | { readonly said: "unresolved"; readonly why: string };

/**
 * A sum of dollars in the token's smallest unit, or nothing where it does not fit.
 *
 * Money never becomes a float on the way through here, and a cap written to more
 * places than the token carries is refused rather than rounded — a cap that was
 * quietly rounded up is not the cap somebody set.
 */
export function atomicOf(dollars: string, decimals: number): bigint | null {
  if (!/^\d+(?:\.\d+)?$/.test(dollars)) {
    return null;
  }
  const [whole = "0", fraction = ""] = dollars.split(".");
  if (fraction.length > decimals) {
    return null;
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

/** An atomic amount written back out as dollars, exactly. */
export function dollarsOf(atomic: bigint, decimals: number): string {
  const written = atomic.toString().padStart(decimals + 1, "0");
  const whole = written.slice(0, written.length - decimals);
  const fraction = decimals === 0 ? "" : written.slice(written.length - decimals);
  return fraction === "" ? whole : `${whole}.${fraction}`.replace(/\.?0+$/, "");
}

/**
 * Whether one purchase fits inside both caps, given what the run has spent.
 *
 * Both are inclusive: a product priced at exactly the cap is payable, because a
 * cap of five cents that refuses a five-cent product is a cap of four. The
 * arithmetic is in the token's own units and never in dollars as a number, so
 * three two-cent purchases against a six-cent budget is three purchases rather
 * than two and a rounding error.
 */
export function withinCaps(purchase: {
  readonly price: bigint;
  readonly spent: bigint;
  readonly max: bigint;
  readonly total: bigint;
  readonly decimals: number;
}): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  const money = (atomic: bigint): string => `$${dollarsOf(atomic, purchase.decimals)}`;

  if (purchase.price > purchase.max) {
    return {
      ok: false,
      why: `it costs ${money(purchase.price)} and the ceiling on one purchase is ${money(purchase.max)} (SMOKE_MAX_USD)`,
    };
  }
  if (purchase.spent + purchase.price > purchase.total) {
    return {
      ok: false,
      why:
        `it costs ${money(purchase.price)}, this run has already spent ${money(purchase.spent)}, ` +
        `and the ceiling on the run is ${money(purchase.total)} (SMOKE_TOTAL_USD)`,
    };
  }
  return { ok: true };
}

/** The words a status document uses for an order where no money moved. */
const NOTHING_WAS_CHARGED = new Set([
  "rejected",
  "declined",
  "expired",
  "cancelled",
  "delivered_unpaid",
]);

/** And the word for an order where nobody can say whether it was. */
const NOBODY_KNOWS = "payment_unresolved";

/** What one paid call came to: money moved, money did not, or nobody knows. */
export type Payment =
  /** It settled. The transaction is named where the exchange carried a receipt. */
  | { readonly paid: "settled"; readonly transaction: string | null; readonly note: string }
  /** It "settled" against nothing: this gateway has no chain behind it. */
  | { readonly paid: "pretend"; readonly why: string }
  | { readonly paid: "refused"; readonly why: string }
  | { readonly paid: "unresolved"; readonly why: string };

/**
 * What a paid call actually came to, read the way the spike learned to read one.
 *
 * Three things make this longer than a status check, and each of them is a way a
 * run went wrong once. The body of a 402 is empty by specification, so a refusal
 * has to be decoded out of a header. The payment wrapper throws on its own
 * failures and returns a quiet 402 on the server's, so the two arrive by
 * different doors. And a gateway with no chain behind it answers a purchase
 * exactly as a real one does — same status, same document, a settlement receipt
 * and all — so the only thing that tells them apart is that the transaction it
 * names is not a transaction.
 *
 * The last one matters here more than anywhere else, because this command's whole
 * subject is a settle that a catalog will index. A sandbox settle is indexed by
 * nobody, and reported as a settle it would send somebody off to wait half an
 * hour for a listing that was never going to happen.
 */
export function whatBecameOfThePayment(outcome: PurchaseOutcome, network: string): Payment {
  if (outcome.kind === "unreachable") {
    // The fifth gate, in one branch. A call that never landed is not a call that
    // failed: the request may have reached the gateway, the gateway may have
    // reached the facilitator, and the money may be gone. Saying "refused" here
    // would be telling somebody their wallet is untouched on no evidence at all.
    return {
      paid: "unresolved",
      why: `a signed payment went out and the exchange did not come back (${outcome.why}), so whether this was charged is not known here`,
    };
  }
  if (outcome.kind === "client_refused") {
    return {
      paid: "refused",
      why: `no payment was ever presented, so nothing was charged: ${outcome.why}`,
    };
  }

  if (outcome.settlement !== null) {
    const settlement = outcome.settlement;
    if (!settlement.success) {
      const said = settlement.errorMessage ?? settlement.errorReason ?? "no reason given";
      return { paid: "refused", why: `the settlement did not succeed: ${said}` };
    }
    if (!looksLikeATransaction(settlement.transaction, network)) {
      return {
        paid: "pretend",
        why:
          `the settlement names ${JSON.stringify(settlement.transaction)}, which is not a ` +
          `transaction on ${network}. A gateway that settles against nothing answers exactly ` +
          "like this, so there is no settle here for a catalog to index and nothing that shows " +
          "money moved",
      };
    }
    return {
      paid: "settled",
      transaction: settlement.transaction,
      note: "the payment layer signed a settlement onto the answer",
    };
  }

  if (outcome.status >= 400) {
    // The one the spike was blind to for a whole afternoon: a bare 402 with an
    // empty body, and the verdict sitting in a header nobody read.
    return {
      paid: "refused",
      why: `the gateway answered ${outcome.status}: ${said(outcome.facilitatorSaid)}`,
    };
  }

  // A purchase that was accepted and carried no receipt. That is ordinary rather
  // than wrong: where the money moves as the order is opened, the settlement was
  // signed onto an exchange that is already over, and no receipt rides back on
  // this one. So the order's own word is what says whether anything was charged,
  // and the transaction stays unnamed because nothing here ever carried it.
  const state = statusWordOf(outcome.body);
  if (state === null) {
    return {
      paid: "unresolved",
      why: `the gateway answered ${outcome.status} with no settlement and no order status this command could read`,
    };
  }
  if (state === NOBODY_KNOWS) {
    return {
      paid: "unresolved",
      why: "the order says payment_unresolved: the payment network was asked and never answered",
    };
  }
  if (NOTHING_WAS_CHARGED.has(state)) {
    return { paid: "refused", why: `the order closed as ${state}, and no money moved` };
  }
  return {
    paid: "settled",
    transaction: null,
    note:
      `the order stands at ${state} and no settlement rode back on this exchange — this card's ` +
      "money moved as the order was opened, so there is no transaction here to name",
  };
}

/** What the facilitator's word amounts to, in a sentence somebody can act on. */
function said(word: FacilitatorWord): string {
  switch (word.heard) {
    case "verdict":
      return word.error;
    case "no reason":
      return "the PAYMENT-REQUIRED header it sent back carried no reason, so it reads as a fresh challenge rather than as a verdict on the payment";
    case "nothing":
      return "no PAYMENT-REQUIRED header came back with it, so this never got as far as the facilitator";
  }
}

/** Whether a settlement's transaction is one a chain could have. */
function looksLikeATransaction(transaction: string, network: string): boolean {
  if (!network.startsWith("eip155:")) {
    // A hash on a chain this command has never seen is a shape it cannot judge,
    // and inventing a rule for it would refuse working deployments. Anything
    // non-empty passes, and the report says the shape was not checked.
    return transaction.trim() !== "";
  }
  return /^0x[0-9a-fA-F]{64}$/.test(transaction);
}

/** The order's own word for where it stands, or nothing where there is none. */
function statusWordOf(body: unknown): string | null {
  const document =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return typeof document.status === "string" ? document.status : null;
}

/**
 * Whether anything this run does could put this resource in a catalog.
 *
 * The catalog fetches the resource itself — that is what makes a listing a
 * listing — and its own validation endpoint refuses anything that is not an
 * https address outright, measured rather than read (`listing-command.ts` in the
 * gateway says the same and for the same reason). So a resource whose canonical
 * address is `http://localhost:8080/...` cannot be crawled, cannot be validated
 * and will never be listed, however well the payment goes.
 *
 * That address is also the only thing a local sandbox says about itself on the
 * wire. A gateway with no chain behind it warns at the top of its own log and
 * nowhere else: nothing in a challenge, a catalog page or a status document
 * names its facilitator, and the "was this money real" flag every order carries
 * is set for every order at this stage of the pilot, so it distinguishes
 * nothing. What is left is the address, and it is enough for the sandbox anybody
 * actually runs, which is the one on localhost. A sandbox published at a public
 * https address is not caught here — it is caught after the purchase, by a
 * settlement whose transaction is not a transaction, having cost nothing.
 */
export function couldEverBeListed(
  challenge: Challenge,
): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  if (!challenge.resourceUrl.toLowerCase().startsWith("https://")) {
    return {
      ok: false,
      why:
        `the address a listing would be keyed on is ${challenge.resourceUrl}, which is not an ` +
        "https address — the catalog fetches the resource itself and refuses those, so no " +
        "payment could list it. That is what a gateway with no public address looks like from " +
        "out here, and a local sandbox is one",
    };
  }
  return { ok: true };
}

/** Whether the buyer would be paying itself, which the facilitator refuses. */
export function isSelfSend(payTo: string, buyer: string): boolean {
  return payTo.trim().toLowerCase() === buyer.trim().toLowerCase();
}

/** The names this card asks for that the run has no answer to give. */
export function unanswerable(
  card: CatalogCard,
  answers: Readonly<Record<string, unknown>>,
): readonly string[] {
  return Object.entries(card.params ?? {})
    .filter(([name, spec]) => spec.required === true && !(name in answers))
    .map(([name]) => name);
}

const USAGE = [
  "Usage: pnpm smoke:bootstrap [item-id ...] [--confirm]",
  "",
  "Makes the bootstrap purchase that lists a product in Coinbase's Bazaar: one",
  "real paid call per product, then a walk of the discovery catalog until the",
  "resource shows up or the wait runs out. With no product named it does every",
  "purchasable card in the target's catalog.",
  "",
  "It is read from the environment, and the key is never taken from a command",
  "line — ps shows those to everybody on the machine.",
  "",
  "  COINSLOT_SMOKE=1        say out loud that this touches the network",
  "  GATEWAY_URL             the gateway to buy from",
  "  SMOKE_BUYER_KEY         the buyer's private key, 0x and 64 hex characters",
  `  SMOKE_MAX_USD           ceiling on one purchase (default $${DEFAULT_MAX_USD})`,
  `  SMOKE_TOTAL_USD         ceiling on the whole run (default $${DEFAULT_TOTAL_USD})`,
  "  SMOKE_ALLOW_MAINNET=1   consent to a chain where the money is real",
  "  SMOKE_PARAMS            JSON answers for cards that ask for parameters",
  `  SMOKE_WAIT_MINUTES      how long to watch the catalog (default ${DEFAULT_WAIT_MINUTES})`,
  "  --confirm               actually pay; without it nothing is signed",
];

/**
 * Everything a run needs, read out of the environment and held to shape.
 *
 * Every refusal here happens before the way out is built, which is deliberate:
 * a settings mistake should cost nothing and reach no network at all.
 */
export function readSettings(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly settings: Settings }
  | { readonly ok: false; readonly why: readonly string[] } {
  const named = argv.filter((one) => !one.startsWith("--"));
  const confirm = argv.includes("--confirm") || env.SMOKE_CONFIRM === "1";

  // Before anything else, because it is the one mistake that cannot be taken
  // back once it is made: a key on a command line has been shown to every other
  // process on the machine by the time this refuses it, but at least it has not
  // also been used.
  if (argv.some((one) => PRIVATE_KEY.test(one))) {
    return {
      ok: false,
      why: [
        "something on the command line looks like a private key, and this command takes none there.",
        "ps shows one process's arguments to every user on the machine. Put it in SMOKE_BUYER_KEY,",
        "and treat the key that was just typed as one somebody else has now seen.",
      ],
    };
  }

  if (env.COINSLOT_SMOKE !== "1") {
    return {
      ok: false,
      why: [
        "set COINSLOT_SMOKE=1 to run this — it touches the network and, with --confirm, spends real money.",
      ],
    };
  }

  const baseUrl = (env.GATEWAY_URL ?? "").replace(/\/+$/, "");
  if (baseUrl === "") {
    return { ok: false, why: ["set GATEWAY_URL to the gateway to buy from.", ...USAGE] };
  }
  for (const [mark, what] of [
    ["?", "query"],
    ["#", "fragment"],
  ] as const) {
    if (baseUrl.includes(mark)) {
      return {
        ok: false,
        why: [
          `GATEWAY_URL carries a ${what}, and a path is joined onto it, so it would land in the middle of every address.`,
        ],
      };
    }
  }

  const buyerKey = env.SMOKE_BUYER_KEY;
  if (buyerKey === undefined || buyerKey === "") {
    return {
      ok: false,
      why: [
        "set SMOKE_BUYER_KEY to the buyer's private key — there is nothing to pay with otherwise.",
        "It must not be the merchant's own payout wallet: the facilitator refuses a payment whose",
        "payer and payee are the same address, and says self_send_not_allowed.",
      ],
    };
  }
  if (!PRIVATE_KEY.test(buyerKey)) {
    return {
      ok: false,
      // Not the value, and not its length either: a length is a fact about a
      // secret, and this one is either the right shape or it is not.
      why: ["SMOKE_BUYER_KEY is not a private key (expected 0x followed by 64 hex characters)."],
    };
  }

  const maxUsd = env.SMOKE_MAX_USD ?? DEFAULT_MAX_USD;
  const totalUsd = env.SMOKE_TOTAL_USD ?? DEFAULT_TOTAL_USD;
  for (const [name, written] of [
    ["SMOKE_MAX_USD", maxUsd],
    ["SMOKE_TOTAL_USD", totalUsd],
  ] as const) {
    if (!/^\d+(?:\.\d+)?$/.test(written) || Number(written) <= 0) {
      return {
        ok: false,
        why: [`${name} must be a positive amount of dollars, and is ${JSON.stringify(written)}.`],
      };
    }
  }
  if (Number(totalUsd) < Number(maxUsd)) {
    return {
      ok: false,
      why: [
        `SMOKE_TOTAL_USD is $${totalUsd} and SMOKE_MAX_USD is $${maxUsd}, so the ceiling on the run is below the ceiling on one purchase.`,
        "One of the two is not what somebody meant, and guessing which would be spending their money on a guess.",
      ],
    };
  }

  const waitMinutes = Number(env.SMOKE_WAIT_MINUTES ?? String(DEFAULT_WAIT_MINUTES));
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) {
    return {
      ok: false,
      why: ["SMOKE_WAIT_MINUTES must be a number of minutes, and zero means do not wait."],
    };
  }

  let answers: Record<string, unknown> = {};
  const written = env.SMOKE_PARAMS;
  if (written !== undefined && written.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(written);
    } catch (thrown) {
      return { ok: false, why: [`SMOKE_PARAMS is not JSON: ${messageOf(thrown)}`] };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        why: [
          "SMOKE_PARAMS must be a JSON object of answers, keyed by the name a card asks under.",
        ],
      };
    }
    answers = parsed as Record<string, unknown>;
  }

  return {
    ok: true,
    settings: {
      baseUrl,
      buyerKey,
      maxUsd,
      totalUsd,
      waitMs: Math.round(waitMinutes * 60_000),
      allowMainnet: env.SMOKE_ALLOW_MAINNET === "1",
      confirm,
      named,
      answers,
    },
  };
}

/** What one product's run knows about itself, as the run goes on. */
interface Attempt {
  readonly card: CatalogCard;
  readonly challenge: Challenge;
  /** The price in atomic units, where the challenge could be read in dollars. */
  readonly price: bigint;
  readonly decimals: number;
}

export async function runBootstrap(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  outside: Outside,
  say: (line: string) => void,
): Promise<number> {
  const read = readSettings(argv, env);
  if (!read.ok) {
    for (const line of read.why) {
      say(line);
    }
    return 2;
  }
  const settings = read.settings;
  const reach = outside(settings);

  say(`buyer: ${reach.buyerAddress} (the public address; the key is never printed)`);
  say(`target: ${settings.baseUrl}`);
  say(
    `caps: $${settings.maxUsd} per purchase, $${settings.totalUsd} for the run — both are also the payment client's own`,
  );
  say(
    settings.confirm
      ? "mode: LIVE (--confirm). Real money moves."
      : "mode: dry run. Nothing will be signed.",
  );

  let cards: readonly CatalogCard[];
  if (settings.named.length > 0) {
    // Named products are taken as named. A catalog read would only be a second
    // way for this to fail, and the operator has already said which they mean.
    cards = settings.named.map((id) => ({ id, title: id, params: {} }));
  } else {
    try {
      cards = await reach.catalog();
    } catch (thrown) {
      say("");
      say(`The catalog at ${settings.baseUrl} could not be read: ${messageOf(thrown)}`);
      say("Nothing was bought.");
      return 2;
    }
  }

  if (cards.length === 0) {
    // Zero products bought is not zero problems: an empty catalog is exactly the
    // state where nothing was ever published or everything is paused, and that
    // is what somebody running this needs to be told.
    say("");
    say(`There is nothing on sale at ${settings.baseUrl}, so there is nothing to bootstrap.`);
    return 2;
  }

  const verdicts = new Map<string, Verdict>();
  const attempts: Attempt[] = [];
  /** What the run has spent, in the smallest unit of the token it spent it in. */
  let spent = 0n;
  let spentDecimals = 0;

  say("");
  say(`${cards.length} product${cards.length === 1 ? "" : "s"} to bootstrap.`);

  for (const card of cards) {
    say("");
    say(`${card.id} — ${card.title}`);

    let challenge: Challenge;
    try {
      challenge = await reach.challenge(card.id);
    } catch (thrown) {
      say(`  no challenge could be read: ${messageOf(thrown)}`);
      verdicts.set(card.id, {
        said: "not attempted",
        why: `no payment challenge: ${messageOf(thrown)}`,
      });
      continue;
    }

    say(`  resource: ${challenge.resourceUrl}`);
    say(
      `  challenge: ${challenge.amount} ${challenge.symbol ?? challenge.asset} to ${challenge.payTo} on ${challenge.network}`,
    );

    const refusal = gateOneProduct(card, challenge, {
      buyer: reach.buyerAddress,
      settings,
      spent,
    });
    if (refusal !== null) {
      say(`  NOT ATTEMPTED: ${refusal}`);
      verdicts.set(card.id, { said: "not attempted", why: refusal });
      continue;
    }

    // The gate above passed, so the amount was readable and both caps hold.
    const decimals = challenge.decimals ?? 0;
    const price = BigInt(challenge.amount);
    spent += price;
    spentDecimals = decimals;
    attempts.push({ card, challenge, price, decimals });
    say(`  would spend $${dollarsOf(price, decimals)}`);
  }

  if (attempts.length === 0) {
    say("");
    say("Nothing passed the gates, so nothing was bought.");
    summarise(cards, verdicts, 0n, 0, say);
    return 1;
  }

  say("");
  say(
    `${attempts.length} product${attempts.length === 1 ? "" : "s"} would be bought, for $${dollarsOf(spent, spentDecimals)} in total.`,
  );

  if (!settings.confirm) {
    say("");
    say(
      "DRY RUN: every gate passed and NOTHING was signed. No money moved and nothing was listed.",
    );
    say("Re-run with --confirm to make the purchases.");
    // Not zero. Zero is reserved for a run where every product this command
    // attempted is readable in the catalog, and this one attempted none.
    return 2;
  }

  // --- the real purchases ---------------------------------------------------

  say("");
  say("--confirm: buying now.");

  /** What actually left the wallet, as opposed to what the challenges quoted. */
  let paid = 0n;
  /** Products that settled, keyed by the resource address a listing uses. */
  const settled = new Map<
    string,
    { readonly itemId: string; readonly transaction: string | null }
  >();

  /**
   * Why the rest of the run was called off, once something has called it off.
   *
   * There is one thing that does: a settlement that names no transaction. Which
   * facilitator is behind a gateway is a property of the deployment and not of
   * the product, so the next purchase would come back exactly the same, and
   * going on would be paying to learn the same fact again.
   *
   * It is also what keeps the caps sound. A settle this command cannot read is
   * one it cannot count, and a run that went on counting nothing could spend
   * past its own ceiling without the arithmetic ever noticing. Stopping bounds
   * that at one purchase, which is what the per-purchase cap already promises.
   */
  let calledOff: string | null = null;

  for (const attempt of attempts) {
    const { card, challenge, price, decimals } = attempt;
    say("");
    say(`${card.id} — buying`);

    if (calledOff !== null) {
      say(`  NOT ATTEMPTED: ${calledOff}`);
      verdicts.set(card.id, { said: "not attempted", why: calledOff });
      continue;
    }

    // Checked again, against what has actually been spent rather than against
    // the plan. A purchase that cost more than its challenge quoted, or one that
    // settled after this command decided it had not, moves this number, and the
    // cap that matters is the one in front of the next payment.
    const room = withinCaps({
      price,
      spent: paid,
      max: capOr(settings.maxUsd, decimals),
      total: capOr(settings.totalUsd, decimals),
      decimals,
    });
    if (!room.ok) {
      say(`  NOT ATTEMPTED: ${room.why}`);
      verdicts.set(card.id, { said: "not attempted", why: room.why });
      continue;
    }

    const outcome = await reach.purchase(card.id, settings.answers);
    const payment = whatBecameOfThePayment(outcome, challenge.network);

    switch (payment.paid) {
      case "settled": {
        // What was actually settled where the scheme says so, and the quoted
        // amount otherwise. The two differ on schemes that settle less than they
        // authorise, and counting the authorisation would overstate the run.
        const actually = settledAmount(outcome) ?? price;
        paid += actually;
        spentDecimals = decimals;
        say(`  settled: ${payment.transaction ?? "no transaction named"} — ${payment.note}`);
        say(
          `  spent $${dollarsOf(actually, decimals)}, $${dollarsOf(paid, decimals)} so far this run`,
        );
        settled.set(challenge.resourceUrl, { itemId: card.id, transaction: payment.transaction });
        break;
      }
      case "pretend": {
        say(`  NOT ATTEMPTED: ${payment.why}`);
        verdicts.set(card.id, { said: "not attempted", why: payment.why });
        calledOff = `${payment.why} — and that is this gateway rather than this product, so the rest of the run was called off`;
        break;
      }
      case "refused": {
        say(`  REFUSED: ${payment.why}`);
        verdicts.set(card.id, { said: "refused", why: payment.why });
        break;
      }
      case "unresolved": {
        say(`  NO VERDICT: ${payment.why}`);
        verdicts.set(card.id, { said: "unresolved", why: payment.why });
        break;
      }
    }
  }

  // --- the walk -------------------------------------------------------------

  if (settled.size > 0) {
    await watchTheCatalog(reach, settled, settings.waitMs, verdicts, say);
  }

  summarise(cards, verdicts, paid, spentDecimals, say);

  const everyone = cards.map((card) => verdicts.get(card.id));
  const listed = everyone.filter((verdict) => verdict?.said === "listed").length;
  return listed === cards.length && listed > 0 ? 0 : 1;
}

/** The reason one product is not bought, or nothing where there is none. */
function gateOneProduct(
  card: CatalogCard,
  challenge: Challenge,
  run: { readonly buyer: string; readonly settings: Settings; readonly spent: bigint },
): string | null {
  const listable = couldEverBeListed(challenge);
  if (!listable.ok) {
    return listable.why;
  }

  if (isSelfSend(challenge.payTo, run.buyer)) {
    return (
      `this product is paid to ${challenge.payTo}, which is the buyer's own address. The CDP ` +
      "facilitator refuses a payment whose payer and payee are the same and says " +
      "self_send_not_allowed, so this would buy nothing. Use a wallet that is not the merchant's"
    );
  }

  if (!TESTNETS.has(challenge.network) && !run.settings.allowMainnet) {
    return `${challenge.network} is not a known testnet, and real money needs SMOKE_ALLOW_MAINNET=1 said out loud`;
  }

  if (challenge.decimals === null) {
    return (
      `the challenge asks for ${challenge.amount} of ${challenge.asset}, which is not the asset ` +
      `${challenge.network} is known to be paid in, so there is no dollar amount to hold against a cap`
    );
  }

  const missing = unanswerable(card, run.settings.answers);
  if (missing.length > 0) {
    return `this card asks for ${missing.join(", ")}, and this run has no answer for ${missing.length === 1 ? "that name" : "those names"} (SMOKE_PARAMS)`;
  }

  const max = atomicOf(run.settings.maxUsd, challenge.decimals);
  const total = atomicOf(run.settings.totalUsd, challenge.decimals);
  if (max === null || total === null) {
    return `a cap is written to more decimal places than ${challenge.symbol ?? challenge.asset} carries, so it is not an amount that can be charged`;
  }

  const room = withinCaps({
    price: BigInt(challenge.amount),
    spent: run.spent,
    max,
    total,
    decimals: challenge.decimals,
  });
  return room.ok ? null : room.why;
}

/** A cap in atomic units. Only ever called where `gateOneProduct` already read it. */
function capOr(dollars: string, decimals: number): bigint {
  return atomicOf(dollars, decimals) ?? 0n;
}

/** What the settlement says was actually settled, where it says anything. */
function settledAmount(outcome: PurchaseOutcome): bigint | null {
  if (outcome.kind !== "answered" || outcome.settlement?.amount === undefined) {
    return null;
  }
  try {
    return BigInt(outcome.settlement.amount);
  } catch {
    return null;
  }
}

/**
 * The wait, and the whole of what it can prove.
 *
 * The discovery API ignores its own search and filter parameters — measured, not
 * read — so presence in the catalog is established by walking all of it and
 * looking, once every couple of minutes until the resource turns up or the
 * ceiling runs out. Every walk is a line, because a command that goes quiet for
 * half an hour is one somebody kills.
 *
 * Running out is not a failure of the product and the verdict says so. The spike
 * measured twelve minutes on Base mainnet; whether a testnet settle is indexed
 * at all is an open question, and this is the instrument for it.
 */
async function watchTheCatalog(
  reach: Reach,
  settled: ReadonlyMap<string, { readonly itemId: string; readonly transaction: string | null }>,
  waitMs: number,
  verdicts: Map<string, Verdict>,
  say: (line: string) => void,
): Promise<void> {
  const startedAt = reach.now();
  const outstanding = new Map(settled);
  let walks = 0;

  say("");
  say(
    `watching the discovery catalog for ${outstanding.size} resource${outstanding.size === 1 ? "" : "s"}, for up to ${Math.round(waitMs / 60_000)} minutes.`,
  );

  while (outstanding.size > 0) {
    walks += 1;
    let seen: { readonly total: number; readonly found: readonly string[] };
    try {
      seen = await walkOnce(reach, new Set(outstanding.keys()));
    } catch (thrown) {
      say(`  walk ${walks}: the catalog could not be read (${messageOf(thrown)})`);
      seen = { total: 0, found: [] };
    }

    const elapsed = reach.now() - startedAt;
    say(
      `  walk ${walks} at +${written(elapsed)}: ${seen.total} resources in the catalog, ${seen.found.length} of ours among them`,
    );

    for (const resource of seen.found) {
      const one = outstanding.get(resource);
      if (one === undefined) {
        continue;
      }
      outstanding.delete(resource);
      verdicts.set(one.itemId, { said: "listed", resource, afterMs: elapsed });
      say(`  LISTED: ${resource} after ${written(elapsed)}`);
    }

    if (outstanding.size === 0) {
      break;
    }
    if (reach.now() - startedAt >= waitMs) {
      break;
    }
    await reach.sleep(WALK_EVERY_MS);
  }

  const overMs = reach.now() - startedAt;
  for (const [resource, one] of outstanding) {
    verdicts.set(one.itemId, {
      said: "settled",
      resource,
      transaction: one.transaction,
      walks,
      overMs,
      why:
        "the payment settled and the catalog does not show the resource yet. That proves the money " +
        "moved and proves nothing about the listing: the catalog may still be behind, or this chain " +
        "may not be indexed at all",
    });
  }
}

/** One pass over the whole catalog, looking for the addresses we settled for. */
async function walkOnce(
  reach: Reach,
  wanted: ReadonlySet<string>,
): Promise<{ readonly total: number; readonly found: readonly string[] }> {
  const found: string[] = [];
  let offset = 0;
  let total = 0;

  for (let page = 0; page < MOST_PAGES; page += 1) {
    const read = await reach.discoveryPage(offset, DISCOVERY_PAGE_SIZE);
    total = read.total;
    for (const resource of read.resources) {
      if (wanted.has(resource)) {
        found.push(resource);
      }
    }
    offset += read.resources.length;
    // A short page is the end of the catalog, and so is having read as many as
    // it said it holds. The count is checked second and only where there is one:
    // a page that came back full while the total was missing or zero is a
    // catalog that is still going, and stopping on it would be a walk that
    // looked at the first thousand records and reported on all of them.
    if (read.resources.length < DISCOVERY_PAGE_SIZE) {
      break;
    }
    if (read.total > 0 && offset >= read.total) {
      break;
    }
  }

  return { total, found: [...new Set(found)] };
}

/**
 * The real way out: the official payment client, the target's own catalog, and
 * the public discovery endpoint.
 *
 * Everything that can go wrong on the way to a purchase is turned into an
 * outcome rather than thrown, because the caller of this is deciding what became
 * of somebody's money and "it threw" is not one of the answers it is allowed to
 * give. The two doors a failure arrives by are both watched: the client throws
 * on its own refusals — a spend control, a scheme it has no signer for — and the
 * server's refusal comes back as a quiet 402 whose only content is a header.
 *
 * The client is given the run's own cap as its spend control, and that is not
 * belt and braces. It has a hidden default of one dollar a payment, and a
 * challenge above it is dropped before anything is signed, with no error and no
 * sign that a payment was ever attempted — the run before this one lost an
 * afternoon to exactly that.
 *
 * `endpoints` exists so the walk can be exercised against a server standing in
 * this process. Nothing but a test passes it, and what a run uses is the address
 * above.
 */
export function overTheNetwork(
  settings: Settings,
  endpoints: { readonly discovery?: string } = {},
): Reach {
  const account = privateKeyToAccount(settings.buyerKey as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  client.setSpendControls({ maxAmountPerPayment: `$${settings.maxUsd}` });

  /** What each leg of one exchange came to. Cleared at the start of a purchase. */
  let legs: { readonly signed: boolean; readonly word: FacilitatorWord }[] = [];

  const traced: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const signed =
      request.headers.get("payment-signature") !== null ||
      request.headers.get("x-payment") !== null;
    const answered = await fetch(request);

    let word: FacilitatorWord = { heard: "nothing" };
    const header = answered.headers.get("payment-required");
    if (header !== null) {
      try {
        const error = decodePaymentRequiredHeader(header).error;
        word = error === undefined ? { heard: "no reason" } : { heard: "verdict", error };
      } catch {
        word = {
          heard: "verdict",
          error: "a PAYMENT-REQUIRED header came back that this command could not decode",
        };
      }
    }
    legs.push({ signed, word });
    return answered;
  };

  const payFetch = wrapFetchWithPayment(traced, client);
  const purchaseUrl = (itemId: string): string =>
    `${settings.baseUrl}/v0/items/${encodeURIComponent(itemId)}/purchase`;
  const discovery = endpoints.discovery ?? DISCOVERY_ENDPOINT;

  return {
    buyerAddress: account.address,

    async catalog() {
      const at = `${settings.baseUrl}/v0/catalog`;
      const answered = await fetch(at, { headers: { accept: "application/json" } });
      if (!answered.ok) {
        throw new Error(`${at} answered ${answered.status}`);
      }
      const document: unknown = await answered.json();
      const items = (document as { items?: unknown }).items;
      if (!Array.isArray(items)) {
        // A proxy, a login page, a maintenance stub. Saying what it was beats a
        // stack trace about a property of undefined, and this command is run
        // from a checkout that may be older than the deployment — so what is
        // read is the three fields it needs and not the whole document.
        throw new Error("the answer was not a catalog: there is no list of products in it");
      }
      return items.flatMap((entry): CatalogCard[] => {
        const card = entry as { id?: unknown; title?: unknown; params?: unknown };
        if (typeof card.id !== "string" || card.id === "") {
          return [];
        }
        return [
          {
            id: card.id,
            title: typeof card.title === "string" ? card.title : card.id,
            params:
              typeof card.params === "object" && card.params !== null
                ? (card.params as CatalogCard["params"])
                : {},
          },
        ];
      });
    },

    async challenge(itemId) {
      const answered = await fetch(purchaseUrl(itemId), {
        headers: { accept: "application/json" },
      });
      const header = answered.headers.get("payment-required");
      await answered.body?.cancel();
      if (header === null) {
        throw new Error(
          `the gateway answered ${answered.status} with no PAYMENT-REQUIRED header, so there is no challenge to read`,
        );
      }
      const challenge = decodePaymentRequiredHeader(header);
      const requirement = challenge.accepts[0];
      if (requirement === undefined) {
        throw new Error("the challenge carried no payment options");
      }
      // The reverse lookup rather than the network's default: what has to be
      // known is whether this exact asset is one whose decimals are known, and
      // asking for the network's default and comparing would answer a different
      // question and throw on a network the table has never heard of.
      let known: { readonly decimals: number; readonly symbol: string } | undefined;
      try {
        known = findDefaultAsset(requirement.asset, requirement.network);
      } catch {
        known = undefined;
      }
      return {
        resourceUrl: challenge.resource.url,
        payTo: requirement.payTo,
        network: requirement.network,
        asset: requirement.asset,
        amount: requirement.amount,
        decimals: known?.decimals ?? null,
        symbol: known?.symbol ?? null,
      };
    },

    async purchase(itemId, params) {
      legs = [];
      let answered: Response;
      try {
        answered = await payFetch(purchaseUrl(itemId), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ params }),
        });
      } catch (thrown) {
        const why = messageOf(thrown);
        // The client throws for its own refusals — a spend control, a network it
        // has no signer for, a challenge it cannot read — and it throws when a
        // socket dies. For somebody holding a wallet those are two different
        // situations, and what separates them is whether a signed payment ever
        // left this process: it did not, and nothing was charged; it did, and
        // nobody here can say. Counting the legs will not answer that, because
        // the exchange always makes an unpaid call first, so a client that
        // refuses after reading the price has already left one behind.
        return legs.some((leg) => leg.signed)
          ? { kind: "unreachable", why }
          : { kind: "client_refused", why };
      }

      const text = await answered.text();
      let body: unknown;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        body = text;
      }

      const receipt = answered.headers.get("payment-response");
      let settlement: Extract<PurchaseOutcome, { kind: "answered" }>["settlement"] = null;
      if (receipt !== null) {
        try {
          settlement = decodePaymentResponseHeader(receipt);
        } catch {
          settlement = null;
        }
      }

      return {
        kind: "answered",
        status: answered.status,
        body,
        settlement,
        // The word from the leg that carried a signature, which is the only leg
        // whose PAYMENT-REQUIRED is about a payment rather than about the price.
        // No such leg at all is the same news as a leg with no header on it:
        // nothing here got as far as the facilitator.
        facilitatorSaid: legs.filter((leg) => leg.signed).at(-1)?.word ?? { heard: "nothing" },
      };
    },

    async discoveryPage(offset, limit) {
      const at = `${discovery}?offset=${offset}&limit=${limit}`;
      const answered = await fetch(at, { headers: { accept: "application/json" } });
      if (!answered.ok) {
        throw new Error(`the discovery catalog answered ${answered.status}`);
      }
      const document = (await answered.json()) as {
        items?: unknown;
        pagination?: { total?: unknown };
      };
      const items = Array.isArray(document.items) ? document.items : [];
      const resources = items.flatMap((entry): string[] => {
        const resource = (entry as { resource?: unknown }).resource;
        return typeof resource === "string" ? [resource] : [];
      });
      const total = document.pagination?.total;
      return { total: typeof total === "number" ? total : 0, resources };
    },

    sleep: (ms) => new Promise((wake) => setTimeout(wake, ms)),
    now: () => Date.now(),
  };
}

/** The whole run in one place, with the money named whatever happened. */
function summarise(
  cards: readonly CatalogCard[],
  verdicts: ReadonlyMap<string, Verdict>,
  paid: bigint,
  decimals: number,
  say: (line: string) => void,
): void {
  say("");
  say("--- what happened ---");
  for (const card of cards) {
    const verdict = verdicts.get(card.id);
    say(`${card.id}: ${wordFor(verdict)}`);
  }
  say("");
  say(`spent this run: $${dollarsOf(paid, decimals)}`);
}

function wordFor(verdict: Verdict | undefined): string {
  if (verdict === undefined) {
    // Nothing wrote a verdict for this product, which is a fault in this command
    // rather than in the product — and it is still not a pass.
    return "NO VERDICT — nothing in this run said what became of it";
  }
  switch (verdict.said) {
    case "listed":
      return `LISTED — ${verdict.resource} was readable in the catalog ${written(verdict.afterMs)} after the settle`;
    case "settled":
      return (
        `SETTLED, NOT YET LISTED — ${verdict.transaction ?? "no transaction named"}; the catalog was ` +
        `walked ${verdict.walks} time${verdict.walks === 1 ? "" : "s"} over ${written(verdict.overMs)} and ` +
        `${verdict.resource} was not in it. ${verdict.why}`
      );
    case "refused":
      return `PURCHASE REFUSED — ${verdict.why}`;
    case "not attempted":
      return `NOT ATTEMPTED — ${verdict.why}`;
    case "unresolved":
      return `NO VERDICT — ${verdict.why}`;
  }
}

/** A span of time in the words somebody reading a terminal wants. */
function written(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
