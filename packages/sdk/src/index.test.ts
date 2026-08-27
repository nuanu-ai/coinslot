import { existsSync, readFileSync } from "node:fs";
import { CONTRACT_VERSION } from "@coinslot/contracts";
import { describe, expect, it } from "vitest";
import { contractVersion, speaksContract } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  private?: boolean;
  files?: readonly string[];
  license?: string;
  repository?: unknown;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  publishConfig?: {
    bin?: Record<string, string>;
    exports?: Record<string, { types?: string; default?: string }>;
  };
};

/**
 * The source file a published path is compiled from.
 *
 * The build is `tsc` with `src` as its root and `dist` as its output, so every
 * `./dist/x.js` and `./dist/x.d.ts` the manifest names comes from `./src/x.ts`
 * and from nowhere else. Reversing that mapping is what lets this test check
 * the manifest against the tree without running the build: a file renamed in
 * `src` turns a published path into a promise nothing keeps, and the merchant
 * would be the one to find out.
 */
const sourceOf = (published: string): string =>
  published.replace(/^\.\/dist\//, "./src/").replace(/\.d\.ts$|\.js$/, ".ts");

const inPackage = (path: string): boolean => existsSync(new URL(`../${path}`, import.meta.url));

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

  it("advertises the command the documentation tells a merchant to run", () => {
    // The promise: `npx coinslot verify` starts. npx finds a command through
    // this field, so a package without it makes step 4 of the quickstart
    // impossible for everyone who is not us. What the field points at has to
    // be the built command and not the source, because Node runs the one and
    // not the other.
    expect(manifest.publishConfig?.bin).toStrictEqual({ coinslot: "./dist/cli.js" });
  });

  it("publishes its build and develops against its source", () => {
    // Two promises at once, and they pull in opposite directions. Outside this
    // repository the entry point has to be compiled JavaScript with types
    // beside it, because a merchant's Node cannot run our TypeScript. Inside
    // it, every app and every test still imports `src` directly, so a change
    // is visible without a compile step. `publishConfig` is what keeps both:
    // pnpm swaps these fields in when it packs, and the working tree never
    // sees them.
    expect(manifest.exports).toStrictEqual({ ".": "./src/index.ts" });
    expect(manifest.publishConfig?.exports).toStrictEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    });
  });

  it("names only published paths its own source can produce", () => {
    // The drift this catches: `src/cli.ts` renamed, or the entry point moved,
    // leaving the manifest advertising a file the build will not write. The
    // tarball would then install and fail on first use — which is exactly the
    // failure nobody sees from inside the workspace. `pnpm outside` proves the
    // build really produces them; this holds the mapping without a build.
    const published = [
      ...Object.values(manifest.publishConfig?.bin ?? {}),
      ...Object.values(manifest.publishConfig?.exports ?? {}).flatMap((entry) =>
        [entry.types, entry.default].filter((path) => path !== undefined),
      ),
    ];

    expect(published.length).toBeGreaterThan(0);
    expect(published.filter((path) => !inPackage(sourceOf(path)))).toStrictEqual([]);
  });

  it("carries what npm needs to publish it", () => {
    // A merchant installs this from a registry, so the fields a registry reads
    // are part of the deliverable. `files` is the one with teeth: without it
    // npm ships the whole directory, and our tests, our fixtures and our
    // fake gateway would land in someone else's production.
    expect(manifest.private).toBeUndefined();
    expect(manifest.files).toStrictEqual(["dist"]);
    expect(manifest.license).toBe("UNLICENSED");
    expect(manifest.repository).toBeDefined();
    expect(manifest.engines?.node).toBeDefined();
  });
});
