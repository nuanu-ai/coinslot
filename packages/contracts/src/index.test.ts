import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";
import { CONTRACT_VERSION, schemas, toJsonSchemas } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
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
    // TypeScript gets the same contract we do. A schema built out of something
    // that has no JSON Schema equivalent fails here, at our build, instead of
    // failing in their generator.
    const documents = toJsonSchemas();

    expect(Object.keys(documents).sort()).toStrictEqual(Object.keys(schemas).sort());
    for (const [name, document] of Object.entries(documents)) {
      expect(document, name).toBeTypeOf("object");
      expect(Object.keys(document).length, name).toBeGreaterThan(0);
    }
  });

  it("describes money the way the schema does", () => {
    // A conversion that quietly produced `{}` for everything would satisfy the
    // test above and describe nothing. This one reads one document back.
    const money = toJsonSchemas().money;

    expect(money.type).toBe("object");
    expect(money.required).toStrictEqual(["amount", "currency"]);
    expect(money.additionalProperties).toBe(false);
    expect(money.properties?.amount).toMatchObject({ type: "string" });
  });

  it("describes a card's fulfillment as the three modes and nothing else", () => {
    expect(toJsonSchemas().fulfillment.enum).toStrictEqual(["sync", "async", "confirm"]);
  });
});
