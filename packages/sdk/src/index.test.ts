import { readFileSync } from "node:fs";
import { CONTRACT_VERSION } from "@coinslot/contracts";
import { describe, expect, it } from "vitest";
import { contractVersion, speaksContract } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("@coinslot/sdk", () => {
  it("checks the contract version and refuses a foreign one", () => {
    // The promise to the merchant: a divergence of dialects is discovered at
    // worker startup, not on an order, where it costs the buyer money.
    expect(contractVersion).toBe(CONTRACT_VERSION);
    expect(speaksContract(CONTRACT_VERSION)).toBe(true);
    expect(speaksContract(`${CONTRACT_VERSION}-foreign`)).toBe(false);
  });

  it("drags in not a single third-party runtime dependency", () => {
    // The hard rule of ADR-0003 §8. A failing check means the merchant has
    // installed a foreign package into their production along with the SDK,
    // and every such exception must be a separate written decision.
    const thirdParty = Object.entries(manifest.dependencies ?? {}).filter(
      ([, range]) => !range.startsWith("workspace:"),
    );

    expect(thirdParty).toStrictEqual([]);
  });
});
