/**
 * The workspace's vitest config, as Stryker has to see it from its sandbox.
 *
 * Stryker copies the checkout into a sandbox directory, mutates the copies and
 * runs vitest there, so that the working tree is never touched. Inside the
 * sandbox every `node_modules` is a symlink back to the real one, and under
 * pnpm a workspace package is itself a symlink inside `node_modules`:
 * `apps/gateway/node_modules/@coinslot/core` points at `../../../packages/core`
 * of the real checkout, not of the sandbox. Left alone, every test outside
 * `packages/core` would import the unmutated core and kill nothing, and the
 * test that killed a mutant the spike named (`packages/slice/src/stand.test.ts`)
 * would not even count as related to it.
 *
 * So this file takes the workspace config as it is and adds one thing: an
 * alias for every workspace package, built from its `exports` map, pointing
 * at the copy inside the sandbox. It is loaded only by `scripts/mutate.mjs`;
 * `pnpm test` keeps reading `vitest.config.ts` and never sees it.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import workspace from "../vitest.config.js";

const root = path.resolve(import.meta.dirname, "..");

const exact = (specifier: string): RegExp =>
  new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);

const alias = ["packages", "apps"].flatMap((group) =>
  readdirSync(path.join(root, group)).flatMap((name) => {
    const dir = path.join(root, group, name);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      name: string;
      exports?: Record<string, string>;
    };
    return Object.entries(manifest.exports ?? {}).map(([subpath, target]) => ({
      find: exact(path.posix.join(manifest.name, subpath)),
      replacement: path.join(dir, target),
    }));
  }),
);

export default mergeConfig(workspace, defineConfig({ resolve: { alias } }));
