# 0005. The web surface: one origin, server-rendered pages, no client build

Date: 2026-08-27
Status: accepted (autonomous mandate of 2026-08-26; revisited on Dmitry's word)

## Context

The pilot needs something a merchant's engineer can be shown and can click
through: a landing that says what this is, the documentation portal that
already exists, and the merchant cabinet the pilot plan calls for — cards with
a working pause, orders, receipts. Dmitry's instruction of 2026-08-27 is to get
that chain running locally first, in Docker, and only then to put it on a
server.

Until now the repository has had no human-facing surface at all. The gateway
serves the contract's route table to machines; the portal is a separate
VitePress project. Adding a cabinet is the first time this project renders a
page for a person, so the shape of that is a decision rather than a detail.

## Decision

1. **One origin locally.** Caddy, in Docker, is the only door: `/` is the
   landing, `/docs` the portal, `/cabinet` the cabinet, `/v0/*` the gateway,
   and `/healthz` the gateway's own probe. A merchant's engineer sees one
   address and never reasons about ports. The same file describes the server
   later, so what is demonstrated locally is what gets deployed.

   `/healthz` is the fifth path and the only one that is not a surface anybody
   integrates against. Whether the door is open has to be answerable from
   outside it, and the landing and the portal are files Caddy serves itself, so
   the only process whose health the door can report is the gateway's. It sits
   outside `/v0` because that prefix is the contract, and an operational probe
   is not part of what a merchant's code calls. It answers for the gateway
   alone: not for the cabinet, which reports itself at `/cabinet/healthz`, and
   not for Postgres. There is deliberately no aggregate health document — a
   single verdict over several services is read as one and is wrong the first
   time one of them goes down by itself.

2. **The cabinet is its own process (`apps/cabinet`), not a part of the
   gateway.** The gateway is the money path: a resident process whose surface
   is the contract's route table, mounted in one generic loop. Pages for people
   change for reasons that have nothing to do with money, and mixing the two
   audiences in one process puts that churn on the payment path.

3. **The cabinet reaches the gateway through the public API with a merchant
   key** — the same door a merchant's own tooling uses. It holds no database
   connection of its own. This is deliberate dogfooding: if the cabinet cannot
   show something, the API is missing it, and the merchant would have hit the
   same wall.

   Narrowed by ADR-0009: the cabinet owns two tables of its own, accounts and
   sessions, which are the people who sign into it and hold nothing about a
   merchant's data. Everything on every screen still comes from the public API,
   and no query in the cabinet can reach the gateway's tables — that is the
   part of this section the dogfooding argument is about, and it is unchanged.

4. **Server-rendered HTML, no client-side framework and no client build step.**
   The cabinet v0 shows three lists and offers one real action. A single-page
   application would add a build pipeline, a dependency tree and a second
   surface to keep in step, for nothing the pilot needs. Pages are rendered on
   the server and tested with the same HTTP harness the gateway's routes are.
   Interactivity that earns its place is plain form posts and small inline
   scripts; anything more is a decision to be recorded, not a habit to drift
   into.

5. **The landing is static** — HTML and CSS, served by Caddy from a built
   directory, no runtime behind it.

6. **One visual language across all three surfaces**, held in a shared
   stylesheet with design tokens (colour, type scale, spacing) rather than
   repeated per page. The portal keeps its VitePress theme and takes the same
   palette, so the three do not read as three products.

7. **The whole chain runs from one command locally** (`docker compose up`),
   including Postgres, and that is the state Dmitry inspects before anything
   goes to a server.

## Consequences

- Gained: a chain a person can click through end to end; the cabinet proves
  the API is usable by construction; no build step to keep green; the local
  arrangement is the deployment rehearsal.
- Paid: server-rendered pages make rich interactivity awkward, and the day a
  screen genuinely needs it, that screen argues for a client framework on its
  own merits — a named trigger, not a slide.
- The cabinet needs API surface the contract does not yet carry: a merchant's
  own cards, a pause and its release, and receipts. Those are contract
  additions with the ordinary ceremony, not cabinet-private endpoints.

## Rejected alternatives

- **The cabinet inside the gateway** — fewer processes, but it mixes the
  machine contract with human pages and puts UI churn on the money path.
- **A single-page application (React or similar)** — a build pipeline and a
  dependency tree bought before any screen needs them. The trigger to revisit
  is named above.
- **The cabinet talking to Postgres directly** — faster to write, and it would
  have hidden exactly the API gaps this cabinet exists to expose.
