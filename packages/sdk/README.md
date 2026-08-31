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

The merchant documentation and complete quickstart are published at
<https://coinslot.nuanu.ai/docs/>.

## License

This package is `UNLICENSED`. Publication on npm makes the package installable;
it does not grant a license to copy, modify or redistribute it outside an
agreement with Coinslot.
