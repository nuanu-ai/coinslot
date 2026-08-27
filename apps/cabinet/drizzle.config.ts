import { defineConfig } from "drizzle-kit";

/**
 * Where the cabinet's migrations come from and where they go.
 *
 * The generated SQL is checked in, so what a deployment applies is a file
 * somebody read rather than whatever a tool works out at the time. Applying it
 * is `pnpm --filter @coinslot/cabinet db:migrate`, which needs DATABASE_URL and
 * nothing else.
 *
 * The history is kept in a table of its own rather than in the default one,
 * which belongs to the gateway. Two independent sets of migrations sharing one
 * journal would each read the other's entries as its own and conclude there was
 * nothing left to apply.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  migrations: { table: "cabinet_migrations" },
  strict: true,
});
