import { defineConfig } from "drizzle-kit";

/**
 * Where the migrations come from and where they go.
 *
 * The generated SQL is checked in, so what a deployment applies is a file
 * somebody read rather than whatever a tool works out at the time. Applying it
 * is `pnpm --filter @coinslot/gateway db:migrate`, which needs DATABASE_URL and
 * nothing else.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/adapters/postgres/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
});
