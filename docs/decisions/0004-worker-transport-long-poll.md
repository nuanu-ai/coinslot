# 0004. Worker transport: HTTP long polling

Date: 2026-08-26
Status: accepted (autonomous mandate of 2026-08-26; revisited on Dmitry's word)

## Context

ADR-0002 fixed the model: orders live in our queue, and the default way a
merchant receives them is a worker subscription through the SDK — but it left
the concrete protocol open. Stage 1 of the pilot plan builds the gateway and
the SDK worker, so the protocol has to be chosen now. Whatever carries orders
must also carry price questions (the price handler is the default price-check
transport, ADR-0002 §2) and order events, because the portal promises all
three on one subscription.

## Decision

1. The worker channel is HTTP long polling against the gateway. The SDK
   worker calls a poll endpoint with a wait window (~25 s); the gateway holds
   the request until something arrives or the window closes, then returns a
   batch of envelopes or an empty batch. Auth is the merchant API key
   (stage 1 minimum per the pilot plan).
2. One envelope stream carries three kinds — order, quote question, order
   event — each carrying its kind marker. Quote questions answered over the
   same HTTP surface (a reply call referencing `price_id`); orders are acked
   by their outcome calls (`deliver` / `refuse` / accept); events need no ack.
3. Delivery is at-least-once with redelivery by visibility timeout in the
   queue; the handler-side idempotency the portal already demands is what
   makes that safe.
4. A worker that is connected and waiting receives a message with no polling
   lag — the long poll is parked server-side, so the latency-critical case
   (the quote question of a synchronous purchase, where the agent is waiting)
   is bounded by the network, not by a poll interval.
5. The SDK hides the transport entirely: a merchant registers what their
   process answers with `on(kind, handler)` — one call per kind the stream
   carries — and opens the channel with `start()`, which is the loop over the
   poll call. Switching transport later must not change merchant code.

## Rejected alternatives

- **WebSocket** — a persistent-connection stack (upgrade handling, heartbeat,
  proxy behavior) bought for nothing the pilot needs; the hand-rolling rule
  (ADR-0003 §9) counts a custom framing protocol on top of it as exactly the
  infrastructure we do not build. Named trigger to revisit: a measured
  latency or throughput need long polling cannot meet, or fan-out to many
  concurrent workers per merchant.
- **Server-Sent Events** — one-directional, so quote answers and acks need a
  second surface anyway; at that point it is long polling with an extra moving
  part.
- **Webhooks as the default** — rejected in ADR-0002 already: the merchant
  would have to expose a public endpoint, which the integration model exists
  to avoid. Webhook remains a listed alternative transport, out of the pilot.

Precedents for queue-drain over merchant-exposed endpoints: Telegram
getUpdates, SQS receive-message, Temporal task queues
(`docs/research/12-big-players-merchant-integration.md`).

## Addendum (2026-08-26): the handler's answer has its own route

§2 said orders are acked "by their outcome calls (deliver / refuse /
accept)", which left the synchronous handler with no address: the state
machine distinguishes the handler's returned answer (delivered / refused /
accepted, arriving as the return value of the merchant's handler) from the
merchant's later explicit calls (`deliver` / `refuse`), and in the
synchronous mode the returned answer is the only thing there is — the
explicit calls answer `not_applicable_in_mode` there by design.

So the surface carries a dedicated answer route: the SDK posts the
handler's return value to it, referencing the order, in every mode; the
explicit `deliver` and `refuse` calls remain the asynchronous mode's
closure verbs. A late synchronous answer receives the typed
"purchase already closed" acknowledgment rather than an error — provided
the goods in it are the ones the card declares. The gateway holds a
delivery to the selling card's `result` before the order machine sees it
wherever that delivery could still be written down, so an answer whose
goods do not fit is refused as `delivery_does_not_match_card` and the
lateness is never reached. That is the deliberate order: the fault in the
handler is what the merchant is told about first, and the state of his
order arrives afterwards.

Two limits on that, both measured against the code rather than reasoned
from this text. The check is skipped on an order that already carries
goods (`deliverOrder` in `apps/gateway/src/app/gateway.ts`): a repeat is
answered `already_delivered`, and what it carried is neither weighed
against the card nor kept, which is what makes a merchant's retry safe
rather than a failure branch. And "arrives afterwards" holds only on the
explicit `deliver` and `refuse` calls, where the merchant reads the
returned answer himself. On the answer route it does not: the fixed
synchronous answer comes back as a success carrying the word
`purchase_already_closed`, and the SDK reports only the answers we refuse,
so the word is dropped and nothing reaches his code. The gap is listed as
open on `portal/orders.md`.

Carrying answers inside the next poll request was rejected: it would couple
the latency-critical synchronous answer — the agent is waiting on it — to
polling cadence and batch size, which §4 exists to keep out of that path.
