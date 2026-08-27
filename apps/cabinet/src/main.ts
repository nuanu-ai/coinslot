/**
 * Starting the cabinet.
 *
 * It reads its configuration, opens a connection to its own two tables, puts
 * the pages on a port and stops on a signal. The tables are the people who sign
 * in and the sessions they are signed in with, and nothing else (ADR-0009 §8):
 * every card, order and receipt on every screen still comes from the gateway's
 * public API, which is the promise ADR-0005 §3 is actually about.
 *
 * There is nothing to migrate here. `pnpm --filter @coinslot/cabinet db:migrate`
 * is a step somebody takes before this starts, because a process that migrates
 * on boot migrates once per replica and races itself.
 */

import { connect, postgresAccounts } from "./accounts-postgres.js";
import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";

const config = loadConfig(process.env);
const accounts = postgresAccounts(connect(config.databaseUrl));
const server = buildApp(config, { accounts }).listen(config.port, () => {
  console.log(`[cabinet] listening on ${config.port}, reading ${config.gatewayUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void accounts.close().finally(() => process.exit(0));
    });
  });
}
