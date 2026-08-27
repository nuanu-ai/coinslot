/**
 * Starting the cabinet.
 *
 * It reads its configuration, puts the pages on a port and stops on a signal.
 * There is nothing to warm up and nothing to migrate: the cabinet holds no
 * state of its own, so a restart loses a merchant's session cookie and nothing
 * else (ADR-0005 §3).
 */

import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";

const config = loadConfig(process.env);
const server = buildApp(config).listen(config.port, () => {
  console.log(`[cabinet] listening on ${config.port}, reading ${config.gatewayUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
