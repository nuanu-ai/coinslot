# 0016. Test and live releases are paused during public cutover

Date: 2026-08-28
Status: accepted (Dmitry's live word)

## Context

The repository is becoming public. A public pull request may execute repository
workflows, so those workflows must not run on Nuanu AI infrastructure or hold a
route to the test and live hosts. The private release controller that will own
that route is deferred.

## Decision

Pushes to `main` and tags matching `v*` run the gate, portal and decision checks
on GitHub-hosted runners. They do not deploy. The public repository contains no
job that reads a deployment key, connects to Nuanu AI infrastructure or sends
an archive to a host.

The existing forced SSH commands and server-owned `.env` files stay in place,
but no automatic caller is authorized during the pause. Automatic delivery may
resume only through a private controller that independently accepts an exact
green commit or tag from this repository. That boundary is recorded here when
the controller exists; it is not assumed in advance.

## Consequences

A green run proves only that the commit passed the repository checks. Test and
live remain on their previously delivered revisions until a separately
authorized delivery occurs. No green check is described as a deployment.
