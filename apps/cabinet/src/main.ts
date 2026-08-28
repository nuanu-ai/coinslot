/**
 * Starting the cabinet.
 *
 * It reads its configuration, opens a connection to its own four tables, puts
 * the pages on a port and stops on a signal. The tables are the people who sign
 * in, their sessions, their passwords and the one-time links they are sent, and
 * nothing else (ADR-0009 §8):
 * every card, order and receipt on every screen still comes from the gateway's
 * public API, which is the promise ADR-0005 §3 is actually about.
 *
 * There is nothing to migrate here. `pnpm --filter @coinslot/cabinet db:migrate`
 * is a step somebody takes before this starts, because a process that migrates
 * on boot migrates once per replica and races itself.
 */

import { loadConfig } from "./config.js";
import { connect } from "./database.js";
import { identityFor } from "./identity.js";
import { isSandboxMail } from "./mail.js";
import { buildApp } from "./server.js";

const config = loadConfig(process.env);
const identity = identityFor(config, { pool: connect(config.databaseUrl) });
const server = buildApp(config, { identity }).listen(config.port, () => {
  console.log(`[cabinet] listening on ${config.port}, reading ${config.gatewayUrl}`);
  // Said at start-up rather than discovered on the day somebody loses a
  // password. A cabinet that writes its messages to the log is a working
  // cabinet and not a broken one, and the difference is worth one line.
  console.log(
    isSandboxMail(config.mailUrl)
      ? "[cabinet] no mail provider is configured: every message is written to this log instead"
      : `[cabinet] messages are sent through ${config.mailUrl}, from ${config.mailFrom}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void identity.close().finally(() => process.exit(0));
    });
  });
}
