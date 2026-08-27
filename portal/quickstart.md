# The first test sale

*A preliminary contract: the wording can still change before the pilot.*

You are the one writing code here: the business has an API, and you want to
keep the delivery in your own hands. Below is the path from an empty project to
a test sale that your side runs end to end — the card, the order, the delivery,
the receipt. A live agent comes after that, on the last step. You do not
rewrite the shop to get there: a handler appears beside it, a process that
takes paid orders and gives out the goods for them.

There are paths with no code at all. By default we write the cards, and we set
up and run the link to an online shop ourselves. Both are described on
[Connecting to Coinslot](/), which is written for the owner of the business.

## The words used below

- Card — the description of a product in the catalogue that an agent decides
  from and buys through; its fields are in the [card reference](/cards).
- Order — the object that appears on our side after a purchase and arrives on
  yours; its whole life is on [Orders and fulfillment modes](/orders).
- Handler — your code, which receives orders and carries out the delivery.
- Idempotency key — a string that is the same across every repeat of one order.
  Ours is the order's identifier, and your side answers with the earlier result
  under it instead of delivering a second time.
- Fulfillment mode — whether the goods arrive in the answer to the purchase or
  later. The mode decides when the buyer is charged ([Three fulfillment
  modes](/orders)).
- Price check — the question of how much a product costs and whether it is
  there, which we ask at the moment of purchase about products whose price
  moves. A price handler answers it, standing in your process beside the order
  handler. A second transport is designed — a price hook, an address of your
  own — and is not called yet.
- Delivery result — what the agent receives once the delivery has gone through:
  a link, a key, a set of fields. Its shape is declared in the card.

::: warning The tool surface is preliminary
The package name, the function names and the field names in the examples below
are working names. What is fixed is the integration model and not the
signatures: of the machine names only `merchant_item_id`, `as_of` and our
catalogue `id` are final. The rest can still change before the pilot, and we
tell you in advance when it does.
:::

## 1. Install the tools

Everything your side needs is in one package. Its dependency tree is short and
listed outright: our contracts package, and zod, the library that validates
data. Nothing beyond those arrives in your project.

```sh
npm install @coinslot/sdk
```

The package is not published yet, so that line has nothing to fetch today; how
it reaches you during the pilot is in the list at the end of this page, and the
name above is a working one like the rest.

You are given a key to our API when you connect, and you keep it wherever you
keep the rest of your secrets.

```ts
import { createClient } from '@coinslot/sdk'

const coinslot = createClient({
  apiKey: process.env.COINSLOT_API_KEY,
  baseUrl: process.env.COINSLOT_URL,
})
```

The address in `baseUrl` comes with the key when you connect. The client
supplies none by itself, because nothing in the contract says where we are.
This step worked if the client was built. Whether the key is the right one is
answered by the first call that reaches us, and that call is on the next step.

## 2. Describe the product with a card

You upload the card yourself, with a call. What is wrong with it comes back in
that same call's answer, so the edit loop is short: fixing and calling again
ten times in a row costs nothing.

```ts
const published = await coinslot.catalog.publish({
  merchant_item_id: 'access-monthly',
  title: 'One month of access to the service',
  description:
    'What the buyer gets, what it is good for, and what is not included.',
  price: { amount: '5.00', currency: 'USD' },
  params: {
    email: { type: 'string', required: true, title: 'Where to send it' },
  },
  result: {
    access_url: { type: 'string', title: 'The link to sign in with' },
  },
  fulfillment: 'sync',
})

if ('errors' in published) {
  console.error(published.errors)
}
```

An invalid card raises no exception. In place of `ok` the call answers with
`errors`: a list of the fields at fault, each with an explanation of what is
wrong with it, and never an empty list. Where there is an `ok`, the card was
accepted, and our catalogue identifier is inside it.

A call that fails for some other reason — a key we do not accept, an address
that does not answer — does throw. The `errors` answer is about the card and
nothing else.

The field `merchant_item_id` is your own identifier for the product, the same
one it has in your database. We issue our catalogue `id` beside it, but your
key stays with the card for good, and it is what ties an arriving order to your
product without a lookup table. It is also how we recognise the card when it is
published again: a second call with the same `merchant_item_id` updates the
card that is already there instead of creating a duplicate, so publishing can
live in a script and be run as often as you like.

The field `result` describes what the agent receives on delivery. The agent
reads that declaration before paying and decides from it whether the purchase
suits it; your handler then returns JSON exactly to it, and we pass that on
unchanged.

A price in the card is required in every case: it is what the agent sees in the
catalogue while it is choosing. If your price is worked out on the fly — from a
rate, from a supplier's cost, from what is available at that minute — you add a
price check to the card, and then the two work together. When the check
answers, the sale goes through at the price it named. When it is silent, what
happens depends on the mode: a synchronous product sells at the price in the
card, and an asynchronous one does not sell at all, because its buyer is
charged at the moment of purchase and we will not take money for stock nobody
has confirmed. You will answer that question in code on the next step; the
fields of the question and of the answer are in the [card reference](/cards),
and what silence leads to is on [What can go wrong](/failures).

The field `fulfillment` declares the mode. With `'sync'` the goods go to the
agent in the answer to the purchase; with `'async'` they go later. There is a
third mode, `'confirm'`, where you say first that you will deliver and the
buyer is charged only after that — a card cannot be published in it during the
pilot, because the request that asks you has no shape on the wire yet and your
handler could not tell one from a paid order. The product decides which mode it
takes, and the channel only narrows the choice: an API delivers both
synchronously and asynchronously — issuing an eSIM, for one, is paid for at
once while the profile arrives later — and an order that arrived as a message
is never synchronous.

The step is done when the call has returned a catalogue `id`. The card is not
visible outside yet: it goes into the catalogues on step 6.

## 3. Take an order and deliver the goods

We hold the orders in a queue on our side, and you take them from it with a
subscription. You do not have to accept incoming connections: your side opens
the subscription, so neither a public address nor an open port is needed.

You declare what your process answers with `on`, once for each kind of message,
and then open the subscription with `start`. Three kinds travel down that one
connection — orders, price questions, and events about orders — so one
subscription is all you need.

There is a fourth registration, and nothing on the wire carries it.
`coinslot.on('problem', ...)` is where the tools tell you what did not get
through: a poll that failed, a handler that threw, an answer we would not take,
a message that arrived with no handler registered for it. Register it. Without
it those go to the console and nowhere else, and one of them matters more than
the rest — when our side speaks a version of the contract your tools do not,
the subscription stops. Your process stays up and stops selling, and this is
the only thing that says so.

In the synchronous mode the handler returns the result straight away, either
the delivery or a refusal. Both answers are built on the order itself:

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

The answer is whatever the handler returned. We send it ourselves, and there is
no separate call for replying: a forgotten reply would be an order nobody
delivered, and a returned value cannot be forgotten.

In the asynchronous mode the handler answers at once that the order is
accepted, and confirms the delivery itself with a separate call, later and from
anywhere in your code. That call is made on the order you kept, so an
identifier of ours never has to be passed anywhere:

```ts
coinslot.on('order', async (order) => {
  await startProvisioning(order.params.email, { idempotencyKey: order.id })

  return order.accepted({ eta_seconds: 60 })
})

await coinslot.start()

// later, once the delivery is finished, on the order you kept:
await order.deliver({ access_url: url })
```

An `accepted` can name the time you expect the delivery to take, where you know
it; an empty `accepted` is a complete answer too. Until `deliver` is called the
order counts as accepted, and the delivery deadline named in your card is
running on it — it started when the buyer was charged, at the moment of
purchase, before the order reached you. A synchronous card carries no such
field: how long to wait for a synchronous answer is set by us, as one number
for everybody, and it bounds the whole purchase rather than your handler — it
runs from the moment the agent buys.

If your process has restarted in the meantime, the object you kept is gone. The
open orders are then read back from us, and the delivery is made on those
instead — [Finding out where an order stands](/orders).

The call `deliver` is idempotent by the order's identifier. Call it twice and
the second call succeeds as well, marked as already delivered, and no second
delivery appears. Success is the same flag in both cases, so you do not have to
branch on the word inside it. Repeating the call after a dropped connection is
therefore safe, and you do not have to keep a note of what you have already
sent.

If the delivery did not work out and you have already taken the order on, say
so at once, without waiting for your deadline:

```ts
await order.refuse({
  code: 'out_of_stock',
  message: 'The supplier did not confirm the number',
})
```

The buyer has already been charged for an asynchronous order, so a refusal like
this marks the order as needing a refund, and the buyer hears about the debt
straight away. Refusing earlier is cheaper for everybody: what happens to the
money on a refusal in each mode is in the table of modes on [Orders and
fulfillment modes](/orders), and the refusal codes are in the [card
reference](/cards).

Errors from `deliver` and `refuse` are returned rather than thrown, and they
carry a flag saying whether repeating the call is worth anything ([what the
errors are](/orders)).

We read a refusal as a final "this cannot be delivered", so express a temporary
failure on your side by throwing rather than by refusing. The order then counts
as never having reached you and comes again, after a delay ([The handler
crashed without answering](/failures)). What you threw goes to your problem
handler and no further — the agent never sees it.

Besides the purchase parameters, the order carries the sale price — the amount,
the currency, the moment of purchase and the `as_of` of the price it was worked
out from — and a `test` flag that tells a test order from a live one. What an
order is made of in full is in [What an order is made of](/orders).

Orders are delivered at least once, which means the same order can reach your
handler again: after a network break, after your process restarted, after a
retry of ours. Pass the idempotency key on into your own delivery system and
answer with the earlier result under it. If your API already takes a key like
that, ours is the one to give it.

One order goes to one instance of the handler. Run three processes and three
subscriptions divide the stream between them, and no order lands in two
processes at once. Within one instance the orders are worked through one at a
time; a parameter for taking several at once is among the things not settled.

We remember where the orders stand as well, so after a restart you do not have
to rebuild the picture from your own database alone: the open orders can be
read back from us — [Finding out where an order stands](/orders).

The subscription is the default, and the model has two more ways of receiving
an order beside it: a request to an address of yours, for a side that already
has the infrastructure for incoming traffic, and a cursor that pulls orders in
batches. Both work with the same order object, so moving between them does not
mean rewriting the delivery. Neither is open during the pilot.

If a product's price is worked out on the fly, the price question comes down
the same channel. You put the price handler beside the order handler, in the
same process:

```ts
coinslot.on('quote', async (q) => {
  const current = await currentPriceOf(q.merchant_item_id)

  if (current === null) {
    return q.unavailable()
  }

  return q.available(
    { amount: current.amount, currency: 'USD' },
    current.checked_at,
  )
})
```

The answer that there is none carries no price, and we do not begin a purchase
on it.

Both calls take `as_of` as their last argument — the moment the answer is true
for. It separates "went and looked" from "handed over what was in the cache",
it is meant to tell us how far the answer can be trusted — nothing compares it
against a threshold yet — and it goes into the record of the sale. In the example above it is named where the price came from
a lookup that carries its own timestamp, and left out where the handler has
just been and confirmed there is none: an `as_of` left out is the moment of the
answer itself. So if you take the price from a cache, name the moment that
cache was filled; left to the default, the answer claims more freshness than
you have.

This is the path we serve: the same channel the orders use, and nothing of
yours facing outward. A second transport is designed for a business whose price
is worked out by a separate pricing service — the price hook, an https address
of your own that we would call instead. We do not call it yet, and a card that
names one is priced as though nobody had answered, so during the pilot the
price handler is the price check that works. The fields of the question and of
the answer are the same for both and are described in the [card
reference](/cards).

Success here is modest: the process starts, holds the connection, and your
problem handler stays quiet. The first order reaches it on step 5.

## 4. Check the card

Before calling us, run your cards through the check. It reads a card the way we
read it at publication and reports what the contract can see from the card
alone: a result that promises nothing, a deadline on a card whose mode never
uses one, a field of the wrong shape. What it cannot see is your delivery, so a
purchase parameter your delivery needs and the card does not name goes through
unremarked. That one is yours to catch.

```sh
npx coinslot verify card.json
```

That is not yet a command you can run — the package does not declare it, so
today the check is reached through the functions the package exports. Either
way it takes the cards as arguments and reads them off disk. It raises no order
and it does not need your handler running.

There is no silent "invalid": every finding is explained in words and points at
one field of one card. A card whose shape is wrong is not then checked against
the rules that compare one field with another, so a short list of findings is
not a promise that one round of fixes is enough.

The other half of checking yourself is missing, and it is the half worth more.
Whether your handler holds against repeats — whether a second delivery appears
when the same order arrives twice — cannot be checked from here, because
nothing on our surface raises a test order to try it against. The check says so
in its own output instead of reporting a pass, and it claims nothing about your
side. Until that changes, holding against repeats is yours to prove against
your own delivery system, and what has to hold is the effect and not the bytes:
two differently filled answers to one order are fine, a second delivery is not.

## 5. Walk a test purchase

The first purchase of your product is made by our sandbox buyer rather than by
a live agent — a program that walks the whole path: it finds the card, asks the
price, pays and takes delivery. It is a real purchase on test money, and
afterwards the whole chain can be seen working.

During the pilot we start that purchase on your signal: say you are ready, and
we run it with you watching, so that you see what happens at every step. The
order from the sandbox buyer arrives with the `test` flag — and so does every
other order during the pilot, because the sandbox is not separated from the
live system yet. Read the flag; do not fork on it until it can tell one order
from another.

It all came together if the order reached your handler, the sandbox buyer
received the goods, and the purchase left a receipt behind it.

## 6. Go into the catalogues

The card goes into the catalogues once the test purchase has gone through.
Before it is published we check the card for completeness on our side too: an
agent has to be able to buy from it.

Done when the card is visible in a catalogue. From that moment a live agent can
buy it, and connecting new catalogues, moving to new exchange formats and
editing cards as products and prices change are our work and do not touch your
code.

## What is not settled yet

- The price hook. We do not call the address a card names, and when we do, your
  side will need something to check a request against to know that it came from
  us. A price handler has neither question — the subscription channel is
  authenticated when it connects.
- The exact names of an order's fields, and the shape of a refusal.
- The names of the fields a card sets deadlines in, and all of the numbers: how
  long a price holds, how long we wait for a synchronous answer, and the
  defaults for the confirmation and delivery deadlines.
- The subscription's network coordinates: where it connects and what to open
  for it in your outbound rules.
- The parameter that lets one subscription work on several orders at once: its
  name and its default.
- How to take orders outside Node. We document the subscription's wire protocol
  by the pilot; the ready-made tools are for Node only.
- The surface of the other order transports: the request to an address of
  yours, and the cursor that pulls batches.
- What separates the sandbox from the live system: a separate environment, a
  separate access key, or only the `test` flag on the order.
- The half of the check that would send one order twice and watch for a second
  delivery. Nothing on our surface raises a test order to send, and behind that
  sits the question of what separates the sandbox from the live system.
- `coinslot verify` as a command you can run. The card check is written and the
  package exports it; what the package does not declare is the command that
  wraps it.
- How the package reaches you. It is not published anywhere, and the name it is
  installed under is a working one.
- Where to say that you are ready for a test purchase: we have no channel for
  that yet.
- Starting the test purchase with a command of your own — after the pilot.
