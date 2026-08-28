# Coinslot

The gateway through which an ordinary online business sells its goods to AI
agents, paid in stablecoins over the x402 protocol. The money goes from the
buyer's wallet to the merchant's and never passes through us. What it is and
why — `docs/vision.md`.

## Seeing it work

```
docker compose up --build
open http://localhost:8080
```

That brings up the whole chain: the landing at `/`, the merchant documentation
at `/docs`, the merchant's cabinet at `/cabinet`, and the gateway at `/v0` —
one origin, one port, with Postgres behind them. A merchant process comes up
beside it and publishes two cards, so there is something to buy.

Nothing buys by itself. A sale in the cabinet is one somebody made:

```
pnpm buy                      # the first card in the catalogue
pnpm buy esim                 # the one delivered later
```

The gateway settles against nothing locally (ADR-0008), so a purchase completes
with no wallet, no network and no faucet, and it says so in its first line of
log. Nothing here moves money.

To sign into the cabinet, make an account — there is no sign-up page yet
(ADR-0009; registration is third on the road ADR-0010 fixes):

```
docker compose exec cabinet pnpm --filter @coinslot/cabinet account add you@example.com
```

If port 8080 is taken, `COINSLOT_HOST_PORT=8090 docker compose up` moves the
whole thing, address in the payment challenge included.

## What is here

- `apps/gateway` — the payment edge, the order machine's runner, the queue
- `apps/cabinet` — the merchant's screens: cards, orders, receipts
- `apps/landing` — the public page, static
- `packages/contracts` — every shape that crosses a boundary, and the route
  table both sides read
- `packages/core` — the order state machine
- `packages/sdk` — what a merchant integrates against
- `packages/slice` — a mock merchant and a buyer, used by the offline gate and
  by the two commands above
- `portal/` — the merchant documentation, its own project with its own build
- `docs/decisions/` — every decision taken, numbered; `docs/research/` — the
  working material behind them

## Checks

```
pnpm install
pnpm check          # formatting and lint
pnpm typecheck
pnpm test           # offline, free, no network
pnpm check:decisions
```

Three more cost something and are kept apart for that reason. `pnpm test:db`
needs a Postgres — `docker compose up -d --wait postgres` — and fails rather
than skipping if there is none. `pnpm outside` packs the SDK, installs it into
a directory outside this repository and runs the documented commands there.
`pnpm smoke:listing <https address>` asks Coinbase's own endpoint whether our
resource would be listed, and reports no verdict rather than a pass when it
cannot reach us.

The discipline these are held to — how decisions are recorded, what a test has
to answer for, why a check that did not run never reports success — is in
`AGENTS.md`.
