#!/usr/bin/env bash
#
# Checks the decision log: file names and the uniqueness of numbers.
#
# Why this file exists. The decisions in docs/decisions refer to each other and
# to research by number — "ADR-0003 §8" turns up both in the code and in the
# portal documents. A number handed out twice turns those references into a
# riddle, and a name that is off the pattern breaks the directory ordering the
# log is read by. Both troubles are cheaper to catch in CI than in a
# conversation a month later; a hook is no good for this, because a decision
# can also arrive by a route other than a local commit.
#
# What the script deliberately does not check: that decisions already taken
# stay unchanged. By the charter decisions remain living documents — the edit
# goes straight into the file, and the history lives in git. Going back to
# append-only is named as a separate trigger, and that is Dmitry's decision,
# not a default of this script.
#
# Why bash: the check reads file names in a single directory. The tool that
# would have to be installed for that would cost more than the check.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
decisions_directory="${repository_root}/docs/decisions"

problems=0

report() {
  printf '%s\n' "$1" >&2
  problems=$((problems + 1))
}

if [ ! -d "${decisions_directory}" ]; then
  printf 'The docs/decisions directory does not exist — nothing to check.\n' >&2
  exit 1
fi

numbers=""
found=0

for path in "${decisions_directory}"/*; do
  [ -e "${path}" ] || continue

  name="$(basename "${path}")"

  # The README describes the format of the log and is not a decision itself.
  if [ "${name}" = "README.md" ]; then
    continue
  fi

  if [ ! -f "${path}" ]; then
    report "docs/decisions/${name}: a decision is a file, not a directory."
    continue
  fi

  if ! printf '%s' "${name}" | grep -Eq '^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$'; then
    report "docs/decisions/${name}: the name is not in the NNNN-slug.md format (four digits, a hyphen, lowercase latin)."
    continue
  fi

  found=$((found + 1))
  numbers="${numbers}${name%%-*}
"
done

if [ "${found}" -eq 0 ]; then
  report "There is not a single decision in docs/decisions — the log is empty."
fi

duplicates="$(printf '%s' "${numbers}" | sort | uniq -d)"

if [ -n "${duplicates}" ]; then
  for number in ${duplicates}; do
    same="$(cd "${decisions_directory}" && printf '%s ' "${number}"-*.md)"
    report "Number ${number} has been handed out more than once: ${same}"
  done
fi

if [ "${problems}" -ne 0 ]; then
  printf 'The decision log is not in order. Problems: %s.\n' "${problems}" >&2
  exit 1
fi

printf 'The decision log is in order. Decisions: %s, numbers are unique.\n' "${found}"
