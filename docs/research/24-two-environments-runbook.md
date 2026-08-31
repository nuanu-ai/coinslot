# Two public environments: first-release runbook

This runbook prepares three manual ceremonies: removing the database used by
the existing `coinslot` Compose project without losing the evidence needed to
understand it, provisioning the seeded merchant in each fresh public stack,
and proving the first live sale. It is a procedure for future host work. It is
not evidence that DNS, ingress, environment files, secrets, releases, a sale,
a settlement, a receipt, or the reset already exist or have happened.

The public channels are separate. `coinslot-test` is the Compose project for
`test.coinslot.nuanu.ai`; `coinslot` is the project for
`coinslot.nuanu.ai`. Both release channels use the same lock file because they
share a host and a Docker daemon.

## Reset the shared `coinslot` project before either first release

Run this ceremony in one Bash session on the host. Keep that session open from
the lock command through `down -v`: closing it releases the lock. The dump and
both inventories are written under `$HOME/coinslot-backups`, outside the
deployment directory. They contain operational data and are mode 0600.

First take the release lock without waiting. A refusal means another release
holds it; stop here and come back after that release has finished.

```bash
set -euo pipefail
mkdir -p "$HOME/.cache"
exec 9>"$HOME/.cache/coinslot-deploy.lock"
flock -n 9 || {
  printf '%s\n' 'STOP: another release holds the Coinslot deployment lock.' >&2
  exit 1
}
```

Stop every application that can read or write the resident database before
counting anything. PostgreSQL stays up only for the inventory, dump, and
restore check.

```bash
cd "$HOME/coinslot"
docker compose --project-name coinslot stop gateway cabinet merchant web
```

Create the evidence directory and print and retain the five exact counts. The
cabinet has no database of its own: `cabinet_accounts` is in `coinslot` beside
the gateway's merchants, cards, orders, and receipts.

```bash
install -d -m 700 "$HOME/coinslot-backups"
inventory_path="$(mktemp "$HOME/coinslot-backups/coinslot-before-two-environments.XXXXXX.inventory.txt")"

{
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot --set ON_ERROR_STOP=1 \
      --tuples-only --no-align --quiet \
      --command "SELECT 'merchants=' || count(*) FROM merchants;"
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot --set ON_ERROR_STOP=1 \
      --tuples-only --no-align --quiet \
      --command "SELECT 'cards=' || count(*) FROM cards;"
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot --set ON_ERROR_STOP=1 \
      --tuples-only --no-align --quiet \
      --command "SELECT 'cabinet_accounts=' || count(*) FROM cabinet_accounts;"
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot --set ON_ERROR_STOP=1 \
      --tuples-only --no-align --quiet \
      --command "SELECT 'orders=' || count(*) FROM orders;"
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot --set ON_ERROR_STOP=1 \
      --tuples-only --no-align --quiet \
      --command "SELECT 'receipts=' || count(*) FROM receipts;"
} | tee "$inventory_path"

test "$(stat -c '%a' "$inventory_path")" = 600
```

Take one custom-format archive. There is one resident database to preserve:
`coinslot`. The migration suite's `coinslot_test` database is scratch data and
is not part of this reset.

```bash
dump_path="$(mktemp "$HOME/coinslot-backups/coinslot-before-two-environments.XXXXXX.dump")"
docker compose --project-name coinslot exec -T postgres \
  pg_dump --username coinslot --dbname coinslot --format=custom \
    --no-owner --no-privileges >"$dump_path"
test "$(stat -c '%a' "$dump_path")" = 600
docker compose --project-name coinslot exec -T postgres \
  pg_restore --list <"$dump_path" >/dev/null
```

A file that exists is not yet a backup that reads. Restore it into the one
explicit throwaway database below and recount the same five tables. The first
`dropdb` only clears residue from a previously interrupted attempt; it cannot
name the resident `coinslot` database.

```bash
docker compose --project-name coinslot exec -T postgres \
  dropdb --username coinslot --if-exists coinslot_restore_check_two_environments
docker compose --project-name coinslot exec -T postgres \
  createdb --username coinslot --owner coinslot --template template0 \
    coinslot_restore_check_two_environments
docker compose --project-name coinslot exec -T postgres \
  pg_restore --username coinslot \
    --dbname coinslot_restore_check_two_environments \
    --exit-on-error --no-owner --no-privileges <"$dump_path"

restored_inventory_path="$(mktemp "$HOME/coinslot-backups/coinslot-restored.XXXXXX.inventory.txt")"
{
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot_restore_check_two_environments \
      --set ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
      --command "SELECT 'merchants=' || count(*) FROM merchants;"
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot_restore_check_two_environments \
      --set ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
      --command "SELECT 'cards=' || count(*) FROM cards;"
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot_restore_check_two_environments \
      --set ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
      --command "SELECT 'cabinet_accounts=' || count(*) FROM cabinet_accounts;"
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot_restore_check_two_environments \
      --set ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
      --command "SELECT 'orders=' || count(*) FROM orders;"
  docker compose --project-name coinslot exec -T postgres \
    psql --username coinslot --dbname coinslot_restore_check_two_environments \
      --set ON_ERROR_STOP=1 --tuples-only --no-align --quiet \
      --command "SELECT 'receipts=' || count(*) FROM receipts;"
} | tee "$restored_inventory_path"

test "$(stat -c '%a' "$restored_inventory_path")" = 600
cmp --silent "$inventory_path" "$restored_inventory_path" || {
  printf '%s\n' 'STOP: restored counts differ from resident counts.' >&2
  exit 1
}
```

Only after the restore succeeds and `cmp` agrees may the throwaway database and
the resident Compose volume be removed. Both destructive commands below name
their narrow target literally.

```bash
docker compose --project-name coinslot exec -T postgres \
  dropdb --username coinslot --if-exists coinslot_restore_check_two_environments
docker compose --project-name coinslot down -v
printf 'kept inventory: %s\nkept restored inventory: %s\nkept dump: %s\n' \
  "$inventory_path" "$restored_inventory_path" "$dump_path"
```

Nothing from the old database is restored into either public stack. If the
inventory reveals data worth carrying over, stop and make that a separate
decision in front of the counts and archive.

## Provision each fresh stack

A fresh public stack seeds `the_merchant` and one `merchant_code` key. That key
is deliberately not a cabinet credential: `cabinet account add` refuses it,
and no cabinet account is created for this seeded merchant. The seeded merchant
is operator-managed. Registration, when opened later, creates a separate real
merchant with its own cabinet login.

Before publishing, give the seeded merchant a payout wallet on both stacks.
The address is public data, but the command validates it before writing. Run
each command from its deployment directory so Compose uses that channel's
configuration. The test seed is listed as `Coinslot test site`; the live seed
has no public listing name, so the last command asks for its actual trading
name rather than inventing one here.

```bash
set -euo pipefail

read -r -p 'Test merchant payout wallet (0x address): ' TEST_PAYOUT_WALLET
(
  cd "$HOME/coinslot-test"
  docker compose --project-name coinslot-test exec -T gateway \
    pnpm --filter @coinslot/gateway merchant \
      pays-to the_merchant "$TEST_PAYOUT_WALLET"
)

read -r -p 'Live merchant payout wallet (0x address): ' LIVE_PAYOUT_WALLET
(
  cd "$HOME/coinslot"
  docker compose --project-name coinslot exec -T gateway \
    pnpm --filter @coinslot/gateway merchant \
      pays-to the_merchant "$LIVE_PAYOUT_WALLET"
)

# This line is reached only after both payout commands have succeeded.
read -r -p 'Live merchant public trading name: ' LIVE_SELLER_NAME
(
  cd "$HOME/coinslot"
  docker compose --project-name coinslot exec -T gateway \
    pnpm --filter @coinslot/gateway merchant \
      listed-as the_merchant "$LIVE_SELLER_NAME"
)
```

Publishing is then done by that channel's merchant worker with its seeded key
in `MERCHANT_API_KEY`. The key is read from the environment, never passed as a
command argument and never made into a cabinet key. The live host variable
that closes registration is `COINSLOT_INVITATION=`; Compose maps it to the
gateway process's `REGISTRATION_INVITATION`. Leave live registration closed
until the live-sale gate and the separate mail prerequisite are both resolved.

## Check the public path after each first release

The release script checks the origin by resolving the hostname directly to the
host. That does not traverse public DNS and ingress. After the future first
release of a channel, run these checks from a machine outside the deployment
host and its ingress. They verify the public page markers and the two public
JSON endpoints without reading any authenticated data.

```bash
set -euo pipefail

check_public_site() {
  local site="$1"
  local mode="$2"
  local path page

  for path in / /docs/ /cabinet/sign-in; do
    if ! page="$(curl --disable --noproxy '*' --fail --silent --show-error \
      --max-time 15 "https://${site}${path}")"; then
      printf 'FAIL: public %s%s did not answer\n' "$site" "$path" >&2
      return 1
    fi
    if ! grep -Fq "data-coinslot-surface=\"${mode}\"" <<<"$page"; then
      printf 'FAIL: public %s%s does not say %s\n' "$site" "$path" "$mode" >&2
      return 1
    fi
    printf 'public %s%s says %s\n' "$site" "$path" "$mode"
  done

  for path in /healthz /v0/catalog; do
    if ! curl --disable --noproxy '*' --fail --silent --show-error \
      --max-time 15 "https://${site}${path}" >/dev/null; then
      printf 'FAIL: public %s%s did not answer\n' "$site" "$path" >&2
      return 1
    fi
    printf 'public %s%s answered\n' "$site" "$path"
  done
}

check_public_site test.coinslot.nuanu.ai test
check_public_site coinslot.nuanu.ai live
```

These commands are a prepared acceptance check, not a statement that either
hostname or ingress path currently answers.

## The live site's first sale

> **STOP — ADR-0011 blocks a live payment.** Do not run any part of this
> ceremony that publishes live products or signs a payment until Dmitry records
> one of the two choices in `docs/decisions/0011-agent-collection-door.md`:
> narrow the order-status door, or deliberately re-accept its bearer-order-id
> risk for real money. This runbook chooses neither. The checklist below is
> prepared only, and the stop remains in force until that decision is written.

After the ADR gate is resolved, first verify without printing the file that
registration is still closed by the host variable Compose actually consumes.

```bash
set -euo pipefail

grep -qx 'COINSLOT_INVITATION=' "$HOME/coinslot/.env" || {
  printf '%s\n' 'STOP: live registration is not explicitly closed.' >&2
  exit 1
}
```

Use two terminals in a checkout of the exact live release. In terminal A, read
the live seeded merchant key without echoing it and export it under the name
the worker reads. The key is neither an argument nor a file.

```bash
set -euo pipefail

IFS= read -r -s -p 'Live seeded merchant key: ' SEEDED_KEY
printf '\n'
export MERCHANT_API_KEY="$SEEDED_KEY"
export GATEWAY_URL='https://coinslot.nuanu.ai'
pnpm --filter @coinslot/slice serve
```

Wait for `two cards published` and a live subscription before continuing in
terminal B. The worker publishes the cards and remains subscribed so the
synchronous sale can be delivered.

Run every Terminal B fence below in the same dedicated Bash session. It begins
fail-closed. Before making an evidence directory or reading a card, arm an
exit trap that pauses all selling through the authenticated API. The pause is
idempotent. The trap keeps retry responsibility attached to every premature
exit until a pause response has been positively checked; it never writes the
key or puts it in an argument. `SEEDED_KEY` starts empty and all exit and
signal handlers are armed before the secret prompt. If the prompt fails or no
key is read, cleanup does not attempt authentication: it exits nonzero and
says to keep terminal A running and subscribed.

Every authenticated curl gets its header as configuration on standard input.
`printf` is Bash's builtin, so the key does not become another process's
argument. `curl --disable --noproxy '*'` prevents a user curl configuration or
proxy from receiving it.

```bash
set -euo pipefail

selling_pause_verified=0
pause_document=''
SEEDED_KEY=''

pause_all_selling() {
  local response

  if ! response="$(
    printf 'header = "Authorization: Bearer %s"\n' "$SEEDED_KEY" |
      curl --disable --noproxy '*' --config - --fail --silent --show-error \
        --request POST 'https://coinslot.nuanu.ai/v0/selling/pause'
  )"; then
    return 1
  fi

  if ! jq -e '.selling == "paused" and
              (.cards | length > 0) and
              ([.cards[].selling] | all(. == "paused"))' \
    <<<"$response" >/dev/null; then
    return 1
  fi

  pause_document="$response"
}

emergency_pause_on_exit() {
  local prior_status="$?"
  local attempt

  trap - EXIT HUP INT TERM
  if [[ "$selling_pause_verified" == 1 ]]; then
    exit "$prior_status"
  fi

  if [[ -z "$SEEDED_KEY" ]]; then
    printf '%s\n' \
      'EMERGENCY: the global selling pause could not be attempted because no seeded key was read.' \
      'DO NOT stop Terminal A; keep the worker running and subscribed.' \
      'Read the seeded key in a fresh Terminal B and confirm POST /v0/selling/pause before stopping it.' >&2
    exit 1
  fi

  for attempt in 1 2 3; do
    if pause_all_selling; then
      selling_pause_verified=1
      printf '%s\n' \
        'Emergency cleanup confirmed that all selling is paused.' \
        'Terminal A may now be stopped.' >&2
      exit "$prior_status"
    fi
    printf 'Emergency pause attempt %s of 3 was not verified.\n' \
      "$attempt" >&2
  done

  printf '%s\n' \
    'EMERGENCY: the global selling pause could not be verified.' \
    'DO NOT stop Terminal A; keep the worker running and subscribed.' \
    'Repair the API path and confirm POST /v0/selling/pause before stopping it.' >&2
  exit 1
}

trap emergency_pause_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
IFS= read -r -s -p 'Live seeded merchant key: ' SEEDED_KEY
printf '\n'
[[ -n "$SEEDED_KEY" ]] || {
  printf '%s\n' 'STOP: no live seeded merchant key was read.' >&2
  exit 1
}

evidence_dir="$(mktemp -d "$HOME/coinslot-first-live-sale.XXXXXX")"
chmod 700 "$evidence_dir"
```

Read the authenticated card list and select the issued catalog identifier of
the synchronous card. `rented-number-us-30d` is the merchant's identifier and
must not be passed to `smoke:bootstrap`; the command needs the one `itm_...`
identifier returned here.

```bash
ITEM_ID="$(
  printf 'header = "Authorization: Bearer %s"\n' "$SEEDED_KEY" |
    curl --disable --noproxy '*' --config - --fail --silent --show-error \
      'https://coinslot.nuanu.ai/v0/cards' |
    jq -er --arg merchant_item_id 'rented-number-us-30d' \
      '[.cards[] | select(.card.merchant_item_id == $merchant_item_id) | .id]
       | if length == 1 then .[0]
         else error("expected exactly one synchronous card") end'
)"
[[ "$ITEM_ID" == itm_* ]] || {
  printf '%s\n' 'STOP: the card lookup did not return an itm_ identifier.' >&2
  exit 1
}
```

Take the receipt list before paying so the later check identifies a new
receipt instead of guessing that the list had been empty.

```bash
receipts_before="$evidence_dir/receipts-before.json"
install -m 600 /dev/null "$receipts_before"
printf 'header = "Authorization: Bearer %s"\n' "$SEEDED_KEY" |
  curl --disable --noproxy '*' --config - --fail --silent --show-error \
    'https://coinslot.nuanu.ai/v0/receipts' >"$receipts_before"
jq -e '.receipts | type == "array"' "$receipts_before" >/dev/null
```

The buyer must be a funded address distinct from the merchant's payout wallet.
Read its private key into the environment without echoing or writing it. The
dry run prints the public buyer address, payee, mainnet chain, and quoted price
without signing anything. A successful dry run deliberately exits 2, so its
output and status are captured and then checked. Any other result exits this
session and invokes the emergency pause.

```bash
IFS= read -r -s -p 'Funded Base-mainnet buyer private key: ' SMOKE_BUYER_KEY
printf '\n'
export SMOKE_BUYER_KEY

dry_run_output="$evidence_dir/bootstrap-dry-run.txt"
dry_run_status_file="$evidence_dir/bootstrap-dry-run.exit-status"
install -m 600 /dev/null "$dry_run_output"
install -m 600 /dev/null "$dry_run_status_file"

set +e
COINSLOT_SMOKE=1 \
GATEWAY_URL='https://coinslot.nuanu.ai' \
SMOKE_ALLOW_MAINNET=1 \
SMOKE_MAX_USD=4.00 \
SMOKE_TOTAL_USD=4.00 \
SMOKE_WAIT_MINUTES=0 \
  pnpm smoke:bootstrap "$ITEM_ID" 2>&1 | tee "$dry_run_output"
dry_run_pipeline_status=("${PIPESTATUS[@]}")
dry_run_status="${dry_run_pipeline_status[0]}"
dry_run_tee_status="${dry_run_pipeline_status[1]}"
set -e
printf '%s\n' "$dry_run_status" >"$dry_run_status_file"

test "$dry_run_status" -eq 2
test "$dry_run_tee_status" -eq 0
grep -F 'mode: dry run. Nothing will be signed.' "$dry_run_output" >/dev/null
grep -F 'DRY RUN: every gate passed and NOTHING was signed.' \
  "$dry_run_output" >/dev/null
grep -F 'would spend $3.50' "$dry_run_output" >/dev/null
```

Stop here and independently verify that the printed public buyer address has
enough Base-mainnet USDC and gas and differs from the printed payee. The
repository cannot prove funding. The explicit acknowledgement below is the
gate between that human check and `--confirm`; any other answer exits through
the emergency pause. `SMOKE_BUYER_KEY` remains inherited from the environment
and never appears in the arguments.

```bash
read -r -p \
  'After checking funding and distinct addresses, type FUNDED-AND-DISTINCT: ' \
  buyer_funding_gate
[[ "$buyer_funding_gate" == 'FUNDED-AND-DISTINCT' ]] || {
  printf '%s\n' 'STOP: funded, distinct buyer was not confirmed.' >&2
  exit 1
}
```

Run the confirmed command and capture its output and status, but interpret
neither yet. A non-zero status is expected only together with the settlement
marker; asserting that before safe disposition would let an evidence failure
leave cards selling.

```bash
bootstrap_output="$evidence_dir/bootstrap.txt"
bootstrap_status_file="$evidence_dir/bootstrap.exit-status"
install -m 600 /dev/null "$bootstrap_output"
install -m 600 /dev/null "$bootstrap_status_file"

set +e
COINSLOT_SMOKE=1 \
GATEWAY_URL='https://coinslot.nuanu.ai' \
SMOKE_ALLOW_MAINNET=1 \
SMOKE_MAX_USD=4.00 \
SMOKE_TOTAL_USD=4.00 \
SMOKE_WAIT_MINUTES=0 \
  pnpm smoke:bootstrap "$ITEM_ID" --confirm 2>&1 | tee "$bootstrap_output"
bootstrap_pipeline_status=("${PIPESTATUS[@]}")
bootstrap_status="${bootstrap_pipeline_status[0]}"
bootstrap_tee_status="${bootstrap_pipeline_status[1]}"
set -e
printf '%s\n' "$bootstrap_status" >"$bootstrap_status_file"
```

Read the receipts once more with failure captured rather than asserted, then
call and verify the global pause. Only a verified pause disarms the emergency
trap. If the normal pause attempt fails, exiting invokes the still-armed trap
for three emergency attempts. If none can verify the pause, its final diagnostic
is authoritative: do not stop Terminal A.

```bash
receipts_after="$evidence_dir/receipts-after.json"
pause_response="$evidence_dir/pause.json"
install -m 600 /dev/null "$receipts_after"
install -m 600 /dev/null "$pause_response"

receipt_read_status=0
set +e
printf 'header = "Authorization: Bearer %s"\n' "$SEEDED_KEY" |
  curl --disable --noproxy '*' --config - --fail --silent --show-error \
    'https://coinslot.nuanu.ai/v0/receipts' >"$receipts_after"
receipt_read_status="${PIPESTATUS[1]}"
set -e

if pause_all_selling; then
  printf '%s\n' "$pause_document" >"$pause_response"
  selling_pause_verified=1
  trap - EXIT HUP INT TERM
  printf '%s\n' \
    'SAFE DISPOSITION: all selling is paused.' \
    'Stop Terminal A now and wait for its SIGINT: stopping line.'
else
  printf '%s\n' \
    'The normal global pause could not be verified; emergency cleanup is running.' \
    'DO NOT stop Terminal A unless a later message positively confirms the pause.' >&2
  exit 1
fi
```

Only after the `SAFE DISPOSITION` line may Terminal A be stopped with Ctrl-C.
Wait for its explicit `SIGINT: stopping` line. A new order is then refused at
the gateway before there is nobody subscribed to deliver it.

With selling safe and the worker stopped, interpret the bootstrap result. The
expected measurement is a non-zero status together with
`SETTLED, NOT YET LISTED` and a transaction identifier. Any other non-zero
result is not success. The output supplies the settlement transaction; the
receipt schema does not contain one and must not be reported as if it did.

```bash
test "$bootstrap_status" -ne 0
test "$bootstrap_tee_status" -eq 0
grep -F 'SETTLED, NOT YET LISTED' "$bootstrap_output" |
  grep -Fv 'no transaction named' >/dev/null
```

Identify the one receipt added by this sale and verify the claims the API can
actually make: it names the selected card, is delivered, carries the `3.50`
sale price, and says the payment was real. The before/after delta avoids
presenting an old receipt as evidence of this run.

```bash
test "$receipt_read_status" -eq 0
jq -e '.receipts | type == "array"' "$receipts_after" >/dev/null

new_receipt="$evidence_dir/new-receipt.json"
install -m 600 /dev/null "$new_receipt"
jq --slurpfile before "$receipts_before" --arg item_id "$ITEM_ID" \
  '[.receipts[] | . as $receipt
    | select($receipt.item_id == $item_id)
    | select(([$before[0].receipts[].id] | index($receipt.id)) == null)]' \
  "$receipts_after" >"$new_receipt"

jq -e 'length == 1 and
       .[0].outcome == "delivered" and
       .[0].price.amount == "3.50" and
       .[0].price.currency == "USD" and
       .[0].test == false and
       (.[0].order_id | startswith("ord_"))' \
  "$new_receipt" >/dev/null
jq . "$new_receipt"
printf 'evidence directory: %s\n' "$evidence_dir"
```

The endpoint currently returns one list with no paging field; that is what the
before/after comparison covers. It is not a claim that future paging cannot
exist or that data omitted by a future server was absent.

Finally, write a research note from the retained artifacts. Record the exact
release marker and public-path checks, the command and its non-zero status, the
`SETTLED, NOT YET LISTED` line and transaction identifier, the new receipt, the
pause response, and the worker's stop line. Mark truncation as truncation and
unknown catalog indexing as unknown. Do not write either private key. Live
registration remains closed; opening it and configuring real mail are separate
future acts, not consequences of this checklist.
