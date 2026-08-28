# 0014. Registration makes a merchant, a key and an account in one act

Date: 2026-08-28
Status: accepted (Dmitry, 2026-08-28: "разрабатывай экраны, реализуй регистрацию")

## Context

ADR-0010 settled the product's shape and the order it is built in: tenancy,
then keys a merchant can make and disable, then registration with mail, then
the card generator. Tenancy is done. The keys exist as commands somebody runs
at a terminal, and `merchant-command.ts` says in its opening paragraph that the
screens are the step after it. Registration is not built at all, and ADR-0009
said so in a sentence with no horizon on it, which was then read out loud as a
refusal — corrected there.

Two things stand between here and a merchant who can sign up.

The first is that the cabinet serves exactly one merchant. It reaches the
gateway with `MERCHANT_API_KEY`, read once at start-up and used for the life of
the process, so every screen shows that merchant's cards whoever is signed in.
The client is already shaped for the change — the key is a parameter — and the
comment beside it names what has to happen: accounts naming their own merchant.
Until that happens, a second account is a second person looking at the first
merchant's money.

The second is that the public catalogue is one across merchants, by decision
(ADR-0010): that is the product. A registration form nobody has to get past
therefore does not just make accounts, it puts a stranger's words on the page
every buyer reads, and their resource in front of every crawler that lists us.

Mail would answer the second by confirming an address, and mail is ADR-0010's
next decision — it needs a provider account nobody in this repository can
create. Waiting for it would stop the road at a step that is not ours to take.

## Decision

**1. Registering makes a merchant, its first key and an account, or it makes
none of them.** One form, one act: an address, a password, and the name the
merchant is shown under. What comes back is a session — the person is signed in
where they stand, because a registration that ends at a sign-in page is a
password typed twice for no reason.

The three are written in one transaction each side of the boundary, and the
boundary is crossed once: the gateway makes the merchant and the key, and the
cabinet writes the account. A cabinet that fails after the gateway has answered
leaves a merchant nobody can sign in as, which is litter rather than damage —
the address is free again and the next attempt makes a new one. The reverse
order cannot be built: the account has nothing to name until the merchant
exists.

**2. An account names its merchant and holds that merchant's key.** The cabinet
builds its gateway client per request, from the key on the signed-in account's
row, and `MERCHANT_API_KEY` leaves the cabinet's configuration. This is the
change the client was shaped for, and it is what makes two accounts two
merchants rather than two people at one.

The key is stored as it was issued, which is a secret at rest in our database,
and that is worth saying rather than passing over. It is the same secret that
sits in plain text in the cabinet's environment today, moved from a file into a
row — the exposure is not new, and what the row buys is that it can be revoked
one merchant at a time instead of by a deployment. What it does not buy is
protection from a copy of the database: unlike a password, which is a
derivation, and unlike a session, which is a fingerprint, this column hands over
what it holds. Whoever reads it can act as every merchant in it. The answer to
that is the same answer as for the environment variable it replaces — the
database is a boundary against the network, not against a host — and the day
that stops being enough, the fix is a secret store, not a cleverer column.

**3. The registration route is public, and behind an invitation code.** The
gateway route that makes a merchant takes no key, because nobody registering
has one yet; what stands in the door instead is one value out of the gateway's
configuration, which a person is given along with the address of the site.
Wrong code and right code answer the same way and take the same time, so the
form is not an oracle for whether registration is open.

This is a door, not a door lock, and its whole justification is the paragraph
above about the shared catalogue: it costs one configuration value and it means
the pilot's sandbox cannot be filled with a stranger's cards by anybody who
finds the hostname. It retires the day an address is confirmed by mail, and the
decision that brings mail is the decision that removes it.

**4. The address is not confirmed, and the cabinet says so where a person can
see it.** Nothing is sent anywhere: ADR-0009 §1 already says the address is a
name rather than a channel, and that stays true for one more decision. A
merchant who registers has proved they hold an invitation, not that they hold
the address they typed. Every screen that shows the address says it is
unconfirmed, so nobody builds on it, and losing a password is still answered by
the command that sets a new one.

**5. Keys are made and disabled from the cabinet, which is what ADR-0010 said
they would be.** Three routes the gateway does not have yet — list this
merchant's keys, issue one, disable one — each scoped to the merchant the
caller's key resolves to, like every other merchant route. The secret is shown
once on the screen that issued it and never again, the same promise the command
makes, and for the same reason.

A merchant cannot disable the key their cabinet is holding. That is a rule in
the route rather than a warning on the screen: it is one click between a
merchant and a cabinet that answers every page with "the gateway will not take
this key", and the way back is a terminal they do not have. Rotating that key is
its own act and is not built here.

## Consequences

The cabinet stops being single-tenant, and the two things that made it so are
gone: the process-wide client and the environment variable behind it. What
replaces the variable is a column, so a deployment has one less thing to set and
one more thing to back up.

Registration is reachable by anybody who has the code and the hostname, which is
the pilot's shape: we hand out the code. It is not open sign-up and does not
pretend to be — the road's third step arrives when mail does.

An account and a merchant are one-to-one from here. A merchant with two people
and a person at two merchants are both refused by that shape rather than by a
check, and both are named in ADR-0009 §9 as the trigger for buying an
authentication component. This decision does not move that trigger; it makes one
more thing that will have to change when it fires.

What is not built and is not pretended to be: confirming an address, resetting a
password by mail, a second person at a merchant, roles, deleting a merchant or
their account, and rotating the key the cabinet itself holds. The first two are
the mail decision. The rest wait for a reason.

## Alternatives rejected

**Open registration, with nothing in the door.** Honest self-service and the
thing the road is heading for, and it cannot be had before an address means
something. The catalogue is shared by decision; an open form puts words nobody
answers for in front of every buyer, and the first cost is not ours to pay but
theirs.

**Wait for mail, and build nothing now.** It stops the road at the one step that
needs an account somebody outside this repository has to create, and it leaves
the cabinet single-tenant for as long as that takes. Everything in this decision
is needed whether the door is a code or a confirmed address; only the door
changes.

**One privileged key for the cabinet, naming the merchant per request.** No key
stored per account, and a smaller-looking secret. It is the same secret: a
cabinet that can act as any merchant is a cabinet whose compromise is every
merchant, which is exactly what the column already is. What it adds is a second
authentication mode on the money path, which ADR-0005 §2 exists to keep thin,
and a route surface where "which merchant" is a parameter somebody can forget to
check.

**Encrypting the stored key.** The question it raises is where the encryption
key lives, and every answer available today puts it in the same process
configuration the merchant key is in now — so it moves the secret one step and
calls it protected. A secret store is the real answer, and it is bought when
there is something to protect that is not a sandbox.

**Registration on the gateway, with the cabinet redirecting to it.** It would
save the cabinet a call. It also puts a public form, a password and a rate
limit on the money path, which is what ADR-0005 §2 says not to do, and the
gateway would then need the account table this decision keeps on the other side.
