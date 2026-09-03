# 0023. The merchant proves their own integration, alone

Date: 2026-09-03
Status: accepted

## Context

A merchant who has published a card and started a worker has proved nothing
yet. Everything on their side can be right while the card is off sale, the price
question reaches nobody, or the goods do not match what the card declared. The
only proof is a purchase made the way a stranger's agent makes one: through the
public storefront, with a payment on it.

Until now that purchase was ours to start — the portal's quickstart says we run
it on the merchant's signal, with them watching. That makes the last step of an
integration a conversation with us, on a test site whose whole promise is that
an invitation code is the last thing a merchant needs from anybody.

## Decision

A merchant asks for a test purchase of their own card at
`POST /v0/cards/:item_id/test-purchase`, behind their own key, and this gateway
buys it with a buyer of its own. The walk goes out of the front door: every call
is a real HTTP request to `PUBLIC_BASE_URL` — the catalog, the purchase address,
the order's own status door — because an in-process short cut would produce the
same document while proving nothing about the addresses a stranger's agent uses.

What comes back is a transcript. Each step names the door, says whether it went
through, carries the whole address it called, and says what came of it in words,
taking the storefront's own sentence wherever the storefront refused. A walk
that did not get through is that same document with fewer steps in it and never
an error: "the price call was refused because the card is not on sale" is the
answer the merchant came for, and a 500 would throw it away. Beside the steps it
carries the order the walk opened and the goods exactly as the buyer received
them.

The money is ours, so the ceilings are ours. The route exists only where the
money is test money: a chain that makes this a live deployment (ADR-0020)
refuses every one of these, because a button anybody may press must not decide
when we spend real money. Where the facilitator settles against nothing the
buyer signs with a key made for that one walk and thrown away; anywhere else it
needs a wallet in `TEST_PURCHASE_BUYER_KEY`, and a gateway without one says so
at the door rather than failing at the payment. `TEST_PURCHASE_MAX_USD` (5.00)
is the most one purchase may pay, checked against the card before the walk and
against the challenge before anything is signed; `TEST_PURCHASE_PER_HOUR` (5) is
how many one merchant may walk in a moving hour, counted per merchant so one
merchant retrying cannot lock the rest of the site out. Both are chosen rather
than measured — nobody here has measured what a Base Sepolia faucet gives in a
day, and free test funds do not make a faucet infinite.

## Consequences

After an invitation code a merchant does everything themselves, and what they
end up holding is evidence about the public storefront rather than our word for
it. What it costs is a spending wallet in this gateway's configuration and a
rate ledger in its memory: the ledger dies with the process, which hands one
merchant its whole hour again after a restart and is cheaper than a table on
disk for a number nobody reconciles anything from.

The buyer is written inside the gateway rather than taken from `packages/slice`,
whose sandbox buyer walks the same exchange: the dependency could only go one
way, since the slice depends on the gateway. So one exchange is walked by two
pieces of code, each held to a real gateway over a real socket, and `viem` joins
the gateway's dependencies for the one thing the x402 packages do not carry — a
signer made from a private key.

Rejected: a merchant pointing their own buyer at us, which asks them for a
funded wallet before they have sold anything and proves the wrong half.
Running the walk against this process's own flows, which cannot fail on
anything a proxy or an ingress would break and is therefore evidence about the
wrong thing. And a separate code for each way this call is refused before it
starts: they are one family, a consumer shows the sentence, and the one of them
a caller gets past by waiting says so in the envelope's own `retryable`.

Revisited on the day a live gateway has to issue a test key, which is the
trigger ADR-0020 already names for the key prefix: a merchant proving an
integration against the live site would want this route there too, and what
changes then is where the money comes from rather than the ceiling on it.
