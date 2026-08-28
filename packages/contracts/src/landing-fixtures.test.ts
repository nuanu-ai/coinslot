/**
 * The landing's one code example is a fixture of this package.
 *
 * The rule is the portal's, one page further out. `portal-fixtures.test.ts`
 * holds the documentation's examples to the schemas, because an example a
 * merchant copies is a promise about what our side accepts and a promise
 * nobody checks goes stale between one commit and the next. The landing makes
 * the same promise to a stranger who has not opened the documentation yet, and
 * nothing held it to anything.
 *
 * The lesson belongs in the file it produced. The landing showed a publish
 * call carrying `merchant_item_id`, `title`, `price` and `fulfillment`, under
 * a caption saying it was the quickstart's own card with the optional fields
 * dropped. `description` and `result` are not optional, so the only code on
 * our public page was a card our own door would have refused — under a header
 * comment promising that every claim on the page is traceable. Nobody was
 * careless: the fixture test globs `portal/*.md`, the landing does not live in
 * `portal/`, and no test in this repository had ever read it. The example
 * drifted because nothing read it. The charter says a rule moves into a
 * machine once it has slipped past people, and this file is that machine.
 *
 * The example is read off the page rather than copied into this file, and that
 * is a departure from how the portal's TypeScript examples are pinned. Those
 * are transcribed by hand and kept honest by a token-by-token drift check,
 * which is the right trade for a dozen fences written in a language nothing
 * here parses. Here there is one example, and the defect being fixed is
 * precisely a copy that stopped matching what it was a copy of — a second hand
 * copy would be the same shape of thing again. So a small reader takes the
 * object literal off the page. It understands objects, quoted strings, numbers
 * and the two booleans, and it refuses everything else by name instead of
 * doing its best: a reader that guessed would certify a card the page does not
 * show, which is the failure this file exists to catch, arriving in a shape
 * nobody could see.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CardSchema } from "./card.js";

const repoRoot = new URL("../../../", import.meta.url);

const LANDING = "apps/landing/public/index.html";
const QUICKSTART = "portal/quickstart.md";

const pageOf = (file: string): string => readFileSync(new URL(file, repoRoot), "utf8");

/** The offset's character, or "" past the end. */
const charAt = (source: string, index: number): string => source[index] ?? "";

/** The next stretch of text, so a complaint can be found by eye on the page. */
const near = (source: string, index: number): string =>
  JSON.stringify(source.slice(index, index + 40));

const pastBlanks = (source: string, from: number): number => {
  let index = from;
  while (index < source.length && /\s/.test(charAt(source, index))) index += 1;
  return index;
};

interface Reading {
  readonly value: unknown;
  /** The offset just past what was read. */
  readonly end: number;
}

const FIELD_NAME = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^-?\d+(?:\.\d+)?/;

const readString = (source: string, from: number): Reading => {
  const quote = charAt(source, from);
  let index = from + 1;
  let text = "";

  while (index < source.length) {
    const char = charAt(source, index);

    // A page may well write an apostrophe in a title, and it writes it the way
    // source does. Two escapes have a meaning of their own and the rest stand
    // for the character behind the backslash.
    if (char === "\\") {
      const escaped = charAt(source, index + 1);
      text += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      index += 2;
      continue;
    }

    if (char === quote) return { value: text, end: index + 1 };

    text += char;
    index += 1;
  }

  throw new Error(`a string opens at ${near(source, from)} and is never closed`);
};

/**
 * One value of the small language these examples are written in.
 *
 * Everything it does not understand is a throw with the offending text in it,
 * including the end of the source arriving in the middle of something: a
 * reader that returned what it had so far would hand the schema below a
 * shorter card than the page shows, and a shorter card is exactly the defect
 * this file was written for.
 */
const readValue = (source: string, from: number): Reading => {
  const start = pastBlanks(source, from);
  const opener = charAt(source, start);

  if (opener === "'" || opener === '"') return readString(source, start);

  if (opener === "{") {
    const fields: [string, unknown][] = [];
    let index = pastBlanks(source, start + 1);

    while (charAt(source, index) !== "}") {
      if (index >= source.length) {
        throw new Error(`an object opens at ${near(source, start)} and is never closed`);
      }

      const quoted = charAt(source, index);
      let name: string;

      if (quoted === "'" || quoted === '"') {
        const read = readString(source, index);
        name = String(read.value);
        index = read.end;
      } else {
        const written = FIELD_NAME.exec(source.slice(index));
        if (written === null) {
          throw new Error(`a field name was expected at ${near(source, index)}`);
        }
        name = written[0];
        index += name.length;
      }

      index = pastBlanks(source, index);
      if (charAt(source, index) !== ":") {
        throw new Error(`a ":" was expected after "${name}", at ${near(source, index)}`);
      }

      const read = readValue(source, index + 1);
      fields.push([name, read.value]);
      index = pastBlanks(source, read.end);

      if (charAt(source, index) === ",") index = pastBlanks(source, index + 1);
      // The end of the source is left to the guard at the top of this loop, so
      // an example that stops in the middle of a card is reported as the
      // object that was never closed rather than as a missing comma at nothing.
      else if (charAt(source, index) !== "}" && index < source.length) {
        throw new Error(`a "," or a "}" was expected after "${name}", at ${near(source, index)}`);
      }
    }

    return { value: Object.fromEntries(fields), end: index + 1 };
  }

  if (source.startsWith("true", start)) return { value: true, end: start + 4 };
  if (source.startsWith("false", start)) return { value: false, end: start + 5 };

  const number = NUMBER.exec(source.slice(start));
  if (number !== null) return { value: Number(number[0]), end: start + number[0].length };

  throw new Error(
    `this reader takes objects, quoted strings, numbers and true or false, and found none of them at ${near(source, start)}; an example that needs a list — a card's tags, say — needs a few more lines here before it can be read`,
  );
};

/** Everything between <pre><code> and </code></pre>, in the order the page writes it. */
const codeBlocksOf = (html: string): string[] =>
  [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((block) => block[1] ?? "");

/**
 * The source a visitor reads: the highlighting spans taken off and the
 * entities turned back into the characters they stand for.
 *
 * The spans go first. Decoding first would turn an escaped `&lt;` in the
 * example's own text into a tag and the stripping would then eat what followed
 * it.
 */
const sourceOf = (block: string): string =>
  block
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

/**
 * The marker the card is found by.
 *
 * It is the call itself rather than a class name, a heading or a position on
 * the page, because the call is the one thing the example cannot lose while
 * still being an example of publishing a card. Everything around it — the
 * panel, the highlighting, the order of the sections — is presentation and may
 * be rewritten freely.
 */
const PUBLISH_CALL = /coinslot\.catalog\.publish\(\s*\{/;

/** Where each of these sources opens the card it publishes, if it does. */
const publishCallsIn = (sources: string[]): { source: string; opensAt: number }[] =>
  sources.flatMap((source) => {
    const anchor = PUBLISH_CALL.exec(source);
    return anchor === null ? [] : [{ source, opensAt: anchor.index + anchor[0].length - 1 }];
  });

/**
 * The card one page publishes, taken off that page.
 *
 * Finding no call, or more than one, is a failure with words on it rather than
 * a quiet nothing. That matters more here than the reading itself: a test that
 * silently found no card would go green forever while the page said whatever
 * it liked, which is the state this file was written to end.
 */
const cardPublishedIn = (file: string, sources: string[]): unknown => {
  const calls = publishCallsIn(sources);
  const [call] = calls;

  if (call === undefined || calls.length > 1) {
    throw new Error(
      `the anchor is not where this file reads it in ${file}: ${calls.length} of the code examples there call coinslot.catalog.publish({ … }, and it reads exactly one. Move the anchor to wherever the example lives now — a page nothing reads is how this example drifted the first time`,
    );
  }

  const card = readValue(call.source, call.opensAt);
  const after = call.source.slice(card.end).trimStart();

  if (!after.startsWith(")")) {
    throw new Error(
      `the publish call in ${file} does not close on the card it publishes: after it the example reads ${near(after, 0)}, so what was read here may not be all the page shows`,
    );
  }

  return card.value;
};

/** The landing's examples: HTML, with the highlighting taken back off. */
const landingExamples = (): string[] => codeBlocksOf(pageOf(LANDING)).map(sourceOf);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where the landing's card says something the quickstart's card does not.
 *
 * In that direction only. What the landing leaves out is the caption's own
 * claim — the optional fields, dropped — and the schema is the authority on
 * what a card may be published without, so a card that passes it has dropped
 * nothing it had to keep and there is nothing for this to add. What this
 * catches is the other half of the caption: a value the landing changed, or a
 * field it grew of its own, either of which makes "the example is the one in
 * the first test sale" false again with nothing to say so.
 */
const departuresFrom = (mine: unknown, theirs: unknown, path: string): string[] => {
  if (isRecord(mine) && isRecord(theirs)) {
    return Object.entries(mine).flatMap(([name, value]) =>
      name in theirs
        ? departuresFrom(value, theirs[name], `${path}${name}.`)
        : [`${path}${name} is a field the quickstart's card does not carry`],
    );
  }

  return mine === theirs
    ? []
    : [
        `${path.slice(0, -1)} reads ${JSON.stringify(mine)} on the landing and ${JSON.stringify(theirs)} in the quickstart`,
      ];
};

describe("the landing's code example", () => {
  it("is a card the door it calls would accept", () => {
    const verdict = CardSchema.safeParse(cardPublishedIn(LANDING, landingExamples()));

    expect(
      verdict.success ? "" : z.prettifyError(verdict.error),
      `the card printed on ${LANDING} is one our own publish would refuse, and it is the only code a stranger sees before deciding whether we are worth an engineer's afternoon`,
    ).toBe("");
  });

  it("is the quickstart's own card, as the caption beside it says", () => {
    // The whole markdown goes in as one source: the quickstart calls publish
    // once, so there is no fence to find first, and the reader stops at the
    // brace that closes the card either way.
    const departures = departuresFrom(
      cardPublishedIn(LANDING, landingExamples()),
      cardPublishedIn(QUICKSTART, [pageOf(QUICKSTART)]),
      "",
    );

    expect(
      departures,
      `the caption under the example calls it the card of the first test sale with the optional fields dropped, and ${QUICKSTART} no longer agrees`,
    ).toStrictEqual([]);
  });

  it("is the only code the page shows", () => {
    const examples = landingExamples();

    expect(
      examples.length,
      `${LANDING} shows ${examples.length} code examples and this file reads one; the first one drifted because nothing read it, so a second belongs here too rather than on the page alone`,
    ).toBe(1);
  });
});

describe("the reader that takes the example off the page", () => {
  // Everything above also passes if this reader quietly returns something the
  // page does not say. These are the tests that tell the two apart.

  it("reads the shape these examples are written in", () => {
    const source = "{\n  title: 'a month',\n  price: { amount: '5.00' },\n  required: true,\n}";

    expect(readValue(source, 0).value).toStrictEqual({
      title: "a month",
      price: { amount: "5.00" },
      required: true,
    });
  });

  it("reads a string the page broke across two lines, and an apostrophe in one", () => {
    const source = "{\n  description:\n    'the merchant\\'s own words',\n}";

    expect(readValue(source, 0).value).toStrictEqual({
      description: "the merchant's own words",
    });
  });

  it("refuses a shape it does not understand instead of guessing at it", () => {
    // A card may carry tags, and nothing here reads a list. The point is that
    // it says so: silently reading `tags: []` as nothing would pin a card the
    // page does not show.
    expect(() => readValue("{ tags: ['access'] }", 0)).toThrow(/found none of them/);
  });

  it("refuses an object that is never closed", () => {
    // The failure that would otherwise be invisible: a page truncated halfway
    // through the card, read as the shorter card that happens to be there.
    expect(() => readValue("{ title: 'a month', price: { amount: '5.00' }", 0)).toThrow(
      /never closed/,
    );
  });

  it("gives back the source a visitor reads, not the markup around it", () => {
    expect(
      sourceOf('<span class="tok-key">await</span> f({ a: <span>&#39;b&amp;c&#39;</span> })'),
    ).toBe("await f({ a: 'b&c' })");
  });
});
