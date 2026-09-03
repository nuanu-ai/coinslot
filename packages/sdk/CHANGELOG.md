# @nuanu-ai/coinslot

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
