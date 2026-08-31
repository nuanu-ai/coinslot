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
the routes and is not derived from it.

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

4. **The path prefix and the contract version are separate on purpose** and
   neither is derived from the other. `/v0/` names the shape of the surface —
   which calls exist at which addresses; `CONTRACT_VERSION` names the
   vocabulary and documents flowing through it. A vocabulary can grow many
   times under one surface, and the day the surface itself changes shape is the
   day the prefix moves.

## Consequences

- Gained: an installed SDK either reads the whole vocabulary it was built for or
  stops before polling an order; generated schemas and TypeScript tell the same
  truth.
- Paid: even an additive informational result requires a contract-version move
  and coordinated gateway delivery. That cost starts with contract `"1"`.
