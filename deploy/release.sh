#!/usr/bin/env bash

# Installed outside the checkout and forced by the GitHub Actions SSH key.

set -Eeuo pipefail
umask 077

readonly deployment="${HOME}/coinslot"
readonly environment_file="${deployment}/.env"
readonly requested_command="${SSH_ORIGINAL_COMMAND:-}"

fail() {
  printf 'coinslot release refused: %s\n' "$*" >&2
  exit 64
}

if [[ "${requested_command}" =~ ^release\ ([0-9a-f]{40})$ ]]; then
  readonly revision="${BASH_REMATCH[1]}"
else
  fail 'expected release <40 lowercase hex sha>'
fi

[[ -f "${environment_file}" ]] || fail 'server .env is missing'
[[ "$(stat -c '%a' "${environment_file}")" == '600' ]] || fail 'server .env is not 0600'

mkdir -p "${HOME}/.cache"
exec 9>"${HOME}/.cache/coinslot-deploy.lock"
flock -n 9 || fail 'another release is running'

incoming="$(mktemp -d "${HOME}/.cache/coinslot-release.XXXXXX")"
trap 'rm -rf -- "${incoming}"' EXIT
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
[[ -f "${payload}/compose.yaml" ]] || fail 'archive has no compose.yaml'
[[ -f "${payload}/deploy/compose.preview.yaml" ]] || fail 'archive has no preview override'

export COINSLOT_APP_IMAGE="coinslot-app:${revision}"
export COINSLOT_WEB_IMAGE="coinslot-web:${revision}"
staged_compose=(
  docker compose --project-name coinslot --env-file "${environment_file}"
  -f "${payload}/compose.yaml" -f "${payload}/deploy/compose.preview.yaml"
)

"${staged_compose[@]}" config --quiet
"${staged_compose[@]}" build
"${staged_compose[@]}" run --rm --no-deps \
  -e DATABASE_URL=postgres://coinslot:coinslot@postgres:5432/coinslot_test \
  gateway pnpm test:db

rsync -a --delete --exclude='.env' --exclude='.coinslot-revision' \
  "${payload}/" "${deployment}/"

cd "${deployment}"
compose=(
  docker compose --project-name coinslot --env-file "${environment_file}"
  -f compose.yaml -f deploy/compose.preview.yaml
)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait --remove-orphans

for path in / /docs/ /cabinet/healthz /v0/catalog; do
  curl -fsS --max-time 15 --resolve coinslot.nuanu.ai:443:10.20.10.20 \
    "https://coinslot.nuanu.ai${path}" >/dev/null
done
printf '%s\n' "${revision}" >.coinslot-revision
printf 'deployed=%s\n' "${revision}"
