import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "./index.js";

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
