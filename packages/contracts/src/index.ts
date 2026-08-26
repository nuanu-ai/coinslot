/**
 * Coinslot contracts — the single source of truth for the card, the order, the
 * price check, the receipt and everything else that crosses the boundary
 * between us, a merchant and an agent. Everything that goes outside or arrives
 * from outside is described here by a zod schema; consumers get their types by
 * inference from the schema instead of writing them by hand (ADR-0003 §5).
 *
 * This package owns the wire vocabulary: the field names, the values an agent
 * or a merchant can see, the refusal codes, the event names. What the gateway
 * calls things inside itself is its own business, and the two are tied
 * together where they meet rather than by one importing the other.
 *
 * One shape a reader might expect here is deliberately absent. The worker
 * channel carries orders, price questions and events on one stream, each in an
 * envelope with a marker saying which it is (ADR-0004 §2). The envelope is not
 * described here because the merchant never sees it: the same decision has the
 * SDK hide the transport entirely, handing a handler an order rather than
 * anything it is wrapped in. Where the envelope should be described — here,
 * because it is still a format between two of our own parts, or alongside the
 * transport that invented it — is a question nobody has answered, and it is
 * better asked than quietly settled by whichever side writes it first.
 */

import type { ZodType } from "zod";
import { z } from "zod";
import { CardSchema, FulfillmentSchema, PriceCheckSchema } from "./card.js";
import { OrderEventSchema, RefundDueReasonSchema } from "./events.js";
import { HandlerAnswerSchema, RefusalCodeSchema, RefusalSchema } from "./handler.js";
import { OrderSchema } from "./order.js";
import {
  FieldSpecSchema,
  ParamNameSchema,
  ParamSpecSchema,
  ParamTypeSchema,
} from "./param-spec.js";
import {
  AmountSchema,
  CurrencyCodeSchema,
  IdentifierSchema,
  MoneySchema,
  SalePriceSchema,
  TimestampSchema,
} from "./primitives.js";
import { QuotePurposeSchema, QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";
import { ReceiptOutcomeSchema, ReceiptSchema } from "./receipt.js";
import { OrderCallErrorSchema, PublishErrorSchema, PublishResultSchema } from "./results.js";

export type { Card, Fulfillment, PriceCheck } from "./card.js";
export { CardSchema, FulfillmentSchema, PriceCheckSchema } from "./card.js";
export type { OrderEvent, RefundDueReason } from "./events.js";
export { ORDER_EVENT_TYPES, OrderEventSchema, RefundDueReasonSchema } from "./events.js";
export type { HandlerAnswer, Refusal, RefusalCode } from "./handler.js";
export {
  HandlerAnswerSchema,
  RECOMMENDED_REFUSAL_CODES,
  RefusalCodeSchema,
  RefusalSchema,
} from "./handler.js";
export type { Order } from "./order.js";
export { OrderSchema } from "./order.js";
export type { FieldSpec, ParamSpec, ParamType } from "./param-spec.js";
export {
  FieldSpecSchema,
  ParamNameSchema,
  ParamSpecSchema,
  ParamTypeSchema,
  paramSpecToValidator,
} from "./param-spec.js";
export type {
  Amount,
  CurrencyCode,
  Identifier,
  Money,
  SalePrice,
  Timestamp,
} from "./primitives.js";
export {
  AmountSchema,
  CurrencyCodeSchema,
  IdentifierSchema,
  MoneySchema,
  SalePriceSchema,
  TimestampSchema,
} from "./primitives.js";
export type { QuotePurpose, QuoteRequest, QuoteResponse } from "./quote.js";
export { QuotePurposeSchema, QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";
export type { Receipt, ReceiptOutcome } from "./receipt.js";
export { ReceiptOutcomeSchema, ReceiptSchema } from "./receipt.js";
export type { OrderCallError, PublishError, PublishResult } from "./results.js";
export { OrderCallErrorSchema, PublishErrorSchema, PublishResultSchema } from "./results.js";

/**
 * The version of the public contract. It grows when the meaning of the fields
 * changes, not when a schema is added: a consumer uses it to decide whether it
 * understands the other side.
 */
export const CONTRACT_VERSION = "0";

/**
 * Every schema of the public contract, under the name it is known by outside
 * TypeScript.
 *
 * The registry is what makes the contract readable by something that is not
 * this package: the JSON Schema export below walks it, and a merchant's
 * engineer working in another language reads that. It carries the building
 * blocks as well as the whole documents, because a merchant validating one
 * amount should not have to lift it out of a card.
 *
 * A schema that exists and is not here is a schema nobody outside TypeScript
 * can see, so a test holds the two in step.
 */
export const schemas = Object.freeze({
  amount: AmountSchema,
  card: CardSchema,
  currency_code: CurrencyCodeSchema,
  field_spec: FieldSpecSchema,
  fulfillment: FulfillmentSchema,
  handler_answer: HandlerAnswerSchema,
  identifier: IdentifierSchema,
  money: MoneySchema,
  order: OrderSchema,
  order_call_error: OrderCallErrorSchema,
  order_event: OrderEventSchema,
  param_name: ParamNameSchema,
  param_spec: ParamSpecSchema,
  param_type: ParamTypeSchema,
  price_check: PriceCheckSchema,
  publish_error: PublishErrorSchema,
  publish_result: PublishResultSchema,
  quote_purpose: QuotePurposeSchema,
  quote_request: QuoteRequestSchema,
  quote_response: QuoteResponseSchema,
  receipt: ReceiptSchema,
  receipt_outcome: ReceiptOutcomeSchema,
  refund_due_reason: RefundDueReasonSchema,
  refusal: RefusalSchema,
  refusal_code: RefusalCodeSchema,
  sale_price: SalePriceSchema,
  timestamp: TimestampSchema,
}) satisfies Readonly<Record<string, ZodType>>;

/** The name of one schema in the registry. */
export type SchemaName = keyof typeof schemas;

/** One JSON Schema document, as zod renders it. */
export type JsonSchemaDocument = z.core.JSONSchema.BaseSchema;

/** The identifier a rendered document carries, so a reader knows what it holds. */
export const jsonSchemaIdOf = (name: SchemaName): string =>
  `urn:coinslot:contract:${CONTRACT_VERSION}:${name}`;

/**
 * The whole contract as JSON Schema, one document per registry entry.
 *
 * A function rather than a constant: the conversion costs something, and a
 * consumer who only needs to validate a card in TypeScript should not pay for
 * a description of everything else at import time.
 *
 * What the documents carry and what they do not is worth saying plainly,
 * because the difference is invisible from the outside. Structure crosses
 * intact — fields, types, which are required, whether unknown keys are
 * allowed, enumerations, patterns, the branches of a union. Rules that look at
 * more than one field at a time do not: JSON Schema cannot say "this field
 * only when that one has this value", and zod drops such a rule without a
 * word. Every schema that has one says so in its own `description`, which does
 * cross, so a reader of the document is told what it is not checking rather
 * than left to assume it checks everything.
 *
 * Each document is stamped with the contract version it came from.
 */
export const toJsonSchemas = (): Record<SchemaName, JsonSchemaDocument> => {
  const documents = {} as Record<SchemaName, JsonSchemaDocument>;

  for (const [name, schema] of Object.entries(schemas) as [SchemaName, ZodType][]) {
    documents[name] = { $id: jsonSchemaIdOf(name), ...z.toJSONSchema(schema) };
  }

  return documents;
};
