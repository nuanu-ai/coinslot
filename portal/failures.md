# What can go wrong

*A preliminary contract: the wording can still change before the pilot.*

You have written the handler, or you are writing it now, and this page is what
will go wrong with it. Refusals and failures are part of ordinary work for us,
and every case below is laid out the same way: first how it ends for the buyer
and for you, then why it is built that way and what to do about it.

There is one thing that decides every case below. Faced with not knowing, we
either carry the sale on or stop it, and what settles that is not the severity
of the failure but where the money is at that moment: while your answer comes
before the money, your silence costs the buyer nothing; where the money moves
at once, your silence stops the sale. The moments of charging in each mode are
in a table on [Orders and fulfillment modes](/orders).

## The price check is silent

In the synchronous mode and in the confirmation mode the purchase carries on:
we take the price from the card and sell at it. In the asynchronous mode the
purchase does not begin — the agent gets a refusal, and no order appears on
your side.

The difference is set by where the money is. In the first two modes your live
answer stands between the price and the charge: you still have time to deliver
or to refuse, and a second of your side being unreachable should not cancel a
sale that can be made honestly at a known price. In the asynchronous mode the
money leaves at once, and a sale made while availability is unknown would turn
into a debt to the buyer — a lost sale is cheaper than that debt.

Four things count as silence: no answer for longer than the timeout; a server
error or a network failure in place of an answer; an answer that did not parse
against the declared shape; and a timestamp in the answer older than the
freshness threshold. Both numbers, the timeout and the threshold, we name
before the pilot. Which transport you answer over makes no difference: a price
handler has the same boundaries as a hook.

Silence like this does not stop your selling. The automatic stop described
below goes by deliveries, and a side that cannot name a price but hands over
the goods reliably has not gone quiet by that measure.

What follows for you differs by mode. For synchronous products and products
with confirmation, keep the price in the card current: in a minute of silence
it is the price of the sale. For asynchronous products a silent check costs
you sales for as long as it lasts.

## You could not deliver

What your refusal turns into depends on the moment it arrives. In the
synchronous mode the purchase does not happen: nothing has been charged yet
and the buyer spends nothing. In the confirmation mode an "I will not deliver"
answer to a request to confirm closes the order just as freely, while a
refusal after the confirmation arrives against money already charged. In the
asynchronous mode the money has been with you from the start, and such an
order is marked as needing a refund.

A refusal in itself is an ordinary answer from a handler: there is none, the
parameters do not fit, the delivery is impossible. The buyer gets a clear
answer, and you are not left with an order to sort out by hand later.

From which the choice of mode follows: if refusals at delivery happen to you
regularly, catch them earlier, in the answer to the question about price and
availability, before the money. What happens to the money on orders that need
a refund is in [If the buyer did not get the goods](/money).

## The handler crashed without answering

The order will arrive again. We count a handler's answer only once it has come
back: an exception inside the handler, a process that fell over, a connection
that broke — for us all of these mean the order never reached you, and we
repeat the delivery, after a delay, until the mode's deadline runs out.

From which a practical rule follows: a temporary failure is expressed by
throwing rather than by refusing. We read a refusal as a final "this cannot be
delivered" and close the order on it, so a supplier that did not answer within
five seconds is not worth a refusal — a repeat a minute later might well have
gone through.

The repeats are not endless; they run into the deadline, and what happens
after that is in the next section.

## No answer about the delivery

Silence ends the same way a refusal does, only on a deadline. In the
synchronous mode the purchase closes with nothing charged. In the asynchronous
mode the order is marked as needing a refund, because the money has already
gone. In the confirmation mode, silence in answer to a request to confirm
closes the order at no cost, while silence after the confirmation ends the way
the asynchronous mode does.

Say you have allowed a day for delivering an asynchronous product (an example
figure). The day passes with no confirmation of a delivery from you — the
order is marked as needing a refund, and the money for it is already with you.
You set the deadline for asynchronous delivery yourself, in the card, and the
agent sees it before it buys; how long to wait for a synchronous answer is set
by us.

It works this way because an order that waits forever is worse than an honest
refusal: the agent holds its budget tied up and can neither buy from your
neighbour nor finish its task.

A late answer matters in one case: the delivery started before the deadline
and finished after it. By then the purchase is closed, but the work already
done is not lost — a repeat purchase collects the delivery along with the
payment, and that is described in
[You did not deliver in time](/orders).

## An order arrived twice

The handler receives an order it already knows and answers with the earlier
result under the idempotency key. No second delivery happens, and no second
charge either.

Repeats are an ordinary event here: orders are delivered at least once, and
the same order arrives again after a connection breaks, after your process
restarts, after a retry of ours.

That your side really does hold against repeats can be checked before
publishing: our check sends one order twice and watches for a second delivery
— that is the [step where you check yourself](/quickstart). Those orders
travel the ordinary path, through the live subscription, so the handler has to
be running while the check runs. It compares the effect and not the bytes of
the answers, so two differently filled answers to one order are not a fault.

## The buyer paid and the answer was lost

The buyer repeats the purchase and receives what you have already delivered.
No second charge happens, and no second delivery is asked of you.

The case looks like this: the agent sent the purchase, you carried it out, and
the answer did not reach the agent — the connection broke, or its own process
fell over. Not knowing whether the purchase went through, it repeats it under
the same key. We find the completed purchase by that key and hand back the
result that is ready, and in this case the repeat does not reach your side at
all.

Your part of the work is the same as ever: answer with the earlier result
under the idempotency key. If a repeat did reach the handler — because the
purchase had not finished closing, for instance — you answer with what you
answered the first time. Which key recognises a repeat in which mode is in
[Telling a repeat apart](/orders).

## The goods ran out

The purchase does not happen and the buyer's money does not move, provided you
said so in time. You can say it in the answer to the question about price and
availability, or by refusing at delivery; the first is cheaper, because it
lands before the money in every mode.

We keep no stock counts and do not work them out for you: the only source of
truth about availability is your side. Which is exactly why goods that can run
out are worth listing with a price check.

The share of purchases that run into missing goods is something we measure and
hold below a limit we name before the pilot: to an agent, a purchase like that
looks like a promise the catalogue did not keep.

## Your side went quiet for a long time

Selling stops by itself, without you. Cards stop selling and the orders
already taken on play out in the ordinary way — the same pause you switch on
by hand, switched on automatically.

That is how we defend against the worst case, where buyers pay for goods
nobody delivers. Selling can be paused and unpaused by hand at any moment as
well — [how that is done](/faq).

## What is not settled yet

- The conditions for the automatic stop: how many failures in a row and over
  what period switch it on, and how selling comes back.
- The limit on the share of purchases that run into missing goods.
- The timeout on a price answer, and the freshness threshold past which an
  answer counts as silence.
- The delay before we repeat the delivery of an order that never reached you,
  and how many times we repeat it.
- What happens when it is we who go quiet: how your side sees it, and what we
  promise in that case.
