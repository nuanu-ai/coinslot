# 0017. A card may be written short, and opens out at the door

## Context

Publishing a card is the first thing a merchant does, and the first
example they see is the measure of the whole integration. The full card
spelled out every default and every field spec, so the smallest honest
example ran twenty-five lines — most of them saying things the merchant
had no opinion about, such as that a field is a string or that delivery
is synchronous. The product frame is fixed: the contract a stranger's
engineer sees must be small and obvious, with the complexity under the
hood.

## Decision

The publish door accepts three short forms, and the card schema itself
opens each out before validation, so nothing downstream ever sees them:

- `fulfillment` may be omitted; a card without it is synchronous.
- A declared field may be the type word alone: `'string'` means
  `{ type: 'string' }`.
- A price may be one string: `'5.00 USD'` means the amount and the
  currency as the two stored fields.

What is stored and what an agent reads never change shape — the short
form exists only in what a merchant may write. A finding about a
short-written field points at what the merchant wrote, not at the opened
form. The smallest card that sells is now eight lines, and the landing,
the quickstart and the examples show that card; the long form remains
valid and documented for cards that need it.

This widens the wire contract of the publish call: once an external
merchant writes the short form, withdrawing it is a breaking change.
That is the reason this is a decision and not a note.

## Rejected alternatives

- **A second, "simple" publish surface.** Two ways in is two contracts
  to learn and to keep honest; the charter prices every added surface as
  a cost. One door that accepts both spellings adds no surface — the
  short form is a subset of what the reader already understands.
- **Expanding the short form in the SDK only.** The door itself must
  accept what the documentation shows, or a merchant on curl meets a
  different contract than a merchant on the SDK, and the examples stop
  being fixtures of the real thing.
- **Documentation sugar over an unchanged wire.** Showing a short
  example the gateway would refuse is the drift the fixtures exist to
  prevent; the examples are tests, so what the page shows must be what
  the door takes.
