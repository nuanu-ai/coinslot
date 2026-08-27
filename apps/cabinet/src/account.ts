/**
 * The account command, wired to the database.
 *
 * This is the only way an account comes into being (ADR-0009). In the local
 * stack it is one line, run against the cabinet that is already up:
 *
 *   docker compose exec cabinet \
 *     pnpm --filter @coinslot/cabinet account add you@example.com
 *
 * Outside Docker it needs the same DATABASE_URL the cabinet itself is given and
 * nothing else — not the merchant key, because nothing here talks to the
 * gateway:
 *
 *   DATABASE_URL=postgres://coinslot:coinslot@localhost:5432/coinslot \
 *     pnpm --filter @coinslot/cabinet account list
 *
 * What the file itself does is only the wiring. The commands are in
 * `account-command.ts`, where they are tested without a database.
 */

import { runAccount } from "./account-command.js";
import { connect, postgresAccounts } from "./accounts-postgres.js";

/** Postgres's own answer for "there is no table by that name". */
const NO_SUCH_TABLE = "42P01";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error(
    "DATABASE_URL is not set, so there is no database to keep an account in." +
      " It is the same address the cabinet is given.",
  );
  process.exit(1);
}

const accounts = postgresAccounts(connect(databaseUrl));
let code = 1;
try {
  code = await runAccount(process.argv.slice(2), accounts, (line) => {
    console.log(line);
  });
} catch (thrown) {
  // The tables are not there. Said as its own thing, because the database's own
  // sentence names a table nobody has heard of and does not say what to run.
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    String((thrown as { code: unknown }).code) === NO_SUCH_TABLE
  ) {
    console.error(
      "The cabinet's tables are not in this database yet." +
        " Run: pnpm --filter @coinslot/cabinet db:migrate",
    );
  } else {
    console.error(thrown);
  }
} finally {
  await accounts.close();
}

process.exit(code);
