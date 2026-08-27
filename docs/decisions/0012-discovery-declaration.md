# 0012. The payment challenge declares the product, as a projection of its card

Date: 2026-08-27
Status: accepted (Dmitry, 2026-08-27)

## Context

ADR-0001 settled where the pilot is exposed: a catalog entry appears when an
endpoint answers a payment challenge carrying a discovery declaration and a
payment for it settles through the CDP facilitator. The spike in
`docs/research/04-spike-bazaar-listing.md` proved the whole path on a throwaway
server and it was never carried into the gateway. Measured on the running stack
before this change, the challenge the gateway emitted carried a version, an
error, a resource and a price, and no declaration at all — so nothing this
product sells could be found by an agent that had not been told about it.

Almost everything a declaration wants is already in a card. The description, the
parameters an agent supplies and the result it receives are all there, and the
contract already derives a check from a parameter declaration. Two fields the
catalog reads were missing, and the resource address it keys a listing on was
being read off the request, which behind a terminator is the wrong address.

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
The library would derive it from the request; behind our own terminator that
yields `http://` and drags the query string into the identity of the resource. A
listing is keyed on that address, so two spellings are two listings for one
product, or one that flickers between them. The configured base has its trailing
slash removed once, where it is read, because a path is joined onto it.

**The seller's listing name belongs to the merchant; the tags belong to the
card.** A name names a seller, a merchant sells under one, and a per-card name
would be one seller appearing as several — so it is a column on the merchants
table, set by `merchant listed-as`. Tags describe one product and sit on the
card. Both are text a merchant typed, and both are held to the catalog's own
rule before they go out: printable ASCII, at most 32 characters, at most 5 tags,
no two tags differing only in case, nothing padded with spaces. The catalog
silently drops what breaks those rules, and silent truncation of somebody's name
is not something to pass on.

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
  reachable from the internet, and reports a probe with no verdict as no verdict.
- We pay in what a merchant may write. A seller whose name is in Cyrillic, Greek
  or Arabic cannot be listed under it, and learns that when they set the name
  rather than from a listing that is missing it. Tags carry the same cost.
- The card's title is not sent. The resource block has one field of prose and a
  card has two, and joining a merchant's headline to their description with
  punctuation of ours would be writing their listing for them.
- The examples in the declaration are shapes and not facts: every declared field
  at the empty value of its type, because a card carries no example values.
  Tests hold them to the card's own checks, so what goes out is something our own
  door accepts. A card that could carry real examples would say more, and adding
  a field for them is not part of this.
- The challenge now carries the declaration in one header, and nothing bounds a
  card's description or the number of its parameters. Measured: a card with a
  55-character description and one parameter produces a 1.9 KB header; one with
  a 1,500-character description and eight parameters, 4.3 KB; one with a
  4,000-character description and forty parameters, 10.3 KB. What a given
  terminator does with a header that size is not measured, and it is the kind of
  limit that shows up as a transport error rather than as a refusal anybody can
  read. Whether a description gets a maximum is an open question, and the number
  would be a decision rather than a derivation.
- Rejected: an opt-in flag on the card. It would make the default invisibility,
  which is the state this change exists to leave.
- Rejected: reusing the merchant's existing name as the listing name. It would
  put one channel's alphabet rule on every merchant's name, or list them under a
  cut-down version of it.
