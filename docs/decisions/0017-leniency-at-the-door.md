# 0017. Leniency lives at the door, and only the canon lives behind it

Date: 2026-08-28
Status: accepted

## Context

The first thing a merchant meets is the publish call, and the smallest
honest card ran twenty-five lines — most of them saying things the
merchant had no opinion about. Shortening what a merchant may write is
product work and would not deserve a decision record; what deserves one
is where the alternative spellings are allowed to exist, because every
future convenience will raise that question again.

## Decision

The wire may accept more spellings than the canon. Today that means a
card without `fulfillment` is synchronous, a declared field may be the
type word alone (`'string'` for `{ type: 'string' }`), and a price may
be the one string `'5.00 USD'`. Every such leniency is opened out into
the canonical shape at the parse boundary, inside the schema itself,
and nothing behind the door ever meets it: storage holds the canon,
internal code reads the canon, and what an agent or the cabinet is
served is the canon. A finding about a short-written field still points
at what the merchant wrote.

Stated once for every future case: adding or removing a spelling is a
product choice — cheap while every consumer is ours, a compatibility
promise after the first external merchant. The placement is the
architecture: a spelling that reached storage or a reader would be a
second shape for the same fact, and two shapes drift.

## Consequences

What this buys: the landing, the quickstart and the door all take the
same eight-line card, while every consumer downstream keeps exactly one
shape to parse. What it costs: the card schema carries the opening-out
logic, and anyone extending it must put new leniency there and nowhere
else.

Rejected: a second, "simple" publish surface — two doors is two
contracts to learn and keep honest, while a spelling accepted by the
one door adds no surface. Expanding short forms in the SDK only — the
door itself must accept what the documentation shows, or curl and the
SDK meet different contracts and the examples stop being fixtures of
the real thing. Storing what was written and normalizing on read —
every reader becomes a parser, and the one that misses serves the
second shape.
