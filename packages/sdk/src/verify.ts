/**
 * `npx coinslot verify` — the check a merchant runs on themselves before they
 * ask us to look.
 *
 * The portal describes two checks. Is the card enough for an agent to assemble
 * a correct purchase, and does the merchant's handler hold idempotency — that
 * is, does a second delivery appear when one and the same order arrives twice.
 *
 * The first is here in full. The second is not, and this file refuses to
 * pretend otherwise: it names what is missing, in the same words anyone can
 * check against the route table, and answers with a code of its own that says
 * "did not run" rather than "passed" or "failed". The reasons are written out
 * in `IDEMPOTENCY_IS_NOT_BUILDABLE` below and are worth reading before anybody
 * tries to add the check, because the gap is not in this package.
 *
 * Which cards are checked is asked for rather than discovered. Nothing in this
 * package, in the contract or in any decision says where a merchant keeps
 * their cards, and a command that went looking would be inventing a
 * convention — a file name, a directory, a manifest — that nobody agreed to
 * and that every merchant would then have to work around.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { checkCard } from "./check-card.js";
import { describeProblems } from "./schema.js";

/**
 * What the command answers with.
 *
 * Four and not two, because a build that branches on this needs to tell a
 * check that failed from a check that never ran. Collapsing the two would make
 * a missing check look like a passing one on the day somebody decides that
 * anything non-zero is a failure and anything else is fine.
 */
export const VERIFY_EXIT = Object.freeze({
  /** Every check ran and every check passed. */
  PASSED: 0,
  /** A check ran and found something. */
  PROBLEMS: 1,
  /** The command was called with something it cannot work from. */
  USAGE: 2,
  /** A check could not be run at all, so nothing is claimed about it. */
  COULD_NOT_RUN: 3,
});

/**
 * Why the idempotency run is not in this version, stated so it can be checked
 * rather than taken on trust.
 *
 * The run the portal describes needs a test order to exist: the same order
 * delivered twice through the live subscription, marked `test`, against a card
 * that is published but not yet in any catalog. Four things it needs are
 * absent, and none of them is ours to add here.
 *
 * There is no route that asks for one. The only way an order comes into being
 * on this surface is `purchase_item`, and that is the payment exchange itself
 * — an agent buying — not a request a merchant can make about their own card.
 *
 * `PurchaseRequestSchema` is closed and carries the purchase parameters and
 * nothing else, so there is nowhere in a purchase to say "this one is a test".
 *
 * Nothing says how an order's `test` flag comes to be true. The order carries
 * it, the handler is told to branch on it, and no document in the contract
 * describes who sets it or from what.
 *
 * And a card carries no marker for "published, not yet in catalogs", which is
 * the state the portal says these orders are raised against.
 *
 * Behind all four sits a question the portal lists as open: whether the
 * sandbox is a separate environment, a separate key, or only that flag on the
 * order. Inventing a route or a field here would answer it, and this is not
 * the place where that is answered.
 */
export const IDEMPOTENCY_IS_NOT_BUILDABLE = [
  "The idempotency run needs a test order, and nothing on the surface can ask for one:",
  "  - no route raises an order for a merchant's own card; the only way an order",
  "    comes into being is purchase_item, which is an agent's payment exchange",
  "  - purchase_item's body carries the purchase parameters and nothing else, so",
  "    there is nowhere in it to say that a purchase is a test",
  "  - nothing in the contract says how an order's test flag comes to be true",
  "  - a card carries no marker for published-but-not-yet-in-catalogs, which is",
  "    the state the documentation raises these orders against",
  "Behind all four is an open question — whether the sandbox is a separate",
  "environment, a separate key, or only that flag on the order — and inventing a",
  "route or a field here would be answering it.",
].join("\n");

interface CardFile {
  readonly path: string;
  /**
   * How the card is named in the report: the file, and beside it the
   * merchant's own key where the file carries one.
   *
   * Both, because they answer different questions. The file is what the
   * merchant edits; the key is what their database and every order call it,
   * and a report that gave only the file would leave them matching one to the
   * other by hand across a directory of cards.
   */
  readonly name: string;
  readonly problems: readonly { readonly path: string[]; readonly message: string }[];
}

const nameOf = (file: string, card: unknown): string => {
  const key =
    typeof card === "object" && card !== null && "merchant_item_id" in card
      ? (card as { merchant_item_id: unknown }).merchant_item_id
      : undefined;

  return typeof key === "string" && key !== "" ? `${file} (${key})` : file;
};

const USAGE = [
  "Usage: coinslot verify <card.json> [more-cards.json ...]",
  "",
  "Checks each card against the published contract before it is published.",
  "The cards are named on the command line: nothing here knows where a",
  "merchant keeps them, and guessing would invent a convention nobody agreed to.",
  "",
  "Answers: 0 every check passed, 1 a check found something,",
  "2 called with something it cannot work from, 3 a check could not be run.",
].join("\n");

const checkFile = (path: string): CardFile => {
  const name = basename(path);

  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`${path} could not be read: ${String(cause)}`);
  }

  let card: unknown;

  try {
    card = JSON.parse(text);
  } catch (cause) {
    return {
      path,
      name,
      problems: [
        {
          path: [],
          message: `${name} is not JSON, so there is no card in it to check: ${String(cause)}`,
        },
      ],
    };
  }

  return { path, name: nameOf(name, card), problems: checkCard(card).problems };
};

export type Say = (line: string) => void;

export const runVerify = async (argv: readonly string[], say: Say): Promise<number> => {
  const [command, ...files] = argv;

  if (command !== "verify") {
    say(command === undefined ? USAGE : `coinslot does not know "${command}".\n\n${USAGE}`);
    return VERIFY_EXIT.USAGE;
  }

  if (files.length === 0) {
    say(`coinslot verify needs at least one card file.\n\n${USAGE}`);
    return VERIFY_EXIT.USAGE;
  }

  const checked: CardFile[] = [];

  for (const file of files) {
    try {
      checked.push(checkFile(file));
    } catch (cause) {
      say(String(cause instanceof Error ? cause.message : cause));
      return VERIFY_EXIT.USAGE;
    }
  }

  say("Card completeness");

  for (const card of checked) {
    if (card.problems.length === 0) {
      say(`  ${card.name}: complete as far as the contract can tell`);
      continue;
    }

    say(`  ${card.name}: ${card.problems.length} finding${card.problems.length === 1 ? "" : "s"}`);
    say(describeProblems(card.problems as Parameters<typeof describeProblems>[0]));
  }

  const faulted = checked.filter((card) => card.problems.length > 0);

  if (faulted.length > 0) {
    // The truncation, said out loud. A card is checked in two stages and the
    // second — the rules that compare one field against another — is only
    // reached when the first passes, so a short list is not a promise that
    // one round of fixes is enough.
    say(
      "  Fix these and run again: a card whose shape is wrong is not checked against the rules that compare one field with another, so there may be more behind them.",
    );
  }

  say("");
  say("Idempotency");
  say("  could not be run.");
  say(IDEMPOTENCY_IS_NOT_BUILDABLE);
  say("");
  say(
    faulted.length > 0
      ? "Verdict: the cards have findings, and the idempotency run did not happen."
      : "Verdict: the cards are complete. Nothing is claimed about idempotency — that check did not run.",
  );

  return faulted.length > 0 ? VERIFY_EXIT.PROBLEMS : VERIFY_EXIT.COULD_NOT_RUN;
};
