/**
 * The landing's code example is the portal's card, rendered as a call.
 *
 * The lesson belongs in the file it produced. The landing showed a publish call
 * carrying `merchant_item_id`, `title`, `price` and `fulfillment`, under a
 * caption saying it was the quickstart's own card with the optional fields
 * dropped. `description` and `result` are not optional, so the only code on our
 * public page was a card our own door would have refused — under a header
 * comment promising that every claim on the page is traceable. Nobody was
 * careless: the fixture test read `portal/*.md`, the landing does not live in
 * `portal/`, and no test in this repository had ever opened it. The example
 * drifted because nothing read it.
 *
 * What read it next was a reader for JavaScript object literals, two hundred
 * lines of it with a suite of its own, which lifted the card off the page so
 * that a second test could hold it beside the card in the quickstart. Two
 * copies kept alike, and a guard that had become its own subject. The charter's
 * answer to both is one file with two readers.
 *
 * So the card is not written on this page at all, and it is not written here
 * either. `portal/examples/card/access-monthly.json` is the card: the card
 * reference prints it as JSON, `portal-fixtures.test.ts` holds it to
 * `CardSchema`, and what this file renders is that same file as the call a
 * merchant would write. Nothing here needs to check that the landing shows a
 * card our door accepts, because the landing shows the card the schema already
 * passed. A card edited in the one place it lives reaches the landing; a
 * landing edited by hand does not stay edited.
 *
 * Holding the rendering against the committed HTML is a comparison of two
 * texts, and here that is honest in a way it would not be for the portal:
 * nothing stands between this file and the reader. The landing is served
 * exactly as it is committed, so the bytes checked here are the bytes a visitor
 * gets. The portal has a renderer in the middle, which is why its examples are
 * checked against the built site instead, by `scripts/check-portal-render.mjs`.
 *
 * The highlighting is rendered rather than left to a hand. The page has three
 * token classes and the rules for them are mechanical — the keyword, the call,
 * the literals — so leaving them out would have put a hand back on the block
 * and given it something of its own to drift with.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../", import.meta.url);

const LANDING = "apps/landing/public/index.html";
const CARD = "portal/examples/card/access-monthly.json";

const fileOf = (path: string): string => readFileSync(new URL(path, repoRoot), "utf8");

/**
 * The panel's line, in characters.
 *
 * Measured rather than chosen. The hero's code panel is five columns of the
 * grid, and at a window 1440 wide its content box is 487 pixels — sixty-four
 * characters of a mono face at 12.5px. The block scrolls sideways past that,
 * and a line a reader has to drag into view is a line they do not read: the
 * first thing that went off the edge here was half of what the buyer has to
 * send at purchase.
 */
const WIDTH = 64;

/** A string as the source writes it, then as the page has to carry it. */
const quoted = (text: string): string =>
  `'${text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}'`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One value written on a single line, wearing the page's own highlighting. */
const inlineOf = (value: unknown): string => {
  if (typeof value === "string") return `<span class="tok-str">${quoted(value)}</span>`;

  if (isRecord(value)) {
    const fields = Object.entries(value).map(([name, child]) => `${name}: ${inlineOf(child)}`);

    return `{ ${fields.join(", ")} }`;
  }

  return `<span class="tok-key">${String(value)}</span>`;
};

/** What a reader sees of a marked-up line: its length with the markup taken off. */
const width = (marked: string): number => marked.replace(/<[^>]+>/g, "").length;

/**
 * The fields of an object, one to a line, each opened out where the whole of it
 * would run past the panel.
 */
const linesOf = (value: Record<string, unknown>, indent: string): string[] =>
  Object.entries(value).flatMap(([name, child]) => {
    const together = `${indent}${name}: ${inlineOf(child)},`;

    if (width(together) <= WIDTH) return [together];

    if (isRecord(child)) {
      return [`${indent}${name}: {`, ...linesOf(child, `${indent}  `), `${indent}},`];
    }

    // A long string has nowhere to break, so it goes under its own name — which
    // is how the page wrote its one long line before any of this was rendered.
    return [`${indent}${name}:`, `${indent}  ${inlineOf(child)},`];
  });

/** The example the landing has to carry, whole. */
const exampleFor = (card: Record<string, unknown>): string =>
  [
    '<span class="tok-key">await</span> coinslot.catalog.<span class="tok-call">publish</span>({',
    ...linesOf(card, "  "),
    "})",
  ].join("\n");

/**
 * The code blocks of the page.
 *
 * Attributes on either tag are allowed, and that is the difference between
 * reading the page and reading the page as it happens to be written today.
 * Matching the bare tags meant that the day anyone put a class or a language on
 * them the example would go invisible, and the failure would have said the
 * example was missing while it sat where it always had.
 */
const codeBlocksOf = (html: string): string[] =>
  [...html.matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map(
    (block) => block[1] ?? "",
  );

/** The source a visitor reads: the highlighting off, the entities turned back. */
const sourceOf = (block: string): string =>
  block
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    // Last, so an escaped `&lt;` in the card's own text keeps its ampersand.
    .replaceAll("&amp;", "&");

/** Every name and every value a card is made of. */
const wordsOf = (value: unknown): string[] =>
  isRecord(value)
    ? Object.entries(value).flatMap(([name, child]) => [name, ...wordsOf(child)])
    : [String(value)];

describe("the landing's code example", () => {
  it("is the card the portal publishes, written as the call that publishes it", () => {
    // If this fails, the only code a stranger sees before deciding whether we
    // are worth an engineer's afternoon is no longer the card we sell. The fix
    // is to put the rendering below on the page, not to edit the card twice.
    const card: unknown = JSON.parse(fileOf(CARD));

    expect(isRecord(card), `${CARD} is not an object`).toBe(true);

    const [shown] = codeBlocksOf(fileOf(LANDING));

    expect(shown, `${LANDING} shows no code at all`).toBeDefined();
    expect(shown).toBe(exampleFor(card as Record<string, unknown>));
  });

  it("shows every name and every value the card carries", () => {
    // The control on the rendering, read off the page rather than off the
    // renderer. Everything above passes just as well if the renderer quietly
    // lost a field: the page would carry exactly what it produced, and the two
    // would agree with each other about a card that neither of them shows. A
    // shortened card on this page is the defect this file was written for, and
    // this is the check that does not go through the renderer to find it.
    const card: unknown = JSON.parse(fileOf(CARD));
    const [shown = ""] = codeBlocksOf(fileOf(LANDING));
    const missing = wordsOf(card).filter((word) => !sourceOf(shown).includes(word));

    expect(missing, `${LANDING} shows a card with these left out`).toStrictEqual([]);
  });

  it("is the only code the page shows", () => {
    const blocks = codeBlocksOf(fileOf(LANDING));

    expect(
      blocks.length,
      `${LANDING} shows ${blocks.length} code examples and this file renders one; the first one drifted because nothing read it, so a second belongs here too rather than on the page alone`,
    ).toBe(1);
  });
});
