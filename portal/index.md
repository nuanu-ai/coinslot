# Connecting to Coinslot

*A preliminary contract: the wording can still change before the pilot.*

You run an online business, and you are deciding whether it is worth putting
your goods where programs do the buying. This page is what that decision is
made of: who buys there, what we will ask you, what we take on ourselves, and
how connecting begins.

## Who buys here

Coinslot puts the goods of an ordinary online business into the catalogues
where AI agents buy — the listings an agent searches when it is looking for
something, run by other people and not by you. An agent is a program that a
person handed a task and a budget; to finish the task it finds the goods it
needs, pays for them and takes delivery, all by itself.

For you that is one more place to sell. Your range does not have to change,
the prices stay yours, and your shop goes on working the way it works now. One
thing is different: on the other side of the sale, in place of a person who
opened your site and pressed the buttons, there is a program. It does not look
at
pictures and does not read reviews. It decides whether to buy from the card,
the text that describes one of your products in a catalogue, and how precisely
that text says what the buyer gets settles how many sales you end up sorting
out by hand.

The money goes from the buyer's wallet straight to yours, one transfer per
sale. It never passes through our accounts, and we take no percentage of it.
The moment the buyer is charged is not the same for every product: for some
the money arrives after you have delivered, for others at the moment of
purchase. That, and the rest of what there is to say about the money, is on
[Money](/money).

## What we will ask you

The conversation about connecting comes down to four questions, and once you
have answered them we have no more questions for you.

1. What you sell. A link to your site, your product list or your documentation is
   enough — we write the cards from those materials. A card carries the title,
   the description, the price and the list of what has to be given at
   purchase. You check the finished card and approve it. Approval goes by
   correspondence rather than by a button: we send you the card, and you
   either say yes or say what to fix. The last word stays with you, because
   the card sells under your name and at your prices.
2. Where to send the money. We need the address of your wallet — buyers'
   payments arrive there. Nothing accumulates on our side, and nothing is paid
   out once a week.
3. Whether the product survives being delivered twice. The same order can
   reach you twice: a connection dropped, an answer never landed, we tried
   again. Access, a key, a link, a subscription go out a second time to the
   same buyer without loss; a unit off a shelf or a one-off code from a
   limited batch does not. During the pilot we take on goods of the first kind
   only, and that is our limit rather than a property of what you sell: we
   have not chosen how money goes back yet, so we sell what we are almost
   certain we can deliver. Once there is a way to send money back, the limit
   comes off ([Money](/money)).
4. How the goods are delivered. There are three paths, and you take the one
   closest to the way your business already works:
   - you have an API — a handler appears beside it that takes paid orders and
     gives out the goods for them;
   - you have an online shop — paid orders show up in it as ordinary ones, and
     you deal with them as you always have;
   - you have neither — the order reaches you as a message, you confirm it and
     deliver; this path we switch on after the pilot.

## Your hands or ours

You only have to write code on the first path. Your own engineer can write the
handler against your API, and the whole path from an empty project to a test
sale is on [The first test sale](/quickstart). If you
have no engineer of your own, or they are busy with something else, we write
the handler and run it ourselves — then what we need from you is access to
your API and your approval of the cards. Either way the sales themselves work
the same.

On the second path, through an online shop, your side has nothing to build: we
set up the link to your shop's admin and run it ourselves, and it asks no
engineering work of you.

The third path, the order that arrives as a message, is designed and not yet
switched on. It comes after the pilot, and it is too early to promise a date
for it.

## After you are connected

Most of the work from there stays with us. We keep the cards up after you are
connected too: the product, what is in it or its price changes, you tell us,
and we make the edit. We connect new catalogues without asking anything of
your side, so you find yourself in them without doing anything; when the
formats we exchange in change, we move everyone at once and your side is not
touched.

You can stop the sales yourself at any moment. The cabinet is a page on our
side that you sign in to, and it shows your cards, your orders and the
receipts for the sales that went through. It carries a pause on each card and
one button that stops selling altogether. Paused, a card stops
selling and disappears from the catalogues, while the orders already taken on
play out in the ordinary way; to be left with no open orders at all you have
to leave entirely.

We also mean to stop selling without your asking, when your side stops
answering or answers too often that the goods are gone — to the buyer that
looks like a promise the catalogue did not keep. That stop is designed and not
built: nothing today counts your refusals or takes your cards off sale on its
own, so during the pilot the switch is the one in your hands, and we watch the
rest with you. What it will look like when it exists is on
[What can go wrong](/failures).

Short answers — what this costs, what happens about refunds, who settles a
dispute — are collected in the [common questions](/faq).

## How to start

During the pilot, connecting starts with a conversation. We go through the
four questions above together, look at what you sell and decide which
products go out first and how they are sold. Then we write the cards, you
approve them, and after a test purchase the products become visible in the
catalogues. There is no sign-up button yet: we run the pilot by hand so that
we see for ourselves where it is awkward for you.

## What is not settled yet

- Where to write to start the conversation: we have neither an address nor an
  application form yet.
- What the subscription costs and what it covers.
- Reconciling the money. Orders are visible in the cabinet, but we write a
  receipt at the moment the goods are delivered, so an order that is paid for
  and not yet delivered appears among the orders and not among the receipts.
  The money arrives straight in your wallet, and putting the two together is
  still yours to do.
- What happens when a purchased period runs out: renewing a subscription and
  buying the same access again are not designed yet.
- What we promise you when it is our side that goes quiet. There is a great
  deal here about your side falling silent and nothing about ours.
- Stopping your selling without being asked. Nothing does it today, and what
  will count as your side having gone quiet, where the limit on "the goods are
  gone" answers sits, and how selling comes back are all open.
