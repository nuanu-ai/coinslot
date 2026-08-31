#!/usr/bin/env node

/**
 * The portal's examples reached the built pages.
 *
 * `packages/contracts/src/portal-fixtures.test.ts` holds every example file to
 * its schema, checks that some page names it, and checks that every name a page
 * writes resolves to a file. What no test can reach is the last step: whether
 * VitePress turned `<<< @/examples/…` into the file's content or printed the
 * line as text. A snippet syntax that changed under an upgrade would leave the
 * whole suite green while every example vanished from the site — which is the
 * failure this exists for, because the merchant reads the built page and
 * nothing else.
 *
 * Run it after `pnpm run docs:build` in `portal/`. It compares the file against
 * the page whole rather than sampling: the built HTML, with its tags taken off
 * and its entities decoded, has to contain the example's own text. Whitespace
 * is collapsed on both sides, because the highlighter lays the JSON out in
 * spans and the line breaks between them are not the document's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORTAL = join(ROOT, "portal");
const EXAMPLES = join(PORTAL, "examples");
const DIST = join(PORTAL, ".vitepress", "dist");

/** The house style, addressed to us: the site does not build it. */
const NOT_A_PAGE = "WRITING.md";

const die = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

/**
 * What a reader sees, with the markup gone and the whitespace levelled.
 *
 * A tag becomes nothing rather than a space. The highlighter wraps every token
 * of the JSON in its own span and puts no whitespace between them, so a space
 * in their place would cut `"merchant_item_id":` into three pieces and no
 * example would ever be found.
 */
const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Last, so that a page writing `&amp;lt;` keeps its `&lt;` instead of
    // turning into a `<` it never wrote.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** The paths a page includes: `<<< @/examples/card/x.json`, region and options cut. */
const includesOf = (markdown) =>
  markdown
    .split("\n")
    .map((line) => /^<<<\s+(\S+)/.exec(line.trim())?.[1])
    .filter((path) => path !== undefined)
    .map((path) => path.replace(/[#{].*$/, "").replace(/^@\//, ""));

/** Every example file, by the path a page includes it with. */
const exampleFiles = () =>
  readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((directory) =>
      readdirSync(join(EXAMPLES, directory.name)).map((name) => `${directory.name}/${name}`),
    )
    .sort();

/** Every built page, at whatever depth the router put it. */
const builtPages = (directory, prefix = "") =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? builtPages(join(directory, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith(".html")
        ? [`${prefix}${entry.name}`]
        : [],
  );

let built;
try {
  built = builtPages(DIST);
} catch {
  die(`no built portal at ${DIST}; run "pnpm run docs:build" in portal/ first`);
}

/** Which pages name each example, and the built page each of those became. */
const pages = readdirSync(PORTAL)
  .filter((name) => name.endsWith(".md") && name !== NOT_A_PAGE)
  .sort();

const shownBy = new Map();
for (const page of pages) {
  const html = `${basename(page, ".md")}.html`;

  for (const path of includesOf(readFileSync(join(PORTAL, page), "utf8"))) {
    shownBy.set(path, [...(shownBy.get(path) ?? []), html]);
  }
}

if (shownBy.size === 0) {
  // The negative control. A portal that moved, or an include syntax nothing
  // here recognises, would otherwise leave this script with nothing to check
  // and let it report success over an empty list.
  die(`no page under ${PORTAL} includes anything; the layout or the syntax has changed`);
}

const files = exampleFiles();
if (files.length === 0) die(`no example files under ${EXAMPLES}`);

const complaints = [];

for (const file of files) {
  const where = shownBy.get(`examples/${file}`) ?? [];

  if (where.length === 0) {
    complaints.push(`portal/examples/${file} is included by no page, so no page can show it`);
    continue;
  }

  const wanted = readFileSync(join(EXAMPLES, file), "utf8").replace(/\s+/g, " ").trim();

  for (const html of where) {
    if (!built.includes(html)) {
      complaints.push(`${html} includes portal/examples/${file} and was never built`);
      continue;
    }

    const shown = textOf(readFileSync(join(DIST, html), "utf8"));

    if (shown.includes(wanted)) {
      console.log(`ok   ${html} shows portal/examples/${file}`);
      continue;
    }

    const printedAsText = /<<<\s+\S*examples\//.test(shown);

    complaints.push(
      printedAsText
        ? `${html} printed the include line as text instead of the file: VitePress no longer understands "<<<", and every example on the site is gone`
        : `${html} does not show portal/examples/${file}; the page was built without it`,
    );
  }
}

if (complaints.length > 0) {
  // Deduplicated: when the syntax itself has gone, every example on the page
  // has the same thing wrong with it, and saying it once is saying it.
  die(`the built portal does not show its examples:\n  ${[...new Set(complaints)].join("\n  ")}`);
}

// The one place a hook that skipped nested pages would be caught. A reader
// landing on a page with no marker is told nothing about which stack they are
// reading, and the release's own probe only fetches three addresses.
// Present, and above the page rather than after it. A marker appended at the
// end satisfies a probe and reaches no reader, which is the failure that would
// otherwise ship looking like a pass.
const unmarked = builtPages(DIST).filter((page) => {
  const html = readFileSync(join(DIST, page), "utf8");
  const marker = html.indexOf('data-coinslot-surface="');
  const app = html.indexOf('<div id="app"');
  return marker === -1 || app === -1 || marker > app;
});

if (unmarked.length > 0) {
  die(
    "these built pages carry no surface marker above the page, so a reader is told nothing " +
      `about which stack they are reading:\n  ${unmarked.join("\n  ")}`,
  );
}

console.log(`\n${files.length} example(s) reached the pages that include them.`);
