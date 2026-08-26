/**
 * Coinslot contracts — the single source of truth for the product card, the
 * order, the price hook and the receipt. Everything that goes outside or
 * arrives from outside is described here by a zod schema; consumers get their
 * types by inference from the schema instead of writing them by hand
 * (ADR-0003 §5).
 *
 * The schemas arrive with the next step of stage 0. For now the package
 * declares only the contract version and an empty registry — that is enough
 * for the SDK and the gateway to already check that they speak one dialect.
 */

import type { ZodType } from "zod";

/**
 * The version of the public contract. It grows when the meaning of the fields
 * changes, not when a schema is added: a consumer uses it to decide whether it
 * understands the other side.
 */
export const CONTRACT_VERSION = "0";

/** The registry of contract schemas. Empty until the schemas are written. */
export const schemas: Readonly<Record<string, ZodType>> = Object.freeze({});
