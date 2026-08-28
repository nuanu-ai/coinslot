# Architecture Decision Records

One decision — one file, `NNNN-slug.md`. An ADR records a decision that is
expensive to reverse: a dependency in a published package's tree, a schema on
disk, a wire contract, a security boundary. Everything else — screens, flows,
internal mechanics — is a design note in `docs/research/`.

The ceiling is about sixty lines. Enough to reconstruct the reasoning, not to
exhaust the subject; measurements and their status live in research, linked.
Decisions are living documents until the first external merchant or a second
permanent participant: an accepted change is an edit to the file itself, and
the history lives in git.

Template:

```markdown
# NNNN. The decision, named as a sentence

Date: YYYY-MM-DD
Status: accepted | superseded by NNNN

## Context
Why the question arose, and the constraint that decides it.

## Decision
What is decided, in a couple of paragraphs.

## Consequences
What this buys and what it costs. Alternatives rejected, and why.
```
