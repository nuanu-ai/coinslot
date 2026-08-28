/**
 * The portal's TypeScript examples are compiled against this SDK.
 *
 * The charter's rule is that the documentation's examples are fixtures of the
 * code. The contracts package already holds the portal's JSON to its schemas;
 * this is the same rule one step further out, and it is the one that catches
 * the failure a merchant meets first. A method renamed here, an argument that
 * changed shape, an answer that lost a field — each of those turns the code on
 * the quickstart page into code that does not build, and the merchant finds
 * out by pasting it into their editor. So every ```ts fence on the three pages
 * a merchant integrates from is written out as a TypeScript file, compiled
 * against the real SDK types, and the build fails if any of them stops
 * compiling.
 *
 * Two things had to be decided to make that possible, and both are visible
 * rather than hidden in a helper.
 *
 * The examples call the merchant's own functions — `grantAccess`,
 * `startProvisioning`, `currentPriceOf`, `lookupItem` — and use values the
 * page never shows being created, such as the order a merchant saved earlier.
 * None of those are ours and none of them can be inferred from the page. They
 * are declared as globals in the harness below, with the shapes the examples
 * imply and nothing more, and those declarations are the harness's
 * assumptions rather than the portal's promises. What is being checked is that
 * the SDK's own side of each line type-checks; what a merchant's own function
 * returns is theirs.
 *
 * One fence on the cards page is not a program but the middle of a card — the
 * `result` block on its own. It is compiled as what it is, the `result` field
 * of a card, and the table below says so for that one fence. A fence with no
 * entry is compiled as it stands.
 *
 * The count of fences per page is asserted, so an example added to the portal
 * cannot slip past this file unchecked. When that assertion fails the answer
 * is to decide how the new fence is compiled, not to raise the number.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The values and functions the examples use that are the merchant's own.
 *
 * `declare global` rather than declarations pasted into each file, so that a
 * fence which declares a name of its own — the orders page reads an order back
 * into `order` — shadows the global instead of colliding with it.
 */
const HARNESS = `
import type { CoinslotClient, LiveOrder } from "@coinslot/sdk";

declare global {
  /** The client the quickstart builds on its first page. */
  const coinslot: CoinslotClient;
  /**
   * An order the merchant saved when they took it on — the object their
   * handler was given, which carries the calls that close it.
   */
  const order: LiveOrder;
  const orderId: string;
  /** An identifier the merchant kept in their own record, without the order. */
  const savedId: string;
  const url: string;
  const expiresAt: string;
  const until: string;
  function accessFor(orderId: string): Promise<{ url: string; expiresAt: string } | null>;
  function grantAccess(
    recipient: unknown,
    options: { idempotencyKey: string },
  ): Promise<{ ok: boolean; url: string }>;
  function startProvisioning(
    recipient: unknown,
    options: { idempotencyKey: string },
  ): Promise<void>;
  function currentPriceOf(
    merchantItemId: string,
  ): Promise<{ amount: string; checked_at: string } | null>;
  function lookupItem(
    merchantItemId: string,
  ): Promise<{ in_stock: boolean; price: string; checked_at: string }>;
}
`;

/** The card's result declaration, which is what that fence is a piece of. */
const asCardResult = (body: string): string =>
  `import type { Card } from "@coinslot/sdk";\nconst declared: Pick<Card, "result"> = {\n${body}\n};\nvoid declared;\n`;

interface Page {
  readonly file: string;
  /** How many ```ts fences the page carries. Raised only with a decision. */
  readonly fences: number;
  /** The fences that are a piece of something rather than a program. */
  readonly pieces?: Readonly<Record<number, (body: string) => string>>;
}

const PAGES: readonly Page[] = [
  { file: "portal/quickstart.md", fences: 6 },
  { file: "portal/orders.md", fences: 4 },
  { file: "portal/cards.md", fences: 2, pieces: { 0: asCardResult } },
];

/**
 * The fenced blocks of one language, in the order the page writes them. Not a
 * markdown parser: it looks for the line that opens a fence and the line that
 * closes it, which is enough for pages that have no nested and no indented
 * fences — and if one ever appears, the text comes out wrong and the
 * compilation fails loudly, which is the failure we want.
 */
const fencesOf = (markdown: string, language: string): string[] => {
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of markdown.split("\n")) {
    if (current === null) {
      if (line.trim() === `\`\`\`${language}`) current = [];
      continue;
    }
    if (line.trim() === "```") {
      blocks.push(current.join("\n"));
      current = null;
      continue;
    }
    current.push(line);
  }

  return blocks;
};

interface Example {
  /** The name the compiler will print, which says which fence of which page. */
  readonly name: string;
  readonly source: string;
}

const examplesOf = (page: Page): Example[] => {
  const markdown = readFileSync(join(repoRoot, page.file), "utf8");
  const fences = fencesOf(markdown, "ts");

  return fences.map((body, index) => ({
    name: `${page.file.replace(/^portal\//, "").replace(/\.md$/, "")}-${index + 1}`,
    source: page.pieces?.[index]?.(body) ?? `${body}\n`,
  }));
};

interface Compilation {
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Writes the examples out beside a harness and a configuration, and runs the
 * compiler over the lot in one pass.
 *
 * The configuration is the repository's own, with four differences and each
 * one is a decision. It resolves `@coinslot/sdk` to this package's source,
 * because the examples import it by the name a merchant installs. It carries
 * its own `package.json` saying the files are modules, because two of the
 * examples await at the top level and a directory with no such file would be
 * read as the other kind. It names the type roots outright, since the
 * generated files sit outside the repository and would otherwise find no
 * description of Node. And it turns off the complaint about unused locals: an
 * example is an excerpt, and a `const` the page declares to show its shape is
 * exactly what an excerpt does.
 */
const compile = (examples: readonly Example[]): Compilation => {
  const directory = mkdtempSync(join(tmpdir(), "coinslot-fences-"));

  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(directory, "harness.d.ts"), HARNESS);
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: join(repoRoot, "tsconfig.base.json"),
        compilerOptions: {
          noEmit: true,
          types: ["node"],
          typeRoots: [join(repoRoot, "node_modules", "@types")],
          noUnusedLocals: false,
          noUnusedParameters: false,
          paths: { "@coinslot/sdk": [join(repoRoot, "packages", "sdk", "src", "index.ts")] },
        },
        include: ["./*.ts"],
      }),
    );

    for (const example of examples) {
      writeFileSync(join(directory, `${example.name}.ts`), example.source);
    }

    try {
      const output = execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), [
        "--noEmit",
        "-p",
        join(directory, "tsconfig.json"),
      ]);

      return { ok: true, output: output.toString() };
    } catch (failure) {
      const reported = failure as { stdout?: Buffer; stderr?: Buffer };

      return {
        ok: false,
        output: `${reported.stdout?.toString() ?? ""}${reported.stderr?.toString() ?? ""}`,
      };
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("the portal's TypeScript examples", () => {
  it("compiles every example on every page against this SDK", () => {
    // If this fails, a merchant who copies the page into their editor gets a
    // type error, and the first they hear of it is when they try.
    //
    // One compiler for all three pages rather than one each. Starting `tsc` is
    // most of what this costs and the work itself is a rounding error beside
    // it, and nothing about a page needs its own pass: every generated file is
    // named for the page and the fence it came from, so the compiler's own
    // output says which example broke. What one pass adds is that the examples
    // now share a compilation — an excerpt that declares a name at the top
    // level of a file the compiler reads as a script would meet the same name
    // from another page. That has not happened, and if it does the fix is on
    // the page, which is where two examples contradicting each other belongs.
    const compiled = compile(PAGES.flatMap(examplesOf));

    expect(compiled.ok, compiled.output).toBe(true);
  });

  it.each(PAGES)("has the examples this harness knows about on $file", (page) => {
    // An example added to the portal has to be compiled too. Raising this
    // number is the moment to decide how the new fence is compiled, and doing
    // it without looking is how a page starts drifting away from the code.
    expect(examplesOf(page)).toHaveLength(page.fences);
  });

  it("compiles the pages' own code and not a blank stand-in for it", () => {
    // Everything above also passes if the fences arrive empty, because empty
    // files compile. What is asserted here is that the text reaching the
    // compiler is the merchant's whole promised surface, method by method: it
    // fails if the harness stops reading the pages, and equally if the pages
    // stop documenting one of these calls.
    const everything = PAGES.flatMap((page) => examplesOf(page))
      .map((example) => example.source)
      .join("\n");

    for (const promised of [
      "createClient",
      "coinslot.catalog.publish",
      "coinslot.on('order'",
      "coinslot.on('quote'",
      "coinslot.start()",
      "order.delivered(",
      "order.refused(",
      "order.accepted(",
      "order.deliver(",
      "order.refuse(",
      "coinslot.orders.forId(",
      "coinslot.orders.get",
      "coinslot.orders.list",
    ]) {
      expect(everything).toContain(promised);
    }
  });

  it("would notice a method this SDK does not have", () => {
    // The negative control for the harness itself. Everything above passes
    // just as well if the compiler is never really seeing the SDK, or if the
    // examples are never really reaching the compiler; this is what tells the
    // two apart.
    const broken = compile([
      { name: "renamed", source: "await coinslot.catalog.publishTheCard({})\n" },
      { name: "wrong-argument", source: "await coinslot.orders.get(42)\n" },
      {
        // The kind a handler is registered under is checked too: a merchant
        // who wrote `orders` would otherwise get a handler nothing calls.
        name: "wrong-kind",
        source: "coinslot.on('orders', () => ({ accepted: {} }))\n",
      },
    ]);

    expect(broken.ok).toBe(false);
    expect(broken.output).toMatch(/publishTheCard/);
    expect(broken.output).toMatch(/wrong-argument/);
    expect(broken.output).toMatch(/wrong-kind/);
  });
});
