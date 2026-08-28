/**
 * The portal's examples are files of this repository, and this is what holds
 * them to the schemas.
 *
 * The charter's rule is that an example a merchant copies out of the
 * documentation has to pass the schemas, and that the documentation and the
 * code may not drift apart quietly. The way that rule used to be kept was a
 * matcher: the examples lived inside the pages, hand-written copies of them
 * lived in this file, and some two hundred lines compared the copy against the
 * page name by name and value by value — with four lists of exceptions for the
 * parts that could not be compared, and a suite of its own to check the
 * comparing. A guard that needs its own suite is a guard that has become the
 * subject.
 *
 * There is no copy any more. Every payload example is one file, the page shows
 * that file with VitePress's snippet import (`<<< @/examples/…`), and the bytes
 * a merchant reads on the portal are the bytes this test parses. Nothing is
 * compared against anything, because there is only one of everything.
 *
 * The convention the checks below rest on: an example lives at
 * `portal/examples/<schema>/<name>.json`, and the directory names the schema
 * the file is held to. `SCHEMAS` is that map, and a directory missing from it
 * fails rather than becoming a place where files sit unvalidated.
 *
 * Four checks, and together they mean an example cannot arrive unwatched.
 * Every file parses and passes the schema its directory names. Every file is
 * shown by at least one page, so an example nobody reads cannot sit here going
 * stale. Every include on every page resolves to a file that exists, so a page
 * cannot point at nothing. And no page carries a payload inline, which is what
 * stops the whole mechanism from being walked around by writing the JSON back
 * into a fence.
 *
 * Two things are deliberately outside all of this.
 *
 * The TypeScript fences are outside. They are calling code — `order.delivered({
 * … })`, `q.available(price, asOf)` — and not documents: the merchant writes
 * the call, and the SDK builds what goes on the wire from it. Every one of them
 * is compiled against the real SDK by `packages/sdk/src/portal-fences.test.ts`,
 * which is the check that catches what a merchant meets first, and the document
 * each call puts on the wire is asserted by the SDK's own tests. Transcribing
 * them into JSON here meant certifying a document the portal has never shown
 * anybody.
 *
 * Fragments are outside. An example file is a whole document, because a
 * merchant copies what they see, and a document missing a required field is a
 * claim about what our side accepts that our side would refuse — the charter's
 * fifth gate. Where a page genuinely discusses a piece of something rather than
 * a document — the `result` block of a card, under the heading that explains
 * that one field — the piece stays a plain fence: not included from here, not
 * validated as a document, because it is not one. What keeps that exception
 * from widening is the fourth check: a fragment is TypeScript on the page, and
 * anything written as JSON has to be a file.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { CardSchema, deliveryCheckFor } from "./card.js";
import { QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";

const PORTAL = fileURLToPath(new URL("../../../portal/", import.meta.url));
const EXAMPLES = join(PORTAL, "examples");

/**
 * Which schema each directory of examples is held to.
 *
 * This map is the whole naming convention. A directory that is not in it is a
 * failure below rather than a quiet corner of the tree where an example could
 * live without being checked against anything.
 */
const SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  card: CardSchema,
  "quote-request": QuoteRequestSchema,
  "quote-response": QuoteResponseSchema,
};

/** The house style: the page addressed to us, which the site does not build. */
const NOT_A_PAGE = "WRITING.md";

const entriesOfExamples = readdirSync(EXAMPLES, { withFileTypes: true });

/** Every example, by the path a page includes it with: `card/access-monthly.json`. */
const files: readonly string[] = entriesOfExamples
  .filter((entry) => entry.isDirectory())
  .flatMap((directory) =>
    readdirSync(join(EXAMPLES, directory.name)).map((name) => `${directory.name}/${name}`),
  )
  .sort();

const pages: readonly string[] = readdirSync(PORTAL)
  .filter((name) => name.endsWith(".md") && name !== NOT_A_PAGE)
  .sort();

const textOf = (page: string): string => readFileSync(join(PORTAL, page), "utf8");

/**
 * The snippet imports a page writes, as the path each one names.
 *
 * VitePress lets a line carry a region after the path (`#name`) and options
 * after that (`{2,4}`); neither is part of the file's name, so both are cut.
 * The paths on our pages all start `@/`, which is the source root — the portal
 * directory itself.
 */
const includesOf = (markdown: string): string[] =>
  markdown
    .split("\n")
    .map((line) => /^<<<\s+(\S+)/.exec(line.trim())?.[1])
    .filter((path) => path !== undefined)
    .map((path) => path.replace(/[#{].*$/, "").replace(/^@\//, ""));

/** Every path any page includes, and the pages that include it. */
const included = new Map<string, string[]>();
for (const page of pages) {
  for (const path of includesOf(textOf(page))) {
    included.set(path, [...(included.get(path) ?? []), page]);
  }
}

const jsonOf = (file: string): unknown => {
  const text = readFileSync(join(EXAMPLES, file), "utf8");

  try {
    return JSON.parse(text);
  } catch (failure) {
    throw new Error(`portal/examples/${file} is not valid JSON: ${(failure as Error).message}`);
  }
};

describe("the portal's examples are files, and every file is checked", () => {
  it("finds examples and includes at all", () => {
    // The negative control for the two directory reads everything else is
    // generated from. A portal that moved, an include syntax that changed, a
    // filter that quietly matched nothing — any of those would leave the checks
    // below with nothing to say and read as a clean run.
    expect(files.length, "no example files found under portal/examples").toBeGreaterThan(0);
    expect(included.size, "no page includes anything").toBeGreaterThan(0);
  });

  it("keeps every example in a directory that names a schema", () => {
    // Where an unchecked example would otherwise hide: a file dropped at the
    // top of the tree, or a directory nobody mapped to a schema.
    const loose = entriesOfExamples.filter((entry) => !entry.isDirectory()).map((e) => e.name);
    const unmapped = entriesOfExamples
      .filter((entry) => entry.isDirectory() && SCHEMAS[entry.name] === undefined)
      .map((entry) => entry.name);

    expect(loose, "an example belongs in a directory named for its schema").toStrictEqual([]);
    expect(
      unmapped,
      "no schema is mapped to this directory, so nothing here would be validated; add it to SCHEMAS",
    ).toStrictEqual([]);
  });

  it.each(files)("%s passes the schema its directory names", (file) => {
    // If this fails, a merchant who copied this example got a document our own
    // side would refuse.
    const [directory = ""] = file.split("/");
    const schema = SCHEMAS[directory];

    expect(file.endsWith(".json"), `${file} is not JSON, and nothing here can check it`).toBe(true);
    expect(schema, `no schema for ${directory}`).toBeDefined();

    const result = schema?.safeParse(jsonOf(file));

    expect(
      result?.success === true ? "" : JSON.stringify(result?.error?.issues),
      `portal/examples/${file} does not pass ${directory}`,
    ).toBe("");
  });

  it.each(files)("%s is shown by a page", (file) => {
    // An example nobody includes is an example nobody reads, and it would go on
    // passing its schema long after the page that once showed it moved on.
    expect(
      included.get(`examples/${file}`) ?? [],
      `no portal page includes portal/examples/${file}; include it or delete it`,
    ).not.toStrictEqual([]);
  });

  it("includes nothing that is not there", () => {
    // The other direction: a page pointing at a file that does not exist
    // renders as an empty block, and the page reads as though the example were
    // simply missing.
    const known = new Set(files.map((file) => `examples/${file}`));
    const missing = [...included.entries()]
      .filter(([path]) => !known.has(path))
      .map(([path, where]) => `${path} (included by ${where.join(", ")})`);

    expect(missing, "a page includes a file that is not in portal/examples").toStrictEqual([]);
  });

  it.each(pages)("%s writes no payload inline", (page) => {
    // What keeps the mechanism whole. A payload written back into a fence is
    // one nothing above sees: it passes no schema, it belongs to no file, and
    // it is exactly the transcription this file was rebuilt to be rid of.
    const inline = textOf(page)
      .split("\n")
      .filter((line) => /^```(json|http)\b/.test(line.trim()));

    expect(
      inline,
      `${page} writes a payload in a fence; put it in portal/examples and include it with <<<`,
    ).toStrictEqual([]);
  });
});

describe("the pages agree with each other", () => {
  it("every delivery the orders page shows carries what the card example declares", () => {
    // The promise, and it spans two pages: a merchant who declares a result on
    // one and copies a delivery call from the other has to end up with a
    // delivery that goes through. Before the portal said that every declared
    // field is delivered, the two pages disagreed — the declaration named two
    // fields and the call sent one.
    const card = CardSchema.parse(jsonOf("card/access-monthly.json"));
    const check = deliveryCheckFor(card);
    const orders = textOf("orders.md");

    // Every `deliver` call on the page: what each one carries, up to the
    // parenthesis that closes it, so a call written over several lines is read
    // whole.
    const calls = orders
      .split(".deliver(")
      .slice(1)
      .map((rest) => {
        const end = rest.indexOf(")");
        return end === -1 ? rest : rest.slice(0, end);
      });

    expect(calls.length, "the orders page shows no delivery at all").toBeGreaterThan(0);

    for (const call of calls) {
      for (const name of Object.keys(card.result)) {
        expect(
          new RegExp(`(?<![\\w$])${name}\\s*:`).test(call),
          `the orders page delivers without "${name}", which the card example declares: ${call}`,
        ).toBe(true);
      }
    }

    // And a delivery of the shape those calls produce passes the check the card
    // compiles to, while one missing a declared field does not.
    expect(
      check.safeParse({
        access_url: "https://example.com/a/9f2c4a",
        expires_at: "2026-09-25T10:00:00Z",
      }).success,
    ).toBe(true);
    expect(check.safeParse({ access_url: "https://example.com/a/9f2c4a" }).success).toBe(false);
  });
});
