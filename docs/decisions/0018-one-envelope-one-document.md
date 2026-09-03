# 0018. One error envelope, one order document

Date: 2026-08-28
Status: accepted

## Context

The agent-facing surface had grown four shapes for saying "no" and four
shapes for describing an order, each the local invention of the route
that sent it. An agent integrating against the gateway had to learn all
of them, and the differences carried no meaning — they were sediment,
not signal. Two of the order shapes also leaked the merchant's private
naming to the buyer: `merchant_item_id`, `params`, `price_id` and the
raw receipt are the merchant's bookkeeping, not the buyer's business.

## Decision

Every error the gateway sends travels in one envelope:
`{ error: { code, message, retryable, ... } }`. On our side the
vocabulary of codes is closed — a refusal is built by one function that
takes a code from `ERROR_CODES`, and the compiler refuses a word that
is not in the dictionary. On the wire the code stays an open string, so
a reader parses an unfamiliar code as the failure it is and loses only
the meaning, never the message.

`retryable` answers one question — could this same call succeed if it
were made again — and it is required, because both readings of a
missing flag are expensive and a caller left to guess turns one of them
into a retry loop and the other into an abandoned call. It is a fact
about the refusal and not an instruction: how long to wait and whether
to bother stay with the caller, who knows what the call was worth. The
gateway assigns it per code, in a table the compiler forces every code
to appear in, and the rule is conservative — true only where repeating
the call is itself the way through, false for everything settled and
everything merely arguable. Two refusals carry what the payment layer
said about one payment instead, because a table cannot know it. This
closes the gap the SDK had been papering over: it was claiming every
refusal retryable, having no way to tell a defect from a locked door.

A purchase answers with the same order document the status route
serves. What an agent learns once — what it bought, the price it was
charged, whether the money behind it was real, and how the order can
end — is the whole of what any route tells it. The fields that named
the merchant's private world are gone from that document.

## Consequences

What this buys: one error-handling branch and one success shape in a
stranger's integration, and nothing in an agent's view to leak. What it
costs: adding an error code now means adding it to the dictionary
first, and any route that wants to say something new about an order
must say it in the shared document or not at all. Both are wire
contracts — withdrawing either after the first external consumer is a
breaking change, which is why this is a decision and not a note.

Rejected: per-route error shapes, documented well — documentation does
not shrink a surface, and every route stays a new lesson. Closing the
code vocabulary on the wire too — an error nobody anticipated must
reach the reader in its own words rather than be flattened into the
nearest known code, and the version handshake (0006-wire-version.md) is
not yet the place to catch a new word. A purchase response of its own
beside the status document — two shapes for one fact drift apart, and
the agent that bought and the agent that polls would each believe a
different account of the same order.
