# 0012. The payment challenge declares the product, as a projection of its card

Date: 2026-08-27
Status: accepted (Dmitry, 2026-08-27)

## Context

ADR-0001 exposes the pilot on the x402 Bazaar: an entry appears in that catalog
when an endpoint answers a payment challenge carrying a discovery declaration
and a payment for that endpoint settles through the CDP facilitator. The spike
(`docs/research/04-spike-bazaar-listing.md`) proved the path on a throwaway
server; the gateway's own challenge carried no declaration at all, so nothing
this product sells could be found by an agent that had not been told about it.
Almost everything a declaration wants is already in a card.

## Decision

**The declaration is a projection of a card**, in
`packages/contracts/src/card.ts`, beside the projection an agent reads in our
own catalog. It yields the material — the resource block, an example purchase
body, the JSON Schema that body is held to, an example delivery — and the wire
format is assembled at the edge by the protocol's own library, never by hand.
`@x402/extensions` is a dependency of the gateway alone: ADR-0003 §8 holds the
contracts package to zod, because that tree is the merchant SDK's tree.

**The resource address is pinned from `PUBLIC_BASE_URL` and the route table**,
not read off the request: behind our own reverse proxy the request arrives as
`http://` with the caller's query string still attached, and a listing is keyed
on that address — two spellings are two listings for one product.

**The seller's listing name belongs to the merchant; the tags belong to the
card.** A per-card name would be one seller appearing as several, so the name
is a column on the merchants table, set by the merchant themselves over the API
or by `merchant listed-as` at a terminal. It is null by default and never
filled in from the display name beside it — that one may be written in any
alphabet, this one goes out to strangers under the catalog's ASCII rule.
Merchant-written text is held on the way in to the catalog's own limits,
checked with the catalog's own code where that code is runnable, because the
catalog drops what breaks its rules without telling anybody. The description's
ceiling of 500 is honoured rather than verified; the numbers, their sources
and their status are recorded in the spike note.

**Every card is declared, and only while it is for sale.** There is no opt-in
flag: a merchant who published a card is selling it, and a card off sale — its
own pause, its merchant's, or a merchant who left — answers no challenge at
all, so the catalog never carries a product nobody can buy.

**The declaration's shape follows the request's method**: a GET is declared as
the probe the crawlers and the catalog's validator make, a POST as the purchase
an agent makes. A resource declared only as a POST is invisible to the thing
that lists it — the failure the spike paid for once.

## Consequences

An agent that has never heard of us can find a product of ours in a catalog it
already walks; until now nothing in this repository did that. Our own tests
cannot say whether the facilitator accepts what we emit — they hold the
declaration to the library's schema and to a shape that was accepted once,
which is not acceptance; `pnpm smoke:listing` makes the live call and reports
a probe with no verdict as no verdict. The card schema is shared by the
publish and read paths on purpose, so a row stored before the description
ceiling stops being readable until the card is republished. We pay in what a
merchant may write: a name in Cyrillic, Greek or Arabic cannot be a listing
name, and the refusal happens here, where the merchant sees it, not in the
catalog, where it is silent. The challenge carries the declaration in one
header that grows with the card; the measurements live in the spike note.

Rejected: an opt-in flag on the card — it would make the default invisibility,
the state this change exists to leave. Reusing the merchant's display name as
the listing name — one channel's alphabet rule on every merchant's name.
