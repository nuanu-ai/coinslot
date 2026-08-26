# Coinslot — working discipline

## Stage
Stage 0 of the pilot plan (`docs/research/21-pilot-plan.md`): the monorepo
scaffold, contracts as code, the state machine with tests. Product code is
being written, so the "Code" section is in force. Decisions taken: exposure
ADR-0001, integration model ADR-0002, stack ADR-0003.

## Hierarchy of instructions
Conflicts are resolved in this order: a decision in `docs/decisions/` →
Dmitry's live word → this file → general considerations. The live word
outranks the written one, but a conflict with a written decision is entered
the same day as an edit to the decision itself — decisions do not drift
silently.

## Skepticism
Doubt is voiced before implementation; "great idea, on it" in answer to a
questionable requirement is professional unfitness. A decision went against
you — implement it in good faith and record the disagreement as a line in the
report. "Everything works" without the output of the checks is not done. If
you do not know, write "I don't know": that is cheaper than a confident
mistake.

## The fifth gate: claims beyond evidence
A card, a receipt, an order status and the text of an error are claims on
which someone else's agent moves someone else's money. Every artifact that
goes outside gets four questions: what has been truncated and is that said;
what has been guessed and is it marked; what this turns into at ten times the
data; how "I don't know" sounds and whether it is distinguishable from "I know
that there is none".

## Git
- Main branch: `main`. Small steps go straight into it; experiments go into
  `spike/<topic>` branches, the branch is deleted once the conclusions are in,
  and the conclusions move into an ADR or into research.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`,
  `spike:`), small and atomic, with the message written in English. We commit
  when a step is finished, not "at the end of the day".
- History is bisect-friendly: one commit — one reason to roll back; every
  commit leaves the repository in a valid state (docs read, builds build). The
  single declared exception is the red `test(...)` commit of a red→green pair,
  from the code stage onward.
- Remote: `github.com/nuanu-ai/coinslot` (private). We push when we commit.
- Never commit: secrets, `.env`, `.claude/settings.local.json`.

## Decisions
- Every significant decision (stack, architecture, tooling) is a separate ADR
  in `docs/decisions/` (format `NNNN-slug.md`).
- Until a decision is written down in an ADR, it has not been taken.
- Until the first product code, decisions are living documents: on Dmitry's
  word the edit goes straight into the file, the history lives in git, and
  there are no "decisions on top of decisions". A cancelled decision is
  deleted; its "why not" moves into the rejected alternatives of its successor
  or into research.
- The trigger for going back to append-only/supersede is named in advance: the
  first product code, a second permanent participant, or the first case of
  "but we decided otherwise" confusion caused by an edit made after the fact.

## Documents

- Engineering artifacts are written in English: code, comments, commit
  messages, engineering documents such as this charter and the README.
  Research and product documents are written in the language of their
  audience, and the research notes and ADRs already written in Russian stay as
  they are — they are the historical record, not a translation backlog. The
  language of the portal is an open question, and Dmitry decides it.
- Product and architecture documents are written clean and self-contained:
  present tense, no version comparisons in the body (the history is in git),
  no internal jargon and no cryptic shorthand. A term may be used only if it
  is defined in that same document.
- Market numbers, reviews and their verdicts live in research notes. A product
  document carries at most one sentence of motivation with a link.
- Examples are real or anonymized, nothing else. Invented characters and
  scenarios that do not survive a check against a real merchant catalog are
  forbidden.
- Do not mix audiences: text for the merchant, text for the agent and a
  technical specification are separate documents or explicitly separated
  parts.
- We do not estimate other people's effort ("that's half a day of work") — the
  estimating is done by the reader's engineer.
- We do not compress text: volume is not a metric. Coherent paragraphs that
  explain the reasons, sentences of varying length; lists only for genuine
  enumerations. Staccato fragments, a bold label in every bullet and
  aphoristic triples read as AI generation — do not write that way.
- The quality test: the document is read by a person who took no part in the
  sessions, without a glossary and without git archaeology.

## Code
- TDD red→green. The hand-over ritual: a mutation self-check, a negative
  control, a run outside the fixtures, an adversarial review by a separate
  agent (three rounds at most; repeats of one class are a signal of a missing
  abstraction). A micro-edit of up to ~50 lines that touches neither contracts
  nor schemas goes without ceremony; the scope of the check is named by
  whoever set the task.
- Tests: `pnpm test` is free, deterministic and works without the network.
  Everything that touches the chain, the facilitator or a merchant's live API
  goes only into a separate smoke command with a spending cap.
- A useful test answers the question: "if this test failed, which promise to a
  consumer is broken?" A test with no answer to that question is theater and
  is deleted.
- Anti-theater: a test checks behavior, not implementation; a mock inside an
  assert is a defect (we do not test mocks); negative cases are mandatory —
  every required field of a schema has a test for its absence with an
  intelligible error; the mutation self-check confirms that the tests die
  together with the behavior, distinguishing "mutation killed", "survived" and
  "did not apply".
- Examples from the documentation are test fixtures: the portal's JSON
  examples (a card, a hook response) must pass the contracts schemas, and the
  portal's tables ("time ran out", "how an order can end") must be test cases
  of the state machine. Documentation and code cannot drift apart silently.
- A rule is moved into a machine (a hook, CI) after it has slipped past
  people; until then it is text. The lessons are written in the header of the
  file that grew out of them.

## Research
- Working materials live in `docs/research/`. These are drafts, they may be
  rewritten.
- Open questions are kept in `docs/research/00-open-questions.md` and struck
  out as the answers arrive.
- Experiments are pre-registered: the predictions and the decision rule are
  fixed before the start and executed literally.
