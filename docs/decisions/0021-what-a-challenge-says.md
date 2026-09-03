# 0021. A challenge says what every other challenge says

Date: 2026-09-01
Status: accepted

## Context

An x402 challenge carries an optional `error` line, and we were writing a
sentence into it about how a card's price works: that the price quoted
to a crawler is the published one and a purchase is priced when it is
made. True, and written for an audience nobody had checked existed.

Measured (`docs/research/25-what-the-challenge-says.md`): of fifteen
challenges read from live resources in the public catalogue, fourteen
carry an `error` line and thirteen of those are the words "Payment
required". One is informative — "PAYMENT-SIGNATURE header is required."
None says anything about the product behind the resource. And the
catalogue's own record has no `error` field at all, so whatever a server
writes there reaches no listing.

The wire is the surface a stranger's agent meets, and it is the one
place where being unlike everyone else costs an integrator time.

## Decision

The `error` line on a challenge says why this call did not return the
resource, in the shortest words that say it, and nothing else. It
carries no product semantics, no pricing explanation and nothing about
how this gateway works.

Two challenges fill it today. The GET probe says "payment required",
which is what the shelf says. A payment naming an order this gateway is
not holding says so, because that is a reason the caller cannot work out
and will otherwise read as its payment being rejected.

Where a fact about a product has to reach an agent, it goes somewhere an
agent can branch on it. `price_checked_at_purchase` on the public card is
that place for the one this decision removed from the wire.

## What this costs, and why it is acceptable

An agent doing a bare GET no longer learns that the price it sees is
provisional. It does not need to: the x402 exchange re-reads the
requirements of the call it actually makes and signs against those, and
the client's own spending ceiling catches a difference. The GET price is
advisory by construction, and a sentence in a field nothing reads was
not what made it safe.

## Alternatives rejected

**Leave the sentence.** It is honest and it is ours. But it is in a
field named for failures, on an answer that is not one; monitoring that
counts `error` lines counts our ordinary answers as faults; and the
crawler it was written for never receives it.

**Empty the field.** Tidier by the field's name, and it would make us
one resource in fifteen that sends nothing where the rest send a line.
Native beats tidy on a surface somebody else integrates against.

**Carry the fact in our own `extensions` key.** The catalogue does keep
`extensions`, so it would survive. It is also a public surface nobody
consumes, and the pit of success prices a surface as a cost. Revisit if
an agent ever asks for it.
