# 0022. One envelope for every answer, and two words for what went wrong

Date: 2026-09-01
Status: accepted

## Context

The merchant-facing surface had four names for "what went wrong" and two ways
of shaping an answer. Publishing answered `{ok: {id}} | {errors: [...]}`, where
success was a key that had to be present rather than a value that had to be
true. The order calls answered `{ok: true, result} | {ok: false, error}`, where
`ok` was a literal boolean. The local card check called the same findings
`problems`, and anything thrown was a bare `Error` carrying a sentence and no
code at all. A merchant learned the same lesson three times and got a different
word each time.

The asymmetry was defended as meaning something — a card can be wrong in
several places, a call fails for one reason — but that distinction is about
findings and failures rather than about envelopes, and the envelope was
carrying it. Two traps came with that. `{"ok": {}}` is falsy in Python and in
PHP, so the one idiom an engineer outside TypeScript would write says yes to a
delivery and no to an acceptance; and a key that may or may not be present
exports as no discriminator at all, leaving a generated client to work out
which branch it is holding.

## Decision

Every merchant-facing call answers in one envelope. `ok` is `true` or `false`
and nothing else says which; a success carries its own fields beside it — the
catalog id sits at the top level of a successful publish — and a failure
carries one `error`. As a literal, `ok` crosses into the JSON Schema export as
a `const` on each branch, which a generator can switch on.

Two words carry what went wrong, and they are not two names for one thing.
`error` is why the call did not go through: one object, always, with an open
`code`, a `message` a person can act on, and `retryable`. `problems` is the
list of findings about what was sent, it lives inside `error`, and it is never
empty on the wire — a publish requires it, a delivery that does not match its
card carries it, and the SDK's local `checkCard` answers in the same shape. The
word `errors` is gone. A refused publish is `card_rejected` and is never
retryable: the same card gets the same answer, and what changes the outcome is
fixing what the findings name.

What throws shares the vocabulary. `CoinslotError` carries `code`, `route` and
`retryable` — the gateway's own code and its own answer about calling again
where the gateway refused in words we recognise, and otherwise the same three
codes the order calls return, with `retryable` true because nothing was learned
about the call. A client built wrong stays a `TypeError`.

`CONTRACT_VERSION` moves from `1` to `2`: a strict reader built against `1`
cannot parse the new publish answer, and must stop at the handshake rather than
report a published card as an answer it could not read (0006-wire-version.md).

## Consequences

What this buys: one shape to learn, one word for findings, and a discriminator
that behaves the same in every language a merchant writes in. What it costs: a
wire break paid for by a version move, and every consumer of the publish answer
rewritten in the same change.

Rejected: discrimination by key presence, which is what publishing did — it
exports no `const` for a generator to use and hands the falsy-`{}` trap to the
readers the export exists for. Per-call idioms documented well —
0018-one-envelope-one-document.md already refused that on the agent surface,
and documentation does not shrink a surface. Throwing domain refusals in the
Stripe manner — the failure branch of a money call must be unskippable in the
types, and retrying on `retryable` is ordinary control flow rather than an
exception; what is thrown here is only what the contract gives no branch to.
