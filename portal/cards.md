# The product card

*A preliminary contract: the wording can still change before the pilot.*

If you keep the cards yourself, this reference is yours. By default we write
them and the owner of the business approves them; the whole path, from an empty
project to a test sale, is on [The first test sale](/quickstart).

The working words — handler, order, agent — are defined on [The first test
sale](/quickstart).

A card is the description of one product in a catalogue: everything the agent
sees before buying, and everything it decides to buy from. From that follows
the requirement that runs through every field at once — an agent has to be able
to buy from the card, which means assembling a correct purchase and getting
back what it expected.

::: warning The field names are preliminary
What is fixed is the model and not the signatures. Of the machine names `id`,
`merchant_item_id` and `as_of` are final; the other names in this reference are
working names and can still change before the pilot.
:::

## Fields

| Field | Type | Required | Example |
| --- | --- | --- | --- |
| `id` | string | not yours to fill in: we issue it at publication | `itm_9f2c4a` |
| `merchant_item_id` | string | required | `access-monthly` |
| `title` | string | required | `One month of access to the service` |
| `description` | string, up to 500 characters | required | `Access for 30 days from delivery, renewal not included` |
| `price` | an amount as a string, and a currency | required | `{ amount: '5.00', currency: 'USD' }` |
| `price_check` | what to ask the price and availability with: a handler, or an address we do not call yet | optional | `'handler'` |
| `params` | the shape of the purchase parameters | required where the delivery needs input | `{ email: { type: 'string', required: true } }` |
| `result` | the shape of what the agent receives on delivery | required | `{ access_url: { type: 'string' } }` |
| `tags` | words that describe this product in a catalogue: at most five, each 1 to 32 characters of plain typewriter text — unaccented letters, digits, spaces and the punctuation on a keyboard, so a curly quote or a long dash is refused — with no space at either end and no two the same but for their case. A card with no tags leaves the field out rather than sending an empty list | optional | `['esim', 'telecom']` |
| `fulfillment` | `'sync'` or `'async'`; `'confirm'` is not published during the pilot | required | `'sync'` |
| `fulfill_deadline_seconds` | how long you may take to deliver | optional, and only on an asynchronous card | `86400` |

An asynchronous card can carry one deadline of your own: how long you may take
to deliver. It runs from the moment the buyer is charged, which for an
asynchronous product is the moment of purchase — so the clock is already going
when the order reaches your handler, and it covers every attempt we make to
deliver that order to you. Name it, and the agent sees it before it buys.

Leaving it out does not leave you off a clock. A day applies instead, an order
that runs past it is marked as needing a refund exactly as one past a number of
your own would be, and the agent is shown no deadline at all — so the clock you
are held to is one the agent never saw. That day is ours to set rather than the
card's, and naming your own is the only way the agent learns what it is. What
happens when a delivery deadline runs out is in [Time ran out](/orders).

A synchronous card has no such field, because how long to wait for a synchronous
answer is set by us, the same for every product: eight seconds. That one runs
from the moment of purchase rather than from the moment your handler is called,
so the price question and the payment check come out of it first. The
confirmation mode has a deadline of its own — an hour, where the card names none
— and it arrives together with the mode.

### Two identifiers

A product has two keys, and they appear at the same moment. Our catalogue `id`
is issued when the card is published, and it is what lives in the catalogues,
in the orders and in the receipts. Your `merchant_item_id` is set by you: it is
the identifier the product already has in your database.

The second key saves you a lookup table. An order arrives carrying your own
key, so there is nothing to translate from our numbering into yours. It is also
the point of connection that survives you publishing your cards again.

### Title

A short line by which the product is told apart from its neighbours in a
listing. It reaches the agent in our own catalogue, beside the description and
the price.

It does not reach a catalogue outside ours. Those carry one field of prose for
a product where a card has two, and joining your headline to your description
with punctuation of our own would be us writing your listing for you — so what
goes out there is the description, the field a card writes for a program to
read.

A title has to be there and it has to be more than blank space. Nothing else is
checked: no length is measured and nothing is shortened, so what you write is
what an agent is shown, whole, and a title long enough to be a paragraph is one
nothing on our side will stop. What the limits ought to be is not settled.

### Description

The description is read by the buying program, so you write it differently from
one meant for a person. A program needs facts that distinguish: what exactly
the buyer receives, what task it is good for, what is not included, what the
limits are. "The best offer on the market" is empty to a machine, while
"incoming messages only" settles whether the product fits.

### Price

A price in the card is required in every case: it is what the agent sees in a
catalogue while it is choosing, and it is what ends up in the receipt when the
sale goes through at it. For a product with a fixed price that is the whole
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
Each parameter has a type — `string`, `number`, `integer` or `boolean` — a mark
saying whether it is required, and an explanation a person can read of what it
is for. Those four are the whole language today, so a date, a list or a choice
from a set travels as one of them.

Nothing checks this field against your delivery, and it is where the card's
main requirement breaks. A parameter your delivery needs and the card does not
name produces a purchase you cannot fulfil — and instead of a sale you get a
refusal. No check of ours can see that, because neither we nor the contract
know what your delivery needs; getting it right is yours.

### Delivery result

The shape of what the agent receives once the delivery has gone through: a
link, a key, a number, a set of fields. It sits in the card next to the
purchase parameters, and it is how the agent sees before paying what it is
actually buying.

We pass the delivery to the agent as it is: the handler returns JSON to this
shape, and we neither rewrite it nor rename anything in it. So the declaration
has to match what the handler really sends, in both directions: a promised
field that does not arrive is a mismatch, and so is a field the card never
declared. A mismatch does not reach the agent — we refuse the delivery, name
the fields that are wrong and leave the order where it was, so your handler can
send the right thing. It is the merchant who finds out, not the buyer.

Where that order has already ended — its deadline ran out while the handler was
being fixed — the refusal names the ending as well as the fields, rather than
inviting another attempt at a sale there is nothing left to deliver against.

Where a handler has got everything wrong at once, the refusal is held to a
single line rather than allowed to grow into a paragraph nobody reads. A field
your card declares and your handler got wrong is one item in that line, and
where there are more items than fit, the refusal names the first few and says
how many are left. Every field your card never declared goes into a single item
listing all of them at once, and that item is cut at a fixed length with the
cut marked, so a handler that sent a hundred names nobody asked for is told the
first several of them and that the text went on, without a count of what was
left out.

Every field of the result is required until you mark it `required: false`. The
result is a promise, and a delivery missing a promised field does not go
through as a delivery; a promised string that arrives empty counts as missing,
because an empty access code is not a shorter access code but nothing under the
name of something. Purchase parameters run the other way round: a parameter is
required only where it is marked `required: true`, and one the agent leaves
empty is left empty, since that is input it chose to give.

A card declares at least one field here, and at least one of them has to arrive
every time. A result that might be entirely absent tells the agent nothing
about what it is paying for, and a card carrying one is refused at publication.

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
asked whether you will deliver, and the buyer is charged after your yes. A card
cannot be published in it during the pilot — the request that asks you has no
shape on the wire yet, so a handler could not tell one from a paid order, and
publishing such a card would sell you a mode we cannot serve.

The product decides the mode. The channel only narrows the choice: an order
that arrived as a message is never synchronous, while a connected API delivers
both synchronously and asynchronously. What happens inside each mode is on
[Orders and fulfillment modes](/orders).

## Asking the price and availability

The check answers one question: what the product costs and whether it is there
right now. We ask it at the moment of purchase. It has two transports, the
fields of the question and of the answer are the same for both, and what
differs is only where your code stands. The forms below are working ones and
can change before the pilot.

The question travels the same channel as the orders: you put a price handler
beside the order handler, in the same process. Nothing of yours faces outward —
no address, no open ports. This is the transport we serve.

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

A second transport is designed for a business whose price is worked out by a
separate pricing service the order handler cannot reach: the price hook, an
https address declared in the card, carrying the same question and the same
answer.

We do not call it yet. A card that names an address is priced as though nobody
had answered, which costs different things in different modes — a synchronous
product sells at the price in its card, every time, with your pricing service
never once consulted, and an asynchronous one does not sell at all. So until
the transport is served, a card whose price moves belongs behind a price
handler.

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

The field `purpose` says why we are asking. Today it always reads `"purchase"`:
there is an agent behind the question, buying right now. Its other value,
`"poll"`, belongs to a scheduled refresh between purchases — nothing sends it
yet, and a handler should accept it all the same. Where the two are told apart,
an expensive stock lookup is worth spending on a purchase and worth skipping on
a poll.

The field `price_id` identifies this one price question, and it is good once —
no more than one order goes through under a single `price_id`. The same
`price_id` arrives later with the order, so you can tie your own answer to the
sale. Beside it comes `expires_at`, the moment up to which the price you name
will be honoured: if you have set stock aside against it, there is no need to
hold that stock any longer, and we send no separate message when the moment
passes. Nobody is obliged to reserve anything — without a reservation the check
stays an answer to a question rather than a commitment.

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
"went and checked just now" from "handed over what was in the cache". A price
handler is given it as the last argument; a call made without it stamps the
moment of the answer itself, which is right only if you really did look just
then. An answer out of a cache is dated by the moment that cache was filled, as
in the example above.

We carry the mark and we do not yet weigh it. It travels into the order your
handler is given and into the record of the sale, so whoever reconciles a
charge afterwards can see how old the number behind it was — but nothing
compares it against anything. An answer stamped a year ago is honoured for
exactly as long as one stamped a second ago, because a price's life runs from
the moment your answer reached us rather than from the moment it says it was
true. So nothing here catches a stale price on your behalf: a handler answering
out of a cache is the one deciding how old that cache may get.

An `available: false` answer to a purchase closes it before any money moves,
and no order appears on your side. The price from an answer lives until
`expires_at`: how long a price holds is set by us and is the same across the
system — thirty seconds — and what happens once it has passed is in [Time ran
out](/orders).

We wait five seconds for an answer, and a question unanswered by then counts as
silence, which costs different things in different modes ([What can go
wrong](/failures)). Nothing on our side holds down how often these questions go
out: one purchase asks one question and that question is put on your stream
once, so the rate your price handler meets is the rate agents buy at, and that
is the number to size it against. The thresholds that would hold the rate down
are among what is not settled below; until they exist there is nothing between a
burst of purchases and your handler.

Coinslot keeps no stock counts: only you know how much of anything there is. So
a product that can run out is worth listing with a check, because without one
we sell at the card's price and hear that it has run out only from your refusal
at delivery.

## Refusal codes

A handler's refusal carries a short code and a reason a person can read. The
code is read by us and by the agent; the reason is read by the person who works
on the case afterwards. What happens to the order after a refusal is on [Orders
and fulfillment modes](/orders); here is the vocabulary of codes.

The set is open, and a code of your own is fine where none of the common ones
fits. Three we understand the same way every time, and those are the ones to
prefer.

| Code | When to send it |
| --- | --- |
| `out_of_stock` | there is none: sold out, no places left, the supplier did not hand it over |
| `invalid_params` | the purchase parameters are no good for the delivery |
| `cannot_fulfill` | it cannot be delivered, for some other reason |

`out_of_stock` is the one we mean to count separately, because it feeds the
availability measure — the share of purchases that ran into missing goods,
which we mean to hold below a limit ([why](/failures)). Nothing counts it yet.
When something does, a "there is none" refusal sent under a code of your own
will not reach that measure and the picture of your catalogue's availability
will come out wrong, so the common code is worth preferring now.

## Who checks a card before it is published

Two of us: the check we ship, run on your side, and we ourselves before the
card goes into the catalogues. Both sides look at the same thing — whether an
agent can assemble a correct purchase from this card — and both read the card
by the same contract, so a card the first accepts is not turned away by the
second.

## Updating a card, and taking one off sale

Updating is the call that created it. Publishing again under the same
`merchant_item_id` updates the card that is there rather than creating a second
one: the key is yours, and we find what is already published by it. So a card
can be uploaded from a script without checking first whether we have it.

Taking a card off sale is the pause in the cabinet rather than a call. Paused,
the card stops being visible in the catalogues, and the orders still open
against it play out in the ordinary way. Nothing removes a card altogether, and
what that ought to be is not settled.

## What is not settled yet

- The maximum length of a title and the characters allowed in one.
- The limits on a description beyond its length: the language it is written in,
  and the ban on addressing the buying program or instructing it.
- The exact shape that describes the purchase parameters and the delivery
  result.
- How long a delivery deadline may be, and whether an asynchronous card ought
  to be required to name one at all, rather than fall to a default the buying
  program is never shown.
- The shape of the field a card declares a price check in and chooses a
  transport with.
- Whether the vocabulary of recommended codes grows beyond three: we decide
  that from the refusals the pilot actually turns up.
- The scheduled refresh of price and availability between purchases. It is
  designed — a poll's answer would take a card out of a catalogue's listing
  until the next poll, and no sale would go through on a poll's answer alone,
  because a question with money behind it is asked again — and nothing runs it
  yet.
- The thresholds that limit how often price questions go out.
- Whether an answer whose `as_of` is too old is refused rather than honoured,
  what counts as too old, and what a sale does when one arrives.
- The price hook. We do not call the address a card names, and when we do, your
  side will need something to check a request against to know that it came from
  us. A price handler has neither question — the subscription channel is
  authenticated when it connects.
- How a card is removed altogether rather than paused, and how long that takes.
