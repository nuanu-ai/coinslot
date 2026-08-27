/**
 * The Coinslot merchant cabinet: the cards with their pause, the orders and
 * the receipts, rendered on the server.
 *
 * It is its own process rather than a part of the gateway, and it reaches the
 * gateway through the same public API a merchant's own tooling uses, holding no
 * database connection (ADR-0005 §2 and §3). Pages for people change for reasons
 * that have nothing to do with money, and the deal is that the money path never
 * pays for that churn — while the cabinet, by being an ordinary consumer of the
 * API, cannot draw a screen the merchant could not have built themselves.
 */

export { type CabinetConfig, loadConfig } from "./config.js";
export { type Answer, type GatewayClient, gatewayFor } from "./gateway.js";
export { cardsScreen, ordersScreen, receiptsScreen } from "./screens.js";
export { buildApp } from "./server.js";
export {
  FULFILLMENT_WORDS,
  moment,
  money,
  NEEDS_ATTENTION,
  needsAttention,
  ORDER_WORDS,
  SELLING_WORDS,
  type Tone,
  type Word,
} from "./words.js";
