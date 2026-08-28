# 0009. Signing into the cabinet is a component's job, not ours

Date: 2026-08-28
Status: accepted (Dmitry, 2026-08-28: "просто сделай мне нормальную авторизацию")

Rewritten, not annotated: the version of 2026-08-27 described a sign-in written
by hand, and its whole middle is the mechanism being removed. No merchant has
built on it; the history is in git.

## Context

The cabinet has to sign a person in, keep them signed in, confirm the address
they typed, let a lost password be recovered, and refuse a form posted from
somewhere else. All of it was ours, and three things ended that.

Self-service registration made the cabinet multi-tenant, which inverts the
original argument: a component's user and session model no longer has to be bent
around a cabinet with one merchant, it fits one with many. The hand-written
form-origin check had already cost a live outage — it built the origin it
expected out of a forwarded header, so an honest browser was told its form came
from somewhere else, exactly as the comment beside it had predicted. And the
expensive half was still ahead: confirmation and reset mean tokens, expiry,
single use, resend limits, and a form that must not become a way of asking which
addresses are registered.

One account, one deployment, no merchant depending on it: the cheapest moment
this will ever be.

## Decision

**Identity comes from Better Auth, in our own process on our own Postgres
through drizzle.** A library, not a service: nothing more to deploy, no second
database, nobody else's availability in front of the screen a merchant opens
when their selling has stopped. Verified before choosing rather than
remembered — it runs in a plain express app, its server API can be called from
our handlers, mail is a function we supply, and telemetry is off by default. We
switch telemetry off explicitly anyway: a default we depend on can change.

**Tenancy stays ours.** The merchant on the account, that merchant's key, the
gateway client built per request from it, the key screens, the gate above every
route. None of that is identity and no component would know what to do with it.

**The screens stay server-rendered forms.** Our handlers call the component's
server API and pass on the cookie it makes, so the cabinet keeps working without
JavaScript and nothing pulls in a client framework.

**Mail is a function we supply; with no provider it writes to the log.** Resend
on a server, from a subdomain of its own so this product's reputation and the
company's Workspace mail are not one basket. Locally the whole flow walks with
no account, no domain and no network, and the suite stays offline. Nothing reads
mail: receiving is off, and the address a person sees says replies go nowhere.

**Nothing waits for a message.** Registering signs a person in where they stand,
with a banner saying the address is unconfirmed. Putting delivery in front of a
working account turns every mail filter into somebody who has an account and
cannot reach it, recoverable only by us at a terminal — which is the thing this
decision exists to stop needing. Confirmation buys the right to be sent a new
password, and later the retirement of the invitation code.

**Two properties survive the swap because they are why the old version existed.**
A session is a row that can be ended one at a time, without touching the
merchant's running code. And the cookie cannot take the `__Host-` prefix — the
cabinet shares an origin with the landing, the docs and `/v0`, so it is scoped
to the cabinet's path — which means a sibling subdomain is "same site" and the
check that a form came from this host stays until the component covers that case
with a token rather than with `SameSite` alone.

## Consequences

Out: our password derivation, our session table and sweep, our sign-in and
password handlers. Tests that described those mechanisms go with them; tests
that describe what a merchant experiences are rewritten against the new
mechanism, because they are what says the swap changed nothing anybody can see.

A merchant recovers a lost password without us, which is the first thing here
that stops needing a person at a terminal. An unconfirmed account keeps working;
what its owner lacks is recovery. And we become a sender — a domain whose
reputation can be spent, a bounce stream nobody reads yet, a provider whose
outage merchants can feel — answered by sending only transactional mail, by
limiting how often one can be asked for again, and by not waiting for delivery.

## Alternatives rejected

**Keep writing it by hand.** Defensible for one merchant whose account we made
ourselves, and it stopped being so the morning registration existed — having
already refused an honest merchant's sign-in on the live site.

**A hosted identity provider.** Removes the most code, and puts a vendor's
availability in front of the worst possible screen with merchant identities in
their database rather than ours.

**A separate auth service — Kratos, Keycloak, Zitadel.** Each is a second
deployment, database and backup, for a cabinet with one merchant. Worth
revisiting the day there are identities outside the cabinet to federate.

**Letting the browser call the component directly.** The usual way it is used,
and it would make signing in need JavaScript.
