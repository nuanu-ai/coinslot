/**
 * Which environment a deployment is, derived from the chain it settles on.
 *
 * There is no `COINSLOT_ENV`. The chain is a field the gateway already takes,
 * it holds one value, and a single field cannot disagree with itself — which
 * is the argument ADR-0008 made for the sandbox and the same one made again.
 * A flag beside the chain is a second field that survives a copied `.env`, can
 * be left set from yesterday, and enables the one mistake worth designing
 * against: a gateway that believes it is testing while it moves real money.
 *
 * This module is private to the workspace and deliberately not in
 * `@nuanu-ai/coinslot-contracts`. Its subject is our deployment policy, not
 * the wire: an integrator would gain a chain allowlist they can neither act on
 * nor rely on, and we would gain a public commitment to a list that should
 * stay easy to revisit. The wire's own answer travels where it always has, in
 * the `test` field of an order and a receipt.
 */

/** What a deployment is, for the keys it issues and the mark it writes. */
export type Environment = "test" | "live";

/**
 * What a page is allowed to say, which is a three-way question where the two
 * above are two-way ones. The laptop is the third thing: its chain is Base
 * Sepolia and its facilitator settles against nothing, so a page reading the
 * chain alone would tell a developer their payments settle on Base Sepolia,
 * which is the sandbox's one distinguishing untruth.
 */
export type SurfaceMode = "sandbox" | "test" | "live";

/** The chains whose money is play money. */
export const TESTNET_CHAINS: ReadonlySet<string> = new Set([
  "eip155:84532", // Base Sepolia
  "eip155:11155111", // Ethereum Sepolia
  "eip155:80002", // Polygon Amoy
]);

/**
 * The chains where the money is real — one of them.
 *
 * Ethereum mainnet and Polygon mainnet are deliberately absent. They are
 * chains we do not sell on, and a chain we do not sell on is refused like any
 * other we have not written down; adding one is a decision, not a value
 * somebody types into a file.
 */
export const LIVE_CHAINS: ReadonlySet<string> = new Set([
  "eip155:8453", // Base mainnet
]);

/**
 * The address that selects the scripted facilitator: verify and settle against
 * nothing, and every payment accepted is pretend (ADR-0008).
 *
 * It lives here rather than in the gateway because the cabinet needs the same
 * answer about the same string, and two spellings of one distinguished value
 * is exactly the disagreement this module exists to remove.
 */
export const SANDBOX_FACILITATOR = "sandbox:scripted";

/** Coinbase's facilitator, in the one spelling a live chain is allowed. */
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

/** The public facilitator, which asks for no credentials. */
export const PUBLIC_X402_FACILITATOR_URL = "https://x402.org/facilitator";

/** Whether this deployment settles against nothing. */
export const isSandboxFacilitator = (facilitatorUrl: string): boolean =>
  facilitatorUrl === SANDBOX_FACILITATOR;

/**
 * Whether a chain's money is play money — total, and answering for every
 * string.
 *
 * The spending gates in the smoke commands need an answer about a chain
 * nobody wrote down, and their answer is "not a testnet, so say
 * SMOKE_ALLOW_MAINNET=1 out loud". A derivation that threw there would turn a
 * refusal somebody can read into a stack trace.
 */
export const isTestnetChain = (network: string): boolean => TESTNET_CHAINS.has(network);

const written = (chains: ReadonlySet<string>): string => [...chains].join(", ");

/**
 * Which environment this chain makes, or a refusal.
 *
 * Guessing is wrong in both directions, which is why there is no default side
 * to fall to. Treating an unknown chain as live is the safe reading for
 * spending and the wrong one for the wire: an unlisted test network would
 * issue `csk_live_` keys, drop the banner, and write `test: false` onto every
 * order and receipt — our claim, on somebody else's document, that money moved
 * when it did not. Treating one as a test is worse the other way. So a chain
 * we have not written down is refused, where the difference between "I don't
 * know" and "I know there is none" is still visible to a person.
 */
export function environmentOf(network: string): Environment {
  if (TESTNET_CHAINS.has(network)) {
    return "test";
  }
  if (LIVE_CHAINS.has(network)) {
    return "live";
  }
  throw new Error(
    `PAYMENT_NETWORK is ${JSON.stringify(network)}, which is on neither written list, so there is ` +
      "no honest answer to whether this deployment's money is real. The test chains are " +
      `${written(TESTNET_CHAINS)}; the live chains are ${written(LIVE_CHAINS)}. Adding one is a ` +
      "decision recorded in docs/decisions, not a value typed into an environment file",
  );
}

/**
 * What the surfaces are allowed to say, from the chain and the facilitator
 * together.
 *
 * The chain is read first and on every path, so a chain nobody wrote down is
 * refused in the sandbox exactly as it is anywhere else.
 */
export function surfaceModeOf(network: string, facilitatorUrl: string): SurfaceMode {
  const environment = environmentOf(network);
  return isSandboxFacilitator(facilitatorUrl) ? "sandbox" : environment;
}

/** Where each environment's keys work, for the words the door refuses in. */
export const SITES: Readonly<Record<Environment, string>> = {
  test: "test.coinslot.nuanu.ai",
  live: "coinslot.nuanu.ai",
};

const KEY_PREFIXES: Readonly<Record<Environment, string>> = {
  test: "csk_test_",
  live: "csk_live_",
};

/**
 * What a key issued here starts with, so that one found in a log or a paste is
 * recognisable as ours, searchable by people who scan for leaked credentials,
 * and readable as belonging to one site rather than the other.
 */
export const keyPrefixFor = (environment: Environment): string => KEY_PREFIXES[environment];

/**
 * Which environment a key was issued by, or nothing at all.
 *
 * Nothing is the answer for the bare `csk_` prefix this change removed, and
 * for anything else. The door turns both away; only a key that names the other
 * environment gets the sentence naming the other site, because only that one
 * is a key somebody holds that works somewhere.
 */
export function environmentOfKeyPrefix(secret: string): Environment | null {
  for (const environment of ["test", "live"] as const) {
    if (secret.startsWith(KEY_PREFIXES[environment])) {
      return environment;
    }
  }
  return null;
}

/** The attribute every surface carries, holding the mode it is rendering. */
export const SURFACE_MARKER_ATTRIBUTE = "data-coinslot-surface";

/**
 * What each mode says to a reader, and nothing where there is nothing to warn
 * about.
 *
 * The test wording is the design's own, clause by clause: it claims what the
 * payment was made with and stops there. An earlier draft ended it with "and
 * neither is anything you buy", which this system does not enforce and cannot
 * — a test chain proves what a payment was made with, not what a merchant's
 * worker does when the order reaches it, and the merchants here are real
 * integrators running their own code.
 *
 * The sandbox wording is ADR-0008's own sentence, said to a reader instead of
 * to a log.
 */
export const SURFACE_WORDS: Readonly<Record<SurfaceMode, string | null>> = {
  sandbox:
    "Sandbox. No chain stands behind this stack: every payment it accepts is pretend, nothing " +
    "arrives at the address in a challenge, and no receipt it writes points at a transfer.",
  test:
    "Test environment. Payments settle on Base Sepolia with test funds, and every order and " +
    "receipt here is marked as a test. The live site is coinslot.nuanu.ai.",
  live: null,
};
