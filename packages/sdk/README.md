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
  const url = await grantAccess(order.params.email, { idempotencyKey: order.id })

  return order.delivered({ access_url: url })
})

await coinslot.start()
```

The handler returns its answer and the SDK sends it. Every call that can fail
answers in one envelope: `ok` says which it was, and a failure carries one
`error` with a code, a sentence a person can read, and whether repeating the
call could change the outcome.

The merchant documentation and complete quickstart are published at
<https://coinslot.nuanu.ai/docs/>.

## License

This package is `UNLICENSED`. Publication on npm makes the package installable;
it does not grant a license to copy, modify or redistribute it outside an
agreement with Coinslot.
