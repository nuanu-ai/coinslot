/**
 * The Coinslot merchant SDK: what someone else's engineer installs so that
 * their catalog sells to agents.
 *
 * There are three things in here and they are all one process. `createClient`
 * builds a handle on the gateway from a key and an address. Through it a
 * merchant publishes cards, receives paid orders on an outgoing subscription
 * and answers questions about prices, and closes orders they took on earlier.
 * Beside it, `npx coinslot verify` checks a card before it is published.
 *
 * The runtime dependency tree is minimal and listed in full: our own
 * `@coinslot/contracts`, and zod underneath it, and nothing else. A merchant
 * installing the SDK into their production should know exactly what arrives
 * with it, rather than inherit a foreign package tree they would then be
 * maintaining themselves. Every new third-party package in this tree is a
 * recorded decision (ADR-0003 §8), and a test in this package holds the line.
 *
 * The types a merchant needs to write their own functions against — what a
 * card is, what an order carries, what a handler may answer — are re-exported
 * here from the contracts package, so that integration code has one import and
 * not two.
 */

export type {
  Acceptance,
  Card,
  Delivery,
  Fulfillment,
  HandlerAnswer,
  Money,
  Order,
  OrderCallError,
  OrderCallResponse,
  OrderCallResult,
  OrderEvent,
  OrderList,
  OrderStatus,
  OrderWithStatus,
  PublishError,
  PublishResult,
  QuotePurpose,
  QuoteRequest,
  QuoteResponse,
  Refusal,
  RefusalCode,
  SalePrice,
} from "@coinslot/contracts";
export { ORDER_EVENT_TYPES, RECOMMENDED_REFUSAL_CODES } from "@coinslot/contracts";
export type { CardCheck } from "./check-card.js";
export { checkCard } from "./check-card.js";
export type {
  CatalogNamespace,
  ClientOptions,
  CoinslotClient,
  OrdersNamespace,
  PricingNamespace,
  QuoteOptions,
  SubscribeOptions,
} from "./client.js";
export {
  ANSWER_NOT_UNDERSTOOD,
  CALL_DID_NOT_REACH_US,
  createClient,
  OUTCOME_UNKNOWN,
} from "./client.js";
export { contractVersion, speaksContract } from "./contract.js";
export type {
  Delivered,
  EventHandler,
  OrderHandler,
  ProblemReporter,
  QuoteHandler,
  Subscription,
  WorkerProblem,
  WorkerProblemKind,
} from "./worker.js";
export { WORKER_PROBLEM_KINDS } from "./worker.js";
