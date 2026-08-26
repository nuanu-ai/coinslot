import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
      "pending",
      "delivered",
      "refund_due",
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
