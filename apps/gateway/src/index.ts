/**
 * The Coinslot gateway: the 402 edge, the order queue and the receipts.
 *
 * It is an interpreter and not a second brain. The order machine in
 * `@coinslot/core` decides everything about an order — whether a silence sells,
 * whether the money moves, whether there is another delivery — and everything
 * here loads an order, hands it one event, writes down what comes back and
 * carries out the effects. The HTTP surface is mounted from the table in
 * `@coinslot/contracts` rather than transcribed, so the addresses both sides use
 * cannot come apart (ADR-0003 §7).
 *
 * Three ports hold all the IO. Behind them in a deployment sit one Postgres,
 * pg-boss and the official x402 facilitator client (ADR-0003 §6 and §9);
 * behind them in a test sit three implementations in memory, which is what
 * lets the whole of the application logic be tested for free, offline and the
 * same way every time.
 */

export { ScriptedFacilitator } from "./adapters/memory/facilitator.js";
export { MemoryQueue } from "./adapters/memory/queue.js";
export { MemoryStore } from "./adapters/memory/store.js";
export { PgBossQueue, queueOn } from "./adapters/pgboss/queue.js";
export { connect, PostgresStore } from "./adapters/postgres/store.js";
export { X402Facilitator } from "./adapters/x402/facilitator.js";
export { Gateway, type PurchaseAttempt } from "./app/gateway.js";
export {
  type IssuedKey,
  issueKey,
  KEY_PREFIX,
  keyDigest,
  makeMerchant,
  newKeySecret,
  SEEDED_MERCHANT,
  type SeedOutcome,
  seedSandboxKey,
} from "./app/merchants.js";
export { type Applied, OrderRunner, orderDocumentOf, type PresentResult } from "./app/runner.js";
export {
  modeForCard,
  policyFor,
  priceCheckOf,
  quoteReachesTheMerchant,
  type Runtime,
} from "./app/runtime.js";
export { Waiting } from "./app/waiting.js";
export {
  type DeadlineConfig,
  type GatewayConfig,
  loadConfig,
  type PaymentConfig,
  type RedeliveryConfig,
  type WorkerConfig,
} from "./config.js";
export { buildApp, type MountedRoute, type RouteAnswer, type RouteHandler } from "./http/server.js";
export { PaymentEdge, paymentFingerprint, presentedPayment } from "./http/x402.js";
export { asTimestamp, type Clock, type Ids, randomIds, systemClock } from "./ports/clock.js";
export type { Charge, Facilitator, SettleOutcome, VerifyOutcome } from "./ports/facilitator.js";
export type { DrawnEnvelope, Queue, Reminder } from "./ports/queue.js";
export type {
  CatalogEntry,
  MerchantScope,
  OrderChange,
  OrderLookup,
  PaymentClaim,
  PaymentWord,
  Store,
  StoredCard,
  StoredKey,
  StoredMerchant,
  StoredOrder,
} from "./ports/store.js";
