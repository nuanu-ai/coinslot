import { defineConfig } from "vitest/config";

/**
 * The suite that needs a database.
 *
 * It is a separate command because `pnpm test` is free, deterministic and works
 * without a network, and a suite that needs a Postgres server is none of those.
 * These tests skip themselves with a sentence saying so when there is no server
 * to reach, so running the command without one is a clear message rather than a
 * wall of connection errors.
 *
 *   docker compose up -d --wait postgres
 *   pnpm test:db
 *
 * Naming the service matters: `docker compose up -d` with nothing after it
 * starts the whole stack, six services of it.
 *
 * There is nothing to set. The suite runs against `coinslot_test`, which is its
 * own database on that server and not the `coinslot` the gateway and the
 * cabinet use, and it makes that database if it is not there. DATABASE_URL
 * still overrides it, and naming `coinslot` is refused: this suite empties
 * every table it finds and drops the queue's schema, which is not a thing to do
 * quietly to the database somebody is watching.
 */
export default defineConfig({
  test: {
    environment: "node",
    // A run with no server reachable fails here rather than skipping every file
    // and exiting zero. See the file for why that mattered.
    globalSetup: ["./vitest.db.setup.ts"],
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
