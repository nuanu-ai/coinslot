/**
 * The portal's table of closing-call codes, held to the codes themselves.
 *
 * That table is the thing a merchant writes their `switch` from. It names
 * seven codes as promised to mean one thing each, and the promise is only worth
 * the paper it is on if the seven are the seven the code actually sends: a code
 * added to the contract and not to the page is a case the merchant never writes
 * an arm for, and a code on the page that nothing sends is an arm they wrote
 * for nothing.
 *
 * The names are imported rather than typed out here. A copy in a test is a
 * third place to keep in step, and a test that drifts along with the page it
 * guards catches nothing.
 *
 * What is checked is the names and how many there are, not a word of the prose
 * around them: what each code means is the page's to say, and pinning that
 * would make every improvement to a sentence a failing test.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORDER_CALL_ERROR_CODES } from "@nuanu-ai/coinslot-contracts";
import { describe, expect, it } from "vitest";
import { ANSWER_NOT_UNDERSTOOD, CALL_DID_NOT_REACH_US, OUTCOME_UNKNOWN } from "./client.js";

const page = fileURLToPath(new URL("../../../portal/orders.md", import.meta.url));

/** The three this package produces where no answer it could read came back. */
const FROM_THE_TOOLS = [CALL_DID_NOT_REACH_US, ANSWER_NOT_UNDERSTOOD, OUTCOME_UNKNOWN];

/** The heading the table belongs to, so a table added elsewhere is not read as this one. */
const SECTION = "### When a closing call does not go through";

/**
 * The first column of the first table under that heading.
 *
 * A row is taken as a code only where its first cell is a single backticked
 * word, which is what separates the codes from the header and the rule beneath
 * it without matching on either's spelling.
 */
const codesOnThePage = (): string[] => {
  const markdown = readFileSync(page, "utf8");
  const section = markdown.indexOf(SECTION);

  if (section === -1) {
    throw new Error(`${SECTION} is not on the orders page, so the codes table cannot be found.`);
  }

  const codes: string[] = [];
  let started = false;

  for (const line of markdown.slice(section).split("\n")) {
    const named = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);

    if (named?.[1] !== undefined) {
      started = true;
      codes.push(named[1]);
      continue;
    }

    // The table ends at the first line after it that is not one of its rows.
    if (started && !line.startsWith("|")) break;
  }

  return codes;
};

describe("the portal's table of codes a closing call fails under", () => {
  it("names every code those calls send, and no code they do not", () => {
    const promised = [...ORDER_CALL_ERROR_CODES, ...FROM_THE_TOOLS];
    const printed = codesOnThePage();

    expect([...printed].sort()).toStrictEqual([...promised].sort());
    // Said separately from the comparison above, because a code printed twice
    // sorts into a list that still contains all the right names.
    expect(printed).toHaveLength(promised.length);
  });

  it("counts them in the sentence above the table the way the table counts", () => {
    // The page says how many there are and how they split before it lists
    // them, which is the sentence a merchant sizes their `switch` from. It is
    // read the way `apps/gateway/src/portal-numbers.test.ts` reads the
    // deadlines: enough of the sentence is quoted for the pin to die when the
    // sentence is rewritten, and the numbers it must agree with are counted
    // from the lists rather than written down here a second time.
    const words: Record<string, number> = { three: 3, four: 4, seven: 7 };
    const said =
      /(\w+) codes are promised to mean one thing each — (\w+) sent by us, and (\w+) the tools produce/.exec(
        readFileSync(page, "utf8").replace(/\s+/g, " "),
      );

    expect(said).not.toBeNull();

    const [total, ours, theirs] = (said ?? []).slice(1).map((word) => words[word.toLowerCase()]);

    expect(ours).toBe(ORDER_CALL_ERROR_CODES.length);
    expect(theirs).toBe(FROM_THE_TOOLS.length);
    expect(total).toBe(ORDER_CALL_ERROR_CODES.length + FROM_THE_TOOLS.length);
  });
});
