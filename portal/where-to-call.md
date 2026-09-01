# Where to call, and with which key

*A preliminary contract: the wording can still change before the pilot.*

There are two environments, and everything about them is separate: the address
you call, the key that opens it, and the chain the payments settle on.

|                           | Test                            | Live                                |
| ------------------------- | ------------------------------- | ----------------------------------- |
| Address                   | `test.coinslot.nuanu.ai`        | `coinslot.nuanu.ai`                 |
| Keys start with           | `csk_test_`                     | `csk_live_`                         |
| Payments settle on        | Base Sepolia, with test funds   | Base mainnet, where the money is real |
| Orders and receipts carry | `test: true`                    | `test: false`                       |

## The address arrives with the key

You are given both when you connect. The key goes to the client as `apiKey`,
the address as `baseUrl`. The client supplies no address of its own, because
nothing in the contract says where we are.

## A key opens one environment

A `csk_test_` key opens the test address; a `csk_live_` key opens the live one.
Presented to the other environment, a key is refused in words that name the
site it does work on.

## The `test` flag follows the chain

`test` on an order and on a receipt says which chain the payment settled on: a
gateway settling on Base Sepolia writes `test: true`, and one settling on Base
mainnet writes `test: false`. It is not a switch of its own, and your key does
not decide it.
