# 0013. An effect commits with the state that implies it

Date: 2026-08-27
Status: accepted (autonomous mandate; the pilot gate below is when it must hold)

## Context

`Runner#apply` writes the order inside the store's transaction and then carries
out the effects the machine returned: the envelope that hands the order to the
merchant, the receipt, the deadline that has to fire if nobody answers. The
write commits first and the effects run after, so the window between them is a
window in which the record says one thing happened and nothing did.

What that costs, in the order it hurts:

- The money moved and the order says `paid`, and the merchant was never handed
  the work. A retry does not repair it: the state has already moved past the
  transition that emits the dispatch, so nothing re-emits it.
- An order says `delivered` and no receipt was written. The receipt is what a
  merchant reconciles a wallet against, so the sale is invisible to them.
- A deadline that was never armed is an order that never times out. Nothing
  refunds a buyer whose merchant went quiet, because nothing notices.

An external review of `main` put this first among the things that block a
pilot, and it was right to. Today it costs nothing, because the sandbox settles
against nothing and every order is marked a test — which is exactly why it is
worth deciding now rather than under a real payment.

## Decision

**An effect that must not be lost is enqueued inside the same transaction that
writes the state implying it.** Both live in one Postgres already (ADR-0003 §6:
the cards, the orders, the receipts and the queue), and pg-boss takes a `db`
handle in its send options whose whole contract is `executeSql(text, values)` —
so the job insert can be made on the client already inside the store's
transaction, and it commits or rolls back with the order. Read from the
installed library rather than assumed.

That covers the queue-shaped effects that carry something to a merchant: the
dispatch, the redelivery, the merchant events. It does not cover the receipt,
which is a row of ours in the same database — and that one is simpler still,
because a write in the same transaction is all it needs.

It does not cover the reminders either, and this decision said it did until
the work implementing it showed why it should not. A reminder is armed before
the order is written rather than after, so the direction that cannot be
repaired — an order handed out with no clock running — is already impossible;
and a reminder left behind for a transition that never happened is refused by
the machine when it fires. Pulling it into the transaction would remove
harmless litter at the cost of a longer hold on the row, which is the wrong
trade. The sweep re-arms a clock that was never armed, which is the half that
matters.

**A periodic sweep derives what is still owed from the state itself**, as the
answer to whatever slips anyway. It is not a second bookkeeping of intent; it
asks the orders what they are missing — a `paid` order with no envelope drawn,
a `delivered` order with no receipt, an open order with no deadline armed — and
does the missing thing. The mechanism exists: `queue.everyDay` already runs the
claims sweep on the queue's own scheduler.

The sweep is the part that must be written to be safe to run twice, because it
will be. Every effect it re-drives has to be one the receiver already tolerates
twice, which the wire already promises for the dispatch and which the receipt's
own key gives for free.

## Consequences

The failure this removes is the one that cannot be retried: a state that has
moved past its own effect. After this, a process that dies mid-flight either
did both or did neither, and what it did not do is found by asking the orders.

It does not make delivery exactly-once and does not try to. Everything here is
at-least-once, which is what the contract already promises a merchant and what
their handler is already told to survive.

It buys nothing against a Postgres that is simply gone — the transaction fails
and the purchase fails, which is the correct outcome and the one the buyer can
retry.

The sweep can do work twice if it runs beside a recovering process. That is the
reason it is confined to effects whose receivers tolerate a repeat, and the
reason it is a decision rather than a detail: any future effect that does not
tolerate one cannot be swept, and has to say so where it is defined.

**Tolerating a repeat on the wire is not the same as a repeat being free**, and
this decision read as though it were. A merchant's handler is told to expect the
same order twice and does survive it — but a second hand-over spends one of that
order's five redeliveries, and the attempt cap closes a paid order into a debt.
So the sweep costs the merchant a delivery they never failed, and enough of
those cost them the sale and the money. Building this is what showed it: the
sweep now asks the merchant's own stream whether an envelope is still waiting
and leaves that order alone, and it runs one at a time under a lock, because
two runs beside each other both saw an empty stream and both published. Neither
guard follows from "the receiver tolerates a repeat", which is why the sentence
above is not enough on its own.

The rule that replaces it: an effect may be swept when its receiver tolerates a
repeat **and** repeating it costs the order nothing that belongs to a real
failure. The second half is the one that has to be argued each time.

## Alternatives rejected

**A table of intents drained by a worker — the usual outbox.** It is the
textbook answer and here it would be a second queue beside the queue we have.
pg-boss's job table already is a durable record of intent in the same database;
adding another means two things to drain, two to observe, two to get wrong, and
a new schema. The property that makes an outbox work — writing the intent in
the state's own transaction — is available without the table.

**Run the effects before committing the state.** Worse in the direction that
matters: an effect that ran against a state change that then rolled back is a
merchant handed an order that does not exist, and there is no record to
reconcile it against.

**Leave it and name the gap.** Defensible while the sandbox settles against
nothing, and it is what today does. It stops being defensible at the first real
payment, and that is the gate: this holds before mainnet, or mainnet waits.
