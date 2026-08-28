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
 *
 * Both answers it reads are one document — where your order stands — so the
 * purchase and the wait are read the same way here, and the only thing the
 * card's mode decides is whether the goods are in the first answer or in a
 * later one.
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

/** What the door calls an identifier it has no order for. */
const NO_SUCH_ORDER = "no_such_order";

/** How much of an unreadable answer is worth printing before it is cut. */
const SHOW_AT_MOST = 500;

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
const comeBackLater = (orderId: string, where: string, why: string): void => {
  console.log(
    `[buyer] ${why}; ${orderId} is still the merchant's to finish, not a sale that ended`,
  );
  console.log(`[buyer] the goods are collected at the door that is the agent's own:`);
  console.log(`  curl -s ${where}`);
};

/**
 * What stands in for a receipt, printed wherever a reader would go looking for
 * one and find none.
 *
 * A reader is owed the difference between a receipt that is missing and one
 * that was never theirs to be given. Neither of the agent's doors carries
 * ours: a receipt is the merchant's own record of the sale, kept behind the
 * merchant's key.
 *
 * What an agent holds instead is not the same in both modes, and saying one
 * sentence for both would credit a proof that is not there. Where the payment
 * executes last — the synchronous sale — the payment layer signs a settlement
 * onto the answer, and that is the agent's word that money moved. Where it
 * executes while the order is being opened, no settlement rides back on this
 * exchange at all, and the price and the test word are the whole of what the
 * agent is told about its own money.
 */
const insteadOfAReceipt = (settled: boolean): void => {
  console.log(
    settled
      ? "[buyer] no receipt here: a receipt is the merchant's own record of the sale. The settlement above is the payment layer's word that the money moved, and the price and the test word are what this door tells an agent about it."
      : "[buyer] no receipt here, and no settlement either: the money moved as the order was opened rather than as the last step of this exchange. The price and the test word above are the whole of what this door tells an agent about the money, and the receipt is the merchant's own record.",
  );
};

/**
 * The refusal code an answer carried, where it was a refusal at all.
 *
 * Read off the document rather than off the HTTP status, and the difference
 * matters here. A proxy between this command and the gateway answers 404 for a
 * route it does not know, in HTML; the gateway's own "there is no such order"
 * is a document that says so. Told apart by the code, the first is a bad read
 * and the second is an answer, which is the whole of what this command has to
 * decide between.
 */
const refusedAs = (body: unknown): string | null => {
  const document = typeof body === "object" && body !== null ? (body as { error?: unknown }) : {};
  const error = document.error;
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
  return typeof code === "string" ? code : null;
};

/**
 * Whether the door has said where this order stands and there is nothing more
 * to wait for.
 *
 * Two answers end the watching: a word from the status vocabulary that is not
 * the running one, and the gateway's own refusal, which no amount of asking
 * again will turn into an order. Everything else — an error page, a body with
 * no state in it, a 502 from something in the middle — is not an answer about
 * the order at all, so the watching goes on. A door that answered badly once
 * has not told us the purchase is over.
 */
const isAnEnding = (seen: OrderStatus): boolean =>
  (seen.state !== null && seen.state !== STILL_RUNNING) || refusedAs(seen.body) === NO_SUCH_ORDER;

/** An answer written out for a reader, cut where it is too long to be read. */
const asFarAsItReads = (body: unknown): string => {
  const written = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return written.length <= SHOW_AT_MOST
    ? written
    : `${written.slice(0, SHOW_AT_MOST)}\n… cut here; ${written.length - SHOW_AT_MOST} more characters came back`;
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

// A paid purchase answers with where the order stands, in the same document
// the agent's own door answers with — so what the card's mode changes is which
// of its fields is filled in, not which shape came back. The goods are there
// where delivery happened on the call, and null where they come later; either
// way the identifier is how this command comes back for them.
const answered = bought.body as {
  readonly delivered?: unknown;
  readonly order_id?: unknown;
} | null;

if (answered?.delivered != null) {
  // The goods were in the purchase answer and this run is over. The reader is
  // owed the same line the waiting path prints, and for the same reason: they
  // have just read a whole answer with no receipt in it.
  insteadOfAReceipt(bought.settlement !== null);
  process.exit(0);
}

const orderId = answered?.order_id;

if (typeof orderId !== "string") {
  console.error(
    "[buyer] the purchase was accepted but named neither the goods nor an order to come back for, so there is nothing to wait on",
  );
  process.exit(1);
}

console.log(
  `[buyer] accepted as ${orderId}; the goods come later, so this waits up to ${WATCH_MS / 1_000}s for them`,
);

// Where this order is collected, settled before anything is asked. It has to be
// printable when nothing came back at all — that is exactly the moment somebody
// needs it — so it is taken from the buyer rather than off an answer.
const where = buyer.statusUrl(orderId);

process.on("SIGINT", () => {
  console.log("");
  comeBackLater(orderId, where, "stopped watching on Ctrl-C");
  process.exit(INTERRUPTED);
});

/**
 * One look at the door, or an end to the watching.
 *
 * An answer that arrived is returned however little sense it made; the throw
 * this catches is a call that never landed — the gateway gone, a name that does
 * not resolve, a socket closed. That is the one case where asking again in a
 * second is not obviously right, and it is the case where the address below
 * matters most: the money has already moved, so a stack trace here would end
 * the wait without telling anybody where the order went.
 */
const look = async (): Promise<OrderStatus> => {
  try {
    return await buyer.status(orderId);
  } catch (thrown) {
    const why = thrown instanceof Error ? thrown.message : String(thrown);
    comeBackLater(orderId, where, `stopped watching: the door could not be reached (${why})`);
    process.exit(1);
  }
};

let seen = await look();

const until = Date.now() + WATCH_MS;
while (!isAnEnding(seen) && Date.now() < until) {
  await sleep(ASK_EVERY_MS);
  seen = await look();
}

if (refusedAs(seen.body) === NO_SUCH_ORDER) {
  // The door's own refusal, which is an answer and not a failure to read one:
  // this gateway has no such order, and asking again would not change that.
  console.error(`[buyer] the agent's door says there is no order called ${orderId}:`);
  console.error(asFarAsItReads(seen.body));
  process.exit(1);
}

if (seen.state === null) {
  // The ceiling ran out and the last thing that came back was not a status this
  // buyer could read. Saying what it was matters — an HTML page names the proxy
  // that wrote it — and so does not calling it an ending: nobody here has been
  // told where the order stands, which is why the address follows.
  console.error(`[buyer] the last answer, ${seen.status}, was not a status this buyer can read:`);
  console.error(asFarAsItReads(seen.body));
  comeBackLater(orderId, where, `stopped watching after ${WATCH_MS / 1_000}s`);
  process.exit(1);
}

if (seen.state === STILL_RUNNING) {
  comeBackLater(orderId, where, `stopped watching after ${WATCH_MS / 1_000}s`);
  // Not a success: this run has no goods to show for itself. Not a failure of
  // the purchase either, and the lines above are where that is said — an exit
  // code has no room for the difference, and the one thing a script must not
  // read from this command is that a sale completed when nobody has seen it.
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
// The settlement is read off the purchase rather than off this answer, because
// this door never carries one: whatever the payment layer signed, it signed
// onto the exchange that moved the money, and a card whose goods come later
// moved it back at the purchase.
insteadOfAReceipt(bought.settlement !== null);
