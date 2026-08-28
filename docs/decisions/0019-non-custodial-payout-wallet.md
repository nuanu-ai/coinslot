# 0019. The money goes straight to the merchant's own wallet

Date: 2026-08-28
Status: accepted

## Context

Until now every payment request this gateway wrote named one address:
`PAY_TO_ADDRESS`, out of the deployment's configuration. That was
survivable while the deployment had one merchant and the operator was
that merchant. It stopped being survivable the moment merchants became
rows somebody else registers into (ADR-0010, ADR-0014): every sale would
be paid into the operator's wallet, and paying each merchant what they
were owed would take a ledger, a reconciliation and a promise to hold
other people's money — none of which exists, and all of which would have
to.

x402 asks us to hold nothing. The buying agent signs an authorisation to
a `payTo` address and the facilitator settles it on the chain; nothing
passes through the gateway at any point. So the only question is whose
address goes in that field, and the answer decides whether this is a
payments business or a catalogue.

## Decision

Payments are non-custodial. The `payTo` of every payment request is the
address of the merchant who published the card, read at the moment the
request is written — so a merchant who moves their wallet moves every
card of theirs with it, with no republishing. There is no balance, no
settlement run, and no moment at which a merchant's money is ours.

The address is a nullable column on the merchant, set and read through
`/v0/payout-wallet`, held to `EvmAddressSchema` in the contracts: `0x`
and forty hexadecimal characters, accepted in lower case or in the exact
EIP-55 spelling a wallet shows, refused in between, stored lower case. A
mistyped address is not a malformed one — it is another perfectly good
address belonging to somebody else — so the checksum is the only warning
anybody gets, and it is read where the merchant can still be told.

A merchant with no address cannot publish: the publish call refuses with
`no_payout_wallet` beside `no_seller_name`, because a card with nowhere
for its money to go is a product offered for sale that cannot be bought
honestly. An address is changed, never taken away — a merchant without
one has published cards that answer an agent with nothing at all, and
the act somebody reaching for that wants is the pause.

The sandbox asks for none. It settles against nothing (ADR-0008), so the
configured `PAY_TO_ADDRESS` stands in as the placeholder a challenge has
to name. It stands in nowhere else: where the money is real, a merchant
with no address is refused rather than defaulted, because that address
is the operator's.

## Consequences

What this buys: the gateway never holds anyone's money, so it needs no
custody, no ledger and no payout run, and a merchant is paid the instant
a buyer's agent settles. What it costs: a merchant has one more thing to
set before they can sell, and the checksum needs a hash — Keccak-256,
written out in `packages/contracts/src/evm-address.ts` rather than
installed, because the published contracts tree is `zod` alone and a
package in it is its own decision (ADR-0003 §8). The trigger to replace
it with an audited library is the first other thing in that package that
needs a hash.

Rejected: one address per deployment, kept as it was — custody with
extra steps, and the reconciliation it implies is a product nobody has
decided to build. An address per card — a merchant with fifty products
is paid at one address, and fifty copies are forty-nine chances for one
to be somebody else's. Falling back to the configured address for a
merchant who has set none — the failure is silent, on a chain, and
irreversible. Refusing the sale rather than the publish — the merchant
finds out at the till, and the agent finds out instead of them.
