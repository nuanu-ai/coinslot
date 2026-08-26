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
5. The SDK hides the transport entirely: `orders.subscribe(handler)` and
   `pricing.onQuote(handler)` are loops over the poll call. Switching
   transport later must not change merchant code.

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
