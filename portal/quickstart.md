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
The package name is `@nuanu-ai/coinslot`. The function names and field names in the
examples below remain preliminary: of the machine names only
`merchant_item_id`, `as_of` and our catalogue `id` are final. Changes arrive in
a new package and contract version before the gateway speaks them.
:::

## 1. Install the tools

Everything your side needs is in one package. Its dependency tree is short and
listed outright: our contracts package, and zod, the library that validates
data. Nothing beyond those arrives in your project.

```sh
npm install @nuanu-ai/coinslot
```

Release tags publish this package to the public npm registry. A stable release
is installed through npm's default `latest` channel. Stage 0 does not publish
prerelease versions.

The client needs two things from you: a key, which you keep wherever you keep
the rest of your secrets, and the address to call.

```ts
import { createClient } from '@nuanu-ai/coinslot'

const coinslot = createClient({
  apiKey: process.env.COINSLOT_API_KEY,
  baseUrl: process.env.COINSLOT_URL,
})
```

You make the key yourself, in your cabinet, on the API Keys screen: press
"Issue a key", name it so you can tell it from the next one, and copy it — it
is shown once and never again. The address is the environment you are working
in: `https://test.coinslot.nuanu.ai` while you are building, and
`https://coinslot.nuanu.ai` when you go live. Give the client the address and
nothing after it; it adds the rest of the path itself. A key made in one
environment does not open the other, and a key you issued on the test address
starts with `csk_test_` so you can see at a glance which one you are holding.

This step worked if the client was built. Whether the key and address belong
together is answered by the first call that reaches us, and that call is on the
next step.

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
  price: '5.00 USD',
  params: {
    email: { type: 'string', required: true, title: 'Where to send it' },
  },
  result: { access_url: 'string' },
})

if (!published.ok) {
  console.error(published.error.problems)
}
```

Two fields there are written short and one is missing, and all three are
deliberate. A price goes as one string, the amount and the currency code with a
space between them, or as the two fields written out. A declared field that
needs no title and no `required` mark goes as its type word — `email` above
needs both, so it is written out. And a card that names no fulfillment mode is
synchronous, which is what this one is. The [card reference](/cards) starts
from a card with no purchase parameter on it at all and adds a field at a time,
each under the need for it; the long spelling of all three is there, and what
you write is opened out into it when the card arrives.

An invalid card raises no exception. Every answer to this call carries `ok`,
and it is either true or false: true means the card was accepted and our
catalogue `id` is there beside it, false means the answer carries an `error`
instead. The error has a code to branch on — `card_rejected` where we would not
publish the card — a sentence you can print, and `problems`: the findings
standing between this card and the catalogue, each with a code, words a person
can act on, and the path to the field it is about where it is about one. That
list is never empty.

Not every finding is about the card. A name for buyers to read that you have
not set, or a wallet for your sales to be paid into, arrives in the same list,
so one answer names everything you have to fix instead of handing it to you a
round trip at a time. Sending the same card again gets the same refusal, and
the error says as much: its `retryable` flag is false, because what changes the
answer is fixing what the findings name.

A call that fails for some other reason — a key we do not accept, an address
that does not answer — does throw, as a `CoinslotError`. It carries a `code`.
Where we refused the call in words, that word is the code: a key we will not
take arrives as `not_authorised`, not as something about the network. Where no
answer arrived, or none these tools could read, it is one of the three words
they use for that. It is the same vocabulary either way, and the same one the
returned errors carry. It also carries `retryable`, answering the same question
it answers on a returned error, and `route`, the name of the call it happened
on, so a `catch` can tell what happened without reading the sentence. A client
built wrong — no key, an address that is not an address — is a `TypeError` at
the line that is wrong, before anything leaves your process.

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
price check to the card and answer it in code on the next step, and the sale
then goes through at the price your answer named. What a check that stays
silent costs is on [What can go wrong](/failures), and the fields of the
question and of the answer are in the [card reference](/cards).

The field `fulfillment` declares the mode, and a card that leaves it out is
synchronous. With `'sync'` the goods go to the agent in the answer to the
purchase; with `'async'` they go later, and a card that sells that way names the
mode. Which of the two your product takes decides which handler you write on
the next step. There is a third mode as well, and it cannot be published during
the pilot. That one, and the reason a product rather than a channel picks its
mode, are in the [card reference](/cards).

The step is done when the call has returned a catalogue `id`. Publication is
the act that puts the card in this Coinslot environment's own catalogue, as
long as the merchant and card are selling. The test purchase below proves that
the product can be bought and delivered; it does not publish the card. Whether
an external discovery catalogue indexes the paid resource is a different
measurement, described on step 6.

## 3. Take an order and deliver the goods

We hold the orders in a queue on our side, and you take them from it with a
subscription. You do not have to accept incoming connections: your side opens
the subscription, so neither a public address nor an open port is needed. It
goes out over ordinary HTTPS to the address you gave the client on step 1 — a
request we hold open until something arrives — so what your outbound rules have
to allow is that one host.

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

The worker's first log line says which gateway it started against and whether
the money there is real — it reads that from your own key. Glance at it once
before trusting a green run: a test key rehearses, a live key sells.

In the asynchronous mode the handler answers at once that the order is
accepted, and confirms the delivery itself with a separate call, later and from
anywhere in your code. Write the order's `id` into your own record of the job —
the row or the queue task the delivery is driven from — and make that call
against the identifier you saved:

```ts
coinslot.on('order', async (order) => {
  await startProvisioning(order.params.email, { idempotencyKey: order.id })

  return order.accepted({ eta_seconds: 60 })
})

await coinslot.start()

// later, once the delivery is finished, against the id you wrote down:
await coinslot.orders.forId(savedId).deliver({ access_url: url })
```

An `accepted` can name the time you expect the delivery to take, where you know
it; an empty `accepted` is a complete answer too. Until `deliver` is called the
order counts as accepted, and the delivery deadline named in your card is
running on it — it started when the buyer was charged, at the moment of
purchase, before the order reached you. A card that names none is held to a day.

A synchronous card carries no such field: how long to wait for a synchronous
answer is set by us, as one number for everybody, and it is eight seconds. The
clock starts when the payment checked out, so they are the eight seconds your
handler has, less the trip the order makes to reach you and the trip your answer
makes coming back: the price question is asked and answered on the call before
the payment, and the check itself runs before the eight begin. They are not the
agent's whole wait: the charge executes after your answer, and the ten seconds
we promise the agent for a synchronous purchase cover your answer and that
charge together. The ten start where your eight do, when the payment checked
out, so the check sits on top of them rather than inside — the agent waits for
the check, and then for the ten. Both numbers are ours to set rather than the
card's, and both are what the system you are connecting to runs with ([Time ran
out](/orders)).

The order your handler was given carries that same `deliver` call, and inside
the handler it is the shorter thing to write. Between the handler and the
delivery, though, your process can restart, be deployed over, or hand the job to
another instance, and the object survives none of those; the identifier in your
own record survives all three, and `coinslot.orders.forId` turns it back into an
order that can be delivered against. If your own record is gone as well, the
open orders can be read back from us — [Finding out where an order
stands](/orders).

The call `deliver` is idempotent by the order's identifier. Call it twice and
the second call succeeds as well, marked as already delivered, and no second
delivery appears. `ok` is true in both cases, so you do not have to branch on
the word inside it. Repeating the call after a dropped connection is therefore
safe. What such a repeat has to carry is on [Telling a repeat
apart](/orders#telling-a-repeat-apart).

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

Failures of `deliver` and `refuse` are returned rather than thrown, in the same
envelope the publish call answers in: `ok` is false and one `error` beside it
carries a code, a sentence and a flag saying whether repeating the call could
change the outcome. Which codes arrive when, and what each of them means for
your next move, is on [When a closing call does not go
through](/orders#when-a-closing-call-does-not-go-through).

We read a refusal as a final "this cannot be delivered", so express a temporary
failure on your side by throwing rather than by refusing. The order then counts
as never having reached you and comes again, after a delay ([The handler
crashed without answering](/failures)). What you threw goes to your problem
handler and no further — the agent never sees it.

Besides the purchase parameters, the order carries the sale price — the amount,
the currency, the moment that price was fixed for this sale and the `as_of` of
the price it was worked out from — and a `test` flag that tells a test order
from a live one. What an order is made of in full is in [What an order is made
of](/orders).

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
the same channel. You put the price handler — the one you register under
`on('quote', …)` — beside the order handler, in the same process:

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
against a threshold yet — and it goes into the record of the sale. In the
example above it is named where the price came from a lookup that carries its
own timestamp, and left out where the handler has just been and confirmed there
is none: an `as_of` left out is the moment of the answer itself. So if you take
the price from a cache, name the moment that cache was filled; left to the
default, the answer claims more freshness than you have.

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

The check we ship is what goes in front of every publish from here on. Calling
us is the short loop while you are fixing one card by hand; once publishing
lives in a script or in your build, running the check first is what keeps a card
that cannot be published from getting as far as the call. It reads a card the
way we read it at publication and reports what the contract can see from the
card alone: a result that promises nothing, a deadline on a card whose mode
never uses one, a field of the wrong shape. What it cannot see is your delivery,
so a purchase parameter your delivery needs and the card does not name goes
through unremarked. That one is yours to catch.

```sh
npx coinslot verify card.json
```

Run it from the project you installed into. The bare name `coinslot` belongs to
somebody else's package on npm, so `npx` in a directory without our package
fetches theirs; once `@nuanu-ai/coinslot` is installed beside you, `npx` finds ours
first and the stranger's never enters it.

Name the card files. The command does not go looking for them: it takes no key
and no address, so it cannot ask us what you have published, and nothing says
where you keep the files you publish from — called bare, it refuses and prints
those reasons rather than checking nothing quietly. It raises no order and it
does not need your handler running.

The same check is also a function the package exports, which takes a card you
have already parsed and hands its findings back in the shape a refused publish
carries them in. That is the one to call where the cards are assembled in code
rather than kept in files.

There is no silent "invalid": every finding is explained in words, and all but
one point at a field — a file that is not JSON at all is a finding about the
card as a whole. A card whose shape is wrong is not then checked against the
rules that compare one field with another, so a short list of findings is not a
promise that one round of fixes is enough.

The other half of checking yourself is missing, and it is the half worth more.
Whether your handler holds against repeats — whether a second delivery appears
when the same order arrives twice — cannot be checked from here, because
nothing on our surface raises a test order to try it against. The check says so
in its own output instead of reporting a pass, and it claims nothing about your
side. Until that changes, holding against repeats is yours to prove against
your own delivery system, and what has to hold is that a second order produces
no second delivery and no fresh goods — the buyer keeps what the first delivery
carried ([Telling a repeat apart](/orders#telling-a-repeat-apart)).

## 5. Walk a test purchase

The first purchase of your product on the configured test channel is made by
our sandbox buyer rather than by a live agent — a program that walks the whole
path: it finds the card, asks the price, pays and takes delivery. It pays with
test funds, and afterwards the whole test path can be seen working.

During the pilot we start that purchase on your signal: say you are ready, and
we run it with you watching, so that you see what happens at every step. The
order it leaves carries `test: true`, because the test address settles on a
test chain — the flag follows the chain the payment settled on and not the key
you called with.

It all came together if the order reached your handler, the sandbox buyer
received the goods, and the purchase left a receipt behind it.

## 6. Prove the sale; measure external discovery separately

The publish call on step 2 puts the card into that Coinslot channel's own
catalogue before this purchase. The purchase is the proof that an agent can
buy it: the order reaches your handler, the buyer receives the declared goods,
and the sale leaves a receipt.

A settled payment is also the event an external discovery catalogue such as
Coinbase Bazaar may index. That is a different surface from Coinslot's own
catalogue, and indexing is not established merely because the purchase or the
receipt succeeded. We measure it and report "settled, not yet listed" when the
settlement is known but no external listing has appeared; whether a testnet
settlement is eligible remains an open question.

Publication on the live channel is a separate act with that environment's key.
Passing the test-channel purchase copies neither a card nor its evidence into
the live environment. Connecting new catalogues, moving to new exchange
formats and editing cards as products and prices change are our work and do
not touch your code.

## What is not settled yet

- The price hook. We do not call the address a card names, and when we do, your
  side will need something to check a request against to know that it came from
  us. A price handler has neither question — the subscription channel is
  authenticated when it connects.
- The exact names of an order's fields, and of the two fields a handler's
  refusal carries. Their shapes are settled and described on these pages; the
  spelling can still change before the pilot, in a new package and contract
  version.
- The names of the fields a card sets deadlines in.
- The parameter that lets one subscription work on several orders at once: its
  name and its default.
- How to take orders outside Node. We document the subscription's wire protocol
  by the pilot; the ready-made tools are for Node only.
- The surface of the other order transports: the request to an address of
  yours, and the cursor that pulls batches.
- The half of the check that would send one order twice and watch for a second
  delivery. Nothing on our surface raises that order to send, so this check
  still cannot exercise your delivery system's idempotency from outside.
- Where to say that you are ready for a test purchase: we have no channel for
  that yet.
- Starting the test purchase with a command of your own — after the pilot.
