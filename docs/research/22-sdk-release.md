# Publishing the merchant SDK

The tag `sdk-v<version>` publishes two public npm packages from one immutable
commit:

- `@nuanu-ai/coinslot-contracts`, because every SDK install resolves it at runtime;
- `@nuanu-ai/coinslot`, whose version must be the version written in the tag.

The workflow is `.github/workflows/publish-sdk.yml`. It runs on the Comino
self-hosted pool, accepts GitHub's OIDC token through `id-token: write`, and
keeps npm provenance off because the source repository is private. It carries
no npm credential.

## Prepare a release

Every public change has a Changeset. Prepare the versions on `main`, review the
generated changelogs and run the same gates the tag will run:

```sh
pnpm changeset version
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm outside
```

`pnpm outside` needs the public npm registry but no Coinslot credential. It
packs both packages, installs them with npm outside the workspace, compiles a
strict TypeScript consumer, imports the SDK with Node, and runs the documented
command with positive and negative cards.

Commit and push that prepared version, then wait for the `CI` workflow to deploy
that exact commit. Before making the tag, run the publish workflow manually on
`main` with `release_tag=sdk-v0.1.0` and `dry_run=true`. For SDK `0.1.0`, the
normal release after the package names have been bootstrapped starts with:

```sh
git tag sdk-v0.1.0
git push origin sdk-v0.1.0
```

For the first registry release, use the bootstrap sequence below instead; it
keeps the tag local until both package names and their trusted publishers
exist.

The workflow refuses a tag whose version differs from the SDK manifest, a tag
whose commit is not the commit being built, and a tagged commit that is not
reachable from `origin/main`. It also waits for the `CI` workflow, including
the deploy job, to succeed for that exact commit. Stage 0 publishes stable
versions only and assigns them npm dist-tag `latest`; prereleases are refused
instead of deriving another public channel from an unchecked name.

## Bootstrap the two package names once

npm can attach a trusted publisher only after a package name exists. The first
release therefore needs one authenticated publication from the exact commit
after its CI and deployment have succeeded. Use an npm account that owns the
`nuanu-ai` organization and requires 2FA. Create the release tag locally but do
not push it yet, check that it names `HEAD`, and let Changesets publish
contracts before the SDK:

```sh
git tag sdk-v0.1.0
test "$(git rev-parse 'sdk-v0.1.0^{commit}')" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
./scripts/check-sdk-release-tag.sh sdk-v0.1.0
NPM_CONFIG_PROVENANCE=false pnpm exec changeset publish --tag latest
```

Do not save a token in the repository or GitHub. An interactive `npm login`
session or another short-lived authenticated session is enough for this
one-time command.

After both names exist, npm 11.15 or newer can configure the same trusted
publisher on each package:

```sh
npm trust github @nuanu-ai/coinslot-contracts --repo nuanu-ai/coinslot --file publish-sdk.yml --allow-publish --yes
npm trust github @nuanu-ai/coinslot --repo nuanu-ai/coinslot --file publish-sdk.yml --allow-publish --yes
npm trust list @nuanu-ai/coinslot-contracts
npm trust list @nuanu-ai/coinslot
git push origin sdk-v0.1.0
```

Because bootstrap already published `0.1.0`, that first tag run validates the
registry artifacts but its Changesets publish is a no-op; it does not itself
exercise OIDC. The authenticated `npm trust list` reads above are therefore
part of bootstrap acceptance. The next new version is the first registry write
performed by the trusted publisher.

The equivalent npm website settings are:

- provider: GitHub Actions;
- repository: `nuanu-ai/coinslot`;
- workflow file: `publish-sdk.yml`;
- allowed action: `npm publish`.

Then set package publishing access to require 2FA and disallow ordinary tokens.
Every later `sdk-v*` tag publishes through OIDC on Comino without an npm secret.

## Acceptance

A green workflow is not registry evidence. The last workflow step reads the
exact contracts and SDK versions back from npm, confirms that `latest` points
at both versions, then installs and imports those exact registry artifacts in
a fresh directory. An HTTP 200 from npm or a green build alone does not prove
that a merchant can import the release.
