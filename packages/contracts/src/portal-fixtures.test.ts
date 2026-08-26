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

interface Token {
  kind: "key" | "text" | "literal";
  text: string;
  /** The name this token belongs to: itself for a key, its field for a value. */
  key: string | null;
}

/**
 * Every name and every literal value of a transcription, tagged by which it
 * is, for the drift check below.
 *
 * The tag is what makes the check bite. Asking only that each token appear
 * somewhere in the fence lets `'sync'` pass against `'async'` and `'5.00'`
 * against `'15.00'`, which is not a hypothetical: both went through unnoticed
 * before the tag was here.
 */
const tokensOf = (value: unknown, key: string | null = null): Token[] => {
  if (typeof value === "string") return [{ kind: "text", text: value, key }];
  if (typeof value === "number" || typeof value === "boolean") {
    return [{ kind: "literal", text: String(value), key }];
  }
  if (Array.isArray(value)) return value.flatMap((item) => tokensOf(item, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([name, child]) => [
      { kind: "key" as const, text: name, key: name },
      ...tokensOf(child, name),
    ]);
  }
  return [];
};

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where in a TypeScript or JSON example a token of each kind has to appear. */
const occursIn = (fence: string, token: Token): boolean => {
  switch (token.kind) {
    // `email:` or `"email":` — a name in the position of a name.
    case "key":
      return new RegExp(`["']?${escaped(token.text)}["']?\\s*:`).test(fence);
    // `'sync'` or `"sync"` — a string, quotes and all, so one value cannot
    // pass as the tail of a longer one.
    case "text":
      return fence.includes(`'${token.text}'`) || fence.includes(`"${token.text}"`);
    // `60`, `true` — bounded, so 60 does not match inside 160.
    case "literal":
      return new RegExp(`(?<![\\w.])${escaped(token.text)}(?![\\w.])`).test(fence);
  }
};

/** The names an example writes on a line of their own, for the reverse check. */
const keysWrittenIn = (fence: string): string[] =>
  [...fence.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((match) => match[1] ?? "");

/**
 * The other direction of the drift check: names the example writes that the
 * transcription has never heard of.
 *
 * Without it a field added on the portal is invisible here — every token of
 * the transcription still occurs, so the check passes while the example has
 * grown something no schema is holding.
 */
const namesTheFixtureLacks = (fence: string, known: Set<string>): string[] =>
  keysWrittenIn(fence).filter((name) => !known.has(name));

interface Fence {
  file: string;
  language: string;
  index: number;
}

interface Common {
  what: string;
  fence: Fence;
  schema: z.ZodType;
}

type Fixture =
  | (Common & { kind: "read" })
  | (Common & {
      kind: "transcribed";
      value: unknown;
      /**
       * Also demand that the example write no name the transcription lacks —
       * only for fences that are a payload and nothing else. Turned on for the
       * examples where a field added on the portal would silently go
       * unchecked; left off where the fence is calling code and its own
       * variables would trip it.
       */
      completeKeys?: boolean;
      /** Names the fence writes around the payload rather than inside it. */
      outerKeys?: string[];
      /**
       * Fields whose value the example computes instead of writing out — a
       * timestamp from a clock, an amount from a lookup. The name is still
       * checked; the value cannot be, because there is no literal in the fence
       * to compare against, and the transcription has to invent one for the
       * schema to have something to parse.
       *
       * The escape hatch verifies itself: a field listed here whose value the
       * example does write literally fails the test, so the list cannot
       * quietly grow into a way of switching the drift check off.
       */
      computed?: string[];
    });

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
    completeKeys: true,
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
    completeKeys: true,
    // The fence shows the declaration under the card field it sits in.
    outerKeys: ["result"],
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
  {
    kind: "transcribed",
    what: "the same refusal, as the quickstart writes it",
    fence: { file: "portal/quickstart.md", language: "ts", index: 4 },
    schema: RefusalSchema,
    value: { code: "out_of_stock", message: "Поставщик не подтвердил номер" },
  },
  {
    kind: "transcribed",
    what: "a price handler answering that the item is there",
    fence: { file: "portal/quickstart.md", language: "ts", index: 5 },
    schema: QuoteResponseSchema,
    // The available branch names every field the fence writes on a line of
    // its own, so it can be held to the example in both directions.
    completeKeys: true,
    computed: ["amount", "as_of"],
    value: {
      available: true,
      price: { amount: "5.00", currency: "USD" },
      as_of: "2026-08-26T10:15:00Z",
    },
  },
  {
    kind: "transcribed",
    what: "the same price handler answering that it is not",
    fence: { file: "portal/quickstart.md", language: "ts", index: 5 },
    schema: QuoteResponseSchema,
    // No `completeKeys` here: one fence carries both answers, and `price`
    // belongs to the other one. Asking this fixture to account for every name
    // on the page would be asking it about a payload that is not its own.
    computed: ["as_of"],
    value: { available: false, as_of: "2026-08-26T10:15:00Z" },
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

describe("the drift check itself", () => {
  // The promise this file makes is that a portal edit cannot pass unnoticed,
  // and the whole promise rests on these few lines. An earlier version asked
  // only that each token appear somewhere in the fence, and `'sync'` passed
  // against a portal that said `'async'` while `'5.00'` passed against
  // `'15.00'` — the guard was green and guarding nothing.

  /** A token to look for, as `tokensOf` would have produced it. */
  const token = (kind: Token["kind"], text: string, key: string | null = null): Token => ({
    kind,
    text,
    key,
  });

  it("does not let one value pass as the tail of a longer one", () => {
    expect(occursIn("fulfillment: 'async'", token("text", "sync"))).toBe(false);
    expect(occursIn("fulfillment: 'sync'", token("text", "sync"))).toBe(true);

    expect(occursIn("amount: '15.00'", token("text", "5.00"))).toBe(false);
    expect(occursIn("amount: '5.00'", token("text", "5.00"))).toBe(true);

    expect(occursIn("eta_seconds: 160", token("literal", "60"))).toBe(false);
    expect(occursIn("eta_seconds: 60 }", token("literal", "60"))).toBe(true);
  });

  it("wants a name written where a name goes", () => {
    expect(occursIn("const email = order.params.email", token("key", "email"))).toBe(false);
    expect(occursIn("  email: { type: 'string' }", token("key", "email"))).toBe(true);
    expect(occursIn('  "email": "buyer@example.com"', token("key", "email"))).toBe(true);
  });

  it("reads the names an example writes, for the other direction", () => {
    expect(keysWrittenIn("  price: {\n    amount: '5.00',\n  }\n  title: 'x'")).toStrictEqual([
      "price",
      "amount",
      "title",
    ]);
  });

  it("keeps a value token tied to the field it came from", () => {
    // What lets a fixture say "this one field the example works out" without
    // that turning into "check nothing". The tie is the `key` on each token.
    const tokens = tokensOf({ available: true, price: { amount: "5.00", currency: "USD" } });

    expect(tokens.filter((token) => token.kind === "key").map((token) => token.text)).toStrictEqual(
      ["available", "price", "amount", "currency"],
    );
    expect(tokens.find((token) => token.text === "5.00")?.key).toBe("amount");
    expect(tokens.find((token) => token.kind === "literal")?.key).toBe("available");
  });

  it("notices a name the example grew and the transcription never heard of", () => {
    // The case the forward check cannot see: every token of the transcription
    // still occurs, and the example has gained a field nothing holds to a
    // schema.
    const known = new Set(["merchant_item_id", "title", "fulfillment"]);

    expect(namesTheFixtureLacks("  title: 'x'\n  fulfillment: 'sync'", known)).toStrictEqual([]);
    expect(
      namesTheFixtureLacks("  title: 'x'\n  subscription: { period: 'P1M' }", known),
    ).toStrictEqual(["subscription"]);
  });
});

describe("the portal's examples pass the schemas", () => {
  for (const fixture of fixtures) {
    it(`${fixture.what} (${fixture.fence.file})`, () => {
      const text = fenceTextOf(fixture.fence);

      if (fixture.kind === "transcribed") {
        const computed = new Set(fixture.computed ?? []);

        // The transcription is only worth as much as its likeness to the page.
        for (const token of tokensOf(fixture.value)) {
          if (token.kind !== "key" && token.key !== null && computed.has(token.key)) {
            // The example works this value out rather than writing it, so the
            // transcription's stand-in has nothing to be compared against —
            // but it does have to still be a stand-in.
            expect(
              occursIn(text, token),
              `the example now writes ${JSON.stringify(token.text)} for "${token.key}" literally, so it no longer belongs in this fixture's computed list`,
            ).toBe(false);
            continue;
          }

          expect(
            occursIn(text, token),
            `the example no longer writes the ${token.kind} ${JSON.stringify(token.text)}; the transcription here has to be brought back in line with the portal`,
          ).toBe(true);
        }

        if (fixture.completeKeys === true) {
          const known = new Set([
            ...tokensOf(fixture.value)
              .filter((token) => token.kind === "key")
              .map((token) => token.text),
            ...(fixture.outerKeys ?? []),
          ]);

          expect(
            namesTheFixtureLacks(text, known),
            "the example now writes names this fixture does not carry, so nothing holds them to a schema",
          ).toStrictEqual([]);
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
