# What can go wrong

*A preliminary contract: the wording can still change before the pilot.*

You have written the handler, or you are writing it now, and this page is what
will go wrong with it. Refusals and failures are part of ordinary work for us,
and every case below is laid out the same way: first how it ends for the buyer
and for you, then why it is built that way and what to do about it.

We settle every case below the same way. Faced with not knowing, we either
carry the sale on or stop it, and what decides is not the severity of the
failure but where the money is at that moment: while your answer comes before
the money, your silence costs the buyer nothing; where the money moves at once,
your silence stops the sale. The moments of charging in each mode are in a
table on [Orders and fulfillment modes](/orders).

The confirmation mode appears below because the design has three of them. A
card cannot be published in it during the pilot, and the reason is on [The
product card](/cards).

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
before the pilot. Those boundaries are a price handler's. A card that names a
price hook instead counts as silent every time, because we do not call that
address yet ([the card reference](/cards)).

Silence like this does not stop your selling. The automatic stop described
below goes by deliveries: silence about a price is not silence about the goods.

What follows for you differs by mode. For synchronous products and products
with confirmation, keep the price in the card current: in a minute of silence
it is the price of the sale. For asynchronous products a silent check costs you
sales for as long as it lasts.

## You could not deliver

What your refusal turns into depends on the moment it arrives. In the
synchronous mode the purchase does not happen: nothing has been charged yet and
the buyer spends nothing. In the confirmation mode an "I will not deliver"
answer to a request to confirm closes the order just as freely, while a refusal
after the confirmation arrives against money already charged. In the
asynchronous mode the money has been with you from the start, and such an order
is marked as needing a refund.

A refusal in itself is an ordinary answer from a handler: there is none, the
parameters do not fit, the delivery is impossible. The buyer gets a clear
answer, and you are not left with an order to sort out by hand later.

This is also how the mode gets chosen: if refusals at delivery happen to you
regularly, catch them earlier, in the answer to the question about price and
availability, before the money. What happens to the money on orders that need a
refund is in [If the buyer did not get the goods](/money).

## The handler crashed without answering

The order will arrive again. We count a handler's answer only once it has come
back: an exception inside the handler, a process that fell over, a connection
that broke — for us all of these mean the order never reached you, and we
repeat the delivery, after a delay, until the mode's deadline runs out.

What your handler threw does not travel to us or to the agent. It goes to the
handler you registered for problems, which is also where a failed poll, a
refused answer and a message nobody claimed arrive ([registering
one](/quickstart)).

So the practical rule is to express a temporary failure by throwing and not by
refusing. We read a refusal as a final "this cannot be delivered" and close the
order on it, so a supplier that did not answer within five seconds is not worth
a refusal — a repeat a minute later might well have gone through.

The repeats are not endless; they run into the deadline, and what happens after
that is in the next section.

## No answer about the delivery

Silence ends the same way a refusal does, only on a deadline. In the
synchronous mode the purchase closes with nothing charged. In the asynchronous
mode the order is marked as needing a refund, because the money has already
gone. In the confirmation mode, silence in answer to a request to confirm
closes the order at no cost, while silence after the confirmation ends the way
the asynchronous mode does.

Say you have allowed a day for delivering an asynchronous product (an example
figure). The day passes with no confirmation of a delivery from you — the order
is marked as needing a refund, and the money for it is already with you. An
asynchronous card can carry a delivery deadline of yours: name it and the agent
sees it before it buys, leave it out and a default of ours applies that neither
of you is shown ([The product card](/cards)). How long to wait for a synchronous
answer is set by us and no card carries it.

It works this way because an order that waits forever is worse than an honest
refusal: the agent holds its budget tied up and can neither buy from your
neighbour nor finish its task.

A late answer matters in one case: the delivery started before the deadline and
finished after it. By then the purchase is closed, but the work already done is
not lost — a repeat purchase collects the delivery along with the payment, and
that is described in [You did not deliver in time](/orders).

## An order arrived twice

The handler receives an order it already knows and answers with the earlier
result under the idempotency key. No second delivery happens, and no second
charge either.

Repeats are an ordinary event here: orders are delivered at least once, and the
same order arrives again after a connection breaks, after your process
restarts, after a retry of ours.

Whether your side really holds against repeats is not something we can check
for you yet: nothing on our surface raises a test order to send twice, and the
check we ship says so instead of reporting a pass ([Check the
card](/quickstart)). Proving it is yours, and what has to hold is that a second
order produces no second delivery and no fresh goods: the buyer keeps what the
first delivery carried, so the repeat has to carry the same thing ([Telling a
repeat apart](/orders#telling-a-repeat-apart)).

## The buyer paid and the answer was lost

The buyer repeats the purchase and receives what you have already delivered. No
second charge happens, and no second delivery is asked of you.

The case looks like this: the agent sent the purchase, you carried it out, and
the answer did not reach the agent — the connection broke, or its own process
fell over. Not knowing whether the purchase went through, it repeats it under
the same key. We find the completed purchase by that key and hand back the
result that is ready, and in this case the repeat does not reach your side at
all.

Your part of the work is the same as ever: answer with the earlier result under
the idempotency key. If a repeat did reach the handler — because the purchase
had not finished closing, for instance — you answer with what you answered the
first time. Which key recognises a repeat in which mode is in [Telling a repeat
apart](/orders).

## The goods ran out

The purchase does not happen and the buyer's money does not move, provided you
said so in time. You can say it in the answer to the question about price and
availability, or by refusing at delivery; the first is cheaper, because it
lands before the money in every mode.

We keep no stock counts and do not work them out for you: the only source of
truth about availability is your side. So goods that can run out are worth
listing with a price check.

The share of purchases that run into missing goods is what we mean to measure
and hold below a limit, because to an agent a purchase like that looks like a
promise the catalogue did not keep. Nothing counts it yet, and the limit is not
named.

## Your side went quiet for a long time

Nothing stops selling on its own today. The switch is the one in your hands,
and pausing and unpausing are yours to do at any moment — [how that is
done](/faq).

An automatic stop is designed, and it is the defence against the worst case,
where buyers go on paying for goods nobody delivers: your cards would come off
sale and the orders already taken on would play out, exactly as a pause you set
by hand does. Nothing builds that yet, so during the pilot we watch for the
case with you rather than instead of you.

## What is not settled yet

- The automatic stop itself. Nothing builds it yet, and neither its conditions
  — how many failures in a row and over what period — nor the way selling comes
  back afterwards is settled.
- The limit on the share of purchases that run into missing goods.
- The timeout on a price answer, and the freshness threshold past which an
  answer counts as silence.
- The delay before we repeat the delivery of an order that never reached you,
  and how many times we repeat it.
- What happens when it is we who go quiet: how your side sees it, and what we
  promise in that case.
