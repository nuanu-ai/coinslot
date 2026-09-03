# 0016. The VM pulls test releases; live releases remain paused

Date: 2026-08-28
Status: accepted (Dmitry's live word)

## Context

The repository is public. A public pull request may execute repository
workflows, so those workflows must not run on Nuanu AI infrastructure or hold a
route to the test and live hosts. The test VM can instead observe public CI
evidence without giving GitHub a command channel into Nuanu AI infrastructure.

## Decision

Pushes to `main` and tags matching `v*` run the gate, portal and decision checks
on GitHub-hosted runners. The public repository contains no job that reads a
deployment key, connects to Nuanu AI infrastructure or sends an archive to a
host.

On `dmitry-dev`, a system timer reads the exact head of `main`, independently
requires the completed successful `CI` run for that SHA and `push` event, and
downloads the immutable SHA archive. The installed receiver accepts that archive
through a local test-only door. The archive is rejected before extraction unless
every member is a regular file, directory or relative symbolic link confined to
one root. Failed releases are not retried until `main` moves. After an interrupted
release, only the receiver's marker can prove either that activation never began
or that verification finished; an uncertain activation stops for an operator.
The server-owned `.env` stays outside the archive, and no GitHub token is held on
the VM.

There is no automatic live caller. A `v*` tag proves the release checks but does
not deploy the live channel.

## Consequences

A green run alone proves only that the commit passed the repository checks. The
test revision is described as deployed only after the receiver activates it and
records `origin-verified`. Live remains on its previously delivered revision
until a separately authorized delivery occurs.
