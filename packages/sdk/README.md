# `@nuanu-ai/coinslot`

The Coinslot merchant SDK connects a seller's existing service to Coinslot. It
publishes product cards, receives paid orders and price questions through one
outgoing worker connection, and closes orders with the goods or a refusal.

The package is an early `0.x` pilot surface. Its wire contract is versioned
separately and the SDK refuses a gateway whose contract version it does not
understand.

## Install

```sh
npm install @nuanu-ai/coinslot
```

Node.js 24 or newer is required.

```ts
import { createClient } from '@nuanu-ai/coinslot'

const coinslot = createClient({
  apiKey: process.env.COINSLOT_API_KEY,
  baseUrl: process.env.COINSLOT_URL,
})
```

The address is the environment: `https://test.coinslot.nuanu.ai` while you are
building, with a key beginning `csk_test_`, and `https://coinslot.nuanu.ai` once
you are live. A key issued in one of them does not open the other.

Say what the process answers with, then open the subscription. Paid orders,
price questions and order events all arrive on that one connection, and
`grantAccess` below is the seller's own delivery.

```ts
coinslot.on('order', async (order) => {
  const access = await grantAccess(order.params.email, {
    idempotencyKey: order.id,
  })

  if (!access.ok) {
    return order.refused({
      code: 'out_of_stock',
      message: 'No seats left on that plan',
    })
  }

  return order.delivered({ access_url: access.url })
})

await coinslot.start()
```

The handler returns its answer and the SDK sends it. The calls that close an
order — delivering, refusing, taking one on — hand a failure back rather than
throwing it, in one envelope: `ok` says which it was, and a failure carries one
`error` with a code, a sentence a person can read, and whether repeating the
call could change the outcome. Publishing a card answers in that envelope too,
where the card is what we would not take. What no envelope can carry — a call
that reached nothing, or one we refused at the door — is thrown as a
`CoinslotError` under the same code, and so is every failure of reading an order
back. A client built wrong — no key, an address that is not an address — is a
`TypeError` before anything leaves your process.

The merchant documentation and complete quickstart are published at
<https://coinslot.nuanu.ai/docs/>.

## License

This package is `UNLICENSED`. Publication on npm makes the package installable;
it does not grant a license to copy, modify or redistribute it outside an
agreement with Coinslot.
