/**
 * What this package promises the registry, checked without a build.
 *
 * The contracts package became publishable at the same time as the SDK, and for
 * the same reason: the SDK depends on it, so a merchant who installs one
 * installs both. That makes its manifest part of the deliverable rather than an
 * internal detail, and it had no guard of its own — `pnpm outside` would have
 * caught a mistake here, but only after a pack, an install and a network round
 * trip, and only for as long as somebody kept running it.
 *
 * The field that matters most is `files`. Without it npm ships the whole
 * directory, and `src/testing/expect-schema.ts` imports vitest — so a slip here
 * puts a runtime import of a package nobody installed into a merchant's
 * production. The build excludes that directory; this holds the other half.
 *
 * These live in their own file rather than in `index.test.ts` because they are
 * about the package rather than about the schemas, and the two answer to
 * different readers.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version?: string;
  private?: boolean;
  files?: readonly string[];
  license?: string;
  repository?: unknown;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
  publishConfig?: {
    access?: string;
    exports?: Record<string, { types?: string; default?: string }>;
  };
};

describe("@coinslot/contracts as a published package", () => {
  it("publishes its build and develops against its source", () => {
    // Inside this repository every import reads `src` directly, so a change to
    // a schema is visible with no compile step. Outside it, a merchant's Node
    // cannot run TypeScript. `publishConfig` is what holds both at once: pnpm
    // swaps these in when it packs and the working tree never sees them.
    expect(manifest.exports).toStrictEqual({ ".": "./src/index.ts" });
    expect(manifest.publishConfig?.exports).toStrictEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    });
  });

  it("names published paths its own source can produce", () => {
    // The build is `tsc` from `src` into `dist`, so `./dist/index.js` can only
    // come from `./src/index.ts`. A renamed entry point would otherwise leave
    // the manifest promising a file the build never writes, and the tarball
    // would install and fail on first import.
    const published = Object.values(manifest.publishConfig?.exports ?? {}).flatMap((entry) =>
      [entry.types, entry.default].filter((path) => path !== undefined),
    );

    expect(published.length).toBeGreaterThan(0);

    for (const path of published) {
      const source = path.replace(/^\.\/dist\//, "./src/").replace(/\.d\.ts$|\.js$/, ".ts");

      expect(existsSync(new URL(`../${source}`, import.meta.url))).toBe(true);
    }
  });

  it("carries what npm needs to publish it, and builds before it is packed", () => {
    // `prepack` is the one with a story. Without it, packing a tree whose
    // `dist` is absent produces a tarball holding nothing but this manifest —
    // no error, no warning — while the entry points above still name files
    // that are not in it.
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).not.toBe("0.0.0");
    expect(manifest.files).toStrictEqual(["dist"]);
    expect(manifest.license).toBe("UNLICENSED");
    expect(manifest.repository).toBeDefined();
    expect(manifest.engines?.node).toBeDefined();
    expect(manifest.scripts?.prepack).toBeDefined();
    expect(manifest.publishConfig?.access).toBe("public");
    expect(existsSync(new URL("../README.md", import.meta.url))).toBe(true);
  });
});
