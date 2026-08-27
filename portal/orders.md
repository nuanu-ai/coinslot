# Orders and fulfillment modes

*A preliminary contract: the wording can still change before the pilot.*

You are writing the handler that takes paid orders and gives out the goods for
them. Everything it rests on is collected here: what the fulfillment modes
are, what arrives in the handler, how an order can end, and what happens when
time runs out. The working words — card, handler, idempotency key — are
defined on [The first test sale](/quickstart), and the individual failures are
collected on [What can go wrong](/failures).

::: warning The names of the calls and the fields are preliminary
What is fixed is the model and not the signatures. Of the machine names `id`,
`merchant_item_id` and `as_of` are final; the other names on this page are
working names and can still change before the pilot.
:::

## Three fulfillment modes

| Mode | `fulfillment` | The goods reach the agent | When the buyer is charged | If you refused or stayed silent |
| --- | --- | --- | --- | --- |
| Synchronous | `'sync'` | in the answer to the purchase | after your delivery, as the last step | the purchase did not happen and the buyer spent nothing |
| Asynchronous | `'async'` | later, by a separate call | at the moment of purchase, before your delivery | the money is with you and the buyer has no goods: the order is marked as needing a refund |
| With confirmation | `'confirm'` | later, by a separate call | right after your confirmation | before the confirmation nothing is charged; after it, as in the asynchronous mode |

The mode is declared in the card, and the agent knows it before it pays. The
product decides which mode it is, and the channel only narrows the choice: a
connected API delivers both synchronously and asynchronously, while an order
that arrived as a message is never synchronous. What the moment of charging
means for the owner of the business is on [Money](/money).

The third mode is not open during the pilot. A card cannot be published with
`fulfillment: 'confirm'`, because the request that asks you to confirm has no
shape on the wire yet and your handler could not tell one from a paid order.
The rest of this page describes the mode as it is designed.

From the agent's side the asynchronous mode and the confirmation mode look
almost the same: the order and the way of watching where it stands are
identical. What differs is the moment of charging, and one consequence of
confirming — a confirmed order acquires a deadline for the agent to pay it in.

## Where an order comes from

A purchase starts on our side. The agent finds the card, we work out the price
— from the card, or from your price check's answer — and we check the payment.
Only after that does the order appear on yours. Invalid purchases, stale
prices and payments that failed their check never reach your handler.

### What an order is made of

| What | What it is for |
| --- | --- |
| `id` | the order's identifier, and its idempotency key: the same across every repeat |
| `merchant_item_id` | your own key for the product, the one it has in your database |
| `params` | the purchase parameters, already checked against the card's declaration |
| `price` | the sale price: the amount, the currency, the moment of purchase, and the `as_of` of the price it was worked out from |
| `price_id` | the identifier of the price question this sale came out of, absent where the card has no price check |
| `test` | the mark of a test order |

Say an agent buys a month of access. What reaches your handler is your own
`access-monthly`, the email address the agent gave at purchase, an order
identifier of the form `ord_7c1e05` — by which you recognise this same order
if it arrives again — and the sum the access was sold for.

The price is in the order because the sale may not have gone at the card's
price: where a product has a price check, the sale went at the check's answer.
You get the final sum, its currency, the moment of purchase and the `as_of` of
the answer it was worked out from, which is enough to record the sale on your
side without looking the card up. There is no need to compare that sum against
your own price list and refuse on a mismatch — we catch a mismatch before the
order leaves for you.

The field `price_id` ties the order to your own answer about the price: if you
set stock aside against the price you named, this is the moment to write it
off. The identifier is good once, and no second order arrives under it.

### What a handler can answer

A handler has three answers:

- a delivery — JSON to the result declared in the card; the order closes as a
  success;
- a refusal — a short code and a reason a person can read, with the codes
  collected in the [vocabulary of refusal codes](/cards);
- taking the order on, where the goods leave later: you confirm the delivery
  itself with a separate call.

Those three are the whole set, and that matters for how you report a temporary
failure. An exception in the handler, a process that fell over, a connection
that broke — for us each of these means the order never reached you: the
answer did not arrive, so we send the order again, after a delay, until the
mode's deadline runs out. We read a refusal the other way, as a final "this
cannot be delivered", and we close the order on it. So a supplier that did not
answer within five seconds is a reason to throw rather than to refuse.

Silence does not count as an answer: every wait has a deadline, and an order
that runs past its own closes without you.

### The confirmation mode

In this mode one more step comes before the order. The request to confirm
arrives on the same subscription the orders do and is marked as a request to
confirm: the purchase parameters and the price are already in it, and no money
has moved for it yet. Your handler answers it the way it answers an order, with
whichever of the two answers hands nothing over — taking it on means "I will
deliver", a refusal means "I will not". The goods cannot go out in that answer,
because they have not been paid for.

Answer that you will deliver, and the agent's clock for paying starts; after
the payment the same order reaches you in the ordinary way. Answer that you
will not, or stay silent past your deadline, and the order closes with the
buyer having spent nothing.

## Confirming a delivery with a separate call

You close an order you took on with `deliver`, once the delivery is finished.
The call is made on the order itself — the object that arrived in your
handler, or the one you read back from us — and it takes one argument: the
result, to the shape declared in the card, which goes to the agent as it is.

```ts
await order.deliver({ access_url: url, expires_at: until })
```

A delivery carries every field the card's result promises the agent, and a
delivery missing one does not go through
([Delivery result](/cards#delivery-result)).

The call is idempotent by the order's identifier. Call it a second time with
the same `order.id` and it succeeds again, marked as already delivered: no
second delivery happened and no second charge. There is nothing here for your
code to treat as a failure: the flag for success is the same one in both
cases, and you do not have to branch on the word inside it. The word is there
when you do want it — a delivery that closed a refund debt rather than
completing a sale says so. Repeating the call after a dropped connection is
therefore safe, and you do not have to keep a note of what you have already
sent.

A late call is accepted. If your delivery deadline has passed, the order is
already marked as needing a refund and the refund has not yet gone out,
`deliver` closes the debt with the goods: the money for them has been paid,
and late goods are better for the buyer than a refund. If the refund has gone
out by then, the call returns an error — there is nothing left to deliver
against.

Errors from `deliver` and `refuse` are returned rather than thrown, and they
carry a flag saying whether repeating is worth anything. The network let you
down, or our side was slow to answer — repeat with the same call, which is
idempotent. Where the error is marked final — the refund already paid out, for
one — repeating changes nothing, and the case is worth writing down on your
side instead of looping.

## Refusing after you have taken the order on

Taking an order on does not bind you: while the order is open, you can refuse
it with a separate call.

```ts
await order.refuse({
  code: 'out_of_stock',
  message: 'The supplier did not confirm the number',
})
```

The call is for the places where you have already answered that you took the
order on: the asynchronous mode, and the confirmation mode after the payment.
In the synchronous mode the handler refuses in its own answer, and there is no
separate call there at all.

The buyer has already been charged for an order you took on, so a refusal
marks the order as needing a refund straight away. There is nothing to gain by
waiting out your delivery deadline and arriving at the same result through
silence: the buyer hears about the debt the minute you do, instead of a day
later.

## Finding out where an order stands

We remember where the orders stand as well, so you can ask us at any moment.

```ts
const order = await coinslot.orders.get(orderId)
const open = await coinslot.orders.list({ open: true })

for (const waiting of open) {
  const issued = await accessFor(waiting.id)

  if (issued !== null) {
    await waiting.deliver({ access_url: issued.url })
  }
}
```

The first call returns one order, the second every order still open. They are
for the case where your process restarted and no record of the order is left
on your side: the list of open orders shows what is still waiting for a
delivery, so the picture does not have to be rebuilt from your database alone.

Orders from here carry the same calls that orders from the handler do:
`deliver` and `refuse` are made directly on them. After a restart your process
therefore walks the list, asks itself what is ready for each order, and closes
what is ready — without collecting identifiers of ours into a variable of its
own. What is ready is something you know and we do not: the list holds
everything still open, including the orders whose delivery is still under way.

If your own record of the order did survive and it holds our identifier — a
job in a queue, a row in your database — the order can be assembled from it
without asking us anything:

```ts
await coinslot.orders.forId(savedId).deliver({ access_url: url })
```

That call asks nothing, and so it works even when we cannot be reached: `get`
at such a moment throws, while a delivery against a saved identifier goes out
and comes back as an error flagged worth repeating. It
does not read the order itself — there are no purchase parameters and no state
in it, only the calls that close an order.

## Events on the same subscription

Besides orders, the same subscription carries events: messages about something
that happened to an order without you. A handler for them is declared the way
one is for orders, with `coinslot.on('event', ...)`, and it sends nothing back
— an event tells you something happened and asks for no answer.

Which is why an event can reach you twice. An order is acknowledged by the
call that closes it and a price question by its answer, and an event has
neither, so nothing on our side can tell that you already have one. Your
handler is given the message's own identifier beside the event, and that
identifier does not change when the same message is delivered again; telling a
repeat from a new message is yours to do, because it means remembering what
you have seen across restarts and that belongs in your database rather than in
our tools. The event to guard first is the one saying an order needs a refund:
acted on twice, it is a second refund out of your own wallet.

| Event | What happened |
| --- | --- |
| An order was marked as needing a refund | you did not deliver in time, or refused after the charge |
| A confirmed order was not paid for | you answered that you would deliver and the agent did not pay in its own time; you are free |
| A payment did not execute after a synchronous delivery | you delivered and the money never arrived |

## You delivered and the payment did not execute

A rare case, and possible only in the synchronous mode. We check a payment
first and execute it as the last step, after your delivery; between the check
and the execution the funds can leave the buyer's wallet for something else.
Then you have produced the goods and there is no money for them.

In this case the order is marked delivered and unpaid, and an event reaches
you — there is no need to go looking for such cases by reconciling transfers.
For the agent the purchase did not happen: we hand the goods over after the
payment executes, so it received neither the goods nor a charge. The order
stays open on your side.

A repeat purchase is what closes it: the agent repeats it under the same key,
the payment executes, and the order closes on the delivery you have already
made — there is no need to deliver a second time. Whether to revoke what you
gave out or to wait for the repeat is yours to decide; the size of the risk is
bounded by the price of one purchase, and the owner of the business is told
about that risk on [Money](/money).

## How an order can end

An order always closes — with a delivery, with a refusal or on a deadline —
and the agent sees which. Three cases stay open, and all three are rare: the
money was charged and no delivery happened; you delivered and the payment did
not execute; and the payment network never said whether the charge went
through.

| Situation | Where the money is | What the agent sees |
| --- | --- | --- |
| You delivered the goods | with you | the goods and a receipt |
| There is none, the parameters did not fit, the payment failed its check — or you refused in the synchronous mode | never moved | a refusal with a reason; the purchase did not happen |
| You answered "I will not deliver" to a request to confirm | never moved | a refusal, and nothing was charged |
| Time ran out: no confirmation, no payment or no synchronous delivery arrived | never moved | the order was closed on its deadline |
| You left, and the open orders closed | for what was not delivered, [you send it back](/money) | the order is closed, the money will come back |
| The money was charged and no delivery happened | with you | the order is waiting for a refund |
| You delivered synchronously and the payment did not execute | never arrived | the purchase did not happen; a repeat drives the payment home |
| The payment network did not say whether the money was charged | not known — we are finding out and will tell you when we do | "the outcome of the payment is not known", not "refused": a repeat under the same key is safe |

A pause closes no orders: cards stop selling, and the orders already taken on
play out in the ordinary way. Only leaving closes the ones that are open.

A status says exactly what the system knows. Where there is no answer from you
yet, that is what the status says, and the agent does not read not knowing as a
refusal.

## Time ran out

An order whose deadline has passed does not hang in the air. It closes, and
the agent sees how it ended. What happens depends on which step the waiting
was at.

We name the numbers before the pilot. An asynchronous card carries one
deadline of yours, on the delivery, counted from the moment the buyer was
charged, and the agent sees it before it buys; the
confirmation mode has a deadline of its own and it arrives together with the
mode. How long to wait for a synchronous answer is set by us — that is the
general ceiling on how long an agent waits, and no card carries it.

| Situation | Time ran out — what happened |
| --- | --- |
| The agent has the price and is thinking | the price no longer holds; if it still wants to buy, it asks for a fresh one |
| A request asking whether you will deliver has arrived | the order closed, and the buyer's money never moved |
| The agent owes payment for a confirmed order | the order closed and you are free; an event comes to you |
| You are delivering a synchronous order | the purchase did not happen and nothing was charged; a late delivery is not lost — a repeat collects it |
| You are delivering an asynchronous order | the money is already with you, and the order is marked as needing a refund |

## Telling a repeat apart

By the order's identifier: it is the same across every repeat, and your side
answers with the earlier result under it instead of delivering a second time.
Orders are delivered at least once, so a repeat is ordinary traffic; it does
not mean that anything broke.

On the agent's side a repeat works differently in different modes. In the
synchronous mode the order itself is the key: the receipt appears together
with the payment, and the payment executes last here, so at the moment of a
repeat there may not be one yet. In the asynchronous mode and in the
confirmation mode the payment has already gone through, and the repeat goes by
the receipt.

One case stands apart: a repeat of an asynchronous order you have already
delivered. You confirmed that delivery with the `deliver` call rather than
with the handler's answer, so the answer to such a repeat is the one you gave
the first time — taking the order on. There is no need to deliver a second
time or to call `deliver` again, because the order is already closed.

The rule to hold yourself to is about the effect and not the bytes: after a
second order there must be no second delivery, while the two answers may well
differ — you named an expected delivery time in the first, say, and not in the
second.

## Running the handler in several instances

One order goes to one instance. Run the handler in three processes and three
subscriptions divide the stream between them, and one order does not land in
two processes at once.

Your answer is what acknowledges an order: until it comes back, the order
counts as open. A process that fell over or reconnected without answering
leaves the order to go out again, possibly to another instance. That is
ordinary behaviour, and it is what the handler's idempotency by the order's
identifier is for.

Within one instance the orders are worked through one at a time. A parameter
for taking several at once is among the things [not settled](/quickstart).

## Test orders

A test order is marked with the `test` flag, which is how a handler is meant
to tell a check from a live sale: send such an order into your own test
environment, answer with a stub, or serve it like any other.

During the pilot the flag tells them apart for nobody, because every order
carries it. The sandbox is not separated from the live system yet — there is
no separate address and no separate key, and nothing to set the flag from — so
read it if you like, and do not fork on it, or everything goes into your test
environment. What will separate the two in the end is still being chosen; the
item is in the list on [The first test sale](/quickstart).

## You did not deliver in time

A synchronous order carries a deadline after which we no longer start your
delivery. The hard case is a delivery that began before the deadline and
finished after it, by which time the purchase is closed as a refusal with
nothing charged.

Say ten seconds are allowed for a synchronous answer (an example figure). Your
handler began the delivery in the ninth second and finished in the twelfth. By
that second the agent has already had a refusal and spent nothing, but the
access you gave out has not gone anywhere.

Work already done is not lost: a repeat purchase under the same order key
collects the delivery that was made, this time with the payment. So answering
with the earlier result under the key is worth doing after the deadline has
passed too.

Being late is not an error and does not come back as an exception: for a late
answer our tools hand your code the result "the purchase is already closed".
There is one thing to do with it — write the case down on your side. You have
produced the goods, there is no payment for them yet, and it will arrive with
a repeat.

## The price changed while the agent was thinking

A payment at a stale price does not go through: the agent is given a fresh
price and decides again. That is the expected course of events, nothing has
failed, and your side never hears about it — no order appears at all.

## What is not settled yet

- The numbers of the deadlines: how long a price holds, how long we wait for a
  synchronous answer, and the defaults for the confirmation and delivery
  deadlines.
- The threshold at which a price counts as stale: any difference at all, or a
  difference larger than a named one.
- What other events we send. The three named here are a minimum, and we add to
  the catalogue as cases turn up where your side would otherwise learn of
  something only by reconciling by hand.
- The delay before we resend an order that never reached you, and how many
  times we do it.
- The transport for confirmations, for sellers with no API — together with the
  path where an order arrives as a message, after the pilot.
- How your side learns that a refund on an order has gone out: together with
  the mechanics of refunding ([Money](/money)).
