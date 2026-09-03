# `@nuanu-ai/coinslot`

Coinslot puts a merchant's existing products where AI agents buy. Each product
gets a card in an agent-facing storefront and a paid address of its own,
`/x402/<item>/purchase`, where an agent pays for it with the x402 payment
protocol; the money goes from the buyer's wallet to the merchant's without
passing through us.

This package is the merchant's side of it. It publishes the cards, receives
paid orders and price questions through one outgoing connection, and closes
each order with the goods or with a refusal. Nothing of the merchant's has to
be reachable from outside — the process opens that connection itself, so no
public address and no open port are needed.

## Install

```sh
npm install @nuanu-ai/coinslot
```

Node.js 24 or newer is required. What arrives with it is our own contracts
package and zod underneath that, and nothing else.

## The address you give it is the world you are in

```ts
import { createClient } from '@nuanu-ai/coinslot'

const coinslot = createClient({
  apiKey: process.env.COINSLOT_API_KEY,
  baseUrl: process.env.COINSLOT_URL,
})
```

There are two of us. At `https://test.coinslot.nuanu.ai` you build: payments
settle on a test chain and the money there is not real. At
`https://coinslot.nuanu.ai` you sell, and it is. A key issued in one does not
open the other, and the key says which one you are holding: `csk_test_` for the
first, `csk_live_` for the second. This package picks neither address for you,
and the worker's first log line names the one it started against and whether
the money there is real.

## A card, and the handler that fills the orders

The card is the whole of what an agent reads before it buys: what you sell, at
what price, and what the buyer receives. This one is complete.

```ts
await coinslot.catalog.publish({
  merchant_item_id: 'access-monthly',
  title: 'One month of access to the service',
  description: 'Access for 30 days from delivery, renewal not included',
  price: '5.00 USD',
  result: { access_url: 'string', expires_at: 'string' },
})
```

Then say what this process answers with, and open the subscription. Paid
orders, price questions and order events all travel that one connection.
`grantAccess` below is the seller's own delivery; the handler returns its
answer and this package sends it, because an answer that has to be returned is
one nobody can forget to send.

```ts
coinslot.on('order', async (order) => {
  const access = await grantAccess({ idempotencyKey: order.id })

  if (!access.ok) {
    return order.refused({
      code: 'out_of_stock',
      message: 'No seats left on that plan',
    })
  }

  return order.delivered({
    access_url: access.url,
    expires_at: access.expiresAt,
  })
})

await coinslot.start()
```

The same order can arrive twice, after a dropped connection or a restart of
yours, so its `id` is also its idempotency key: pass it into your own delivery
system and the second arrival hands back the first result instead of delivering
again.

A call that can fail hands the failure back rather than throwing it, in one
envelope: `ok` says which it was, and a failure carries a code, a sentence a
person can read, and whether repeating could change the outcome. A card we
would not publish carries its findings under `problems`, and what no envelope
can carry — a call that reached nothing at all — is thrown as a `CoinslotError`
under those same codes.

## The check that needs no key

```sh
npx coinslot verify card.json
```

It reads a card the way we read it at publication and names what is wrong,
offline: no key, no address, no order raised, nothing asked of us. The same
check is exported as `checkCard`, for cards assembled in code rather than kept
in files.

It never reports a clean pass. The half of self-checking worth more — whether
your handler holds against a repeat of the same order — needs a test order that
nothing on our surface can yet raise, so the command says that check did not
run instead of calling its silence a success.

## Where the rest of it is written

The merchant documentation is public. [The first test
sale](https://coinslot.nuanu.ai/docs/quickstart) walks from an empty project to
a test purchase your side runs end to end; the other three pages are [the
product card](https://coinslot.nuanu.ai/docs/cards) field by field, [orders and
fulfillment modes](https://coinslot.nuanu.ai/docs/orders) for delivering later
rather than in the answer to the purchase, and [what can go
wrong](https://coinslot.nuanu.ai/docs/failures).

## Versions

This is an early `0.x` pilot surface and the names in it can still change. What
does not change quietly is the wire: the SDK and the gateway agree on a
contract version, and a worker whose version the gateway does not share stops
before it takes an order rather than half reading a document and misreporting
its own successes. Register `coinslot.on('problem', …)`, which is where you
hear about that and about everything else that did not get through.

## License

This package is `UNLICENSED`. Publication on npm makes the package installable;
it does not grant a license to copy, modify or redistribute it outside an
agreement with Coinslot.
