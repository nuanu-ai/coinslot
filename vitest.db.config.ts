import { defineConfig } from "vitest/config";

/**
 * The suite that needs a database.
 *
 * It is a separate command because `pnpm test` is free, deterministic and works
 * without a network, and a suite that needs a Postgres server is none of those.
 * These tests skip themselves with a sentence saying so when DATABASE_URL is
 * absent, so running the command without a database is a clear message rather
 * than a wall of connection errors.
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://coinslot:coinslot@localhost:5432/coinslot pnpm test:db
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/*/src/**/*.db-test.ts"],
    passWithNoTests: false,
    // Verbose so that the sentence explaining a skip is actually printed. A run
    // that says "1 skipped" and nothing else reads like a suite that passed.
    reporters: ["verbose"],
    // One database, one schema: two files writing the same tables at once would
    // be testing each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
