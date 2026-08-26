#!/usr/bin/env bash
#
# Hygiene for agent worktrees under .claude/worktrees.
#
# Why this file exists. Agents work in worktrees and finish; the merge does
# not remove the worktree or its branch, so within one day the repository
# accumulated four 132 MB copies of itself and a thicket of dead branches
# (Dmitry's rule, 2026-08-26: acceptance of an agent branch ends with the
# worktree removed and the branch deleted). This script is that final step
# of acceptance, made safe to run at any moment.
#
# What it will never touch: the primary checkout (it is not under
# .claude/worktrees); locked worktrees (the agent harness locks a worktree
# while its agent is alive); dirty worktrees (uncommitted work is someone's
# work in progress); branches whose commits are not in main (verified with
# git cherry, which compares patches, not hashes — it survives the history
# rewrite of 2026-08-26). Whatever this script refuses to remove, it names
# with the reason; forcing is left to a human with plain git.
#
# Usage: scripts/worktrees.sh [list|clean]   (also: pnpm worktrees[:clean])

set -euo pipefail

mode="${1:-list}"
case "${mode}" in
  list | clean) ;;
  *)
    printf 'Unknown mode: %s (expected list or clean)\n' "${mode}" >&2
    exit 2
    ;;
esac

repository_root="$(git rev-parse --show-toplevel)"
agents_prefix="${repository_root}/.claude/worktrees/"

# Drop worktree records whose directories are already gone.
git worktree prune

# Snapshot the porcelain listing first: removing worktrees while reading
# the list would saw the branch we sit on.
listing="$(git worktree list --porcelain)"

path=""
branch=""
locked=0
removed=0
kept=0

flush() {
  [ -n "${path}" ] || return 0
  case "${path}" in
  "${agents_prefix}"*) ;;
  *)
    path=""
    branch=""
    locked=0
    return 0
    ;;
  esac

  name="${path#"${agents_prefix}"}"
  short_branch="${branch#refs/heads/}"

  state=""
  if [ "${locked}" -eq 1 ]; then
    state="active (locked by its agent)"
  elif [ -n "$(git -C "${path}" status --porcelain)" ]; then
    state="dirty (uncommitted work)"
  elif [ -z "${short_branch}" ]; then
    state="detached HEAD — inspect by hand"
  elif [ "$(git rev-parse "${short_branch}")" = "$(git rev-parse main)" ]; then
    # A branch sitting exactly on main's HEAD has no history of its own: it is
    # either a worktree an agent has only just created and not yet committed
    # into, or one that did nothing. Either way it is not litter left by a
    # merge — a merged branch's HEAD stays on its own last commit while main
    # moves past it. Removing it here is what once deleted a running agent's
    # fresh worktree out from under it (2026-08-27). Left for a human.
    state="no commits of its own — fresh or untouched, not auto-removed"
  elif git cherry main "${short_branch}" | grep -q '^+'; then
    state="unmerged commits — accept or discard by hand"
  fi

  if [ -z "${state}" ]; then
    if [ "${mode}" = "clean" ]; then
      git worktree remove "${path}"
      git branch -D "${short_branch}" >/dev/null
      printf 'removed  %-40s %s\n' "${name}" "${short_branch}"
      removed=$((removed + 1))
    else
      printf 'merged   %-40s %s (removable: pnpm worktrees:clean)\n' "${name}" "${short_branch}"
    fi
  else
    printf 'kept     %-40s %s — %s\n' "${name}" "${short_branch:-—}" "${state}"
    kept=$((kept + 1))
  fi

  path=""
  branch=""
  locked=0
}

while IFS= read -r line; do
  case "${line}" in
  worktree\ *) flush; path="${line#worktree }" ;;
  branch\ *) branch="${line#branch }" ;;
  locked*) locked=1 ;;
  esac
done <<EOF
${listing}
EOF
flush

git worktree prune

if [ "${mode}" = "clean" ]; then
  printf 'Removed: %s, kept: %s.\n' "${removed}" "${kept}"
fi
