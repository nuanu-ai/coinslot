#!/usr/bin/env node

/**
 * Stryker's mutation report for one workspace package, with the working tree
 * left alone.
 *
 * Usage: pnpm mutate <package>       (a directory name under packages/ or apps/)
 *
 * Stryker is a triage tool here, not a gate: the run prints the clear-text
 * table and writes the JSON report, and someone reads the survivors. It is
 * run from the root of the checkout, from which Stryker copies the tracked
 * files into a sandbox, mutates the copies and runs vitest there. Nothing it
 * does reaches the checkout, and a run killed half-way leaves nothing behind
 * but its sandbox on the sdb disk. Its `inPlace` mode, the one the spike
 * (`docs/research/27-stryker-spike.md`) had to use, is the opposite: it
 * rewrites the tree itself and leaves it dirty when the process dies.
 *
 * Why each option is what it is:
 *
 * - TypeScript 5 for Stryker. The sandbox rewrites `tsconfig.json` through
 *   TypeScript's own API, and it calls `parseConfigFileTextToJson`, which
 *   TypeScript 7 no longer exports. `pnpm.packageExtensions` in the root
 *   `package.json` gives `@stryker-mutator/core` a TypeScript 5 of its own;
 *   the workspace's `tsc` stays what it is.
 * - The runner named in `plugins`. The default `@stryker-mutator/*` glob is
 *   resolved next to the installed `core`, and under pnpm nothing else is
 *   installed there.
 * - The root of the checkout as the working directory. Stryker's sandbox is a
 *   copy of the tracked files under the directory it runs from, plus a symlink
 *   for every `node_modules` beneath it. Run from `packages/core` the sandbox
 *   would hold core alone: not the vitest config, not the network guard it
 *   loads, none of the tests in gateway and slice that import core. Run from
 *   the root, all of them are copied and the runner picks the test files that
 *   import the mutated ones. The one thing the copy gets wrong, a workspace
 *   symlink that leads back to the real checkout, is corrected by
 *   `scripts/stryker.vitest.config.ts`, which is why that file is passed as
 *   the vitest config rather than `vitest.config.ts` directly.
 * - Everything Stryker writes goes to the sdb disk: the sandbox
 *   (`tempDirName`) and the report (`jsonReporter.fileName`) are absolute
 *   paths under STORAGE, because the root disk is small and because a file
 *   that appears inside the checkout is a file `git status` has to explain.
 *   Sandboxes left by killed runs are removed at the start of the next one;
 *   two runs at once on this machine is not something this script supports.
 * - The narrow mode. Static mutants, those that only run when a module is
 *   loaded, cost a full reload of the environment and all of the tests each;
 *   `ignoreStatic` skips them, string literals are excluded as a class, and
 *   coverage is taken per test so that a mutant runs only the tests that
 *   reach it. On core this is the difference between five minutes and more
 *   than fifteen. The price is that the state machine's transition table,
 *   which is built at load time, goes unmutated.
 * - The clear-text report lists the mutants that survived, each with its
 *   diff and the tests that ran against it, and the score table; the list of
 *   every test in the dry run, twelve hundred lines that say nothing about a
 *   mutant, is switched off.
 * - Only `.ts` files are mutated, tests and their `fixtures.ts` excluded. The
 *   count is then the count the spike measured. `preflight.mjs` in core is
 *   spawned as a child process by its test, where a mutant switched on in this
 *   process is not seen, so mutating it would only report survivors that are
 *   not holes.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Stryker } from "@stryker-mutator/core";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STORAGE = "/home/dmitry/.codex-project-storage/stryker";

const name = process.argv[2];
const packageDir = ["packages", "apps"]
  .map((group) => path.join(group, name ?? ""))
  .find((dir) => name && existsSync(path.join(ROOT, dir, "package.json")));

if (packageDir === undefined) {
  console.error(
    "Usage: pnpm mutate <package>, where <package> is a directory under packages/ or apps/",
  );
  process.exit(2);
}

const sandboxes = path.join(STORAGE, "sandboxes");
const report = path.join(STORAGE, "reports", name, "mutation.json");

process.chdir(ROOT);
rmSync(sandboxes, { recursive: true, force: true });
mkdirSync(path.dirname(report), { recursive: true });

const stryker = new Stryker({
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: { configFile: "scripts/stryker.vitest.config.ts" },
  mutate: [`${packageDir}/src/**/!(*.test|fixtures).ts`],
  coverageAnalysis: "perTest",
  ignoreStatic: true,
  mutator: { excludedMutations: ["StringLiteral"] },
  tempDirName: sandboxes,
  cleanTempDir: "always",
  reporters: ["clear-text", "progress", "json"],
  clearTextReporter: { reportTests: false },
  jsonReporter: { fileName: report },
});

try {
  await stryker.runMutationTest();
  console.log(`The report is at ${report}`);
} catch {
  // Stryker has already said what went wrong; the exit code says it went wrong.
  process.exit(1);
}
