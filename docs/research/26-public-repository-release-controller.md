# Public source and private release controller

Date: 2026-09-03.
Status: design approved in principle; implementation is split into preparation,
controller acceptance and a final visibility cutover.

## Purpose

Coinslot becomes a public source repository without allowing code from a public
pull request to run on Nuanu AI's persistent Comino runners. The existing
commit-driven test and live release contract remains observable from the source
repository: its public delivery workflow is green only when the exact candidate
has passed its checks and the private controller has reported a successful
delivery.

The deployment target is reachable from the Comino network and accepts archives
through forced SSH commands. That boundary makes the usual public-repository
pattern—ephemeral GitHub-hosted CI followed by cloud OIDC—unavailable without
adding a network access service. A small private release controller keeps the
existing network boundary and does not expose a self-hosted runner to the public
repository.

## Repository boundary

`nuanu-ai/coinslot` remains the source of truth for application code, contracts,
documentation, tests, release tags and the definition of a releasable commit.
Its gate, portal and decision jobs run on `ubuntu-24.04`. SDK publication also
runs there with npm Trusted Publishing; public source permits npm provenance to
be enabled.

`nuanu-ai/coinslot-deploy` is private. It contains one deployment workflow and
the documentation needed to rotate its credentials. It contains no copy of the
application, no environment files, no build, and no alternative release state.
Its jobs use the existing `[self-hosted, comino]` pool, so all four runners remain
available to other private repositories.

The deployment SSH keys and their known-host material belong to the controller.
GitHub does not reveal existing secret values, so the migration creates new test
and live keys, installs their public halves with the existing forced commands,
and removes the source repository's old keys only after controller acceptance.
While the source repository is still private, controller acceptance uses a
temporary fine-grained credential limited to source Contents read and Actions
read. The controller removes it after the visibility cutover, when the same
evidence becomes public.

## Handoff

`deliver.yml` runs on GitHub-hosted infrastructure only for a push to `main` or
a `v*` tag. It waits for the separate public CI run for the same event and SHA
to finish successfully, then dispatches the private controller with four inert
values: source workflow run identifier, channel, full commit SHA and optional
tag. It uses a fine-grained credential limited to the controller repository and
the Actions write permission. Fork pull requests neither start this workflow
nor receive that credential.

The public delivery workflow waits for the correlated controller run and adopts
its result. The controller's logs and deployment addresses remain private,
while the public workflow reports only the candidate SHA, channel and success
or failure. A timeout or an ambiguous controller run is a failed delivery,
never a green public delivery workflow. SDK publication waits for both the
public CI and test delivery workflows for its exact SHA.

The handoff credential can start or inspect controller workflows but cannot
read its contents, change its workflow or read its deployment secrets. A GitHub
App may replace it later if a second permanent writer makes a human-owned token
an operational liability; Stage 0 does not add that service now.

## Controller validation

Inputs are claims, not authority. Before loading an SSH key, the controller
uses GitHub's API and a clean temporary Git repository to prove all of the
following:

1. the source is exactly `nuanu-ai/coinslot`;
2. the run exists, belongs to the public CI workflow, concluded successfully,
   and names the supplied 40-character SHA;
3. a test candidate came from a push to `main` and its SHA is reachable from
   the current `origin/main`;
4. a live candidate came from a pushed tag matching `v*`, the tag resolves to
   the supplied SHA, and that SHA is reachable from `origin/main`;
5. the same channel and SHA are not already being delivered.

The controller fetches that exact commit without executing it, verifies the
resulting object identifier, and streams `git archive` to the existing
`release-test <sha>` or `release-live <tag> <sha>` forced command. It never runs
`pnpm install`, tests, package scripts, repository hooks or application code on
the Comino runner. The deployment host executing an accepted release remains
the boundary already recorded in ADR-0016.

Concurrency is one run per channel. A newer test candidate waits for an active
delivery instead of cancelling it after database activation may have begun.
The live channel never retries automatically after an unknown SSH result.

## Public repository controls

The root distribution uses Apache-2.0. `NOTICE` contains
`Copyright 2026 Nuanu AI`; the SDK and contracts package metadata use the SPDX
identifier `Apache-2.0`. Redistribution must retain the license and applicable
attribution notice, but no product-screen or advertising credit is required.
Each public npm tarball carries its own `LICENSE` and `NOTICE`; the outside-pack
acceptance check reads both from the packed artifacts rather than inferring
their presence from the repository root.

Once visibility changes, a repository ruleset protects `main` from deletion and
force pushes, including by administrators. Ordinary direct pushes remain
allowed because the current repository discipline deliberately permits small
steps directly on `main`; required pull requests or pre-push status checks would
silently replace that rule. A second ruleset prevents updates and deletion of
`v*` and `sdk-v*` release tags.

The old Actions runs, release tags, author metadata and merged remote branch are
not deleted as part of this migration. Secret scanning and Dependabot policy are
also separate work, as requested. Public visibility is changed only after the
controller, new deploy keys and ruleset payloads are ready to apply in one
coordinated sequence.

## Migration order

Public-readiness preparation lands first while the repository remains private.
It adds Apache-2.0 `LICENSE` and `NOTICE`, puts both files into each public npm
artifact, aligns the SDK and contracts metadata, documents the license in the
README and records the licensing decision. It also pins every external GitHub
Action to a verified full commit SHA and prepares the exact repository and tag
rulesets. This step does not change runner labels, workflow triggers, deployment
secrets or the current release path.

The private controller is then created and accepted. Its validation is tested
without a deployment first. New test and live SSH keys are installed under the
existing forced commands, and the test channel proves one exact-SHA delivery
through the controller. The old source workflow and its secrets remain intact
until that proof succeeds.

The final cutover is one coordinated operation. The source workflows move CI
and npm publication to `ubuntu-24.04`, add `deliver.yml`, and remove their direct
self-hosted deployment jobs. The corresponding ADR is updated in the same
change. After that commit is on `main`, repository visibility changes to public,
the prepared branch and tag rulesets are enabled immediately, the hosted CI and
controller handoff are verified, and only then are the old deployment secrets
removed from the public repository.

If any cutover check fails, no untrusted job is allowed onto Comino. The source
may temporarily have a failed delivery workflow while the private controller is
repaired, but the old self-hosted workflow is not re-enabled in the public
repository.

## Acceptance

Before the visibility change, local validation covers workflow syntax, the
controller's refusal cases, tag and ancestry checks, secret boundaries, and the
existing repository gates. The controller workflow is installed while private,
but no public runner access is granted to Comino.

After the visibility change, acceptance requires all of the following:

- an unauthenticated clone can run the documented offline checks;
- a public pull-request run uses only GitHub-hosted runners and receives no
  deployment credential;
- a green `main` CI run is selected by the public delivery workflow, which
  dispatches and waits for the exact test deployment;
- the deployment marker, running revision, health checks and public test route
  agree on that SHA;
- a live-tag validation proves the tag and controller path without performing a
  new live deployment; the next explicitly authorized `v*` release is the first
  mutating live acceptance;
- SDK dry-run checks pass on GitHub-hosted infrastructure with provenance
  enabled;
- the `main`, `v*` and `sdk-v*` rulesets are visible and enforced;
- the old deployment secrets are removed from the public repository only after
  the new test path has passed.

If the controller cannot be made ready, the repository remains private. The
visibility switch is not used as a probe.
