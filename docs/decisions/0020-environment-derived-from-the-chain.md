# 0020. What environment this is, the chain answers

Date: 2026-08-31
Status: accepted

## Context

The one deployment we run becomes two. A test site takes every green commit on
`main` and settles on Base Sepolia with test funds; a live site is delivered by
a version tag and settles on Base mainnet, where the money is real. They are
one image out of one repository, and all that separates them is configuration.

Something has to tell one from the other, because the difference leaves the
building: it is the prefix on every key a merchant is issued, the `test` field
on every order and receipt, and what a page says to whoever is reading it. A
wrong answer there is not a deployment that is down — it is a claim we make on
somebody else's document, to somebody else's agent, about whether somebody
else's money moved.

## Decision

The environment is derived from `PAYMENT_NETWORK` and from nothing else. A
chain on the written testnet list makes a test deployment; Base mainnet, the
one live chain written down, makes a live one. There is no `COINSLOT_ENV`. The
chain is a field the gateway already takes, it holds one value, and a single
field cannot disagree with itself — ADR-0008's argument for the sandbox, made
again about a larger thing.

A chain on neither list stops the process, and the refusal names both lists.
Guessing is wrong in both directions: an unlisted test network read as live
would issue `csk_live_` keys and write `test: false` onto every order and
receipt, and an unlisted live chain read as a test would mark real money as
play money. So an unwritten chain is refused, where the difference between "I
don't know" and "I know there is none" is still visible to a person. Adding one
is an edit to this decision and to the list in
`packages/core/src/deployment/environment.ts` — Ethereum and Polygon mainnet
are deliberately absent, because they are chains we do not sell on.

A live chain settles through Coinbase's facilitator at
`https://api.cdp.coinbase.com/platform/v2/x402`, with `CDP_API_KEY_ID` and
`CDP_API_KEY_SECRET` both set, and through nothing else. The scheme and the
path belong to that rule as much as the host does: `FACILITATOR_URL` takes
`http:` as readily as `https:` and Coinbase is recognised by hostname, so the
right host over plain text satisfies every other check and puts both
credentials on the wire, and the gateway builds `/verify` and `/settle` under
whatever base it was given, so a wrong path under the right host comes up
healthy and fails at the first buyer.

The value nobody types is what this is really for. `FACILITATOR_URL` falls back
to the public x402 facilitator, which is right for the test site and asks for
no credentials; on a live chain that same default would let an environment file
copied from the test host, with one line changed, start and settle somewhere
the pilot does not settle. Going live must not be something that happens by
forgetting a variable.

## Consequences

What this buys: neither site can be talked into being the other by a second
field left set from yesterday. What it costs: a chain nobody has written down
cannot be tried by editing an environment file, and the live site has one
facilitator an operator cannot change. The trigger to widen that is a second
facilitator whose credentials we hold and whose settlements reach the catalog a
listing depends on (ADR-0001); the single address becomes a list.

Rejected: `COINSLOT_ENV=test|live` beside the chain — the same behaviour and a
worse shape, for ADR-0008's reason, because the field that survives a copied
environment file is the one still saying "test" in a place that means to move
real money. Reading an unknown chain as live to be safe — safe for spending and
wrong on the wire, which is the half that leaves the building. Naming the live
facilitator by host alone, the way ADR-0008's credentials door does — that door
asks who may be handed a bearer token, and this one asks where money that is
real may be settled, which the scheme and the path are part of.
