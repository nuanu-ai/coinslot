# 0019. The money goes straight to the merchant's own wallet

Date: 2026-08-28
Status: accepted

## Context

Until now every payment request this gateway wrote named one address:
`PAY_TO_ADDRESS`, out of the deployment's configuration. That was
survivable while the operator was the only merchant. It stopped being
survivable the moment merchants became rows somebody else registers into
(ADR-0010, ADR-0014): every sale would be paid into the operator's
wallet, and paying each merchant what they were owed would take a ledger,
a reconciliation and a promise to hold other people's money — none of
which exists, and all of which would have to.

x402 asks us to hold nothing. The buying agent signs an authorisation to
a `payTo` address and the facilitator settles it on the chain, and
nothing passes through us. So the only question is whose address goes in
that field, and the answer decides whether this is a payments business
or a catalogue.

## Decision

Payments are non-custodial. The `payTo` of every payment request is the
address of the merchant who published the card, read at the moment the
request is written — so a merchant who moves their wallet moves every
card of theirs with it, with no republishing. A payment already verified
is settled to the address it was verified against: a wallet moved
mid-sale governs the merchant's next sale, never the one whose payer has
already signed. There is no balance, no settlement run, and no moment at
which a merchant's money is ours.

The address is a nullable column on the merchant, set and read through
`/v0/payout-wallet`, held to `EvmAddressSchema` in the contracts: `0x`
and forty hexadecimal characters, accepted in lower case or in the exact
EIP-55 spelling a wallet shows, refused in between. A mistyped address is
not a malformed one — it is another perfectly good address belonging to
somebody else — so the checksum is the only warning anybody gets, and it
is read where the merchant can still be told.

Two spellings at the door, one behind it (ADR-0017), and the canon is
the wallet's: what is stored, answered with and put in a payment request
is the checksummed form, written by `checksummedAddressOf`. The reason is
the person rather than the storage. A merchant pastes forty characters
out of their wallet and later reads them back on a settings screen;
handed the same address in lower case they cannot tell it from a
different address without going character by character, and nobody does
that. On the one field money is sent to, that glance is the whole of the
checking anybody performs.

A merchant with no address cannot publish: the publish call refuses with
`no_payout_wallet` beside `no_seller_name`, because a card with nowhere
for its money to go is a product offered for sale that cannot be bought
honestly. An address is changed, never taken away — taking it
away would put every published card off sale under the name of editing
a setting, and the act somebody reaching for that wants is the pause.

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
finds out at the till, and the agent finds out instead of them. Lower
case as the canon — cheaper to compute and impossible to check by eye,
which trades the one safeguard a person has for nothing. Storing what
was sent and normalizing on read — every reader becomes a parser, and
the one that misses serves the second spelling (ADR-0017).
