import { existsSync, readFileSync } from "node:fs";
import { CONTRACT_VERSION } from "@coinslot/contracts";
import { describe, expect, it } from "vitest";
import { contractVersion, speaksContract } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  bin?: Record<string, string>;
};

describe("@coinslot/sdk", () => {
  it("checks the contract version and refuses a foreign one", () => {
    // The promise to the merchant: a divergence of dialects is discovered at
    // worker startup, not on an order, where it costs the buyer money.
    expect(contractVersion).toBe(CONTRACT_VERSION);
    expect(speaksContract(CONTRACT_VERSION)).toBe(true);
    expect(speaksContract(`${CONTRACT_VERSION}-foreign`)).toBe(false);
  });

  it("declares no third-party dependency of its own", () => {
    // The tree the merchant gets is `@coinslot/contracts` and `zod`, nothing
    // else. This is one half of the pin — the SDK adds nothing of its own; the
    // other half is the contracts test, which holds contracts to exactly zod.
    // A failing check means a third-party package entered the merchant's
    // production along with the SDK without a recorded decision (ADR-0003 §8).
    const thirdParty = Object.entries(manifest.dependencies ?? {}).filter(
      ([, range]) => !range.startsWith("workspace:"),
    );

    expect(thirdParty).toStrictEqual([]);
  });

  it("offers the command the documentation tells a merchant to run", () => {
    // The portal's step 4 is `npx coinslot verify`, and npx finds nothing
    // without this entry. The file it names has to be there too: a bin
    // pointing at a path that moved is a command that fails on the merchant's
    // machine and nowhere else.
    const command = manifest.bin?.coinslot;

    expect(command).toBe("./src/cli.ts");
    expect(existsSync(new URL(`../${command}`, import.meta.url))).toBe(true);
  });
});
