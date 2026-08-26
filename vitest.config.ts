import { defineConfig } from "vitest/config";

/**
 * One config for the whole workspace: tests sit next to the code, and we do
 * not set up a separate project per package until that is genuinely needed.
 *
 * `pnpm test` must be free, deterministic and work without the network.
 * Everything that touches the chain, the facilitator or a merchant's live API
 * lives in a separate smoke command with a spending cap and does not get in
 * here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    passWithNoTests: false,
  },
});
