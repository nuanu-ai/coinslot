/**
 * One message on the merchant's worker stream.
 *
 * The stream carries three different things — an order, a question about a
 * price, a notification about an order — and it carries them on one connection
 * because the portal promises the merchant one subscription (ADR-0004 §2).
 * Everything on it is therefore wrapped in the same envelope, whose marker says
 * which of the three the wrapper is holding.
 *
 * Three decisions are worth arguing rather than leaving to be inferred.
 *
 * The payload sits under its own key instead of being spread into the
 * envelope, and the reason is a collision that would be silent. An order
 * already carries an `id`, and that identifier is its idempotency key — the
 * thing a handler answers from on a redelivery. Spread flat, the envelope's own
 * identifier and the order's would be one field, one of the two would win, and
 * whichever lost would be lost without a word. Nesting is what keeps the
 * message's identity and the order's identity from ever being the same string.
 *
 * The key is `payload` for every kind rather than `order`, `quote_request` and
 * `order_event` in turn. Naming it after the kind would say the same thing
 * twice, and two things that say the same thing can disagree — a message
 * marked one way and keyed the other has no reading. With one key the marker is
 * the only place that answers "what is this", and it is checked: the schema
 * holds the payload to the document its kind names, so a price question inside
 * an envelope marked as an order is refused at the boundary rather than handed
 * to an order handler.
 *
 * The kinds are the names the contract registry already publishes for those
 * three documents. That is not decoration: the reader furthest from us has the
 * JSON Schema export and nothing else, and a kind invented separately would be
 * a second vocabulary for documents the export names once. A test holds the two
 * in step.
 *
 * What the envelope does not carry is a handle for acking. Delivery is at least
 * once with redelivery on a visibility timeout, and the acknowledgement of each
 * kind is something that already exists: an order is acked by its outcome call
 * against the order's own identifier, a price question by the reply against
 * `price_id`, and an event wants no acknowledgement at all. A handle here would
 * be a fourth way to name a message that three surfaces already name.
 *
 * The merchant never sees any of this. The SDK hands a handler an order, not
 * the envelope it arrived in (ADR-0004 §5); the envelope is the format between
 * the gateway and the SDK, and it lives in this package because both of them
 * read it and neither owns it.
 */

import { z } from "zod";
import { OrderEventSchema } from "./events.js";
import { OrderSchema } from "./order.js";
import { IdentifierSchema, TimestampSchema } from "./primitives.js";
import { QuoteRequestSchema } from "./quote.js";

/**
 * What each kind of envelope is holding, by the name the marker uses.
 *
 * The union below is built from these, so the marker and the check behind it
 * cannot come apart.
 */
export const WORKER_ENVELOPE_PAYLOADS = Object.freeze({
  /** A purchase that is paid for as far as its mode requires, waiting to be delivered. */
  order: OrderSchema,
  /** "How much is this and is it there", asked before a sale goes through. */
  quote_request: QuoteRequestSchema,
  /** Something that happened to an order without the merchant doing anything. */
  order_event: OrderEventSchema,
} as const);

/** The marker one envelope carries, naming what its payload is. */
export type WorkerEnvelopeKind = keyof typeof WORKER_ENVELOPE_PAYLOADS;

export const WORKER_ENVELOPE_KINDS = Object.freeze(
  Object.keys(WORKER_ENVELOPE_PAYLOADS),
) as readonly WorkerEnvelopeKind[];

/**
 * The fields every envelope carries, whatever it is holding.
 *
 * `id` names the message and does not change when the same message is
 * delivered again; `sent_at` names this delivery of it and does. The pair is
 * how a worker tells a repeat from a new message without looking inside the
 * payload — which matters most for an event, the one kind with no outcome call
 * behind it to make a repeat harmless.
 */
const envelopeOf = <Kind extends WorkerEnvelopeKind, Payload extends z.ZodType>(
  kind: Kind,
  payload: Payload,
) =>
  z.strictObject({
    kind: z.literal(kind),
    id: IdentifierSchema,
    sent_at: TimestampSchema,
    payload,
  });

export const WorkerEnvelopeSchema = z.discriminatedUnion("kind", [
  envelopeOf("order", WORKER_ENVELOPE_PAYLOADS.order),
  envelopeOf("quote_request", WORKER_ENVELOPE_PAYLOADS.quote_request),
  envelopeOf("order_event", WORKER_ENVELOPE_PAYLOADS.order_event),
]);

export type WorkerEnvelope = z.infer<typeof WorkerEnvelopeSchema>;
