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
 *
 * It is run through a loader that compiles TypeScript on the way in rather than
 * from compiled output, and that is a step not taken rather than a preference.
 * The workspace packages this depends on publish their TypeScript sources, so
 * compiling this one alone produces imports of files that are not there;
 * building it properly means building those too, which is a change to how they
 * are published and belongs with the deployment step rather than here.
 */

import { HTTPFacilitatorClient } from "@x402/core/server";
import { ScriptedFacilitator } from "./adapters/memory/facilitator.js";
import { queueOn } from "./adapters/pgboss/queue.js";
import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { X402Facilitator } from "./adapters/x402/facilitator.js";
import { Gateway } from "./app/gateway.js";
import { seedSandboxKey } from "./app/merchants.js";
import type { Runtime } from "./app/runtime.js";
import { isSandboxFacilitator, loadConfig } from "./config.js";
import { buildApp } from "./http/server.js";
import { PaymentEdge } from "./http/x402.js";
import { randomIds, systemClock } from "./ports/clock.js";
import type { Facilitator } from "./ports/facilitator.js";

const config = loadConfig(process.env);
const { db, pool } = connect(config.databaseUrl);

const edge = new PaymentEdge(config.payment, config.publicBaseUrl, config.payment.timeoutSeconds);

/**
 * How long a poll leans on the queue's own polling before coming back empty on
 * this turn. Work published by this process wakes a parked poll with no lag at
 * all, so this only carries work published by another one.
 */
const QUEUE_POLL_INTERVAL_MS = 250;

const queue = queueOn(config.databaseUrl, {
  pollIntervalMs: QUEUE_POLL_INTERVAL_MS,
  reminders: {
    attempts: config.reminderAttempts,
    retryDelayMs: config.reminderRetryDelayMs,
  },
});

/**
 * The payment layer, real or none at all (ADR-0008).
 *
 * The sandbox is a value of the facilitator's address rather than a flag beside
 * it, so this is a fork between two addresses and not between two modes. A
 * gateway told to talk to a facilitator talks to it; a gateway told
 * `sandbox:scripted` verifies and settles against nothing, and says so at the
 * top of its log rather than leaving it to be inferred from a quiet purchase
 * that worked with no wallet.
 */
function paymentLayer(): Facilitator {
  if (isSandboxFacilitator(config.payment.facilitatorUrl)) {
    console.warn(
      "[gateway] SANDBOX: no chain behind this process — every payment it accepts is pretend, " +
        "nothing arrives at the address in a challenge, and no receipt it writes points at a transfer",
    );
    return new ScriptedFacilitator();
  }

  return new X402Facilitator(
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
  );
}

const runtime: Runtime = {
  config,
  // The store is given the queue's way of writing an envelope inside its own
  // transaction: an envelope that must not be lost is written where the order
  // is, so a process that dies mid-flight either did both or did neither
  // (ADR-0013). Both live in the same Postgres, which is what makes it possible.
  store: new PostgresStore(db, randomIds, queue.envelopes()),
  queue,
  facilitator: paymentLayer(),
  clock: systemClock,
  ids: randomIds,
};

const gateway = new Gateway(runtime);

/**
 * The sandbox's one key, put in the database if it is not there already.
 *
 * It is what makes `docker compose up` sell with no manual step: the same
 * string is given to the cabinet and to the merchant process in that file, and
 * without a row to match it the door would turn both of them away. Writing it
 * is idempotent — the key is looked up by its digest first — so a restart and a
 * second replica both write nothing.
 *
 * It is a seed and not a door. Nothing compares a request against this value;
 * once the row is there the key is read like every other key, and disabling it
 * at a terminal keeps it disabled through a restart, which is the point of
 * saying so out loud rather than quietly re-issuing it.
 *
 * This runs before the migrations in any deployment that has them, in the sense
 * that matters: the migration is a separate step that has already finished, and
 * it is what wrote the merchant row and gave every existing card, order and
 * receipt an owner. All this does is hang a key on it.
 *
 * Every way this can go says which one it was, including the two that write
 * nothing. `compose.yaml` tells an operator to close the sandbox by handing the
 * process the name with nothing after it, and promises the log will say which
 * of the two it did — so silence is the one answer that cannot be given: it
 * reads the same whether the key was taken and honoured, was already there, or
 * was never configured at all.
 */
async function seedTheSandbox(secret: string | null): Promise<void> {
  if (secret === null) {
    console.log(
      "[gateway] SANDBOX_MERCHANT_KEY is not set — a name with nothing after it reads the same as no " +
        "name at all — so no key was seeded, and every key that opens a merchant here is one somebody issued",
    );
    return;
  }

  const seeded = await seedSandboxKey(runtime.store, runtime.ids, secret, runtime.clock());
  if (seeded.kind === "issued") {
    console.warn(
      `[gateway] SANDBOX: the key in SANDBOX_MERCHANT_KEY now opens ${seeded.merchantId} — ` +
        "a key from an environment cannot be revoked without a deployment, so no deployment should set it",
    );
    return;
  }
  if (seeded.kind === "already_there") {
    console.warn(
      "[gateway] SANDBOX: the key in SANDBOX_MERCHANT_KEY was already in the database and still opens " +
        "the sandbox merchant; this start wrote nothing",
    );
    return;
  }
  if (seeded.kind === "disabled") {
    console.warn(
      "[gateway] the key in SANDBOX_MERCHANT_KEY exists and somebody disabled it; it is left disabled, " +
        "and nothing presenting it will get in",
    );
  }
}

try {
  await gateway.start();
  await seedTheSandbox(config.sandboxMerchantKey);
} catch (thrown) {
  // The first thing an engineer bringing this up sees. A stack trace out of the
  // queue's own internals says "something about Postgres" and makes them go
  // looking; this says which database was not there.
  console.error(
    `[gateway] cannot start: the queue and the store both live in ${config.databaseUrl.replace(/:[^:@/]*@/, ":***@")}, and it did not answer`,
  );
  console.error(thrown);
  process.exit(1);
}

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
