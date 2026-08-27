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

`CONTRACT_VERSION` is `"0"` and has never moved. The `/v0/` path prefix is
written literally into the routes and is not derived from it, so the two would
begin to contradict each other the first time one moved without the other.

## Decision

1. **`"0"` means unreleased.** While the contract version is `"0"`, no
   compatibility is promised to anybody, because nobody is running a published
   SDK: nothing is on a registry, and the only clients are in this repository
   and move with it. A wire-visible change during this period does not move the
   version, and the reason is stated here rather than left as an omission.

2. **The clock starts at the first published SDK.** That is the named trigger.
   From the moment a merchant can install a version of this SDK that we do not
   control, a change a strict reader cannot read — a new value in a response
   enum, a new required field, a renamed or removed one — requires the version
   to move, and moving it stops an old worker at startup with a clear message
   instead of letting it misreport its own successes.

3. **Before that first publish, the SDK's reading policy must be decided and
   written down.** Strictness is right for the parts of an answer a client acts
   on, and wrong for the parts that only inform: a result word riding alongside
   `ok: true` tells the merchant what happened, while `ok` is what their code
   branches on, and a client that refuses the whole answer over the former has
   turned a success into a failure. Whether the SDK becomes tolerant of unknown
   informational values, or the version simply moves for every such change, is
   an open question — it is listed in `docs/research/00-open-questions.md` and
   belongs to the same step as the publishing pipeline (ADR-0003 §8).

4. **The path prefix and the contract version are separate on purpose** and
   neither is derived from the other. `/v0/` names the shape of the surface —
   which calls exist at which addresses; `CONTRACT_VERSION` names the
   vocabulary and documents flowing through it. A vocabulary can grow many
   times under one surface, and the day the surface itself changes shape is the
   day the prefix moves.

## Consequences

- Gained: additive wire work during the pilot costs nothing, and the day it
  starts costing something is named in advance rather than discovered by a
  merchant whose worker stopped.
- Paid: between now and the first publish, a client built against an older
  checkout of this repository will misread a newer gateway. That is acceptable
  only because every such client is ours and moves with the repository — and it
  stops being acceptable at exactly the trigger above.
