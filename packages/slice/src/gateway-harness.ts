/**
 * A whole gateway, in this process, on a real port.
 *
 * Nothing about the gateway is stubbed here: the configuration is read and
 * refused by the real `loadConfig`, the surface is mounted by the real
 * `buildApp` from the contract's own route table, and every request the buyer
 * and the merchant make crosses real HTTP. What is swapped is only what would
 * otherwise need a database, a queue server or a payment network — the store
 * and the queue are the gateway's own in-memory adapters, and the facilitator
 * is whatever the caller hands in. The end-to-end test hands in the scripted
 * one, so `pnpm test` stays free, offline and the same every time; the smoke
 * hands in the real one against the testnet.
 *
 * The clock is the real one. Everything the flows do in memory resolves on
 * microtasks and the deadlines the happy paths care about sit far in the
 * future, so no test here waits on wall time to reach its assertion.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Environment, keyPrefixFor } from "@coinslot/core";
import {
  buildApp,
  type Facilitator,
  Gateway,
  type GatewayConfig,
  loadConfig,
  MemoryQueue,
  MemoryStore,
  type Runtime,
  randomIds,
  SEEDED_MERCHANT,
  seedSandboxKey,
  setPayoutWallet,
  systemClock,
} from "@coinslot/gateway";

/**
 * The key the merchant in this harness opens the door with, for the site the
 * chain it was given makes it.
 *
 * It is seeded into the store as a row, the way the sandbox's key is seeded
 * from `compose.yaml` (ADR-0010) and through the same function — so what this
 * gate exercises is the door a deployment actually has, a digest looked up in a
 * table, and not a comparison written for tests.
 *
 * The prefix is part of that door, and it is derived rather than written down
 * because this harness is also how `pnpm smoke` boots a gateway, and the smoke
 * takes the chain from `SMOKE_NETWORK`. A constant carrying one site's prefix
 * would be a key the harness's own gateway refuses the moment somebody points
 * it at the other site — the smoke failing wholesale at its first merchant
 * call, for a reason that says nothing about what the smoke checks.
 *
 * Nothing outside reads this. What a caller wants is the key a particular boot
 * seeded, which is {@link Booted.merchantKey}.
 */
const sliceMerchantKeyFor = (environment: Environment): string =>
  `${keyPrefixFor(environment)}slice-merchant-key-please`;

/**
 * The address the merchant in this harness is paid at. On the scripted
 * facilitator no money moves, so this only has to be an address the challenge
 * can name; the smoke overrides it with a real testnet merchant address, and
 * there the sale really does land at it.
 */
export const SLICE_PAY_TO = "0x1111111111111111111111111111111111111111";

export interface Booted {
  /** Where the gateway answers, for the buyer and the merchant to point at. */
  readonly baseUrl: string;
  readonly gateway: Gateway;
  readonly config: GatewayConfig;
  /**
   * The key this boot seeded, which is the one its own door accepts.
   *
   * Carried out rather than left to be named by whoever needs it: the prefix
   * follows the chain this boot was given, so a caller that wrote the string
   * itself would be right on one site and turned away on the other.
   */
  readonly merchantKey: string;
  /** Lets go of the server and everything the gateway is holding open. */
  stop(): Promise<void>;
}

/**
 * The environment the gateway is booted with. The two the harness always sets
 * are the database URL (never connected to — the store is in memory) and the
 * key to seed the merchant with; a caller adds the payment settings the smoke
 * needs.
 */
export function sliceEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const settings = {
    DATABASE_URL: "postgres://coinslot@localhost:5432/coinslot",
    PAY_TO_ADDRESS: SLICE_PAY_TO,
    // Short enough that an idle poll parks briefly rather than for the
    // production window, so the merchant's loop picks up work promptly and the
    // process is not held by a long server-side timer between tests. There is a
    // coupling worth naming here: the synchronous test needs the merchant's
    // quote answer inside the gateway's QUOTE_RESPONSE_MS (5s by default), while
    // the SDK worker can be blind for up to its QUIET_POLL_FLOOR_MS (1s) between
    // empty polls. The default 5:1 margin holds comfortably; cutting
    // QUOTE_RESPONSE_MS close to a second would make that test price from the
    // snapshot intermittently and fail.
    WORKER_POLL_WAIT_MS: "500",
    ...overrides,
  };

  // The key is written last, out of what these settings actually derive. The
  // chain may have arrived in the overrides or been left to the gateway's own
  // default, and only the gateway's schema knows which — so it is asked, rather
  // than the default being copied here where the two could drift.
  return {
    ...settings,
    SANDBOX_MERCHANT_KEY: sliceMerchantKeyFor(loadConfig(settings).environment),
  };
}

/**
 * Boots the gateway with the in-memory store and queue and the facilitator the
 * factory builds, and starts it listening on an ephemeral port.
 *
 * The facilitator is built from the loaded configuration rather than handed in
 * ready-made, because the real one needs the payment settings the config
 * carries — the network it charges on, the address the money goes to — while
 * the scripted one ignores them. The end-to-end test passes a factory that
 * returns its scripted facilitator; the smoke passes one that builds the real
 * x402 client around the same config.
 */
export async function bootGateway(
  makeFacilitator: (config: GatewayConfig) => Facilitator,
  env: Record<string, string> = sliceEnv(),
): Promise<Booted> {
  const config = loadConfig(env);
  const queue = new MemoryQueue({
    attempts: config.reminderAttempts,
    retryDelayMs: config.reminderRetryDelayMs,
  });
  // The queue is made first because the store writes through it: an envelope
  // that must not be lost is written where the order is (ADR-0013). It is
  // `stage` rather than `publish` because the store needs the two halves apart
  // — take it before the order is written, make it visible after.
  const store = new MemoryStore(randomIds, systemClock, (merchantId, envelope, afterMs) =>
    queue.stage(merchantId, envelope, afterMs),
  );

  const runtime: Runtime = {
    config,
    store,
    queue,
    facilitator: makeFacilitator(config),
    clock: systemClock,
    ids: randomIds,
  };

  const gateway = new Gateway(runtime);
  await gateway.start();

  // The merchant and its key, seeded exactly as `main.ts` seeds the sandbox's:
  // one function, so a key that works here is a key that works there.
  //
  // A boot with nothing to seed is refused rather than allowed to come up
  // quiet. Everything this harness exists for — the end-to-end gate, the smoke
  // — needs a merchant to sell as, and a gateway with no key at all would fail
  // later, at the first merchant call, as a 401 that looks like a wrong key.
  const merchantKey = config.sandboxMerchantKey;
  if (merchantKey === null) {
    throw new Error(
      "this harness boots a gateway with a merchant to sell as, and the environment it was " +
        "given seeds no key: SANDBOX_MERCHANT_KEY is empty, so there would be nothing to call as",
    );
  }
  await seedSandboxKey(store, randomIds, merchantKey, systemClock(), config.surfaceMode);

  // And where that merchant is paid, which is the address this slice was
  // configured with. The two are one thing here and only here: this harness
  // runs one merchant and the operator is that merchant, so the address in the
  // environment is theirs — under the scripted facilitator a placeholder no
  // money moves to, and under the smoke's real one the testnet address the sale
  // actually lands at.
  //
  // The seed above deliberately does not do this. It is what a deployment runs,
  // and a deployment's configured address belongs to whoever runs the gateway
  // rather than to the merchants selling on it; writing it onto a merchant
  // there would pay their sales to the operator (ADR-0019).
  if (config.payment.payTo !== null) {
    await setPayoutWallet(store, SEEDED_MERCHANT.id, config.payment.payTo, systemClock());
  }

  // On the address `baseUrl` below names, not on the wildcard: `serve` in the
  // gateway's own harness says what the difference costs.
  const server: Server = buildApp(gateway).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    gateway,
    config,
    merchantKey,
    stop: async () => {
      await gateway.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
