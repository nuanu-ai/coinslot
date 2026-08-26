import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "./index.js";
import { CONTRACT_VERSION, type JsonSchemaDocument, schemas, toJsonSchemas } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

/**
 * A schema nested inside another one, as an object.
 *
 * JSON Schema allows `true` and `false` in the places a sub-schema can sit,
 * and none of ours are ever that — so the tests below say so once here rather
 * than at every step of a path.
 */
const nested = (value: JsonSchemaDocument[keyof JsonSchemaDocument]): JsonSchemaDocument => {
  expect(value, "expected a nested schema object").toBeTypeOf("object");
  return (value ?? {}) as JsonSchemaDocument;
};

/** A zod schema as it is built internally, for the refinement walk below. */
interface ZodInternals {
  _zod?: { def?: Record<string, unknown> };
}

/**
 * The keys under which zod stores one schema inside another, as of zod 4.
 *
 * `shape` and `options` hold several; the rest hold one. `getter` is `z.lazy`,
 * which has to be called to yield anything.
 */
const WAYS_A_SCHEMA_HOLDS_ANOTHER = [
  "shape",
  "options",
  "valueType",
  "keyType",
  "innerType",
  "element",
  "items",
  "rest",
  "left",
  "right",
  "in",
  "out",
  "catchall",
  "getter",
] as const;

const callGetter = (getter: unknown): unknown =>
  typeof getter === "function" ? (getter as () => unknown)() : undefined;

const isRefined = (schema: unknown): boolean =>
  (((schema as ZodInternals)._zod?.def?.checks as unknown[]) ?? []).some(
    (check) => (check as ZodInternals)._zod?.def?.check === "custom",
  );

/**
 * Every schema in the registry that carries a refinement, by the path it sits
 * at — including the ones nested inside another schema, which is where the
 * defect hid the first time.
 *
 * The walk follows the shapes zod builds a schema out of. It is coupled to
 * those internals on purpose: a walk that quietly stopped finding anything
 * would leave the invariant below passing over nothing, so a companion test
 * pins what it finds today.
 */
const walkRefined = (
  schema: unknown,
  path: string,
  found: { path: string; described: boolean }[],
  seen: Set<unknown>,
): void => {
  if (schema === null || typeof schema !== "object" || seen.has(schema)) return;
  seen.add(schema);

  const def = (schema as ZodInternals)._zod?.def;
  if (def === undefined) return;

  if (isRefined(schema)) {
    const meta = z.globalRegistry.get(schema as never);
    found.push({ path, described: (meta?.description ?? "").length > 0 });
  }

  // Every way zod holds one schema inside another. The list was short once and
  // a refinement inside a tuple went unseen — which is the failure this whole
  // invariant exists to prevent, so the walk is tested against each of these
  // rather than trusted to be complete.
  for (const key of WAYS_A_SCHEMA_HOLDS_ANOTHER) {
    const child = key === "getter" ? callGetter(def[key]) : def[key];
    if (child === undefined) continue;

    if (Array.isArray(child)) {
      for (const [index, option] of child.entries()) {
        walkRefined(option, `${path}[${index}]`, found, seen);
      }
    } else if (key === "shape") {
      for (const [name, field] of Object.entries(child as Record<string, unknown>)) {
        walkRefined(field, `${path}.${name}`, found, seen);
      }
    } else {
      walkRefined(child, path, found, seen);
    }
  }
};

/** The refinements inside one schema, described or not. */
const refinementsIn = (schema: unknown, name: string): { path: string; described: boolean }[] => {
  const found: { path: string; described: boolean }[] = [];
  walkRefined(schema, name, found, new Set<unknown>());
  return found;
};

const refinedSchemas = (): { path: string; described: boolean }[] => {
  const found: { path: string; described: boolean }[] = [];
  const seen = new Set<unknown>();
  for (const [name, schema] of Object.entries(schemas)) walkRefined(schema, name, found, seen);
  return found;
};

const refinedSchemaPaths = (): string[] => refinedSchemas().map((entry) => entry.path);

const refinedSchemasWithoutDescription = (): string[] =>
  refinedSchemas()
    .filter((entry) => !entry.described)
    .map((entry) => entry.path);

describe("@coinslot/contracts", () => {
  it("declares the contract version and keeps zod its only runtime dependency", () => {
    // The version is what the merchant's SDK and the gateway use to tell that
    // they are talking about the same thing. An empty string would mean "there
    // is no version", and a version silently missing from the contract must
    // not happen.
    expect(CONTRACT_VERSION).not.toBe("");

    // Contracts is the only package the SDK drags along, so its dependency
    // tree is the SDK's dependency tree (ADR-0003 §8). A failing check means
    // the merchant got something extra when installing.
    expect(Object.keys(manifest.dependencies ?? {})).toStrictEqual(["zod"]);
  });
});

describe("the registry of schemas", () => {
  it("holds every schema this package exports", () => {
    // The promise: the contract has one list, and it is this one. A schema
    // that exists but is not registered is invisible to the JSON Schema export
    // below, which is the only way an engineer outside TypeScript reads any of
    // this — and nobody notices until they ask why a field is undocumented.
    const registered = new Set<unknown>(Object.values(schemas));
    const missing = Object.entries(contracts)
      .filter(([name, value]) => name.endsWith("Schema") && !registered.has(value))
      .map(([name]) => name);

    expect(missing).toStrictEqual([]);
  });

  it("is reachable from outside this package, every bit of it", async () => {
    // The direction nothing was checking, and it hid a whole round's work:
    // `order_status`, `order_call_result` and the two card helpers existed,
    // were registered, and were re-exported by nobody — so the JSON Schema
    // reader could see them and the SDK could not. The package exposes one
    // entry point, so anything not named here does not exist for a consumer.
    //
    // Walking the modules rather than listing them is the point: the next
    // schema added to a file nobody remembers to re-export fails here.
    const publicModules = readdirSync(new URL(".", import.meta.url))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "index.ts")
      .sort();

    expect(publicModules.length).toBeGreaterThan(5);

    const exported = new Set(Object.keys(contracts));
    const unreachable: string[] = [];

    for (const file of publicModules) {
      const module = (await import(`./${file.replace(/\.ts$/, ".js")}`)) as Record<string, unknown>;
      for (const name of Object.keys(module)) {
        if (!exported.has(name)) unreachable.push(`${file}: ${name}`);
      }
    }

    expect(unreachable).toStrictEqual([]);
  });

  it("registers nothing under a name that is not written the way the wire is", () => {
    // The registry names are what a consumer outside TypeScript sees, and the
    // fields on the wire are snake_case. A registry that mixed conventions
    // would make the export read like two contracts.
    for (const name of Object.keys(schemas)) {
      expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("the contract as JSON Schema", () => {
  it("converts every schema in the registry", () => {
    // The promise: a merchant's engineer working in a language that is not
    // TypeScript gets the contract we do. A schema built out of something that
    // has no JSON Schema equivalent fails here, at our build, instead of
    // failing in their generator.
    const documents = toJsonSchemas();

    expect(Object.keys(documents).sort()).toStrictEqual(Object.keys(schemas).sort());
  });

  it("describes something in every document, not only the ones read back below", () => {
    // The tests further down read seven documents in detail, and that left
    // twenty describing nothing without a single failure — including `order`,
    // `receipt` and `quote_request`, which are the ones an engineer actually
    // generates from. Detailed reading does not scale to every schema; this
    // does, and it is the line that catches a document reduced to its name.
    const empty = Object.entries(toJsonSchemas())
      .filter(
        ([, document]) =>
          Object.keys(document).filter((key) => key !== "$id" && key !== "$schema").length === 0,
      )
      .map(([name]) => name);

    expect(empty).toStrictEqual([]);
  });

  it("stamps each document with the contract version it came from", () => {
    // Without it the document is a contract of unknown vintage. The version
    // exists so the two sides can tell they mean the same thing, and the
    // readers furthest from us are the ones who cannot ask.
    const documents = toJsonSchemas();

    expect(documents.card.$id).toBe(`urn:coinslot:contract:${CONTRACT_VERSION}:card`);
    for (const [name, document] of Object.entries(documents)) {
      expect(document.$id, name).toContain(`:${CONTRACT_VERSION}:`);
    }
  });

  // A conversion that quietly produced an empty document for everything would
  // satisfy a test that only counts keys. These read documents back, one per
  // kind of structure the registry contains, so a stub is not enough.

  it("describes an object with its required fields and its closed shape", () => {
    const money = toJsonSchemas().money;

    expect(money.type).toBe("object");
    expect(money.required).toStrictEqual(["amount", "currency"]);
    expect(money.additionalProperties).toBe(false);
    expect(money.properties?.amount).toMatchObject({ type: "string" });
  });

  it("describes an enumeration as its values and nothing else", () => {
    expect(toJsonSchemas().fulfillment.enum).toStrictEqual(["sync", "async", "confirm"]);
    expect(toJsonSchemas().receipt_outcome.enum).toStrictEqual([
      "in_progress",
      "delivered",
      "refund_due",
      "refunded",
    ]);
  });

  it("describes a plain union as its branches", () => {
    const answer = toJsonSchemas().handler_answer;
    const branches = answer.anyOf ?? answer.oneOf ?? [];

    expect(branches).toHaveLength(3);
    expect(branches.flatMap((branch) => branch.required ?? []).sort()).toStrictEqual([
      "accepted",
      "delivered",
      "refused",
    ]);
  });

  it("describes a discriminated union as branches pinned to their discriminator", () => {
    const answer = toJsonSchemas().quote_response;
    const branches = answer.anyOf ?? answer.oneOf ?? [];

    expect(branches).toHaveLength(2);
    expect(branches.map((branch) => nested(branch.properties?.available).const)).toStrictEqual([
      true,
      false,
    ]);
    // The whole point of the two branches: a price on one, none on the other.
    expect(branches[0]?.required).toContain("price");
    expect(branches[1]?.required).not.toContain("price");
    expect(branches[1]?.properties?.price).toBeUndefined();
  });

  it("describes a record by what its keys and its values have to look like", () => {
    const spec = toJsonSchemas().param_spec;

    expect(spec.propertyNames).toMatchObject({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" });
    expect(spec.additionalProperties).toMatchObject({ required: ["type"] });
  });

  it("exports the identifier rule whole, and it means the same thing there", () => {
    // The rule is one pattern rather than several checks precisely so that all
    // of it crosses into the document: a generated client should refuse the
    // keys we refuse. The pattern is read back out and run, because a pattern
    // that is present and matches everything would pass a test that only
    // looked for one.
    const pattern = toJsonSchemas().identifier.pattern;

    expect(pattern).toBeTypeOf("string");
    const accepts = (value: string) => new RegExp(pattern ?? "", "u").test(value);

    expect(accepts("access-monthly")).toBe(true);
    expect(accepts("SKU 100/1")).toBe(true);
    expect(accepts("")).toBe(false);
    expect(accepts("access-monthly ")).toBe(false);
    expect(accepts("a\u0000b")).toBe(false);
    expect(accepts("access-monthly\u200b")).toBe(false);
  });

  it("leaves no refinement undescribed, anywhere in the registry", () => {
    // This is the abstraction the second review asked for, and the reason is
    // that the same defect arrived twice: a rule written as a refinement
    // vanishes from the export without a word, and remembering to describe it
    // per schema failed the first time it was tried. The invariant replaces
    // the remembering — add a refinement anywhere and the build asks for the
    // sentence that tells a generator's reader what is not being checked.
    //
    // It reads zod's own internals to find the refinements, which is a
    // deliberate coupling: if that shape ever changes, this test breaks
    // loudly, and a silently empty walk would be worse than a broken one.
    const undescribed = refinedSchemasWithoutDescription();

    expect(undescribed).toStrictEqual([]);
  });

  it("finds the refinements it is supposed to be checking", () => {
    // The other half: a walk that found nothing would satisfy the invariant
    // above and check nothing at all. These two are the refinements the
    // package has today, one of them nested inside another schema.
    expect(refinedSchemaPaths().sort()).toStrictEqual(["card", "card.result"]);
  });

  it("would notice an undescribed refinement, including a nested one", () => {
    // And the third part, which the mutation self-check asked for: with every
    // refinement in the package described, the invariant passes whether it is
    // demanding a description or not. These two schemas are built here, never
    // registered, purely so the demand itself is exercised.
    const undescribed = z.string().refine(() => true);
    const described = z
      .string()
      .refine(() => true)
      .meta({ description: "says what it checks" });

    expect(refinementsIn(undescribed, "bare")).toStrictEqual([{ path: "bare", described: false }]);
    expect(refinementsIn(described, "bare")).toStrictEqual([{ path: "bare", described: true }]);

    // Nested, which is where the defect actually hid.
    expect(refinementsIn(z.strictObject({ field: undescribed }), "holder")).toStrictEqual([
      { path: "holder.field", described: false },
    ]);

    // And a schema with no refinement at all contributes nothing.
    expect(refinementsIn(z.string(), "plain")).toStrictEqual([]);
  });

  it("reaches inside every way zod holds one schema in another", () => {
    // The companion test above pins what the walk finds in the registry, which
    // is not the guard it looks like: a container the walk cannot enter simply
    // contributes nothing, and the found set stays exactly as expected. A
    // refinement inside a tuple went unseen that way — and unseen means its
    // rule vanishes from the export in silence, the defect this file has now
    // paid for three times.
    const hidden = z.string().refine(() => true);
    const containers: [string, z.ZodType][] = [
      ["object", z.strictObject({ field: hidden })],
      ["record value", z.record(z.string(), hidden)],
      ["array", z.array(hidden)],
      ["optional", hidden.optional()],
      ["nullable", hidden.nullable()],
      ["default", hidden.default("x")],
      ["union", z.union([hidden, z.number()])],
      ["tuple", z.tuple([hidden])],
      ["tuple rest", z.tuple([z.string()], hidden)],
      ["intersection left", z.intersection(hidden, z.string())],
      ["intersection right", z.intersection(z.string(), hidden)],
      // A pipe holds one on each side, and testing only one of them let the
      // other's key be dropped from the walk without a failure.
      ["pipe out", z.string().pipe(hidden)],
      ["pipe in", hidden.pipe(z.string())],
      ["lazy", z.lazy(() => hidden)],
      ["catchall", z.object({}).catchall(hidden)],
    ];

    const blind = containers
      .filter(([, container]) => refinementsIn(container, "held").length === 0)
      .map(([name]) => name);

    expect(blind).toStrictEqual([]);
  });

  it("carries the open code dictionaries, which no structure can hold", () => {
    // An open set has no `enum` to render, so the recommended codes reached
    // the export as `{type: "string"}` and nothing else. `index.ts` claims
    // this package owns the refusal codes as wire vocabulary; owning them and
    // not shipping them to the one reader the export exists for is the fifth
    // gate's truncation, unsaid.
    const documents = toJsonSchemas();
    const refusal = documents.refusal_code.description ?? "";

    for (const code of Object.values(contracts.RECOMMENDED_REFUSAL_CODES)) {
      expect(refusal, code).toContain(code);
    }
    expect(refusal).toContain("open");

    const callError = nested(documents.order_call_error.properties?.code).description ?? "";
    for (const code of contracts.ORDER_CALL_ERROR_CODES) {
      expect(callError, code).toContain(code);
    }
  });

  it("carries the rules it cannot express as structure in words instead", () => {
    // The honest half of the export. JSON Schema cannot say "this field only
    // when that one has this value", and zod drops such a rule without a word;
    // a reader who was not told would take the document for the whole
    // contract. The card's two deadline rules are the case in point.
    const card = toJsonSchemas().card;

    expect(card.description).toContain("confirm_deadline_seconds");
    expect(card.description).toContain("fulfill_deadline_seconds");

    // And where a rule can be expressed after all, it is: the card's result
    // declaration is never empty, and the price hook is https. The pattern is
    // read back and run, because a pattern that is present and means nothing
    // would pass a check that only looked for it.
    expect(card.properties?.result).toMatchObject({ minProperties: 1 });

    const priceCheck = nested(card.properties?.price_check);
    const address = (priceCheck.anyOf ?? priceCheck.oneOf ?? []).find(
      (branch) => nested(branch).properties?.url !== undefined,
    );
    const pattern = nested(nested(address).properties?.url).pattern;

    expect(pattern).toBeTypeOf("string");
    expect(new RegExp(pattern ?? "").test("https://api.example.com/quote")).toBe(true);
    expect(new RegExp(pattern ?? "").test("http://api.example.com/quote")).toBe(false);
  });
});
