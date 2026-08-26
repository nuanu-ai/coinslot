/**
 * The resident process.
 *
 * It is resident rather than serverless because of what it holds open: workers
 * parked on a poll, an agent parked on a synchronous purchase, a consumer of
 * the queue, and a sequence around a payment that has to survive between two
 * HTTP calls (`docs/research/21-pilot-plan.md`, hosting). A function that runs
 * and exits could hold none of them.
 *
 * Everything below is wiring. The configuration is read once and refused whole,
 * the three ports are given their real implementations, and the surface is
 * mounted from the contract's own table. There is no logic here to test,
 * because everything that could be got wrong lives behind one of those three
 * ports and is tested against the in-memory ones.
 */

import { HTTPFacilitatorClient } from "@x402/core/server";
import { PgBoss } from "pg-boss";
import { PgBossQueue } from "./adapters/pgboss/queue.js";
import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { X402Facilitator } from "./adapters/x402/facilitator.js";
import { Gateway } from "./app/gateway.js";
import type { Runtime } from "./app/runtime.js";
import { loadConfig } from "./config.js";
import { buildApp } from "./http/server.js";
import { PaymentEdge } from "./http/x402.js";
import { randomIds, systemClock } from "./ports/clock.js";

const config = loadConfig(process.env);
const { db, pool } = connect(config.databaseUrl);

const edge = new PaymentEdge(config.payment, config.publicBaseUrl, config.payment.timeoutSeconds);

/**
 * How long a poll leans on the queue's own polling before coming back empty on
 * this turn. Work published by this process wakes a parked poll with no lag at
 * all, so this only carries work published by another one.
 */
const QUEUE_POLL_INTERVAL_MS = 250;

const queue = new PgBossQueue(new PgBoss(config.databaseUrl), {
  pollIntervalMs: QUEUE_POLL_INTERVAL_MS,
});

const runtime: Runtime = {
  config,
  store: new PostgresStore(db, randomIds),
  queue,
  facilitator: new X402Facilitator(
    new HTTPFacilitatorClient({
      url: config.payment.facilitatorUrl,
      ...(config.payment.cdpApiKeyId === null || config.payment.cdpApiKeySecret === null
        ? {}
        : {
            createAuthHeaders: async () => {
              // The facilitator's own credentials, sent per path the way its
              // client asks for them. A flat headers object is refused by the
              // client rather than silently dropping auth on every request.
              const headers = {
                "CDP-Api-Key-Id": config.payment.cdpApiKeyId ?? "",
                "CDP-Api-Key-Secret": config.payment.cdpApiKeySecret ?? "",
              };
              return { verify: headers, settle: headers, supported: headers };
            },
          }),
    }),
    edge,
  ),
  clock: systemClock,
  ids: randomIds,
};

const gateway = new Gateway(runtime);
await gateway.start();

const server = buildApp(gateway).listen(config.port, () => {
  console.log(`[gateway] listening on ${config.port}, answering as ${config.publicBaseUrl}`);
});

/**
 * A shutdown that lets go of what it is holding. Parked workers and parked
 * purchases are woken with nothing rather than left waiting on a process that
 * is going away, which is the difference between a restart an agent retries and
 * one it times out on.
 */
const shutDown = async (signal: string): Promise<void> => {
  console.log(`[gateway] ${signal}: stopping`);
  server.close();
  await gateway.stop();
  await pool.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutDown("SIGINT"));
process.on("SIGTERM", () => void shutDown("SIGTERM"));
