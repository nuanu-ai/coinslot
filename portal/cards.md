# The product card

*A preliminary contract: the wording can still change before the pilot.*

You create and edit the cards yourself, which is what makes this reference
yours. By default we write the cards and the owner of the business approves
them; the whole path, from an empty project to a test sale, is on
[The first test sale](/quickstart).

A card is the description of one product in a catalogue: everything the agent
sees before buying, and everything it decides to buy from. From that follows
the requirement that runs through every field at once — an agent has to be
able to buy from the card, which means assembling a correct purchase and
getting back what it expected.

::: warning The field names are preliminary
What is fixed is the model and not the signatures. Of the machine names `id`,
`merchant_item_id` and `as_of` are final; the other names in this reference
are working names and can still change before the pilot.
:::

## Fields

| Field | Type | Required | Example |
| --- | --- | --- | --- |
| `id` | string | not yours to fill in: we issue it at publication | `itm_9f2c4a` |
| `merchant_item_id` | string | required | `access-monthly` |
| `title` | string | required | `One month of access to the service` |
| `description` | string | required | `Access for 30 days from delivery, renewal not included` |
| `price` | an amount as a string, and a currency | required | `{ amount: '5.00', currency: 'USD' }` |
| `price_check` | what to ask the price and availability with: a handler, or an address | optional | `'handler'` |
| `params` | the shape of the purchase parameters | required where the delivery needs input | `{ email: { type: 'string', required: true } }` |
| `result` | the shape of what the agent receives on delivery | required | `{ access_url: { type: 'string' } }` |
| `fulfillment` | `'sync'` or `'async'`; `'confirm'` is not published during the pilot | required | `'sync'` |

An asynchronous card carries one deadline of your own: how long you may take
to deliver an order you have accepted. The agent sees it before it buys, and
what happens when it runs out is in [Time ran out](/orders). A synchronous
card has no such field, because how long to wait for a synchronous answer is
our own ceiling on how long an agent waits, and it is the same for every
product. The confirmation mode has a deadline of its own and it arrives
together with the mode.

### Two identifiers

A product has two keys, and they appear at the same moment. Our catalogue `id`
is issued when the card is published, and it is what lives in the catalogues,
in the orders and in the receipts. Your `merchant_item_id` is set by you: it
is the identifier the product already has in your database.

The second key saves you a lookup table. An order arrives carrying your own
key, so there is nothing to translate from our numbering into yours. It is
also the point of connection that survives a catalogue being republished.

### Title

A short line by which the product is told apart from its neighbours in a
catalogue's listing. Catalogues have their own limits on length and on the
characters allowed, and we fit the title to them at publication.

### Description

The description is read by the buying program, so you write it differently
from one meant for a person. A program needs facts that distinguish: what
exactly the buyer receives, what task it is good for, what is not included,
what the limits are. "The best offer on the market" is empty to a machine,
while "incoming messages only" settles whether the product fits.

### Price

A price in the card is required in every case: it is what the agent sees in a
catalogue while it is choosing, and it is what ends up in the receipt when the
sale went through at it. For a product with a fixed price that is the whole
story — the price is true until you change it.

If your price is worked out on the fly, you add a price check to the card and
the two work together. The check's answer is stronger than the card's price:
when it answers, the sale goes at the price it named; when it is silent, we
take the price from the card, and what follows depends on the fulfillment mode
([What can go wrong](/failures)).

On an asynchronous product with a check, the card's price is there for exactly
one purpose: to show the agent roughly what the purchase will cost while it is
choosing in the catalogue. The sale itself goes only at the price the check
named, because the buyer is charged at the moment of purchase, so a silent
check starts no purchase and the card's price is not a fallback. Put the
ordinary price of the product there rather than a zero or a placeholder: the
agent decides from it whether to look any further.

### Purchase parameters

The list of what the agent has to give at purchase: an email address, a
country, a period, any other input without which the delivery is impossible.
Each parameter has a type, a mark saying whether it is required, and an
explanation a person can read of what it is for.

This field is checked more strictly than the others, because it is where the
card's main requirement breaks. A parameter your delivery needs and the card
does not name produces a purchase you cannot fulfil — and instead of a sale
you get a refusal.

### Delivery result

The shape of what the agent receives once the delivery has gone through: a
link, a key, a number, a set of fields. It sits in the card next to the
purchase parameters, and it is how the agent sees before paying what it is
actually buying.

We pass the delivery to the agent as it is: the handler returns JSON to this
shape, and we neither rewrite it nor rename anything in it. So the declaration
has to match what the handler really sends; a mismatch is something the agent
discovers after it has paid.

Every field of the result is required until you mark it `required: false`. The
result is a promise, and a delivery missing a promised field does not go
through as a delivery. Purchase parameters run the other way round: a
parameter is required only where it is marked `required: true`.

```ts
result: {
  access_url: { type: 'string', title: 'The link to sign in with' },
  expires_at: { type: 'string', title: 'When it stops working' },
}
```

### Fulfillment mode

The value of `fulfillment` declares the mode, and the agent sees it before it
pays. With `'sync'` the goods leave in the answer to the purchase; with
`'async'` they leave later. The mode decides when the buyer is charged and how
the sale behaves when something fails.

A third mode, `'confirm'`, puts your confirmation before the delivery: you are
asked whether you will deliver, and the buyer is charged after your yes. A
card cannot be published in it during the pilot — the request that asks you
has no shape on the wire yet, so a handler could not tell one from a paid
order, and publishing such a card would sell you a mode we cannot serve.

The product decides the mode. The channel only narrows the choice: an order
that arrived as a message is never synchronous, while a connected API delivers
both synchronously and asynchronously. What happens inside each mode
is on [Orders and fulfillment modes](/orders).

## Asking the price and availability

The check answers one question: what the product costs and whether it is there
right now. We ask it at the moment of purchase. It has two transports, the
fields of the question and of the answer are the same for both, and what
differs is only where your code stands. The forms below are working ones and
can change before the pilot.

By default the question travels the same channel as the orders: you put a
price handler beside the order handler, in the same process. Nothing of yours
faces outward — no address, no open ports.

```ts
coinslot.on('quote', async (q) => {
  const item = await lookupItem(q.merchant_item_id)

  if (!item.in_stock) {
    return q.unavailable(item.checked_at)
  }

  return q.available({ amount: item.price, currency: 'USD' }, item.checked_at)
})
```

The subscription channel is authenticated when it connects, so your side does
not have to check that a price question really came from us.

The second transport is the price hook: an address on your side that we reach
over HTTP. It is for a business whose price is worked out by a separate
pricing service that the order handler cannot reach. The address is declared
in the card, and the question and the answer are the same ones.

```http
POST https://api.example.com/quote

{
  "merchant_item_id": "access-monthly",
  "params": { "email": "buyer@example.com" },
  "price_id": "prc_31a8c0",
  "purpose": "purchase",
  "expires_at": "2026-08-26T10:20:00Z"
}
```

The field `purpose` says why we are asking. Today it always reads
`"purchase"`: there is an agent behind the question, buying right now. Its
other value, `"poll"`, belongs to a scheduled refresh between purchases —
nothing sends it yet, and a handler should accept it all the same. Where the
two are told apart, an expensive stock lookup is worth spending on a purchase
and worth skipping on a poll.

The field `price_id` identifies this one price question, and it is good once —
no more than one order goes through under a single `price_id`. The same
`price_id` arrives later with the order, so you can tie your own answer to the
sale. Beside it comes `expires_at`, the moment up to which the price you name
will be honoured: if you have set stock aside against it, there is no need to
hold that stock any longer, and we send no separate message when the moment
passes. Nobody is obliged to reserve anything — without a reservation the
check stays an answer to a question rather than a commitment.

The answer has three parts:

| Field of the answer | Type | Required | Example |
| --- | --- | --- | --- |
| `available` | boolean | required | `true` |
| `price` | an amount and a currency | required where `available` | `{ "amount": "5.00", "currency": "USD" }` |
| `as_of` | a timestamp, ISO 8601 | required | `"2026-08-26T10:15:00Z"` |

In full it looks like this:

```json
{
  "available": true,
  "price": { "amount": "5.00", "currency": "USD" },
  "as_of": "2026-08-26T10:15:00Z"
}
```

The mark `as_of` says which moment the answer is true for, and it separates
"went and checked just now" from "handed over what was in the cache". We
decide from it how far the answer can be trusted, and the same moment ends up
in the record of the sale. A price handler is given it as the last argument; a
call made without it stamps the moment of the answer itself, which is correct
exactly when you were looking at that moment. An answer out of a cache is
dated by the moment that cache was filled, as in the example above.

An `available: false` answer to a purchase closes it before any money moves,
and no order appears on your side. The price from an answer lives until
`expires_at`: how long a price holds is set by us and is the same across the
system, and what happens once it has passed is in [Time ran out](/orders).

We hold down the load on your side ourselves, limiting how often the questions
go out.

Coinslot keeps no stock counts — how much of anything there is, only you know.
Which is where the rule for deciding whether a product needs a check comes
from: a product that can run out is worth listing with one, because without it
we sell at the card's price and hear that it has run out only from your
refusal at delivery.

## Refusal codes

A handler's refusal carries a short code and a reason a person can read. The
code is read by us and by the agent; the reason is read by the person who
works on the case afterwards. What happens to the order after a refusal is on
[Orders and fulfillment modes](/orders); here is the vocabulary of codes.

The set is open, and a code of your own is fine where none of the common ones
fits. Three we understand the same way every time, and those are the ones to
prefer.

| Code | When to send it |
| --- | --- |
| `out_of_stock` | there is none: sold out, no places left, the supplier did not hand it over |
| `invalid_params` | the purchase parameters are no good for the delivery |
| `cannot_fulfill` | it cannot be delivered, for some other reason |

We count `out_of_stock` separately, because it feeds the availability measure —
the share of purchases that ran into missing goods, which we hold below a
limit ([why](/failures)). A "there is none" refusal sent under a code of your
own does not reach that measure, and the picture we hold of your catalogue's
availability comes out wrong. An `available: false` from the check reaches the
same measure without a code at all.

## Who checks a card before it is published

Two of us: the `coinslot verify` command on your side, and we ourselves before
the card goes into the catalogues. Both sides look at the same thing — whether
an agent can assemble a correct purchase from this card.

## Updating or withdrawing a card

With the same tools it was created with. Publishing again under the same
`merchant_item_id` updates the card that is there rather than creating a
second one: the key is yours, and we find what is already published by it. So
a card can be uploaded from a script without checking first whether we have it.

A withdrawn card stops being visible in the catalogues, and the orders still
open against it play out in the ordinary way.

## What is not settled yet

- The maximum length of a title and the characters allowed in one.
- The limits on a description: length, language, and the ban on addressing the
  buying program or instructing it.
- The exact shape that describes the purchase parameters and the delivery
  result.
- The names of the fields a card sets your deadlines in, for confirming and
  for delivering.
- The shape of the field a card declares a price check in and chooses a
  transport with.
- Whether the vocabulary of recommended codes grows beyond three: we decide
  that from the refusals the pilot actually turns up.
- The scheduled refresh of price and availability between purchases. It is
  designed — a poll's answer would take a card out of a catalogue's listing
  until the next poll, and no sale would go through on a poll's answer alone,
  because a question with money behind it is asked again — and nothing runs it
  yet.
- The thresholds that limit how often price questions go out, and how long we
  wait for an answer.
- How your side satisfies itself that a request to a price hook came from us:
  signatures on our HTTP requests. A price handler has no such question — the
  subscription channel is authenticated.
- The procedure for withdrawing a card, and its timings.
