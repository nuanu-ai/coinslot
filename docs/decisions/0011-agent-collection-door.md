# 0011. The order identifier is the agent's proof, for now

Date: 2026-08-27
Status: accepted for the controlled test and live launch; revisit before the first external buyer

## Context

An agent that buys an asynchronous product receives an order before the goods
exist. It needs `GET /x402/orders/:order_id/status` to return later, but the
contract originally left authentication undecided and the gateway did not
mount the route. The pilot eSIM therefore had no usable delivery path for an
agent that is not an email inbox.

Merchants have accounts and keys. Buyers deliberately do not: making an agent
register before buying would undo the product's no-prior-relationship model.

## Decision

**Knowing the order identifier is the proof in both environments.** Whoever
presents the long random identifier is answered about that order and no other.
The production site uses the same rule as the test site for the controlled
launch with no external users.

The identifier is generated from a random source, is impractical to guess and
is absent from catalogues and order listings. It is not exclusive to the
buyer: Coinslot and the merchant also receive it as parties to the sale. It is
a key to one order, not proof of payment ownership. Ownership still comes only
from the verified payer.

The buyer response carries the order's state, price and goods after the order
has closed as delivered. It omits the merchant's product identifier, notes and
other orders. A missing identifier receives the same outward answer as an
unknown one, so probing does not distinguish them.

## Consequences

Asynchronous purchases have a collection path. The weakness is explicit:
anyone who obtains an identifier through a log, proxy or agent store can read
that order. They cannot change it, act as its payer or enumerate other orders.

Dmitry accepts this bearer-link risk for the first controlled live launch. No
external users exist yet, so wallet login would delay running the two
environments without protecting a public audience. Before the first buyer or
agent outside Dmitry's controlled launch, this decision is revisited and the
door is either narrowed or explicitly accepted for that new audience.

## Alternatives rejected

**Leave the route unmounted.** This avoids the weak door but takes money for an
asynchronous product that an agent cannot collect.

**Make the agent prove control of the paying address now.** This remains the
long-term direction. x402 provides Sign-In-With-X: the gateway can ask a wallet
to sign a challenge and verify that the caller controls an address. The
integration is deliberately deferred until the launch has an external user.

**Give buyers accounts and keys.** This turns buying into signing up, while the
product exists so an agent with a budget can buy without a relationship first.
