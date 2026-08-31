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
path are part of that address rather than decoration: the right host over plain
text satisfies every other check and puts both credentials on the wire, and the
gateway builds `/verify` and `/settle` under whatever base it was given, so a
wrong path comes up healthy and fails at the first buyer.

Every key carries the environment it was issued in as its prefix — `csk_test_`
on one site, `csk_live_` on the other — and the door reads that prefix before
it looks a digest up. A key from the other site is refused with words rather
than with a status code: the same `not_authorised` and the same 401 as every
other refusal there, and a sentence naming the site the key does work on. That
gives nothing away, since whoever presents a key can read its own prefix. A key
naming no environment at all gets the plain refusal, because a door that told a
bare key from a guess apart would confirm which guesses had once been real keys.

## Consequences

What this buys: neither site can be talked into being the other by a second
field left set from yesterday, and a merchant who pastes the wrong key is told
which site it belongs to instead of meeting a bare 401. What it costs: an
unwritten chain cannot be tried by editing an environment file, the live site
has one facilitator an operator cannot change, and every key issued before the
prefix existed stops opening anything at the door, whatever a database holds.

Two triggers. The facilitator becomes a list on the day there is a second one
whose credentials we hold and whose settlements reach the catalog a listing
depends on (ADR-0001). The prefix is revisited on the day a live gateway has to
issue a test key — a merchant trying their own integration against the live
site — and the prefix is the seam that change runs along: what the door reads
stops being "this site's own" and becomes the prefixes this site accepts.

Rejected: `COINSLOT_ENV=test|live` beside the chain — ADR-0008's reason, since
the field that survives a copied environment file is the one still saying
"test" where real money moves. Reading an unknown chain as live to be safe —
safe for spending and wrong on the wire, which is the half that leaves the
building. A machine-readable code of its own for the key from the other site —
`ERROR_CODES` is closed and the SDK parses strictly against its own copy, so a
value added there moves `CONTRACT_VERSION` and stops every installed worker
until its merchant upgrades: an enormous price for a sentence.
