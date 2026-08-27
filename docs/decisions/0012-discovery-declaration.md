# 0012. The payment challenge declares the product, as a projection of its card

Date: 2026-08-27
Status: accepted (Dmitry, 2026-08-27)

## Context

ADR-0001 settled where the pilot is exposed: the x402 Bazaar, the public
catalog Coinbase's CDP facilitator builds, which is where agents that buy
things over the x402 payment protocol look for what to buy. An entry in it
appears when an endpoint answers a payment challenge carrying a discovery
declaration and a payment for that endpoint settles through that facilitator.
The spike in
`docs/research/04-spike-bazaar-listing.md` proved the whole path on a throwaway
server and it was never carried into the gateway. Measured on the running stack
before this change, the challenge the gateway emitted carried a version, an
error, a resource and a price, and no declaration at all — so nothing this
product sells could be found by an agent that had not been told about it.

Almost everything a declaration wants is already in a card. The description, the
parameters an agent supplies and the result it receives are all there, and the
contract already derives a check from a parameter declaration. Two fields the
catalog reads were missing, and the resource address it keys a listing on was
being read off the request, which behind a reverse proxy — the process that
ends the agent's TLS connection and passes the request on to us — is the wrong
address. What was measured is the scheme and the query: the request reaches us
as `http://` with whatever the caller wrote after the question mark still in
it, and both go into the identity of the resource.

## Decision

**The declaration is a projection of a card**, alongside the projection an agent
reads in our own catalog, in `packages/contracts/src/card.ts`. It yields the
material a challenge is assembled from — the resource block, an example purchase
body, the JSON Schema that body is held to, and an example delivery. The
assembling is done at the edge by the protocol's own library, from those pieces.
The projection is where the decisions about what a card says about itself live;
the edge is where the wire format is written, and nothing writes that by hand.

Keeping the library call at the edge is not a detail. ADR-0003 §8 holds the
contracts package to a runtime dependency tree of zod alone, because that tree
is the merchant SDK's tree, and every addition to it is a separate written
decision. `@x402/extensions` brings a payment library's whole dependency graph.
It is a dependency of the gateway, which uses libraries freely, and of nothing
else.

**The resource address is pinned from `PUBLIC_BASE_URL` and the route table.**
The library would derive it from the request; behind our own proxy that yields
`http://` and drags the query string into the identity of the resource. A
listing is keyed on that address, so two spellings are two listings for one
product, or one that flickers between them. The configured base has its trailing
slash removed once, where it is read, because a path is joined onto it.

**The seller's listing name belongs to the merchant; the tags belong to the
card.** A name names a seller, a merchant sells under one, and a per-card name
would be one seller appearing as several — so it is a column on the merchants
table, set by `merchant listed-as`. Tags describe one product and sit on the
card. Both are text a merchant typed, and both are held before they go out to
the catalog's rules — printable ASCII, at most 32 characters, at most 5 tags,
and no two tags differing only in case — because the catalog drops what breaks
any of those without telling anybody, and silent truncation of somebody's name
is not something to pass on. Those rules are read out of the catalog's own code,
which we run in our own tests — the same function the catalog cleans a
resource with.

One rule beside them is ours and not theirs, and the two are worth keeping
apart: a value padded with a space at either end is refused here, and the
catalog would have carried it verbatim. Nothing is lost there — what is lost is
here, where a merchant comparing the word they typed with the word they see
finds two spellings that look identical.

The third field of merchant-written text is the description, and it reaches a
listing with nothing of the catalog's checking it at all. The catalog's own
code carries one function that cleans a resource's metadata on the way in, and
what it looks at is the listing name and the tags, never the description. It
is held to 500 characters, and where that number comes from is the honest part.
The other two limits were read out of code we can run; this one is read out of
the catalog's written documentation, recorded in
`docs/research/04-spike-bazaar-listing.md`, which also records the one attempt
to corroborate it: a hundred entries out of the live catalog, longest
description 468 characters, none at or above 500 and none at the boundary a
hard cut would have left behind. That is consistent with the number and settles
nothing, and the boundary itself cannot be tried without a public https
resource of our own. So the number is honoured rather than verified, and what a
catalog does with a longer description is unknown.

The listing name is a second field and not the name the merchants table already
carried. That one is read by a person at a terminal and may be written in any
alphabet; this one goes out to strangers under a rule that would otherwise make
a merchant unable to be called what they are called. Null is the ordinary state
and it means nobody named one, so nothing about a seller goes out. It is never
filled in from the name beside it.

**Every card is declared, and only while it is for sale.** There is no opt-in
flag: a merchant who published a card is selling it. A card that is off sale —
its own pause, its merchant's, or a merchant who left — answers no challenge at
all, on either method, so a catalog built from these challenges never carries a
product nobody can buy.

**The declaration's shape follows the request's method.** A declaration naming a
body is only valid on a method that carries one, and the crawlers and the
catalog's own validator probe with GET. So a GET is declared as the probe it is
and a POST as the purchase an agent makes. This is the failure the spike paid
for once: a resource declared only as a POST is invisible to the thing that
lists it.

## Consequences

- An agent that has never heard of us can find a product of ours in a catalog it
  already walks. That is the product, and until now nothing in this repository
  did it.
- Our own tests cannot say whether the facilitator accepts what we emit. They
  check the declaration against the schema it ships with and run the catalog's
  own sanitiser over the merchant's text — both with the library the facilitator
  uses — and compare the shape against one that was accepted once. None of that
  is acceptance. `pnpm smoke:listing` makes the live call, needs a gateway
  reachable from the internet, and reports a probe with no verdict as no
  verdict.
- The description's ceiling is a rule about reading a card as well as about
  writing one. The schema is shared by the published card, the projection an
  agent reads and the card its own merchant reads back, deliberately, so that
  what an agent is shown is what the merchant is held to. A card stored before
  the ceiling with a longer description is therefore not merely unpublishable
  again: it stops being readable, and it takes its whole page with it — the
  merchant's card list and the public catalog are each one document, parsed
  once. Cards come back out of the database as stored and are not checked on
  the way out, so the gateway serves such a row and the reader is what stops.
  Nothing in the pilot has one, and the way out of it is to republish the card.
- We pay in what a merchant may write. A seller whose name is in Cyrillic, Greek
  or Arabic cannot be listed under it, and learns that when they set the name
  rather than from a listing that is missing it. Tags carry the same cost, and a
  description now has a ceiling on a number nobody has verified. A merchant
  whose prose runs to 520 characters is refused here, and what would have
  happened to it in a listing is unknown — the refusal is the better of the two
  answers available and it is still a cost.
- The card's title is not sent. The resource block has one field of prose and a
  card has two, and joining a merchant's headline to their description with
  punctuation of ours would be writing their listing for them.
- The examples in the declaration are shapes and not facts: every declared field
  holding a value that stands for its type, because a card carries no example
  values. Tests hold them to the card's own checks, so what goes out is
  something
  our own door accepts — which is what settles what a string stands for. A
  delivered string has to carry something, so it is the word `string` rather
  than
  an empty one, and an example built out of empty strings would have advertised
  a
  delivery this system refuses. A card that could carry real examples would say
  more, and adding a field for them is not part of this.
- The challenge carries the declaration in one header, and the header grows with
  the card. The description is bounded and the number of parameters is not.
  Three cards were measured against a build with no ceiling on either: a
  55-character description with one parameter came to a 1.9 KB header; a
  1,500-character description with eight parameters, 4.3 KB; a 4,000-character
  description with forty parameters, 10.3 KB. The ceiling puts the second and
  the third out of reach by way of their descriptions, and neither by way of
  its parameters: a card with forty of those still reaches the same size with a
  description well inside 500. What a given proxy does with a header that large
  is not measured, and it is the kind of limit that surfaces as a transport
  error rather than as a refusal anybody can read.
- Rejected: an opt-in flag on the card. It would make the default invisibility,
  which is the state this change exists to leave.
- Rejected: reusing the merchant's existing name as the listing name. It would
  put one channel's alphabet rule on every merchant's name, or list them under a
  cut-down version of it.
