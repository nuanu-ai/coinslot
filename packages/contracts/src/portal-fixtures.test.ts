/**
 * The portal's examples are fixtures of this package.
 *
 * The rule behind this file is the charter's: an example a merchant copies out
 * of the documentation has to pass the schemas, and the documentation and the
 * code are not allowed to drift apart quietly. Everything a merchant reads on
 * the portal is a promise about what our side accepts, and a promise nobody
 * checks is a promise that goes stale between one commit and the next.
 *
 * Two kinds of fixture live here, because the portal writes its examples in
 * two ways.
 *
 * An example inside a ```json or ```http fence is read out of the page and
 * validated as it stands. If someone edits the example, this test parses the
 * edited text.
 *
 * An example written as TypeScript cannot be read that way without a parser
 * for JavaScript object literals, which is a great deal of machinery for a
 * handful of examples. Those are transcribed into JSON here by hand, and the
 * transcription is kept honest by a second check: every name and every literal
 * value in it has to still appear in the fence it came from. Rename a field on
 * the portal, or change what an example says, and the build says so.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { CardSchema } from "./card.js";
import { HandlerAnswerSchema, RefusalSchema } from "./handler.js";
import { ParamSpecSchema } from "./param-spec.js";
import { QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";

const repoRoot = new URL("../../../", import.meta.url);

const readPortalPage = (file: string): string => readFileSync(new URL(file, repoRoot), "utf8");

/**
 * The fenced blocks of one language, in the order the page writes them.
 *
 * Not a markdown parser: it looks for the line that opens a fence and the line
 * that closes it. That is enough for the portal, which has no nested and no
 * indented fences — and if it ever grows one, this returns the wrong text and
 * the fixtures below fail loudly, which is the failure we want.
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

/**
 * The JSON object inside a fence: everything from the first brace on. In a
 * ```json fence that is the whole block; in an ```http example it steps over
 * the request line above the body.
 */
const jsonBodyOf = (fence: string): string => fence.slice(fence.indexOf("{"));

/** Every name and every literal value of a transcription, for the drift check. */
const tokensOf = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(tokensOf);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([name, child]) => [name, ...tokensOf(child)]);
  }
  return [];
};

interface Fence {
  file: string;
  language: string;
  index: number;
}

type Fixture =
  | { kind: "read"; what: string; fence: Fence; schema: z.ZodType }
  | { kind: "transcribed"; what: string; fence: Fence; schema: z.ZodType; value: unknown };

/**
 * The fixture map: which example on which page is held to which schema.
 *
 * Adding an example to the portal without adding it here is caught further
 * down, for the fences that carry data.
 */
const fixtures: Fixture[] = [
  {
    kind: "read",
    what: "the price question, as the portal shows it going to a price hook",
    fence: { file: "portal/cards.md", language: "http", index: 0 },
    schema: QuoteRequestSchema,
  },
  {
    kind: "read",
    what: "the price answer, in full",
    fence: { file: "portal/cards.md", language: "json", index: 0 },
    schema: QuoteResponseSchema,
  },
  {
    kind: "transcribed",
    what: "the card of the first test sale",
    fence: { file: "portal/quickstart.md", language: "ts", index: 1 },
    schema: CardSchema,
    value: {
      merchant_item_id: "access-monthly",
      title: "Доступ к сервису на один месяц",
      description: "Что покупатель получает, для какой задачи это годится и что в это не входит.",
      price: { amount: "5.00", currency: "USD" },
      params: {
        email: { type: "string", required: true, title: "Куда прислать доступ" },
      },
      result: {
        access_url: { type: "string", title: "Ссылка для входа" },
      },
      fulfillment: "sync",
    },
  },
  {
    kind: "transcribed",
    what: "the delivery result a card declares",
    fence: { file: "portal/cards.md", language: "ts", index: 0 },
    schema: ParamSpecSchema,
    value: {
      access_url: { type: "string", title: "Ссылка для входа" },
      expires_at: { type: "string", title: "До какого момента действует" },
    },
  },
  {
    kind: "transcribed",
    what: "a handler refusing a synchronous order",
    fence: { file: "portal/quickstart.md", language: "ts", index: 2 },
    schema: HandlerAnswerSchema,
    value: { refused: { code: "out_of_stock", message: "Мест на тарифе нет" } },
  },
  {
    kind: "transcribed",
    what: "a handler taking an asynchronous order on",
    fence: { file: "portal/quickstart.md", language: "ts", index: 3 },
    schema: HandlerAnswerSchema,
    value: { accepted: { eta_seconds: 60 } },
  },
  {
    kind: "transcribed",
    what: "a refusal sent after the order was taken on",
    fence: { file: "portal/orders.md", language: "ts", index: 1 },
    schema: RefusalSchema,
    value: { code: "out_of_stock", message: "Поставщик не подтвердил номер" },
  },
];

const fenceTextOf = (fence: Fence): string => {
  const blocks = fencesOf(readPortalPage(fence.file), fence.language);
  const block = blocks[fence.index];

  expect(
    block,
    `${fence.file} has no ${fence.language} example number ${fence.index}; the page was reordered or the example removed`,
  ).toBeDefined();

  return block ?? "";
};

describe("the portal's examples pass the schemas", () => {
  for (const fixture of fixtures) {
    it(`${fixture.what} (${fixture.fence.file})`, () => {
      const text = fenceTextOf(fixture.fence);

      if (fixture.kind === "transcribed") {
        // The transcription is only worth as much as its likeness to the page.
        for (const token of new Set(tokensOf(fixture.value))) {
          expect(
            text,
            `the example no longer contains ${JSON.stringify(token)}; the transcription here has to be brought back in line with the portal`,
          ).toContain(token);
        }
      }

      const value = fixture.kind === "read" ? JSON.parse(jsonBodyOf(text)) : fixture.value;
      const result = fixture.schema.safeParse(value);

      expect(
        result.success ? "" : JSON.stringify(result.error?.issues),
        `${fixture.what} does not pass its schema`,
      ).toBe("");
    });
  }
});

describe("no example on the portal goes unpinned", () => {
  // The pages that carry data examples rather than prose. A ```json or ```http
  // fence anywhere here is a payload a merchant will copy, so every one of
  // them has to appear in the map above. TypeScript fences are not counted:
  // most of them are calling code rather than a payload, and counting those
  // would fail on every unrelated example the portal gains.
  const pages = [
    "portal/cards.md",
    "portal/orders.md",
    "portal/quickstart.md",
    "portal/failures.md",
    "portal/money.md",
    "portal/faq.md",
    "portal/index.md",
  ];

  for (const page of pages) {
    for (const language of ["json", "http"]) {
      it(`${page} has as many ${language} examples as the fixture map pins`, () => {
        const onThePage = fencesOf(readPortalPage(page), language).length;
        const pinned = fixtures.filter(
          (fixture) => fixture.fence.file === page && fixture.fence.language === language,
        ).length;

        expect(
          onThePage,
          `${page} carries ${onThePage} ${language} example(s) and the fixture map pins ${pinned}; add the new one to the map so it is held to a schema`,
        ).toBe(pinned);
      });
    }
  }
});
