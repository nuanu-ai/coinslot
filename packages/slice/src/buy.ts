/**
 * One purchase, against a gateway that is already running.
 *
 * The buyer is the official x402 client with a throwaway key, the same one the
 * offline gate uses — it reads the catalogue, meets the payment challenge,
 * signs, and reads back whatever the resource answers. Nothing about the
 * exchange is simulated on this side.
 *
 * What is not real is the other end. This is meant for the local stack, where
 * the gateway settles against nothing (ADR-0008), so no money moves and the key
 * below needs to hold nothing. Pointed at a gateway with a real facilitator
 * behind it, this would sign a real transfer — which is why the command says
 * which gateway it is talking to before it does anything, and why the smoke
 * command, not this one, is the thing with a spending cap and a dry run.
 *
 *   GATEWAY_URL=http://localhost:8080 pnpm --filter @coinslot/slice buy
 *   GATEWAY_URL=http://localhost:8080 pnpm --filter @coinslot/slice buy esim
 *
 * With no argument it buys the first card in the catalogue. With one, it takes
 * the card whose catalogue identifier matches it exactly, or failing that the
 * first whose title contains it — which is the only handle an agent has. The
 * merchant's own identifier for a product is deliberately not in the public
 * card, so nothing outside can select by it.
 *
 * A card whose goods come later does not answer with them, and this command
 * does not stop there. It waits, asking the door that is the agent's own
 * (ADR-0011) with the identifier the purchase handed back, and prints the goods
 * when they arrive. What it will not do is pretend the wait is the purchase:
 * when the ceiling below runs out, or the reader interrupts it, the order is
 * still the merchant's to finish and the command says where to collect it
 * rather than reporting a sale that ended.
 */

import { makeBuyer, type OrderStatus } from "./buyer.js";

/**
 * A public, valueless test key — the first well-known local-devnet account, the
 * same one the offline gate signs with. Against a gateway that settles against
 * nothing it holds nothing and risks nothing.
 */
const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * What this buyer knows how to answer, by the name a card asks under.
 *
 * A card declares what it needs at purchase, and the gateway refuses a purchase
 * missing a required one before any payment, so filling these in is part of
 * buying rather than decoration. Reading them off the card is also the honest
 * shape: an agent holds the card and nothing else, and a name it has never seen
 * is one it cannot invent — which is why the unknown case below stops rather
 * than guessing.
 */
const KNOWN_ANSWERS: Record<string, unknown> = {
  email: "buyer@example.com",
  area_code: "415",
};

/**
 * How long this command watches an order whose goods come later.
 *
 * It is a ceiling on the watching and not a deadline on the order. The
 * merchant's own deadline is the card's, it is longer than this, and the order
 * goes on running after this command has stopped looking — which is why
 * running out here prints where to collect rather than an ending.
 */
const WATCH_MS = 60_000;

/** How often the agent's door is asked while an order is still running. */
const ASK_EVERY_MS = 1_000;

/**
 * The one word that means a purchase has not finished. Every other word in the
 * status vocabulary is an ending of some kind, so watching stops on it and the
 * command prints whatever it was told rather than deciding what it meant.
 */
const STILL_RUNNING = "in_progress";

/**
 * The exit code for a reader who interrupted the wait.
 *
 * 128 + SIGINT, which is what a shell writes for a process its own Ctrl-C
 * killed. It is here because this command catches the signal in order to say
 * where the goods can be collected, and a command that catches a signal and
 * then exits 0 or 1 has told the shell that it finished on its own.
 */
const INTERRUPTED = 130;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Where an order left off, said in full, followed by how to come back for it.
 *
 * The wording is the point rather than the format. This command stopping is not
 * the purchase stopping, and the two are easy to run together — so what is
 * printed is an address the reader can paste, for this order and no other.
 */
const comeBackLater = (orderId: string, seen: OrderStatus, why: string): void => {
  console.log(
    `[buyer] ${why}; ${orderId} is still the merchant's to finish, not a sale that ended`,
  );
  console.log(`[buyer] the goods are collected at the door that is the agent's own:`);
  console.log(`  curl -s ${seen.url}`);
};

/** The answers for one card, or the names this buyer cannot supply. */
const answersFor = (
  params: Readonly<Record<string, { readonly required?: boolean | undefined }>> | undefined,
): { readonly answers: Record<string, unknown> } | { readonly missing: readonly string[] } => {
  const answers: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(params ?? {})) {
    if (name in KNOWN_ANSWERS) {
      answers[name] = KNOWN_ANSWERS[name];
    } else if (spec.required === true) {
      missing.push(name);
    }
  }
  return missing.length > 0 ? { missing } : { answers };
};

const baseUrl = process.env.GATEWAY_URL ?? "http://localhost:8080";
const wanted = process.argv[2];

const buyer = makeBuyer({ baseUrl, privateKey: TEST_BUYER_KEY, maxUsd: 50 });

console.log(`[buyer] ${buyer.address} against ${baseUrl}`);

const catalog = await buyer.catalog();
if (catalog.length === 0) {
  console.error(
    "[buyer] the catalogue is empty — nothing has been published, so there is nothing to buy",
  );
  process.exit(1);
}

const needle = wanted?.toLowerCase();
const card =
  needle === undefined
    ? catalog[0]
    : (catalog.find((one) => one.id === wanted) ??
      catalog.find((one) => one.title.toLowerCase().includes(needle)));

if (card === undefined) {
  console.error(
    `[buyer] nothing in the catalogue is called ${JSON.stringify(wanted)}; it holds:\n${catalog
      .map((one) => `  ${one.id}  ${one.title}`)
      .join("\n")}`,
  );
  process.exit(1);
}

console.log(
  `[buyer] buying ${card.id} — ${card.title}, listed at ${card.price.amount} ${card.price.currency}${
    card.price_checked_at_purchase ? " (the price is asked for at the purchase)" : ""
  }`,
);

const filled = answersFor(card.params);
if ("missing" in filled) {
  console.error(
    `[buyer] this card asks for ${filled.missing.join(", ")}, and this buyer has no answer for that name`,
  );
  process.exit(1);
}

const bought = await buyer.buy(card.id, filled.answers);

console.log(`[buyer] answered ${bought.status}`);
console.log(JSON.stringify(bought.body, null, 2));

if (bought.settlement !== null) {
  console.log(`[buyer] settlement: ${JSON.stringify(bought.settlement)}`);
}

// A purchase that the resource refused is a failed run, not a quiet one: the
// exit code is what a script around this command reads.
if (bought.status >= 400) {
  process.exit(1);
}

// What a paid purchase answers with depends on the card's mode: the goods
// themselves where delivery happens on the call, an order to come back for
// where it does not. Both were printed above; only the second has anywhere
// left to go.
const answered = bought.body as { readonly delivered?: unknown; readonly order?: unknown } | null;

if (answered?.delivered !== undefined) {
  process.exit(0);
}

const order = answered?.order;
const orderId = typeof order === "object" && order !== null ? (order as { id?: unknown }).id : null;

if (typeof orderId !== "string") {
  console.error(
    "[buyer] the purchase was accepted but carried neither the goods nor an order to come back for, so there is nothing to wait on",
  );
  process.exit(1);
}

console.log(
  `[buyer] accepted as ${orderId}; the goods come later, so this waits up to ${WATCH_MS / 1_000}s for them`,
);

// The first look is taken before the signal is caught, because catching it is
// only worth anything once there is an address to print, and that address comes
// off the answer. A Ctrl-C inside this one round trip kills the process the
// ordinary way, which is the truth of it: nothing was being watched yet.
let seen = await buyer.status(orderId);

process.on("SIGINT", () => {
  console.log("");
  comeBackLater(orderId, seen, "stopped watching on Ctrl-C");
  process.exit(INTERRUPTED);
});

const until = Date.now() + WATCH_MS;
while (seen.state === STILL_RUNNING && Date.now() < until) {
  await sleep(ASK_EVERY_MS);
  seen = await buyer.status(orderId);
}

if (seen.state === STILL_RUNNING) {
  comeBackLater(orderId, seen, `stopped watching after ${WATCH_MS / 1_000}s`);
  // Not a success: this run has no goods to show for itself. Not a failure of
  // the purchase either, and the lines above are where that is said — an exit
  // code has no room for the difference, and the one thing a script must not
  // read from this command is that a sale completed when nobody has seen it.
  process.exit(1);
}

if (seen.state === null) {
  // The door answered something this buyer cannot read as a state at all — a
  // refusal, most likely. It is printed as it arrived rather than summarised,
  // because what it says is the only thing anybody here knows.
  console.error(`[buyer] the agent's door answered ${seen.status} and no order status:`);
  console.error(JSON.stringify(seen.body, null, 2));
  process.exit(1);
}

console.log(`[buyer] the order closed as ${seen.state}, as the agent's own door tells it:`);
console.log(JSON.stringify(seen.body, null, 2));

if (seen.state !== "delivered") {
  // Every other ending is an ending without goods, and this command does not
  // rank them: the word above is the merchant's and the gateway's, printed
  // whole. A run that ends here bought nothing.
  process.exit(1);
}

console.log(`[buyer] the goods:`);
console.log(JSON.stringify(seen.delivered, null, 2));
// Said because the purchase above printed `receipt: null` and a reader is owed
// the difference between a receipt that is missing and one that was never this
// door's to give. The price and the `test` word in the document above are what
// an agent is handed; the receipt is written into the merchant's own record.
console.log(
  "[buyer] this door carries no receipt: the price and the test word above are the agent's proof, and the receipt is the merchant's record",
);
