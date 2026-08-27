# 0009. The cabinet signs in a person, not a key

Date: 2026-08-27
Status: accepted (Dmitry, 2026-08-27: "сделай нормальный логин")

## Context

The cabinet signs a merchant in by asking for the gateway's `MERCHANT_API_KEY`,
putting that key into an HttpOnly cookie, and forwarding the same key on every
call it then makes to the gateway. One secret does two jobs: it is the password
of a machine and the password of a person at the same time.

Four things follow from that, and they are the reason this decision exists —
not the mechanism.

Rotating the key signs the human out of the cabinet and breaks the merchant's
running code, in the same instant. Those are two different acts with two
different reasons behind them, and today neither can be done alone.

Nothing knows who did anything. A merchant with two people cannot tell which of
them stopped all selling, because there is no person in the system at all —
there is a key, and the key has no name.

A session cannot be ended without rotating the key, and rotating the key is the
thing above. Somebody who leaves, or a laptop that is lost, can only be answered
by breaking the merchant's integration.

And the key itself now lives in a browser, having been typed into a form by
whoever was sitting there.

The pilot has one merchant and we create their account by hand, so this is
solved at the size the pilot actually is rather than at the size a signup funnel
would be.

## Decision

**1. A person has an account, and we create it.** An account is an email
address, a password, and nothing else. There is no self-serve sign-up and no
password reset by mail: the pilot has one merchant, we know who they are, and we
make the account with a command. The email address is a name a person already
knows how to type and that no two people share — it is not a channel, and
nothing in this system ever sends anything to it.

**2. Passwords are stored as `scrypt` derivations, using `node:crypto`.** The
stored value names its own parameters — `scrypt$N$r$p$salt$key` — so the cost
can be raised later without a migration and without a second field to keep in
step. The comparison is `timingSafeEqual` over the derived keys, and a sign-in
for an address that has no account derives against a decoy anyway, so the time
an answer takes does not say whether the address exists.

This is the one place the charter's rule about not hand-building infrastructure
(ADR-0003 §9) is worth arguing rather than obeying. The rule is about
components: a queue, retries, a scheduler. `scrypt` *is* the component here —
it is a reviewed key-derivation function that ships with the runtime — and what
is written by hand is the hundred lines that encode a salt and compare two
buffers. An authentication framework would bring a session model, a user model,
an adapter layer and a migration story we would then have to bend around a
cabinet that has one merchant. The trigger for taking one is named below.

**3. A session is a row, and the cookie carries an identifier and nothing
else.** The identifier is 32 random bytes; what the database holds is its
SHA-256, so a copy of the table — a backup, a dump, a query in somebody's
terminal history — does not hand over live sessions. The cookie is HttpOnly,
`SameSite=Strict`, `Secure` wherever the cabinet is served over https, and
scoped to the path the cabinet is mounted at. Nothing in it can be edited into
a different identity, because it is not an identity: it is a lookup key for a
row that says whose session this is.

Being a row is what buys the thing the key could not do. One session can be
ended without touching any other, and without touching the merchant's
integration.

**4. The cabinet holds the merchant key in its own configuration.** That part of
the old arrangement was right and stays: the cabinet reaches the gateway
machine-to-machine, with a merchant key, over the same public API a merchant's
own code uses. What changes is where the key comes from — `MERCHANT_API_KEY` on
the cabinet service, set by whoever deploys it, instead of out of a visitor's
cookie. A key the gateway refuses is now a broken cabinet rather than a rejected
person: the merchant is shown that the cabinet's own key is not accepted, and is
*not* signed out, because signing them out would send them to type a password
that cannot fix it.

**5. The gate denies by default.** One check runs before every route. What a
visitor with no session can reach is the sign-in page, the stylesheet and the
health probe; every other address answers the same way — a redirect to sign-in —
whether or not the cabinet has a page there. A route added later is behind the
gate because it is a route, not because somebody remembered to wrap it. This is
deliberately stricter than answering 404, so that the cabinet's inventory of
pages is not something a stranger can enumerate.

**6. A session lasts twelve hours from the moment it is opened, and is never
extended.** A working day and a bit: a merchant who signs in at nine is still
signed in at six, and one who left a browser open over a weekend is not. There
is no idle timeout and no sliding renewal, and both absences are choices. A
sliding window means a session that never ends as long as somebody keeps a tab
in front of them, which is the case it is supposed to catch. An idle timeout
would be the better answer for a shared machine, and it costs a write on every
page view; the pilot's cabinet is opened from a laptop belonging to the person
who signs in, so the write is not bought yet. A merchant working from a machine
other people use is what changes that.

**7. Sessions are not the record of who did what, and that record is not built
yet.** The two look alike enough to be worth separating on purpose. A session is
state the cabinet consults on every request and destroys the moment a person
signs out; a record of an action has to outlive the session it was taken in, or
ending a session becomes a way of erasing what was done with it. They also have
opposite handling: a session row holds the hash of a live secret, and an action
log is exactly the thing you want to be able to hand to somebody who must not be
able to replay anything.

What is built instead is smaller and is described honestly: every action that
changes something writes one line to the cabinet's process log naming the person
who did it. That is not an audit trail. It rotates, it disappears with the
container, and it is written by the same process it is a record of. It answers
"who stopped selling" for as long as the logs live, which at one merchant with
one person is the question anybody actually has. The table arrives with the
second person.

**8. ADR-0005 §3 is narrowed by this decision.** That section says the cabinet
holds no database connection of its own, and the reason it gives is dogfooding:
if a screen cannot be drawn from the public API, the merchant would have hit the
same wall. That reason is untouched and still binding — every card, order and
receipt on every screen still comes from the API, and no query in the cabinet
can reach the gateway's tables. What the cabinet now owns is two tables that are
nothing to do with the merchant's data and that no API will ever expose:
accounts and sessions. The alternative was putting human authentication on the
money path, which ADR-0005 §2 exists to prevent.

The two tables live in the same Postgres as everything else (ADR-0003 §6), with
their own checked-in migrations and their own migration bookkeeping table, so
neither migration set can be applied on top of the other's history.

**9. The trigger that ends this arrangement is a second person at a merchant we
do not know as well as we know ourselves, or a second merchant.** Either one
turns the questions this decision waves away into real ones: who may do what, who
created whose account, what happened and when, and whose key the cabinet should
be holding. At that point an authentication component and a real action log are
bought rather than argued about.

## Consequences

Rotating the merchant key and signing a person out are now two acts. The key is
changed on the gateway and on the cabinet's configuration and nobody is logged
out; a session is ended in the database and the merchant's integration does not
notice.

A merchant key no longer reaches a browser. Nobody types one into a form, and
nothing stores one outside the two services that need it.

A person who signs out, or whose session is ended from the command line, finds
their open tab dead on its next action — the action does not happen, and they
are sent to sign in. That is the point of the row, and it is what an ended
session has to mean.

Bringing the cabinet up now needs a database and a merchant key, and it refuses
to start without either. That is two more things a deployment can get wrong, and
both fail loudly at startup rather than at the first sign-in.

What this does **not** protect against, said plainly:

- **Guessing a password.** There is no rate limit and no lockout on sign-in, and
  adding one would hand anybody who knows the address a way to lock the merchant
  out of the control that stops their selling. What stands in the way instead is
  the cost of a `scrypt` derivation on every attempt and the fact that the
  password is generated by the command that creates the account rather than
  chosen by a person. A password supplied by hand is refused below twelve
  characters, which is a floor and not a defence.
- **Somebody making the cabinet slow by trying to sign in.** A `scrypt`
  derivation runs on one of the runtime's four background threads, and the
  cabinet's calls to the gateway resolve a hostname on those same threads, so a
  flood of sign-in attempts can be expected to make the pages slow for the
  person who is already signed in. That is a mechanism rather than a
  measurement — nobody has run it — and it is written down because the honest
  reading of "no rate limit" includes this and not only guessing.
- **Somebody who is already on the machine.** A session left open on an unlocked
  laptop is usable for the rest of its twelve hours. There is no idle timeout,
  by the choice above.
- **Anything reading the cabinet's memory or its database connection.** The
  password is in the process's memory while it is being checked, and the process
  can read every session hash there is. This is a boundary against the network
  and against a stolen copy of the database, not against a compromised host.
- **A merchant with two people.** The cabinet knows which person signed in and
  says so in its log; it has no notion of one of them being allowed less than
  the other, and no durable record of what either did.
- **Losing a password.** There is no reset by mail. The answer is the command
  that sets a new one, run by us, which also ends every session that person had.

## Alternatives rejected

**A one-time link sent by mail, or a mail-based reset.** The better shape in the
long run and the wrong one to buy this month: it needs a mail provider account,
an API key, and DNS records on a domain we do not control yet, and a sign-in
that depends on all three is a sign-in that fails for reasons nobody in this
repository can fix. It also does not remove the password problem so much as move
it into a mailbox. This is the first thing to revisit when there is a domain.

**An identity provider — Google, GitHub, an OIDC vendor.** No passwords to store
and no reset flow to write, at the price of a runtime dependency on somebody
else's availability for the screen a merchant opens when their selling has gone
wrong, plus a client registration per environment. For one merchant we create by
hand, that is a lot of moving parts to buy one screen.

**An authentication framework.** Sessions, accounts, adapters and a migration
story, all of it shaped for a product with sign-up, verification and recovery —
none of which exists here. What we would use is the part we have written, and
what we would carry is the rest.

**A signed stateless cookie carrying the person's identity.** No table and no
lookup, and no way to end one session either: the only revocation a signed token
has is a secret rotation, which ends everybody's session at once and is the same
trap the merchant key is in today. Ending one session is the whole point.

**Keeping the merchant key as the credential and merely scoping it — a second,
weaker key for people.** It leaves the person unnamed, which is half the problem,
and it puts the cabinet's credential back in a browser.

**`bcrypt` or `argon2` as a dependency.** `argon2id` is the better function and
both are native modules: a build toolchain in the image, a compile step in an
install that is currently offline, and a rebuild on every Node upgrade. `scrypt`
is memory-hard, is in the runtime, and needs none of that. The stored format
names its algorithm, so the day a real dependency is worth it, the existing rows
say what they are.

**Accounts and sessions inside the gateway, reached over HTTP.** It would keep
ADR-0005 §3 intact by its letter. It would also put password hashing, a session
table and a human sign-in surface on the money path, which is exactly what
ADR-0005 §2 was written to prevent, and it would still need a shared secret
between the cabinet and the gateway to protect that surface.
