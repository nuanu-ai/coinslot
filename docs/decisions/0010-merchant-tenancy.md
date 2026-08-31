# 0010. Every merchant is a row, and a key names its merchant

Date: 2026-08-27
Status: accepted (Dmitry's word of 2026-08-27: the product is self-service)

## Context

Stage one narrowed the gateway to one merchant on purpose. The narrowing is
written in three places: the merchant is a constant in the store
(`THE_MERCHANT`), the key is one environment variable compared against every
request, and the routes that say "this merchant's cards" and "this merchant's
receipts" return the whole store — their own descriptions admit it. For a pilot
with one merchant that was the honest minimum.

Dmitry has now settled the product's shape: self-service. A merchant registers
with an email address, comes to the cabinet, creates a key, integrates against
the SDK themselves and starts selling. "We write the cards" means a generator
writes them from the merchant's own site, not that a person does.

Registration is the last step of that road, not the first. Registration
without tenancy means the second merchant to register sees the first one's
cards, orders and receipts — the money of a stranger, on the first screen. So
the order is fixed by the danger: tenancy, then keys a merchant can make and
disable, then registration with mail, then the generator.

## Decision

**A merchant is a row with an identity.** Every card, every order and every
receipt carries its merchant, not null, from the day of this change. The
selling switch is already per merchant; it stops being per installation by the
constant becoming a real identifier.

**A key is a row that names its merchant.** The secret is generated, shown
once, and stored as a SHA-256 digest; a request is resolved by looking its
digest up, which is constant-time by construction. A key carries a label, a
creation time and a disabled flag. Disabling one key is instant and touches no
other key and no session — which is the whole reason keys are rows: the single
environment variable could never be created, named, or revoked one at a time,
and self-service needs all three.

**Every merchant-key route scopes to the resolved merchant.** The card list,
the receipts, the orders, the pause switches, the worker poll and both answer
routes act on the caller's merchant and nothing else. A worker draws only its
own merchant's envelopes — the queue carries the merchant with each envelope,
and the poll filters. The wording the routes already use ("this merchant's")
becomes true instead of aspirational.

**The public buying surface does not change.** One catalog across all
merchants — that is the product. A purchase routes to the owning merchant's
worker by the card it was made against. No public schema gains a field — a
buyer has no more reason to see the merchant's identity than before, and giving
them one is a separate decision about merchant-facing branding that nobody has
taken. The first SDK release moves `CONTRACT_VERSION` to `"1"` for the release
boundary itself (ADR-0006), not because tenancy changed this surface.

**The sandbox still comes up selling from one command.** `docker compose up`
seeds one merchant and one key deterministically, the merchant process and the
cabinet get that key from the compose file exactly as they do today, and no
manual step appears. The seeded values are sandbox values in a file, like the
database password beside them, and for the same reason.

**The cabinet's accounts belong to a merchant.** Sign-in scopes every screen
to the account's merchant. The screens for making and disabling keys follow in
their own step — the model here is what makes them buildable.

## Consequences

- Registration becomes buildable without handing anyone a stranger's money.
  Mail — confirmation, password reset, the Resend account and the DNS records —
  is the next decision, not part of this one.
- The migration assigns everything already in a database to the seeded
  merchant, which is correct: everything in any database today is that one
  merchant's.
- The gateway's auth stops being a comparison and becomes a lookup, and the
  test that pins constant-time comparison of the single key retires with the
  variable it certified.
- Two of today's honest disclaimers die: the route descriptions that say
  "during the pilot there is one merchant", and the comment in the store that
  names the constant. Killing them is part of the change, not an afterthought.

## Alternatives rejected

**A database per merchant.** Real isolation, and nothing at this scale earns
its operational cost: migrations per tenant, connection pools per tenant, a
provisioning step where a row would do. The failure it prevents — a query that
forgets its filter — is the failure the store's tests exist to catch.

**Keys stay in the environment, one per merchant.** Every key change becomes a
deployment, nobody can revoke one key of several, and self-service dies at the
first step: a merchant cannot make a key for themselves by editing our
environment.

**Scoping in the cabinet only.** The cabinet is one caller of a public API;
scoping there leaves the API itself answering everything to anybody with any
key. The gateway is the boundary both sides trust, so the gateway is where the
scope lives.
