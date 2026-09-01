/**
 * The Coinslot domain core: orders, receipts, idempotency, the state machine.
 * Here lives what actually is the product, so the package knows nothing about
 * HTTP, nothing about the database and nothing about the queue — zero IO and
 * zero runtime dependencies (ADR-0003 §2 and §9). Everything external the core
 * receives as parameters and returns as values.
 */

/**
 * The exhaustiveness guard. It goes into the default branch of a `switch` over
 * the order state: while every state is handled, TypeScript sees `never` here
 * and stays silent, and the moment a new state appears the build breaks on
 * this line instead of breaking in production on an order nobody handled.
 *
 * If the types have been fooled after all — the value came from the database
 * or over the network — the work stops with an exception that names the
 * variant itself. A silent "nothing happened" next to someone else's money is
 * inadmissible.
 */
export function assertNever(value: never, context?: string): never {
  const where = context === undefined ? "" : ` (${context})`;
  throw new Error(`Unhandled variant${where}: ${JSON.stringify(value)}`);
}

export type { Environment, SurfaceMode } from "./deployment/environment.js";
export {
  CDP_FACILITATOR_URL,
  environmentOf,
  environmentOfKeyPrefix,
  isSandboxFacilitator,
  isTestnetChain,
  keyPrefixFor,
  LIVE_CHAINS,
  PUBLIC_X402_FACILITATOR_URL,
  SANDBOX_FACILITATOR,
  SITES,
  SURFACE_MARKER_ATTRIBUTE,
  SURFACE_WORDS,
  surfaceModeOf,
  TESTNET_CHAINS,
} from "./deployment/environment.js";
/**
 * The order state machine. The design it implements is
 * `docs/research/16-order-state-machine.md` with all three of its addition
 * sections, and the merchant-facing half of the same model is
 * `portal/orders.md` and `portal/failures.md`.
 *
 * The gateway is expected to use it like this: build an order with
 * `createOrder`, feed it events with `transition`, run the effects that come
 * back, schedule timers off `deadlines`, answer the agent with `outcomeFor`,
 * and — where it matters enough to be worth the cycles — check the order it is
 * about to write down with `moneyInvariantViolations`.
 *
 * The order fixtures used by this package's own tests are deliberately not
 * exported: an order is built out of a real purchase, and a builder that
 * quietly guesses its defaults has no business standing next to someone else's
 * money.
 */
export type {
  CreateOrderInput,
  CreateOrderResult,
  CreateRejection,
  MerchantSelling,
  PriceCheck,
} from "./orders/create.js";
export { CREATE_REJECTIONS, createOrder, MERCHANT_SELLING, PRICE_CHECKS } from "./orders/create.js";
export { deadlines, fulfillmentDeadline } from "./orders/deadlines.js";
export { transition } from "./orders/machine.js";
export type {
  Closure,
  Deadline,
  DeadlineKind,
  DeadlinePolicy,
  Effect,
  FulfillmentMode,
  MerchantAnswer,
  MerchantAnswerError,
  MerchantAnswerResult,
  MerchantEvent,
  Order,
  OrderEvent,
  OrderEventKind,
  OrderMode,
  OrderPolicy,
  OrderState,
  OrderTimestamps,
  PaymentStage,
  PaymentVerificationFailure,
  Price,
  QuoteSource,
  RedeliveryPolicy,
  SettleTiming,
  StateEvent,
  TransitionRejection,
  TransitionRejectionCode,
  TransitionResult,
} from "./orders/model.js";
export {
  CLOSED_ORDER_STATES,
  DEADLINE_KINDS,
  FULFILLMENT_MODES,
  isOpen,
  MERCHANT_ANSWER_ERRORS,
  MERCHANT_ANSWER_RESULTS,
  MERCHANT_EVENTS,
  modeOf,
  OPEN_ORDER_STATES,
  ORDER_EVENT_KINDS,
  ORDER_STATES,
  PAYMENT_STAGES,
  PAYMENT_VERIFICATION_FAILURES,
  QUOTE_SOURCES,
  RECOMMENDED_REFUSAL_CODES,
  SETTLE_TIMINGS,
  TRANSITION_REJECTION_CODES,
} from "./orders/model.js";
export { moneyInvariantViolations } from "./orders/money.js";
export type { OrderOutcome } from "./orders/outcome.js";
export { ORDER_OUTCOMES, outcomeFor } from "./orders/outcome.js";
export type { RedeliveryDecision, RedeliveryQuestion } from "./orders/redelivery.js";
export { nextRedelivery } from "./orders/redelivery.js";
