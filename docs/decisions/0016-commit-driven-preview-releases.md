# 0016. Commit-driven releases of the public preview

Date: 2026-08-28
Status: accepted (Dmitry's live word)

## Context

`coinslot.nuanu.ai` already runs the Compose stack on `dmitry-dev`, from files
copied there by hand. That makes the deployed source hard to identify and
turns every delivery into another manual copy. The host keeps its `.env`; it is
not a repository artifact.

ADR-0008 says the scripted facilitator is protected by not deploying it. The
live decision is now to expose this stack as a public preview. It remains a
sandbox: a successful order there does not prove that money moved.

## Decision

A push to `main` deploys only after both CI jobs pass. The deploy job checks out
that workflow's exact commit and sends its `git archive` to one fixed server
command. That command mirrors the archive to `/home/dmitry/coinslot` without
replacing `.env` and uses the fixed Compose project name `coinslot`. It builds
SHA-tagged images, runs the database suite against `coinslot_test`, starts the
stack, and checks the four public surfaces from both sides of the ingress. Only
then does it write `.coinslot-revision`.

GitHub Actions reaches the host with a dedicated SSH key forced to that command.
The key has no shell, forwarding or terminal. The host key is pinned in the
workflow.

The resident services use `restart: unless-stopped`. There are no release
directories, confirmation protocol or automatic rollback in Stage 0. A failed
release is red and is repaired by delivering a known commit again.

## Consequences

Every green main commit is delivered without a manual server session, and the
running image tags plus `.coinslot-revision` name what was delivered. Docker's
existing layer cache keeps unchanged dependencies out of later builds.

This decision knowingly removes ADR-0008's “nobody deploys it” protection. I
would not present the resulting purchase or receipt as evidence of payment.
Before this hostname is offered as a real merchant endpoint, the scripted
facilitator must be replaced and the end-to-end money path proved.

The simple mirror can leave new source beside old running containers when a
build fails. The revision marker stays on the last locally proven deployment,
and the containers keep running; the next successful delivery reconciles both.
