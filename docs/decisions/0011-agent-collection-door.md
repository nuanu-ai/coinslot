# 0011. The order identifier is the agent's proof, for now

Date: 2026-08-27
Status: accepted (autonomous mandate; the trigger below is when it is revisited)

## Context

An agent that buys an asynchronous product pays, and the answer it gets carries
an order and no goods — the goods do not exist yet. Nothing then lets it come
back for them. `get_order_status` is written in the contract, at
`GET /v0/orders/:order_id/status`, and its `auth` is `"undecided"`: the route's
own description says nothing in this contract or in any decision says how an
agent proves an order is theirs, so the route is not in the list a gateway may
serve. It is not mounted.

So the asynchronous half of the catalogue takes money and strands the buyer.
For the pilot merchant that is one of two products — the eSIM — and its goods
travel out of band, by the address given at purchase. An agent that is not a
mailbox has no way to learn that anything arrived.

Every other door in this system is a merchant's, and merchants have keys. An
agent has no account, no key and no registration, and inventing one for the
pilot would be a larger decision than this one — it would make buying require
signing up, which is the opposite of what the product is for.

## Decision

**Knowing the order identifier is the proof.** The route is mounted, its `auth`
becomes `"order_id"`, and whoever presents an identifier is answered about that
order and no other.

The identifier already has the properties this leans on. It is generated from a
random source, it is long enough not to be guessed, and it is never published —
it is not in the catalogue and not in any listing an agent can read.

It is not, however, held by one party alone, and an earlier draft of this
decision said it was. It travels in the payment challenge, down the merchant's
own stream and into their receipts, so a merchant holds every identifier of
every buyer they sold to. That does not weaken the door: the merchant already
holds the whole of those orders, because they are their own sales, and this
route shows a buyer strictly less than the merchant's routes already show
them. What it does mean is that the identifier is a key to one order among the
parties to that order's sale, and not a secret between us and the buyer. The
gateway does not lean on it for anything else — ownership of a payment is
decided by the verified payer, never by who knows an identifier.

The answer is deliberately smaller than the merchant's view of the same order.
It carries what the buyer is owed and what became of their money: the state,
the price, and the goods once the order has closed as delivered. Once the order
has closed, and not merely once the merchant has handed something over: a
synchronous delivery whose charge then failed would otherwise be a way to take
the goods and pay nothing, and the two doors would disagree about one order.

It does not carry the merchant's own identifier for the product, the merchant's
notes, or anything about other orders.

An identifier that names no order is answered exactly as one that names
somebody else's would be, so the route does not tell the two apart for anybody
probing it.

## Consequences

The asynchronous purchase stops being a dead end, which is what makes half the
pilot catalogue sellable at all.

The weakness is stated rather than hidden: anyone who obtains an order
identifier can read that order. The places it can leak are the ordinary ones —
a log, a proxy, an agent's own storage — and they are the same places a bearer
token leaks from. For a pilot whose orders are all marked as tests and whose
money is testnet money, that is a proportionate trade. It stops being
proportionate the moment real money moves.

**The trigger to revisit is the first real payment.** Before mainnet, this door
is either narrowed — the natural next form is proving control of the paying
address, which the gateway already knows from the verified payment — or it is
accepted again, deliberately, with that reasoning written down. It must not
simply survive by not being looked at.

## Alternatives rejected

**Leave it unmounted.** Honest, and it is what today does. But it means the
gateway takes money for a product it has no way to hand over, and the contract
already calls that out. Not shipping the route does not make the problem
smaller; it moves it onto the buyer.

**Make the agent prove control of the paying address.** The right long-term
answer, and the one the trigger above points at. It needs a challenge to sign
and a verification path, which is real machinery for a walking skeleton, and it
would be built on guesses about how agent wallets sign outside a payment.

**Give agents accounts and keys.** Turns buying into signing up. The product
exists so that an agent with a budget can buy without a relationship first.
