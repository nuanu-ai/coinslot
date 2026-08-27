# Common questions

*A preliminary contract: the wording can still change before the pilot.*

Short answers, each with a link to where the question is worked through in
full. The first half comes from what people ask while deciding whether to
connect; the second from what they ask once they sit down to write the code.

## Questions from the owner

### Do I have to rebuild my shop?

No. The shop and its code stay as they are, and the range and the prices stay
yours. Where a product is delivered through your API, a handler appears beside
the shop that takes paid orders and gives out the goods for them; nothing
inside the shop changes. The three ways of delivering, and how they differ,
are worked through on [Connecting to Coinslot](/).

### Do I need an engineer for this?

It depends which delivery path you take. The link to an online shop is set up
and run by us, and it asks no engineering work of your side. A handler against
your API can be written by your engineer with our tools, and if you have no
engineer of your own, or they are busy with something else, we do that part
and run it ourselves — what we need from you then is access to the API and
your approval of the cards. The choice is described in
[Your hands or ours](/).

### What does it cost?

We take no percentage of the payments: the money goes from the buyer's wallet
straight to yours, past us. We earn on the tools and on a subscription. The
price of the subscription and what it covers we name before you connect —
that, and the rest of the money, is on [Money](/money).

### Do you write the product cards, or do I?

We do, from your site, your catalogue or your documentation, and you check
them and approve them. Approval goes by correspondence rather than by a
button: we send you the card, and you either say yes or say what to fix. The
last word stays with you, because the sale goes out under your name and at
your prices. Keeping the cards up is our work too: the product, what is in it
or the price changes, you tell us, and we make the edit. If you would rather
keep the cards yourself, the tools for it are there:
[The first test sale](/quickstart).

### Will live customers come to me?

No. The buyers here are programs carrying out a person's instruction and
paying from a budget they were given; the person themselves does not visit
your site, does not fill a basket and does not write to your support. Whether
to buy is decided by the program from the text of the card, and what that text
has to do is described in the [card reference](/cards).

### How do I find out about a sale?

The order reaches you by whichever way we agreed when you connected: into your
API, into your online shop as an ordinary paid order, or as a message. The
payment arrives as its own transfer into your wallet, before your delivery or
after it depending on the product: [Money](/money). Orders are visible in the
cabinet, a page on our side that also holds your cards and the switch that
stops selling. It is not a full picture of the money: we write a receipt at
the moment the goods are delivered, so an order that is paid for and not yet
delivered is in the list of orders and not among the receipts. The money
arrives straight in your wallet, past us, and matching the two up is still
yours to do.

### Can I pause the selling?

Yes, at any moment and with your own hands: the cabinet has a pause on each
card and one button that stops selling altogether. Paused, a card stops
selling and disappears from the catalogues, while the orders already taken on
play out in the ordinary way. If your side stops answering, selling stops
without you as well — [the automatic stop](/failures) works the same way. The
full list of how an order can end is in [How an order can end](/orders).

### Can I leave altogether?

You can, and it is an ordinary operation. The cards come out of the
catalogues, the open orders close, and the money for anything undelivered you
send back to the buyers yourself, from your own wallet: that is where it
arrived. Neither your money nor your goods are left with us — they always went
past us anyway. One thing does remain: the key to your API, if we were the
ones writing and running the handler. Revoke it, and our side can no longer
reach yours. The obligation to refund, and what is still unchosen in its
mechanics, is described on [Money](/money).

### The buyer is unhappy — who settles the dispute?

You do, by your own rules, the same way you settle one in an ordinary shop. We
do not stand between you and the buyer and do not make decisions on your
behalf: the rules about refunds and about good faith are yours, and they are
not ours to apply for you. Our part is technical — we hand you the order and
the records of what happened with the delivery and when, including
[the receipt with the sale price](/money).

### What do buyers pay with?

A stablecoin: a digital dollar, meaning money whose rate is pegged to the
dollar, so nothing is converted between the purchase and the arrival. Which
digital dollar, and which network the transfers run over, is still being
chosen: [Money](/money).

## Questions from the engineer

### The goods ran out or the price changed — how do you find out?

We ask you at the moment of purchase, where the card has a price check turned
on. Your code answers it: by default a price handler in the same process as
the order handler, and where the price is worked out by a separate pricing
service, a price hook instead — an address on your side. The fields of the
question and of the answer are the same for both
([what to answer with](/cards)). The sale then goes at the price you named,
and an answer of "there is none" closes the purchase before any money moves.
Without a check we sell at the card's price and hear that the goods have run
out from your refusal at delivery; what happens when the check is silent is on
[What can go wrong](/failures).

### The same order arrived twice — is that normal?

Yes, it is an ordinary event: orders are delivered at least once, and one
arrives again after a connection breaks, after your process restarts, after a
retry of ours. The handler has to answer with the earlier result under the
idempotency key instead of delivering a second time. Which key recognises a
repeat in which mode is in [Telling a repeat apart](/orders).

### What do I check myself with before publishing?

The `coinslot verify` command, on your side. It looks at two things: whether
the card is enough for an agent to assemble a correct purchase, and whether
your handler holds against repeats — that is, whether a second delivery
appears when the same order arrives twice. It compares the effect and not the
bytes of the answers. The whole step is in [Check yourself](/quickstart).

## What is not settled yet

- The timings of the procedure for leaving, and what becomes of orders taken
  on at the last moment.
- What the records of a delivery contain, the ones we hand you to settle a
  dispute with.
- How a complaint reaches you at all: the buyer is a program, and the person
  it was buying for does not write to your support.
