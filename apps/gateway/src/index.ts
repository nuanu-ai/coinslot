/**
 * The Coinslot gateway: the 402 edge, the order queue and the receipts. There
 * is no HTTP here yet — contracts and the state machine come first, the edge
 * arrives after them (`docs/research/21-pilot-plan.md`, stage 1).
 *
 * The domain logic lives in `@coinslot/core` and knows nothing about the
 * framework, so the edge is replaceable without rewriting the product
 * (ADR-0003 §7).
 */

export { type GatewayConfig, loadConfig } from "./config.js";
