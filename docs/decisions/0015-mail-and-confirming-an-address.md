# 0015. Mail, and what confirming an address is worth

Date: 2026-08-28
Status: accepted (Dmitry, 2026-08-28: authorised the Resend sending domain for
`coinslot.nuanu.ai` and is putting the DNS records into the GitOps zone himself)

## Context

ADR-0010 named this as the next decision and said what it has to cover:
confirmation, password reset, the provider account and the DNS records. ADR-0014
built registration without any of it and said so plainly — a merchant who
registers has proved they hold an invitation, not that they hold the address
they typed, and every screen showing that address says it is unconfirmed.

Two things in the system are waiting on this. A password that is lost is
answered today by somebody running a command on the server, which works for one
merchant we know and does not survive the second. And the invitation code in
ADR-0014 §3 exists because nothing else stands between a stranger and the shared
catalogue; the decision says in its own words that it retires the day an address
means something.

The provider is settled and is not a new dependency: Resend already sends
Freeland's mail, the account exists, and the sending domain for this product is
`coinslot.nuanu.ai` with `send.coinslot.nuanu.ai` as its return path. That
subdomain matters. The apex `nuanu.ai` carries Google Workspace with its own SPF
and DKIM, and a second sender mixed into the apex would put this product's
reputation and the company's mail in one basket for the sake of one form.

## Decision

**1. We send two kinds of mail and no others: confirm this address, and set a
new password.** Both are transactional, both are the direct result of something
a person just did, and neither is a list anybody is on. Nothing here is a
newsletter and nothing collects addresses for a later purpose. A third kind of
mail is a new decision, not a new template.

The sending domain is `coinslot.nuanu.ai`, the address is a `no-reply` one, and
the mail says in its own text that nothing reads replies. That is not politeness
— we authorise sending only and receive nothing, so a reply goes to a mailbox
that does not exist, and a person who answers a machine deserves to be told
before they do it rather than by a bounce.

**2. Registration does not wait for the mail, and signing in does not either.**
A person registers, is signed in where they stand, and works with a banner
saying their address is not confirmed. The alternative — no session until a link
is clicked — makes registration fail every time the provider does, and the first
thing a new merchant would see is an empty page asking them to check a mailbox
the mail may not have reached. Delivery is somebody else's uptime and it must
not be on the path to a working account.

What confirmation buys is therefore not access. It is the right to be sent a new
password, and later the right to register without a code at all.

**3. A confirmation is a row, hashed, single use, and it expires.** The link
carries 32 random bytes; the table holds their SHA-256, the account it belongs
to and when it stops working, exactly as sessions do (ADR-0009 §3), so a copy of
the table is not a set of links somebody can spend. Twenty-four hours, because
the mail may sit unread overnight and a link that dies before the morning is a
support conversation.

Clicking a live link confirms the address, spends the row, and says so. Clicking
a spent or expired one is not an error to apologise for: it says the link is no
longer good and offers to send another, because that is what the person came to
do.

**4. Asking for another one replaces the outstanding link rather than adding
to it, and is refused if the last was sent within a minute.** One live link per
account keeps the arithmetic simple — the newest is the only one that works —
and the minute is there because the alternative is a button in our cabinet that
sends mail to an address as fast as somebody can click. That would make us a
source of unwanted mail before it made us anything else, and a sending domain
gets its reputation from exactly that.

**5. Password reset answers the same way whether or not the address has an
account.** The form is public — a person who needs it cannot sign in — so a
form that said "no account here" would be a way of asking which addresses are
registered, one address at a time. It says a link has been sent if the address
has an account, in one sentence, in every case. This changes ADR-0009 §1, which
said there is no reset by mail; that sentence was written for a pilot whose one
account we made by hand, and it is corrected there rather than left to contradict
this.

A reset link is the same shape as a confirmation link — 32 bytes, hashed,
single use — with an hour rather than a day, because it is a live credential in
a mailbox rather than a one-time acknowledgement. Using one ends every session
that person had, the way the command that sets a password already does.

**6. A cabinet with no provider configured sends nothing and says so, and that
is the sandbox.** One variable holding one value decides which it is, the same
shape ADR-0008 used for the facilitator: `MAIL_URL` is either the address of a
provider or the single word `sandbox:log`, which means there is no provider
behind this process. In that mode every message is written to the log with its
recipient and its link, so the whole flow can be walked on a laptop with no
network, no account and no domain — and `pnpm test` stays free, deterministic
and offline, which the charter requires of it.

Two values travel with it and neither can decide the mode on its own:
`MAIL_API_KEY`, the provider's credential, and `MAIL_FROM`, the address a person
sees a message come from. They are named for the job rather than for Resend,
because the variable that names the provider is `MAIL_URL` and a second place
saying which provider this is would be a second place to disagree. A key beside
`sandbox:log` is refused at start-up rather than ignored, for the reason ADR-0008
gives about its own pair: a credential sitting next to an address that talks to
nothing is somebody's leftovers, and reading it as a choice is how a deployment
sends nothing for a week without noticing.

The three live on the cabinet and not on the gateway. Accounts, sessions and
now confirmations are the cabinet's tables (ADR-0009 §8), the money path carries
no human identity by ADR-0005 §2, and mail is entirely a thing that happens to a
person.

The word is loud at start-up, once, in the same voice the sandbox facilitator
uses. A deployment that meant to send mail and did not configure a provider
finds out from its own log rather than from a merchant who never got a link.

**7. The invitation code stays until confirmation is proven, and its retirement
is a separate change.** ADR-0014 §3 says the code retires when an address is
confirmed, and that is still the intent — but a door removed on the day its
replacement is first deployed is a door removed on the strength of an argument.
The code comes out when confirmed addresses have been working in the sandbox,
and taking it out is one line and its own commit, so it can be put back the same
way.

## Consequences

A merchant who loses a password recovers without us, which is the first thing in
this system that stops needing a person at a terminal. That is the point of the
decision and it is worth naming as the thing that changes.

We become a sender, with everything that carries: a domain whose reputation can
be spent, a bounce stream nobody reads yet, and a provider whose outage is now
visible to merchants. The first is answered by the minute in §4 and by sending
nothing that is not transactional; the second is written down here as not built;
the third is answered by §2, which keeps delivery off the path to a working
account.

Nothing reads mail. Receiving stays off at the provider, there is no MX for an
inbox on this domain, and the return path exists only so Resend can collect
delivery failures. Turning receiving on is a separate decision and a separate
DNS change, which is how Freeland's own infrastructure treats the same split.

An unconfirmed account keeps working indefinitely. There is no sweep that
deletes it and no date on which it stops selling, because taking a merchant's
selling away over an unread mail is a far larger promise than this decision is
making. What an unconfirmed address costs its owner is that they cannot recover
a password, and the banner says so.

## Alternatives rejected

**Block sign-in until the address is confirmed.** The usual shape, and it puts a
third party's uptime in front of the first screen a merchant ever sees. It also
converts every delivery problem — a filter, a typo, a corporate gateway — into a
person who has an account and cannot reach it, and the only way out is us at a
terminal, which is what this decision exists to stop needing.

**A code typed into the page rather than a link.** It survives mail clients that
rewrite links, and it is what we would need if the confirmation had to happen on
a different device. Neither is a problem we have, and a code is one more thing to
rate-limit and one more form to write.

**SMTP against Google Workspace, with no provider account.** The account exists
already and there is no new vendor. It also puts this product's sending on the
company's mail domain and reputation, gives no delivery signal we can read, and
means a quota shared with people writing actual mail. The subdomain and a
transactional provider keep the two apart, which is the whole reason for the
subdomain.

**Waiting for a bounce and complaint pipeline before sending anything.** The
right thing at volume and premature at two kinds of transactional mail to
addresses somebody just typed. It is named above as not built rather than
pretended away, and the trigger for building it is the first time a merchant
tells us a link never arrived.
