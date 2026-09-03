#!/usr/bin/env bash

# Installed outside the checkout and forced by the GitHub Actions SSH key.
#
# There is no rollback and there are no release directories (ADR-0016).
#
# The line a release crosses is its first resident migration, which happens
# inside `up` before the gateway and the cabinet report healthy. A release that
# fails before that point — preflight, build, the scratch suite — has not
# changed the resident deployment database or its schema. A release that fails
# after it has already moved the schema, whatever else went wrong, so a failed
# health check is not a release that did not happen: it is one that left the
# database ahead of whichever application is running.
#
# The repair is to deliver a known commit again. What that costs is that a
# schema which has moved forward is not carried back by it, which is the price
# of having no rollback at Stage 0 rather than a gap somebody discovers at the
# wrong moment.
#
# `.coinslot-revision` therefore names the candidate and how far it got —
# activating, activated, origin-verified — rather than the last release that
# worked. A marker that reported the previous success while this candidate was
# serving would be the one artifact an operator consults being wrong in the one
# moment they consult it.

set -Eeuo pipefail
umask 077

readonly allowed_channel="${1:-}"
readonly requested_command="${SSH_ORIGINAL_COMMAND:-}"

fail() {
  printf 'coinslot release refused: %s\n' "$*" >&2
  exit 64
}

case "${allowed_channel}" in
  test | live) ;;
  *) fail 'this key is forced to no channel; authorized_keys must say release.sh test or release.sh live' ;;
esac

# Two forced commands and two keys. The channel is fixed by the key before the
# request is read, so the key that can deploy the test site cannot deploy the
# live one whatever it asks for. The marker records which command ran, so what
# is running is identifiable by name as well as by revision.
if [[ "${requested_command}" =~ ^release-test\ ([0-9a-f]{40})$ ]]; then
  readonly channel='test'
  readonly revision="${BASH_REMATCH[1]}"
  readonly released_as="release-test ${revision}"
  readonly project='coinslot-test'
  readonly deployment="${HOME}/coinslot-test"
  readonly site='test.coinslot.nuanu.ai'
  readonly port='8443'
elif [[ "${requested_command}" =~ ^release-live\ (v[0-9A-Za-z.+-]{1,64})\ ([0-9a-f]{40})$ ]]; then
  readonly channel='live'
  readonly tag="${BASH_REMATCH[1]}"
  readonly revision="${BASH_REMATCH[2]}"
  readonly released_as="release-live ${tag} ${revision}"
  readonly project='coinslot'
  readonly deployment="${HOME}/coinslot"
  readonly site='coinslot.nuanu.ai'
  readonly port='443'
else
  fail 'expected "release-test <40 lowercase hex sha>" or "release-live <tag> <40 lowercase hex sha>"'
fi

# The request and the key have to name the same channel. This is the line that
# makes the two keys different capabilities rather than two copies of one.
[[ "${channel}" == "${allowed_channel}" ]] \
  || fail "this key may deploy the ${allowed_channel} channel and the request was for ${channel}"

readonly environment_file="${deployment}/.env"

# One lock for both channels, not one each. They share a Docker daemon, a build
# cache and a host, and the reset ceremony in
# docs/research/24-two-environments-runbook.md holds this same file for its
# duration — otherwise a push to `main` arriving mid-ceremony would bring a
# stack back up, let it write after the dump was taken, and `down -v` would
# destroy what it wrote.
#
# It waits rather than refusing on sight. `flock -n` returns immediately, and
# with the workflow's concurrency grouped by ref a tag and a main push can reach
# this host at the same moment — so the second one would be a red release with
# nothing wrong with it. Ten minutes is longer than a release takes and shorter
# than anybody's patience; past that it fails, loudly, because a queue with no
# ceiling is a release that hangs.
mkdir -p "${HOME}/.cache"
exec 9>"${HOME}/.cache/coinslot-deploy.lock"
flock -w 600 9 || fail 'another release held the lock for ten minutes'

[[ -f "${environment_file}" ]] || fail 'server .env is missing'
[[ "$(stat -c '%a' "${environment_file}")" == '600' ]] || fail 'server .env is not 0600'

incoming="$(mktemp -d "${HOME}/.cache/coinslot-release.XXXXXX")"
cleanup_incoming() {
  local status=$?
  rm -rf -- "${incoming}" || true
  exit "${status}"
}
trap cleanup_incoming EXIT
archive="${incoming}/release.tar"
payload="${incoming}/payload"
mkdir "${payload}"
cat >"${archive}"

while IFS= read -r archived_path; do
  path="${archived_path#./}"
  case "${path}" in
    '') ;;
    /* | '..' | ../* | */../* | */..) fail "unsafe archive path: ${archived_path}" ;;
    '.env' | */.env) fail '.env must stay on the server' ;;
  esac
done < <(tar -tf "${archive}")

tar -xf "${archive}" -C "${payload}"
chmod -R u+rwX,go+rX "${payload}"
[[ -f "${payload}/compose.yaml" ]] || fail 'archive has no compose.yaml'
[[ -f "${payload}/deploy/compose.public.yaml" ]] || fail 'archive has no public override'

readonly compose_files=(-f "${payload}/compose.yaml" -f "${payload}/deploy/compose.public.yaml")
export COINSLOT_APP_IMAGE="coinslot-app:${revision}"
export COINSLOT_WEB_IMAGE="coinslot-web:${revision}"

staged_compose=(
  docker compose --project-name "${project}" --env-file "${environment_file}"
  "${compose_files[@]}"
)

# `config` resolves every variable without starting a container, which is what
# makes this a check on the deployment rather than on a container's behaviour.
readonly resolved="${incoming}/resolved.json"
"${staged_compose[@]}" config --format json >"${resolved}"

# The preflight is deterministic logic over that text and is tested offline
# against saved copies of it (packages/core/src/deployment/preflight.test.ts).
# It runs inside a bare Node image with the candidate mounted read-only: this
# host needs no Node of its own, and nothing has been built or installed yet at
# the moment this runs.
docker run --rm -i --network none \
  -v "${payload}:/payload:ro" -w /payload node:24-alpine \
  node packages/core/src/deployment/preflight.mjs "${channel}" \
  <"${resolved}" \
  || fail "the ${channel} channel is not what it claims to be"

"${staged_compose[@]}" build

# The suite gets a disposable server rather than the deployment's own.
#
# It used to reach a PostgreSQL container a previous release left running.
# Neither project has one: `coinslot-test` has never existed, and the reset
# ceremony removed `coinslot`'s container along with its volume, so as written
# the first release of both channels would fail with an error about a host
# named `postgres`. What the change buys beyond that is that a candidate cannot
# recreate the resident database container before it has been built and its
# migrations proved.
#
# Coverage is unchanged: the suite already ran against `coinslot_test`, a
# scratch database it creates and drops, and never against the deployment's
# data. That name means "scratch" here and has nothing to do with which
# environment a stack is.
readonly scratch_project="coinslot-migrate-${revision:0:12}"
scratch_compose=(
  docker compose --project-name "${scratch_project}" --env-file "${environment_file}"
  "${compose_files[@]}"
)
scratch_down() { "${scratch_compose[@]}" down -v --remove-orphans; }
cleanup_scratch() {
  local status=$?
  scratch_down >/dev/null 2>&1 || true
  rm -rf -- "${incoming}" || true
  exit "${status}"
}
trap cleanup_scratch EXIT

"${scratch_compose[@]}" up -d --wait postgres
"${scratch_compose[@]}" run --rm --no-deps --user root \
  -e DATABASE_URL=postgres://coinslot:coinslot@postgres:5432/coinslot_test \
  gateway pnpm test:db
scratch_down

mkdir -p "${deployment}"
rsync -a --delete --exclude='.env' --exclude='.coinslot-revision' \
  "${payload}/" "${deployment}/"

cd "${deployment}"
compose=(
  docker compose --project-name "${project}" --env-file "${environment_file}"
  -f compose.yaml -f deploy/compose.public.yaml
)
"${compose[@]}" config --quiet

write_marker() {
  local state="$1"
  local marker="${deployment}/.coinslot-revision"
  local marker_temporary

  marker_temporary="$(mktemp "${marker}.XXXXXX")" || fail 'could not create the revision marker temporary file'
  if ! printf '%s status=%s\n' "${released_as}" "${state}" >"${marker_temporary}"; then
    rm -f -- "${marker_temporary}" || true
    fail 'could not write the revision marker temporary file'
  fi
  if ! mv -f -- "${marker_temporary}" "${marker}"; then
    rm -f -- "${marker_temporary}" || true
    fail 'could not replace the revision marker'
  fi
}

# The marker is written here, before `up`, and not only after the probes.
#
# `up` is where the line is crossed: it runs the resident migration and
# replaces the containers. A marker written only on success would go on naming
# the previous release while this candidate was already serving — an operator
# reading it would be told the wrong thing at exactly the moment they are
# trying to find out what is running. So the marker says which candidate and
# how far it got, and "I do not know whether this worked" is a state it can
# hold rather than one it renders as the previous success.
write_marker activating
"${compose[@]}" up -d --wait --remove-orphans
write_marker activated

# The three surfaces that answer without a session, each of which has to carry
# the mode this channel is. A probe that asked only whether a banner was
# present would pass a cabinet wired to the wrong facilitator; and on the live
# site the check is a positive answer rather than an absence, because an
# absence cannot tell a correct live page from a template that never ran.
readonly base="https://${site}:${port}"
readonly resolve="${site}:${port}:10.20.10.20"

for path in / /docs/ /cabinet/sign-in; do
  page="$(curl --disable -fsS --noproxy '*' --max-time 15 --resolve "${resolve}" "${base}${path}")" \
    || fail "${path} did not answer"
  grep -q "data-coinslot-surface=\"${channel}\"" <<<"${page}" \
    || fail "${path} does not say it is the ${channel} environment"
done

for path in /healthz /x402/catalog; do
  curl --disable -fsS --noproxy '*' --max-time 15 --resolve "${resolve}" "${base}${path}" >/dev/null \
    || fail "${path} did not answer"
done

# `origin-verified` and not `verified`, because that is what was proved. Every
# curl above went to 10.20.10.20 with --resolve, which is the backend address
# and not the path a reader takes: the Comino ingress in front of it is not in
# that request at all. A stack whose ingress route is missing or wrong answers
# every one of these and is unreachable from the internet, and a marker saying
# `verified` would be this release telling an operator the one thing it did not
# check. The public path is proved by a person the first time each channel is
# released, which is written into the runbook rather than into this script,
# because a probe of the public name from this host is not a probe of the same
# journey either.
write_marker origin-verified
printf 'deployed=%s channel=%s\n' "${revision}" "${channel}"
