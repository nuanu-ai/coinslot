# 0016. Commit-driven test and live releases

Date: 2026-08-28
Status: accepted (Dmitry's live word)

## Context

Two public stacks run on `dmitry-dev`: `test.coinslot.nuanu.ai` is the test
environment and `coinslot.nuanu.ai` is the live environment. Their source must
be identifiable without copying files by hand. Each stack keeps its own `.env`
on the host; neither file is a repository artifact.

The scripted facilitator is absent from both public stacks. A green release
still does not prove that the public ingress works or that the live money path
settles and fulfils an order.

## Decision

A push to `main` delivers that commit to the test stack after the gate, portal
and decision jobs pass. A tag matching `v*` runs those same jobs on the tagged
commit and, when they pass, delivers it to the live stack. The archive is the
workflow's exact `GITHUB_SHA`; the live command also carries the tag name.

The test job uses `COINSLOT_TEST_SSH_KEY`, forced on the server to
`release-test <sha>`. The live job uses `COINSLOT_LIVE_SSH_KEY`, forced to
`release-live <tag> <sha>`. The server fixes the allowed channel before reading
the requested command, so possession of one key grants no way to deploy the
other channel. Both keys have no shell, forwarding or terminal, and the
workflow pins the host key.

A tag on an unmerged ref may run that ref's workflow with access to the live
secret. This is accepted while one repository writer can already put a commit
on `main`; the restriction is reconsidered when that trust boundary changes.

There are no release directories or automatic rollback in Stage 0. A release
crosses its irreversible line when `up` begins the first resident migration. A
failure before that point leaves the resident database and schema unchanged. A
failure after that point has already moved the schema, even when activation or
the later probes fail, and repair means delivering a known commit again.

The revision marker names the candidate and its progress: `activating`, then
`activated`, then `origin-verified`. It never keeps naming the predecessor once
the candidate may be running. `origin-verified` means only that the stack
answers correctly at its backend address; public ingress is checked by a
person on the first release of each channel.

The first live tag does not prove the end-to-end money path. Once a live gateway
is running, the first-sale ceremony uses `pnpm smoke:bootstrap` to make a real
purchase and proves settlement and fulfilment from outside the fixtures.
Registration remains closed until that purchase succeeds and its evidence is
read. A failed or omitted ceremony leaves the site deployed but not open to a
merchant.

## Consequences

Every green `main` commit is a test candidate; every green `v*` tag is a live
candidate. A failed candidate is visible in its marker rather than being
misreported as the previous success. Re-delivery does not reverse a schema
migration, which is the known cost of having no rollback in Stage 0.
