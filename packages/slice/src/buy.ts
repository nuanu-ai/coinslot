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
 */

import { makeBuyer } from "./buyer.js";

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
