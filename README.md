# Coinslot

The gateway through which an ordinary online business sells its goods to AI
agents, paid in stablecoins over the x402 protocol. The money goes from the
buyer's wallet to the merchant's and never passes through us. What the product
is, in the words of the person deciding whether to connect, is `docs/vision.md`.

This file is written for an engineer who has just opened the repository: what
the system does, how to watch it do it, and where each part of it lives.

## How a sale runs

Three parties meet in a purchase. A merchant is an online business that
already sells something and does not change its range to sell here. An agent is a program somebody handed a task
and a budget, and it is the one doing the buying. A facilitator is the service
that checks a payment and executes it against the chain; it belongs to neither
side, and it is the reason the money goes straight from one wallet to the other
instead of resting in an account of ours.

The unit of trade is a card: one product written so that a program can decide
to buy it — a title, a description, a price, and the list of what has to be
given at the moment of purchase. A merchant publishes cards through the SDK,
the gateway serves them, and every card is an address an agent can pay against.

A purchase begins as an ordinary HTTP request to that address. The gateway
answers `402 Payment Required` with a challenge naming the price, the network
and the asset; the agent signs a payment and repeats the request carrying it.
That exchange is x402, an open protocol for paying for an HTTP request, and
none of the protocol is written by hand here — the encoding comes from the
official packages, and what this repository adds is the one thing no library
can supply, which is knowing what order a payment is for.

From the second request onward the shape of the sale is the card's fulfillment
mode, and the card declares it before payment so that the agent knows it in
advance. Under synchronous fulfillment the goods come back in the answer to the
purchase itself, and the charge executes only once they have: a refusal costs
the buyer nothing, because nothing was taken. Under asynchronous fulfillment
the charge goes through at the purchase, the agent immediately gets an order
and a way to ask what became of it, and the goods arrive later — seconds later
or a day later, which makes no difference to the shape. A third mode, in which
the merchant confirms before the buyer is charged, is built inside the state
machine and closed at the door: the card schema refuses to publish a card that
asks for it, and the two effects that belong to it stop the process rather than
invent a message no contract describes (ADR-0007). It opens for the first
merchant who answers orders by hand.

The merchant's side of all this is one small process standing beside their
existing API, and the SDK calls it a handler. It listens on no port: it opens
a single outgoing subscription to the gateway, receives paid orders, price
questions and order events together on that one stream (ADR-0004), answers each
of them, and closes orders it took on earlier off the orders themselves. The
whole surface a merchant learns is `@coinslot/sdk`: the shapes their code is
written against, and the check they run on their own cards before publishing
them.

The order in the middle is a state machine of sixteen states, and it lives in
`packages/core` as a pure function with no IO of any kind. The gateway feeds it
an event and gets back the next state together with the effects that state
implies — send this order out, start this clock, issue this receipt — and those
effects are written down in the same transaction as the state that implies them
(ADR-0013), so there is no moment in which an order is paid and nobody has been
told to deliver. What the machine knows is finer than what an agent is told: an
agent reads a small vocabulary of endings in which a purchase that never
reached the merchant and one the merchant refused are the same word, and the
places where that folding loses something say so in `order-status.ts`.

There is no external merchant yet, and the contract is written to say so.
While the contract version is `"0"` no compatibility is promised to anybody,
because nothing is published and every client of this gateway moves with this
repository; the clock starts at the first published SDK (ADR-0006).

## Seeing it work

```
docker compose up --build
open http://localhost:8080
```

That brings up the whole chain: the landing at `/`, the merchant documentation
at `/docs`, the merchant's cabinet at `/cabinet`, and the gateway at `/v0` —
one origin, one port, with Postgres behind them. A merchant process comes up
beside it and publishes two cards, a rented phone number sold synchronously and
an eSIM sold asynchronously, so there is something to buy in either mode.

Nothing buys by itself. A sale in the cabinet is one somebody made — and the
buyer is the one thing here that runs on the host rather than in the stack, so
the workspace needs its dependencies before it can:

```
pnpm install
pnpm buy                      # the first card in the catalogue
pnpm buy esim                 # the one delivered later
```

The gateway settles against nothing locally (ADR-0008), so a purchase completes
with no wallet, no network and no faucet, and it says so in its first line of
log. Nothing here moves money. That sandbox is selected by the value of
`FACILITATOR_URL` rather than by a flag beside it, so a deployment that names a
real facilitator cannot also be pretending, and the gateway refuses to start if
a real facilitator's credentials are left sitting next to the sandbox address.

To sign into the cabinet, make an account for the merchant this stack seeded.
An account names the merchant it signs in as and holds that merchant's key
(ADR-0014), and the key is read from standard input rather than given as an
argument — an argument is in the shell's history and in the process list of
everybody on the machine:

```
printf %s local-sandbox-merchant-key | docker compose exec -T cabinet \
  pnpm --filter @coinslot/cabinet account add you@example.com the_merchant
```

That key is the sandbox value `compose.yaml` seeds and is a value in a file
like the database password beside it; a stack brought up with
`COINSLOT_MERCHANT_KEY` set takes that instead. A merchant who has been given
an invitation registers from the cabinet's own page rather than running any of
this — the command is the way in when the merchant already exists.

If port 8080 is taken, `COINSLOT_HOST_PORT=8090 docker compose up` moves the
whole thing, address in the payment challenge included. It moves the stack and
nothing else: the buy command runs on the host, reads none of the stack's
variables, and goes to `http://localhost:8080` unless `GATEWAY_URL` sends it
somewhere else — `GATEWAY_URL=http://localhost:8090 pnpm buy`.

## What is here

The workspace is `packages/*` and `apps/*`, and all of it is listed here.

- `apps/gateway` — the payment edge, the order machine's runner and the queue:
  everything an agent or a merchant's handler talks to. Its ports (the clock,
  the queue, the store, the facilitator) are named in `src/ports` and their
  implementations in `src/adapters`, which is what lets the whole of it run
  against memory in the tests and against Postgres in the stack.
- `apps/cabinet` — the merchant's own screens: cards, orders, receipts, keys,
  and the name a buyer reads. Pages are rendered on the server and there is no
  client build (ADR-0005).
- `apps/landing` — the public page, static.
- `packages/contracts` — every shape that crosses a boundary, as zod schemas,
  and the route table both sides import instead of transcribing. Types are
  inferred from the schemas rather than written twice.
- `packages/core` — the order state machine: pure logic, zero IO and zero
  runtime dependencies, so the rules about somebody else's money can be read
  and tested without a database anywhere near them.
- `packages/sdk` — what a merchant integrates against, and the full cost of
  doing so: its runtime dependency tree is our own contracts package and zod,
  and nothing else.
- `packages/slice` — a mock merchant and a buyer. They are the two ends the
  offline gate drives and the two commands above.
- `portal/` — the merchant documentation, a vitepress project of its own with
  its own lockfile, deliberately outside the workspace so that releasing the
  documentation is not tied to releasing the code.
- `spikes/` — experiments living on their own dependencies; a spike dies once
  its conclusions have moved into a decision or into research.

The gateway and the cabinet share one Postgres and each owns its own
migrations under `drizzle/`; `pnpm db:migrate` runs both.

## Checks

```
pnpm install
pnpm check          # formatting and lint
pnpm typecheck
pnpm test           # offline, free, no network
pnpm check:decisions
```

Those four are the gate before a push. CI runs the same ones on every push and
pull request: the first three and `pnpm build` in one job, because building
compiles a different set of files than type-checking does, and the decision log
and the portal in jobs of their own. A commit on `main` that passes all three
jobs is the commit that gets deployed.

Three more checks cost something and are kept apart for that reason.
`pnpm test:db` needs a Postgres — `docker compose up -d --wait postgres` — and
fails rather than skipping if there is none. It looks for it on port 5432,
where that command publishes it; a host that publishes it somewhere else names
it in `COINSLOT_TEST_DATABASE_URL`. `pnpm outside` packs the tarballs npm would
publish, installs them into a directory with no path back to this repository,
and runs the commands the quickstart tells a merchant to run — which is the
only thing that answers whether the SDK works for somebody who does not have
this repository. `pnpm smoke:listing <https address>` asks Coinbase's own
endpoint whether our resource would be listed, and reports no verdict rather
than a pass when it cannot reach us.

## The documents

`docs/vision.md` is the product: what Coinslot is, what connecting asks of a
merchant, and what the pilot is meant to answer. `portal/` is the documentation
a merchant actually reads, and it has three readers of its own — the owner
deciding whether to connect, the engineer building the integration, and both of
them afterwards operating the thing; `portal/WRITING.md` says how those pages
are held apart.

`docs/decisions/` is every decision taken, numbered, one file each: an ADR
records what is expensive to reverse — a dependency in a published package's
tree, a schema on disk, a wire contract, a security boundary. The working
material behind them is `docs/research/`, including the pilot plan the stages
of this work come from and the open questions still unanswered.

The documents are not all in one language, and the rule is the audience.
Engineering artifacts — code, comments, commit messages, this file, the working
charter — are English. Research and product documents are written in the
language of their readers, which is why `docs/vision.md` and the earlier
decisions are in Russian and stay that way: they are the record as it was
written, not a translation backlog.

Some of what is written in the portal is also executable. The JSON examples on
its pages and the tables describing how an order can end are read by the
contracts and core test suites from the very files the pages render, so a page
and the behavior it describes cannot drift apart quietly.

## Working in this repository

Small steps go straight into `main`; experiments go into `spike/<topic>`
branches, and agent work into worktrees under `.claude/worktrees/<topic>` on
`agent/<topic>` branches, which `pnpm worktrees` lists and `pnpm worktrees:clean`
removes once they are merged. Commits follow Conventional Commits, are written
in English, and are small enough that one commit is one reason to roll back;
every commit leaves the repository in a state that builds.

The discipline behind all of that — how decisions are recorded, what a test has
to answer for, why a check that did not run never reports success — is in
`AGENTS.md`.
