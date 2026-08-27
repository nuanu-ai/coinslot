import { defineConfig } from "vitest/config";

/**
 * One config for the whole workspace: tests sit next to the code, and we do
 * not set up a separate project per package until that is genuinely needed.
 *
 * `pnpm test` must be free, deterministic and work without the network.
 * Everything that touches the chain, the facilitator or a merchant's live API
 * lives in a separate smoke command with a spending cap and does not get in
 * here.
 *
 * That was a sentence until a pair of tests quietly called a validation
 * endpoint on every run and went green either way. `vitest.setup.ts` is the
 * same sentence with teeth: a request to anywhere but this process fails the
 * test that made it, and loopback — a server a suite stands up in this
 * process — is what stays allowed.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    passWithNoTests: false,
  },
});
