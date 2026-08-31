# 0014. Registration makes a merchant, a key and an account in one act

Date: 2026-08-28
Status: accepted (Dmitry, 2026-08-28: "разрабатывай экраны, реализуй регистрацию")

## Context

The cabinet served exactly one merchant, through one key read at start-up, so
a second account was a second person looking at the first merchant's money.
And the public catalogue is one across merchants by decision (ADR-0010), so a
registration form nobody has to get past puts a stranger's words in front of
every buyer. Registration therefore needs tenancy and a door, and neither may
wait for perfection: the road's order is ADR-0010's.

## Decision

**1. Registering makes a merchant, the key its cabinet calls with and an
account — or none of them.** The form asks what a person can answer on
arrival: address, password, invitation. They are signed in where they stand.
Each side of the boundary writes in one transaction and the boundary is
crossed once: the gateway makes the merchant and the key, the cabinet writes
the account. A cabinet that fails after the gateway answered leaves a merchant
nobody can sign in as — litter, not damage; the address is free and the next
attempt makes a new one. The reverse order cannot exist: the account has
nothing to name until the merchant does.

**2. An account names its merchant and holds a key made for the cabinet.** The
cabinet builds its gateway client per request from the signed-in account's
row; `MERCHANT_API_KEY` leaves the configuration. The key is stored as issued,
and it is made afresh at every sign-in and the one it replaces forgotten — so a
copy of the database is a set of keys that stops working at the next sign-in
rather than one that works for good. It is still not a secret store; the
database is a boundary against the network, not against a host, and the day
that stops being enough the fix is one, not a cleverer column.

**3. The registration route is public, behind an invitation code.** The route
takes no key — nobody registering has one. A wrong code and a closed
registration answer identically, in constant time against a decoy (the two
answers that must be indistinguishable are the two refusals), so the form does
not say whether registration is open, only whether this code is the one. The
door retires when a confirmed address replaces it (ADR-0009).

**4. The name buyers see is asked for after registering, never on the form.**
It is a public answer demanded at the moment a merchant knows least, so it
lives on its own screen and in settings, changeable. Publishing a card while
it is unset is refused with a sentence naming where to set it: a card with no
seller reaches an agent inside a payment challenge that names nobody.

**5. Keys are made and disabled from the cabinet, and a key says what it is
for.** Three merchant-scoped routes over the keys a merchant made for their own
code — list, issue, disable — and two at `/v0/keys/cabinet` that make a key for
a cabinet and forget one, refused to any other key. That kind is in no
merchant's list and is refused by the disabling, since a merchant switches off
what they issued; forgetting removes rather than revokes. The forgetting takes
the key the call was made with and no other: a rule of the form "every key but
this one" is decided when the call is sent and stale when it lands, so a key
written in between is removed by a caller that never heard of it, and two
overlapping sign-ins leave an account naming a key that is gone. Reaching only
the key in the caller's hand, nobody can take away a credential anybody else
holds. What that costs is that nothing sweeps up after an interrupted sign-in;
clearing those by age is counted from the cabinet, which knows the keys still in
use, and is not built. A merchant cannot disable the key their own call was
made with — a rule in the route, because that click leaves whoever made it
calling with something the gateway no longer takes. It sees the key on the
call, so two keys disabling each other in one moment still leave a merchant
with none of their own, which nobody has decided to refuse; the way back in is
a key of the other kind.

## Consequences

The cabinet is multi-tenant; the process-wide client and its variable are
gone. An account and a merchant are one-to-one, and a merchant who has only
ever signed in has no keys of their own. Not built and not pretended: a second
person at a merchant, roles, deleting a merchant.

## Alternatives rejected

**Open registration.** Not before an address means something: the catalogue is
shared, and the first cost of a stranger's words is the buyer's, not ours.
**Wait for mail, build nothing.** Everything here is needed whichever the door
is; only the door changes. **One privileged cabinet key naming the merchant
per request.** The same secret with a second authentication mode on the money
path (ADR-0005 §2), plus a "which merchant" parameter somebody forgets to
check. **Encrypting the stored key.** Moves the secret into the same process
configuration and calls it protected; a secret store is the real answer, bought
when there is something to protect that is not a sandbox. **Registration on
the gateway.** A public form, a password and a rate limit on the money path,
and the gateway would need the account table this decision keeps out of it.
