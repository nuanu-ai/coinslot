# 0016. Commit-driven test and live releases

Date: 2026-08-28
Status: accepted (Dmitry's live word)

## Context

The repository defines release channels for `test.coinslot.nuanu.ai`, the test
environment, and `coinslot.nuanu.ai`, the live environment. Their source must
be identifiable without copying files by hand, while each stack's `.env`
remains an external host file rather than a repository artifact.

Host provisioning, forced-key installation, first delivery, public ingress
checks and live money-path evidence remain future external work. The rules
below are conditions for operation, not claims of current infrastructure.

## Decision

A push to `main` delivers that commit to the test stack after the gate, portal
and decision jobs pass. A tag matching `v*` runs those same jobs on the tagged
commit and, when they pass, delivers it to the live stack. The archive is the
workflow's exact `GITHUB_SHA`; the live command also carries the tag name.

The external host must provide separate `.env` files and must run neither
public stack with the scripted facilitator. Its authorized keys must force
`COINSLOT_TEST_SSH_KEY` to `release-test <sha>` and
`COINSLOT_LIVE_SSH_KEY` to `release-live <tag> <sha>`. The server fixes the
allowed channel before reading the request, so one key grants no way to deploy
the other channel. Both entries must disable shell, forwarding and terminal;
the workflow pins the host key.

A tag on an unmerged ref may run that ref's workflow with access to the live
secret. This is accepted while one repository writer can already put a commit
on `main`; the restriction is reconsidered when that trust boundary changes.

There are no release directories or automatic rollback in Stage 0. A release
crosses its irreversible line when `up` begins the first resident migration. A
failure before that point leaves the resident database and schema unchanged. A
failure after that point has already moved the schema, even when activation or
the later probes fail, and repair means delivering a known commit again.

Once provisioned, the revision marker names the candidate and its progress:
`activating`, then `activated`, then `origin-verified`. It never keeps naming
the predecessor once the candidate may be running. `origin-verified` means only
that the stack answers at its backend address; a person must check public
ingress on the first release of each channel.

The first live tag does not prove the end-to-end money path. After a live
gateway is first delivered, the first-sale ceremony must use
`pnpm smoke:bootstrap` to make a real purchase and collect settlement and
fulfilment evidence outside the fixtures. Registration remains closed until
that future purchase succeeds and its evidence is read. A failed or omitted
ceremony leaves the site unavailable as a real merchant endpoint.

## Consequences

Every green `main` commit is a test candidate; every green `v*` tag is a live
candidate. A failed candidate is visible in its marker rather than being
misreported as the previous success. Re-delivery does not reverse a schema
migration, which is the known cost of having no rollback in Stage 0.
