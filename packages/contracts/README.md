# `@nuanu-ai/coinslot-contracts`

The Coinslot wire contract, written as schemas rather than as prose: the card an
agent reads before it buys, the order that reaches a merchant, the price check,
the receipt, and the answers every call of the merchant API comes back in. The
gateway and the merchant SDK both read this package, so the two cannot disagree
about a field without one of them failing to build.

Most merchants never install it. `@nuanu-ai/coinslot` depends on it and
re-exports the types integration code is written against — what a card is, what
an order carries, what a handler may answer — so a merchant has one import and
not two. Install this one directly when you validate the same documents at
another boundary of your own, or when you want the schemas as JSON Schema to
generate a client in a language that is not TypeScript.

```sh
npm install @nuanu-ai/coinslot-contracts
```

Node.js 24 or newer is required. Zod is the only thing that arrives with it.

The contract is versioned, and the version is how an SDK and a gateway agree
that they read the same vocabulary; a worker whose version the gateway does not
share stops at startup rather than half understanding a document. What the
merchant-facing side of all this looks like in use is at
<https://coinslot.nuanu.ai/docs/>.

## License

This package is `UNLICENSED`. Publication on npm makes the package installable;
it does not grant a license to copy, modify or redistribute it outside an
agreement with Coinslot.
