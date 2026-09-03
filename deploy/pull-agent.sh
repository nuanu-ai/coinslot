#!/usr/bin/env bash

# Installed outside the checkout and run by coinslot-test-pull.timer.
#
# The agent has one authority: deliver the exact head of `main` to the test
# channel after the public CI workflow has completed successfully for that
# same push. It has no live-channel mode, accepts no repository or workflow
# knobs, and never executes a script from the downloaded checkout. The
# installed release receiver remains the deployment boundary.

set -Eeuo pipefail
umask 077

readonly release_program="${1:-}"
readonly state_file="${2:-}"
readonly marker_file="${3:-}"
readonly repository='nuanu-ai/coinslot'
readonly git_url="https://github.com/${repository}.git"
readonly main_ref='refs/heads/main'

fail() {
  printf 'coinslot test pull refused: %s\n' "$*" >&2
  exit 75
}

[[ "$#" == 3 ]] || fail 'expected <release-program> <state-file> <marker-file>'
[[ -x "${release_program}" ]] || fail 'release program is not executable'
[[ -n "${state_file}" ]] || fail 'state file is empty'
[[ -n "${marker_file}" ]] || fail 'marker file is empty'

head_line="$(GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code --refs "${git_url}" "${main_ref}")" \
  || fail 'could not read the main revision'
read -r revision returned_ref extra <<<"${head_line}"
[[ "${revision:-}" =~ ^[0-9a-f]{40}$ && "${returned_ref:-}" == "${main_ref}" && -z "${extra:-}" ]] \
  || fail 'Git did not return exactly one lowercase main revision'

write_state() {
  local status="$1"
  local state_directory temporary
  state_directory="$(dirname "${state_file}")"
  mkdir -p "${state_directory}"
  temporary="$(mktemp "${state_file}.XXXXXX")"
  printf '%s %s\n' "${revision}" "${status}" >"${temporary}"
  mv -f -- "${temporary}" "${state_file}"
}

if [[ -e "${state_file}" ]]; then
  [[ -f "${state_file}" ]] || fail 'state path is not a regular file'
  saved_state="$(<"${state_file}")"
  [[ "${saved_state}" =~ ^([0-9a-f]{40})\ (running|success|failed)$ ]] \
    || fail 'state file is malformed'
  saved_revision="${BASH_REMATCH[1]}"
  saved_status="${BASH_REMATCH[2]}"
  if [[ "${saved_revision}" == "${revision}" ]]; then
    case "${saved_status}" in
      success)
        printf 'current=%s status=already-deployed\n' "${revision}"
        exit 0
        ;;
      failed)
        fail "revision ${revision} already ended in failed; waiting for a new main revision"
        ;;
      running)
        if [[ ! -e "${marker_file}" ]]; then
          printf 'current=%s status=recovering-before-activation\n' "${revision}"
        else
          [[ -f "${marker_file}" ]] || fail 'deployment marker is not a regular file'
          marker="$(<"${marker_file}")"
          [[ "${marker}" =~ ^release-test\ ([0-9a-f]{40})\ status=(activating|activated|origin-verified)$ ]] \
            || fail 'deployment marker is malformed'
          marker_revision="${BASH_REMATCH[1]}"
          marker_status="${BASH_REMATCH[2]}"
          if [[ "${marker_revision}" != "${revision}" ]]; then
            printf 'current=%s status=recovering-before-activation\n' "${revision}"
          elif [[ "${marker_status}" == 'origin-verified' ]]; then
            write_state success
            printf 'current=%s status=recovered-as-deployed\n' "${revision}"
            exit 0
          else
            fail "revision ${revision} may already have activated; inspect the deployment marker"
          fi
        fi
        ;;
    esac
  fi
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/coinslot-test-pull.XXXXXX")"
cleanup() {
  local status=$?
  rm -rf -- "${work}" || true
  exit "${status}"
}
trap cleanup EXIT

runs_file="${work}/workflow-runs.json"
runs_url="https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&head_sha=${revision}&per_page=1"
curl --fail --silent --show-error --location \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --output "${runs_file}" \
  "${runs_url}" \
  || fail 'could not read CI evidence'

ci_status=0
python3 -c '
import json
import sys

path, revision = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as source:
        document = json.load(source)
except (OSError, json.JSONDecodeError):
    raise SystemExit(2)

runs = document.get("workflow_runs")
if not isinstance(runs, list):
    raise SystemExit(2)
if not runs:
    raise SystemExit(3)
if len(runs) != 1:
    raise SystemExit(4)

run = runs[0]
expected = {
    "name": "CI",
    "head_branch": "main",
    "head_sha": revision,
    "event": "push",
    "status": "completed",
    "conclusion": "success",
}
if not isinstance(run, dict) or any(run.get(key) != value for key, value in expected.items()):
    raise SystemExit(4)
' "${runs_file}" "${revision}" || ci_status=$?

case "${ci_status}" in
  0) ;;
  3)
    printf 'current=%s status=waiting-for-ci\n' "${revision}"
    exit 0
    ;;
  4) fail 'CI evidence is not an exact successful push for this main revision' ;;
  *) fail 'CI response is malformed' ;;
esac

source_archive="${work}/source.tar.gz"
curl --fail --silent --show-error --location \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --output "${source_archive}" \
  "https://api.github.com/repos/${repository}/tarball/${revision}" \
  || fail 'could not download the exact source archive'

archive_status=0
python3 -c '
import sys
import tarfile
from pathlib import PurePosixPath

root = None
try:
    with tarfile.open(sys.argv[1], "r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or not path.parts or ".." in path.parts:
                raise SystemExit(6)
            if root is None:
                root = path.parts[0]
            elif path.parts[0] != root:
                raise SystemExit(6)
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute():
                    raise SystemExit(7)
                resolved = list(path.parent.parts)
                for part in target.parts:
                    if part in ("", "."):
                        continue
                    if part == "..":
                        if len(resolved) <= 1:
                            raise SystemExit(7)
                        resolved.pop()
                    else:
                        resolved.append(part)
                if not resolved or resolved[0] != root:
                    raise SystemExit(7)
            elif not (member.isfile() or member.isdir()):
                raise SystemExit(5)
except (OSError, tarfile.TarError):
    raise SystemExit(6)
if root is None:
    raise SystemExit(6)
' "${source_archive}" || archive_status=$?
case "${archive_status}" in
  0) ;;
  5) fail 'source archive contains an unsafe member type' ;;
  7) fail 'source archive contains an unsafe link target' ;;
  *) fail 'source archive structure is unsafe' ;;
esac

payload="${work}/payload"
mkdir "${payload}"
tar -xzf "${source_archive}" --strip-components=1 -C "${payload}" \
  || fail 'source archive could not be extracted'
[[ -f "${payload}/compose.yaml" ]] || fail 'source archive has no compose.yaml'
[[ -f "${payload}/deploy/compose.public.yaml" ]] \
  || fail 'source archive has no public override'

release_archive="${work}/release.tar"
tar -cf "${release_archive}" -C "${payload}" . \
  || fail 'could not normalize the source archive'

write_state running
release_status=0
"${release_program}" test "${revision}" <"${release_archive}" || release_status=$?
if (( release_status != 0 )); then
  write_state failed
  exit "${release_status}"
fi

write_state success
printf 'deployed=%s channel=test source=pull\n' "${revision}"
