/**
 * The Coinslot merchant cabinet: the cards with their pause, the orders, the
 * receipts and the keys, rendered on the server, behind a sign-in that knows
 * who a person is — and a registration that makes the merchant behind it.
 *
 * It is its own process rather than a part of the gateway, and it reaches the
 * gateway through the same public API a merchant's own tooling uses (ADR-0005
 * §2). Pages for people change for reasons that have nothing to do with money,
 * and the deal is that the money path never pays for that churn — while the
 * cabinet, by being an ordinary consumer of the API, cannot draw a screen the
 * merchant could not have built themselves.
 *
 * The two tables it does hold are its own: the people who sign in and their
 * sessions (ADR-0009). Neither is a merchant's data and no API carries either.
 * One column on the first of them is the key that account reaches the gateway
 * with (ADR-0014 §2), which is what makes two accounts here two merchants
 * rather than two people looking at one.
 */

export { runAccount, type Terminal } from "./account-command.js";
export {
  type Account,
  type AccountMerchant,
  type AccountSummary,
  type Accounts,
  emailAs,
  memoryAccounts,
} from "./accounts.js";
export { connect, migrateAccounts, postgresAccounts } from "./accounts-postgres.js";
export { type CabinetConfig, loadConfig } from "./config.js";
export {
  fingerprintOf,
  hashPassword,
  MINIMUM_PASSWORD_LENGTH,
  newPassword,
  newSessionToken,
  passwordMatches,
} from "./credentials.js";
export {
  type Answer,
  type GatewayClient,
  gatewayFor,
  type IssuedKey,
  type KeyList,
  type MerchantKey,
  type NewMerchant,
  type Registrar,
  registrarFor,
} from "./gateway.js";
export { keysScreen, newKeyScreen } from "./keys.js";
export { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
export { buildApp, type CabinetParts } from "./server.js";
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
