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
sandbox and saying that no payment it accepts is real, and it refuses to start
when a facilitator's own credentials — `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` —
are set beside the sandbox address. Those credentials exist only to talk to a
real facilitator, so beside an address that settles against nothing they are
somebody's leftovers rather than a choice, and the mistake they mark is a
production environment file copied onto a sandbox.

The same door stands the other way round. A deployment whose `FACILITATOR_URL`
names Coinbase's facilitator — the one the pilot settles through, because a
product reaches the Bazaar catalog only after a payment settles through it
(ADR-0001) — refuses to start without both credentials and says which is
missing, because that facilitator answers nothing unsigned and the gateway
would otherwise come up healthy and fail at the first charge in front of a
buyer. It is recognised by its host and not by one exact address: the same
endpoint is reached on a staging host and with a trailing slash, and every
spelling of it needs credentials.

That address, and never whether credentials happen to be set, is also what
decides who receives them. A bearer token is a key good for the account it was
issued to, so credentials go to Coinbase or they go nowhere; a facilitator that
takes none is sent nothing, whatever an environment file was left holding.

`PAY_TO_ADDRESS` is deliberately not one of those doors, though the first draft
of this decision made it one. The payment challenge cannot be built without an
address (`apps/gateway/src/http/x402.ts` refuses rather than inventing one), so
a sandbox that rejected it could not sell anything, which is the whole reason
the sandbox exists. Since ADR-0019 that address is the sandbox's alone: a
payment request names the wallet of the merchant who published the card, and
the configured address stands in only where a merchant has set none — which is
allowed here, where nothing settles, and refused everywhere else.

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

The address in a challenge issued by a sandbox receives nothing, ever. It has
to be there for the challenge to have a shape at all, and it is the one field
on that document a reader is most likely to misread — a real address, in a real
challenge, that no transfer will ever reach.

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

**Refuse `PAY_TO_ADDRESS` in the sandbox.** This is what this decision said
first, and it was wrong for a reason worth leaving here: the edge refuses to
build a challenge without an address, so the door would have shut the sandbox
rather than guarded it. The check that replaced it names the mistake it is
actually for.

**A boolean beside the address — `PAYMENT_SANDBOX=1`.** The same behaviour and
a worse shape: two fields that can disagree, one of which can survive a copied
`.env` into a place that means to move money. A single field cannot disagree
with itself.

**A separate entry point — `main.sandbox.ts`.** No configuration to get wrong,
but two wirings to keep in step, and the one that is not run in earnest is the
one that rots. The port already exists to avoid exactly this.
