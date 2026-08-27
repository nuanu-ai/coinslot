#!/usr/bin/env bash
#
# Does the SDK work for somebody who does not have this repository?
#
# Everything else about the packaging can be green while the answer is no. The
# unit tests read our own `package.json` and believe it; the type checker
# resolves `@coinslot/sdk` through the workspace link and never looks at what
# `files` would ship; `pnpm test` imports TypeScript that a merchant's Node
# would refuse. Each of those passes on a package that installs into someone
# else's project and dies on first use. So this check does the only thing that
# settles it: it packs the tarballs npm would publish, installs them into a
# directory that has no path back here, and runs the two commands the
# quickstart tells a merchant to run.
#
# It needs the network, because the install pulls zod from the registry. That
# is why it lives beside `pnpm smoke` and not inside `pnpm test`, which is free,
# offline and fast and must stay that way.
#
# Two packages are packed and not one. `@coinslot/sdk` depends on
# `@coinslot/contracts`, so a merchant who installs the SDK installs both, and a
# check that packed only the SDK would prove nothing about the half that carries
# the schemas.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/coinslot-outside.XXXXXX")"

failures=0

# A passing run leaves nothing behind; a failing one leaves everything, because
# the install and the tarballs are what whoever debugs it needs to look at.
cleanup() {
  if [ "$failures" -eq 0 ]; then
    rm -rf "$scratch"
  else
    printf '\nLeft in place for reading: %s\n' "$scratch"
  fi
}
trap cleanup EXIT

# Report and keep going, so one run names everything that is wrong rather than
# only the first thing. The exit code at the bottom is what fails the command.
check() {
  local what="$1" expected="$2" actual="$3"

  if [ "$expected" = "$actual" ]; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n         expected: %s\n         actual:   %s\n' \
      "$what" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

contains() {
  local what="$1" needle="$2" haystack="$3"

  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n         no "%s" in what it said\n' "$what" "$needle"
    failures=$((failures + 1))
  fi
}

echo "Packing the two publishable packages the way a release would"
# The build output is deleted first on purpose. Each package's `prepack` runs
# its own build, so packing from nothing is the path a release actually takes,
# and a package that had lost that hook would pack an empty tarball here rather
# than quietly inherit whatever an earlier build left lying around.
rm -rf "$repo/packages/sdk/dist" "$repo/packages/contracts/dist"
# `pnpm pack` applies `publishConfig`, so these tarballs carry the built entry
# points and the command — not the source paths the working tree develops
# against — and `workspace:*` has become a real version range.
pnpm --filter @coinslot/contracts exec pnpm pack --pack-destination "$scratch" >/dev/null
pnpm --filter @coinslot/sdk exec pnpm pack --pack-destination "$scratch" >/dev/null
ls -1 "$scratch"

echo
echo "What the tarballs would ship"
# An allowlist and not a list of things we fear. Naming the bad files would
# pass anything nobody thought of — a stray `.env`, a `node_modules`, the
# sources — whereas `dist` plus the manifest is the entire agreed surface, so
# anything else appearing is the finding.
for tarball in "$scratch"/coinslot-*.tgz; do
  unexpected="$(tar -tzf "$tarball" |
    grep -vE '^package/(package\.json|dist/)' || true)"
  check "$(basename "$tarball") ships its build and nothing else" "" "$unexpected"
done

contains "the command is in it" "package/dist/cli.js" \
  "$(tar -tzf "$scratch"/coinslot-sdk-*.tgz)"

echo
echo "Installing the tarballs into $scratch"
# The tarballs were written here rather than into the repository, so nothing in
# this directory names a path inside our workspace. Node resolves modules by
# walking up from where it starts, and from a temporary directory that walk
# never reaches us. npm and not pnpm, because npm is what the quickstart tells
# a merchant to use and what most of them have.
cd "$scratch"
cat > package.json <<'JSON'
{
  "name": "a-merchant-project",
  "version": "1.0.0",
  "type": "module",
  "private": true
}
JSON

npm install --no-audit --no-fund ./coinslot-contracts-*.tgz ./coinslot-sdk-*.tgz

# The pilot's own eSIM card, the one the vertical slice publishes and sells.
cat > card.json <<'JSON'
{
  "merchant_item_id": "esim-eu-5gb-30d",
  "title": "eSIM, Europe, 5 GB, 30 days",
  "description": "A data-only eSIM for Europe: 5 GB, valid 30 days from first activation. Delivered as an activation code once the provider issues the profile.",
  "price": { "amount": "8.00", "currency": "USD" },
  "params": {
    "email": { "type": "string", "required": true, "title": "Where to send the activation code" }
  },
  "result": {
    "activation_code": { "type": "string", "title": "The eSIM activation code (an LPA string)" },
    "iccid": { "type": "string", "title": "The eSIM ICCID" }
  },
  "fulfillment": "async"
}
JSON

# The same card with its title taken out: the negative control. Without it a
# command that printed "complete" unconditionally would pass every assertion
# above and this check would be theatre.
node -e '
  const card = JSON.parse(require("fs").readFileSync("card.json", "utf8"));
  delete card.title;
  require("fs").writeFileSync("untitled-card.json", JSON.stringify(card, null, 2));
'

echo
echo "Step 3 of the quickstart: importing the package"
# A merchant's first line of integration code. It is run through `node` with no
# loader, no transpiler and no configuration, because that is what they have.
# Both halves matter: that the entry point resolves at all, and that what comes
# out of it is the working code rather than an empty shape.
imported="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { checkCard, createClient, contractVersion } from "@coinslot/sdk";
  const card = JSON.parse(readFileSync("card.json", "utf8"));
  const complete = checkCard(card).problems.length === 0;
  console.log(`contract=${contractVersion} client=${typeof createClient} complete=${complete}`);
' 2>&1)" || imported="node refused it: $imported"
echo "  $imported"
contains "the entry point imports and its exports are callable" \
  "client=function" "$imported"
contains "the check runs on a real card" "complete=true" "$imported"

echo
echo "Step 4 of the quickstart: npx coinslot verify"

# Where `npx coinslot` will resolve, checked before it is run. This matters more
# than it looks: `coinslot` is an unscoped name and there is an unrelated package
# under it on the public registry. If our `bin` wiring ever broke, npx would go
# and fetch that one, and the runs below would fail with somebody else's output
# instead of saying our command is missing.
linked="$(readlink node_modules/.bin/coinslot 2>&1 || true)"
check "npx will find our command and not a stranger's" \
  "../@coinslot/sdk/dist/cli.js" "$linked"

run() {
  set +e
  out="$(npx coinslot "$@" 2>&1)"
  code=$?
  set -e
}

run verify card.json
echo "--- npx coinslot verify card.json (exit $code) ---"
echo "$out"
check "a complete card answers 3, because idempotency never ran" "3" "$code"
contains "it says the card is complete" "complete as far as the contract can tell" "$out"
contains "it claims nothing about the check that did not run" \
  "Nothing is claimed about idempotency" "$out"

run verify untitled-card.json
echo "--- npx coinslot verify untitled-card.json (exit $code) ---"
echo "$out"
check "a card with a finding answers 1" "1" "$code"
contains "it names the field that is missing" "title:" "$out"

run verify
echo "--- npx coinslot verify (exit $code) ---"
echo "$out"
check "the bare command answers 3 and refuses" "3" "$code"
contains "it explains itself to whoever typed it" \
  "where you keep the cards you" "$out"

echo
if [ "$failures" -eq 0 ]; then
  echo "The package works outside this repository."
else
  echo "$failures check(s) failed: the package does not work outside this repository."
fi
exit "$failures"
