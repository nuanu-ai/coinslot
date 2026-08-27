# 0008. A gateway that can answer about money without a chain

Date: 2026-08-27
Status: accepted (autonomous mandate of 2026-08-26; revisited on Dmitry's word)

## Context

The whole surface now comes up from `docker compose up` — the landing, the
documentation, the cabinet and the gateway on one origin, with Postgres behind
them (ADR-0005). What it cannot do is sell anything, and the reason is one
line: `apps/gateway/src/main.ts` builds its facilitator from
`HTTPFacilitatorClient` unconditionally, so every purchase needs the network, a
funded testnet wallet and a faucet before it can move at all.

That is the wrong shape for the two things the local stack exists for. A
merchant's engineer opening this repository should reach a completed purchase
without holding a wallet; and the surfaces are empty until something sells —
the cabinet's cards, orders and receipts have nothing to show, so the screens
that are the point of the exercise cannot be looked at.

`ScriptedFacilitator` already answers exactly these questions offline. It is
not test scaffolding: it lives in `apps/gateway/src/adapters/memory/` beside
the in-memory store and the in-memory queue, and is exported from the package
index. The store and the queue are already chosen by wiring — this is the third
port, and the only one with no choice.

## Decision

The facilitator is selected by configuration, like the other two ports.
`FACILITATOR_URL` takes one distinguished value, `sandbox:scripted`, which
selects the scripted adapter; every other value is a real facilitator's address
and behaves as it does today.

The selection is a value of the existing field rather than a flag beside it,
and that is the whole of the safety argument. A configuration that names a real
facilitator cannot also be in sandbox mode: there is one field, it holds one
value, and a deployment that sets an address gets an address. There is no
variable that can be left set from yesterday, no default that means "pretend",
and nothing to forget to unset. The field is already validated, so a typo is a
refusal at startup rather than a surprise at the first payment.

Two things say so out loud. The gateway prints one line at startup naming the
sandbox, and it refuses to start in sandbox when `PAY_TO_ADDRESS` is set —
an address to receive money is the mark of a configuration that means to move
some, and a sandbox that quietly ignores it would be a gateway that looks paid
and is not.

## Consequences

The local stack completes a purchase with no network, no wallet and no faucet,
which is what makes the cabinet worth opening.

Every order the pilot writes is already marked `test` — stage one sets it on
all of them — so the receipts a sandbox writes carry the same mark the wire
already has for them, and the cabinet showing that mark is the same work it
owes anyway. Nothing about the sandbox introduces an unmarked test payment.

What this does not do is make the sandbox safe to point at a real chain. It
makes the two impossible to hold at once, which is a different and smaller
promise. A gateway in sandbox on a machine an agent can reach will take
payments that never happened; the protection against that is that nobody
deploys it, not that it refuses to run.

The number the sandbox cannot produce is a settlement identifier from a chain.
What it hands back is its own, and a receipt from a sandbox therefore points at
nothing an explorer can show. That is correct — there is nothing to point at —
but it means a receipt is not evidence on its own, and whoever reads one has to
know which gateway wrote it.

## Alternatives rejected

**Leave it as it is and run the demonstration against the public testnet
facilitator.** Honest and needs no code, but it costs the network, a funded
wallet and a faucet, and "one command" stops being true. The first person to
try it on a plane finds out.

**A boolean beside the address — `PAYMENT_SANDBOX=1`.** The same behaviour and
a worse shape: two fields that can disagree, one of which can survive a copied
`.env` into a place that means to move money. A single field cannot disagree
with itself.

**A separate entry point — `main.sandbox.ts`.** No configuration to get wrong,
but two wirings to keep in step, and the one that is not run in earnest is the
one that rots. The port already exists to avoid exactly this.
