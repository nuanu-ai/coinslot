# @nuanu-ai/coinslot

## 0.2.2

### Patch Changes

- 38257b3: Carry a merchant's refusal to the agent. The status document an agent reads
  back for its own purchase grows an optional `refusal`, holding the two words
  the merchant's handler actually answered with — the short code it branches on
  and the sentence it can show a person — in the same shape the handler sends
  them in. It is present wherever a merchant's refusal is what closed the order,
  whichever word the order ended under, and absent everywhere else: an ending
  nobody worded arrives with no pair rather than with an invented one.
  
  `CONTRACT_VERSION` does not move. It is the handshake between a merchant's
  installed SDK and the gateway, and no SDK reads this document — it travels only
  on the agent's storefront, which carries no version by ADR-0006 §5. Nothing in
  the SDK's own surface changes; its bump is the dependency's.
- 3d815e9: License both public packages under Apache-2.0 and include the Nuanu AI
  attribution notice in their npm archives.
- Updated dependencies [38257b3]
- Updated dependencies [3d815e9]
  - @nuanu-ai/coinslot-contracts@0.3.0

## 0.2.1

### Patch Changes

- The package pages on npm say what the packages are. Nothing in the code
  changes: the README of each package is rewritten for somebody meeting Coinslot
  on the registry — what the merchant SDK sells and the two addresses it can be
  pointed at, and why the contracts package exists and who installs it directly —
  and both manifests gain a description written for the same reader, keywords,
  and a link to the documentation.
- Updated dependencies
  - @nuanu-ai/coinslot-contracts@0.2.1

## 0.2.0

### Minor Changes

- 040ca4e: One answer envelope for every merchant-facing call, and one word for findings.
  This changes the wire, and code written against the previous release has to be
  updated.
  
  `catalog.publish` now answers `{ ok: true, id }` or `{ ok: false, error }`,
  where `ok` is a boolean like it already was on the order calls and the catalog
  identifier sits beside it rather than nested. A refused card comes back under
  the code `card_rejected`, never retryable, with every finding in
  `error.problems` — the same list `checkCard` has always returned. Read it as
  `if (!published.ok) console.error(published.error.problems)`; `'errors' in
  published` and `published.errors` are gone.
  
  An error may now carry `problems` on any call, which is how a delivery that
  does not match its card names the fields that did not fit.
  
  Renamed: the type `PublishError` is `Problem`, and `OrderCallError` is
  `CallError` — it is no longer only the order calls' error. `CARD_REJECTED` is
  exported for the code above.
  
  A call with no failure branch of its own — publishing, `orders.get`,
  `orders.list` — now throws `CoinslotError` with `code`, `route` and `retryable`
  instead of a bare `Error`, under the same codes the order calls return. A client
  built wrong is still a `TypeError`.
  
  Every refusal the gateway sends now carries `retryable` beside its code and its
  sentence, answering whether making the same call again could succeed. It is
  assigned conservatively — true only where repeating the call is itself the way
  through — and it is what the SDK reports for a call the gateway refused in
  words, in place of the blanket `true` it used to claim.
  
  The verify command's internals (`runVerify`, `VERIFY_EXIT`, `NOT_JSON`,
  `IDEMPOTENCY_IS_NOT_BUILDABLE`, `Say`) are no longer exported. Run the command
  as `npx coinslot verify`; `checkCard` is what integration code calls.
  
  `CONTRACT_VERSION` is `"2"`. A worker on the previous version stops at its
  handshake against a gateway speaking this one, which is what that handshake is
  for.

### Patch Changes

- Updated dependencies [040ca4e]
  - @nuanu-ai/coinslot-contracts@0.2.0

## 0.1.0

### Minor Changes

- Publish the first installable merchant SDK and its contract schemas.

### Patch Changes

- Updated dependencies
  - @nuanu-ai/coinslot-contracts@0.1.0
