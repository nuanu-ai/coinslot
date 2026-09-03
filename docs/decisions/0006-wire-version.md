# 0006. What the contract version promises, and when it moves

Date: 2026-08-27
Status: accepted (autonomous mandate of 2026-08-26; revisited on Dmitry's word)

## Context

Adding `accepted` to the wire vocabulary raised a question nobody had
answered. The SDK parses every gateway answer strictly against its own copy of
the route table's schema, and `speaksContract` demands the gateway's
`CONTRACT_VERSION` match its own exactly, on every poll. So a merchant running
an older SDK against a newer gateway does not read a word it does not know as
"a word I do not know" — it reads the whole document as unreadable and reports
a failure to the merchant. That is worse than the misleading report this change
set out to remove.

The first registry release makes that hypothetical old client real. It carries
contract version `"1"`; the `/v0/` path prefix remains written literally into
the merchant's routes and is not derived from it.

## Decision

1. **`"0"` means unreleased.** While the contract version is `"0"`, no
   compatibility is promised to anybody, because nobody is running a published
   SDK: nothing is on a registry, and the only clients are in this repository
   and move with it. A wire-visible change during this period does not move the
   version, and the reason is stated here rather than left as an omission.

2. **The first published SDK speaks contract `"1"`.** From the moment a merchant
   can install a version of this SDK that we do not control, a change a strict
   reader cannot read — a new value in a response enum, a new required field, a
   renamed or removed one — requires the version to move. Moving it stops an old
   worker at startup with a clear message instead of letting it misreport its own
   successes.

3. **The published SDK remains strict.** A result word riding alongside
   `ok: true` informs rather than directs, but it is still part of the generated
   schema and the typed result a merchant records. Every new value moves the
   contract version before the gateway sends it. The existing handshake then
   refuses the whole newer vocabulary at worker startup, where no order is in
   flight. Reading an unknown word as an open `string` was rejected: it would
   make one part of an otherwise closed generated contract silently open and
   move the compatibility rule from the version boundary into every consumer.

4. **`/v0/` names the merchant's API and nothing else.** It is versioned for
   the reason a classic API is: an engineer writes a shop's code against those
   addresses, and the number is what lets that code keep working while the
   shapes underneath it change. The prefix and `CONTRACT_VERSION` are still
   separate and neither is derived from the other — the prefix names which
   calls exist at which addresses, the version names the vocabulary and
   documents flowing through them, and a vocabulary can grow many times under
   one surface. The day that surface changes shape is the day its prefix moves.

5. **The storefront carries no version, and its stability is the point.** The
   catalog an agent browses, the address it buys at and the door it comes back
   to for its own order live at `/x402/…` with nothing in them to move. They are
   not a client library anybody pins; they are a product identity. A discovery
   catalog keys a listing on the address it was given, and a stranger's agent
   builds that address from a base and an identifier it read elsewhere, so the
   address has to outlive every dialect we speak. Protocol evolution rides in
   band instead, in the `x402Version` field the challenge already carries, which
   is where a client that needs to know reads it. The paid storefront genre is
   versionless in practice as well as in principle, and the walk of the live
   discovery catalog that establishes it is dated and recorded in
   `docs/research/04-spike-bazaar-listing.md`.

   Rejected: a version segment on the storefront, on the argument that an
   incompatibly changed wire *is* a different resource to an agent and should
   therefore be a different address. It is a promise made to catalogs we do not
   run. Every move retires a listed resource and introduces another — the old
   entry stops answering `402` and is eventually removed, the new one earns its
   own bootstrap settle and starts its ranking from zero — and paying that to
   announce something the challenge could have said in a field buys nothing.

## Consequences

- Gained: an installed SDK either reads the whole vocabulary it was built for or
  stops before polling an order; generated schemas and TypeScript tell the same
  truth.
- Gained: a product's listed address survives our protocol changes, so a listing
  is earned once rather than re-earned on our schedule.
- Paid: even an additive informational result requires a contract-version move
  and coordinated gateway delivery. That cost starts with contract `"1"`.
- Paid: an address that never moves is one we can never retire. A breaking
  change to the purchase has to be carried at that address or announced in
  band, and there is no path segment to fall back on.
- Paid once, by the move itself: anything listed under the old `/v0/items/…`
  address is a listing to re-earn. Whether any external catalog holds such an
  entry today is not known here; `pnpm smoke:listing` is what asks.
