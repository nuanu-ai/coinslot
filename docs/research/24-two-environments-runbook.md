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
configuration.

```bash
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
```

The test seed already has the listing name `Coinslot test site`. The live
seed has no public listing name, so give it the actual name it trades under;
do not invent an example name in this document.

```bash
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
check_public_site() {
  local site="$1"
  local mode="$2"
  local path page

  for path in / /docs/ /cabinet/sign-in; do
    page="$(curl --disable --noproxy '*' --fail --silent --show-error \
      --max-time 15 "https://${site}${path}")"
    grep -Fq "data-coinslot-surface=\"${mode}\"" <<<"$page"
    printf 'public %s%s says %s\n' "$site" "$path" "$mode"
  done

  for path in /healthz /v0/catalog; do
    curl --disable --noproxy '*' --fail --silent --show-error \
      --max-time 15 "https://${site}${path}" >/dev/null
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
grep -qx 'COINSLOT_INVITATION=' "$HOME/coinslot/.env" || {
  printf '%s\n' 'STOP: live registration is not explicitly closed.' >&2
  exit 1
}
```

Use two terminals in a checkout of the exact live release. In terminal A, read
the live seeded merchant key without echoing it and export it under the name
the worker reads. The key is neither an argument nor a file.

```bash
IFS= read -r -s -p 'Live seeded merchant key: ' SEEDED_KEY
printf '\n'
export MERCHANT_API_KEY="$SEEDED_KEY"
export GATEWAY_URL='https://coinslot.nuanu.ai'
pnpm --filter @coinslot/slice serve
```

Wait for `two cards published` and a live subscription before continuing in
terminal B. The worker publishes the cards and remains subscribed so the
synchronous sale can be delivered.

In terminal B, read the same seeded key without echoing it. Create a mode-0700
evidence directory. Every authenticated curl below gets its header as curl
configuration on standard input. `curl --disable --noproxy '*'` prevents a
user curl configuration or proxy from receiving the secret; the key is in
neither curl's arguments nor a file.

```bash
set -u
set -o pipefail
IFS= read -r -s -p 'Live seeded merchant key: ' SEEDED_KEY
printf '\n'
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
Read its private key into the environment without echoing or writing it. Run
the command once without `--confirm`: it prints the public buyer address, the
payee, the mainnet chain, and the quoted price without signing anything. Stop
unless the public buyer address has enough Base-mainnet USDC and gas, differs
from the payee, the one-purchase cap admits the quote, and the total cap admits
the whole run.

```bash
IFS= read -r -s -p 'Funded Base-mainnet buyer private key: ' SMOKE_BUYER_KEY
printf '\n'
export SMOKE_BUYER_KEY

COINSLOT_SMOKE=1 \
GATEWAY_URL='https://coinslot.nuanu.ai' \
SMOKE_ALLOW_MAINNET=1 \
SMOKE_MAX_USD=4.00 \
SMOKE_TOTAL_USD=4.00 \
SMOKE_WAIT_MINUTES=0 \
  pnpm smoke:bootstrap "$ITEM_ID"
```

Only after reading that dry run and checking the funded, distinct buyer may
the explicit spending command be run. `SMOKE_BUYER_KEY` remains inherited from
the environment and never appears in the arguments.

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
bootstrap_status="${PIPESTATUS[0]}"
set -e
printf '%s\n' "$bootstrap_status" >"$bootstrap_status_file"

test "$bootstrap_status" -ne 0
grep -F 'SETTLED, NOT YET LISTED' "$bootstrap_output" |
  grep -Fv 'no transaction named' >/dev/null
```

`SETTLED, NOT YET LISTED` with a non-zero exit is the expected measurement:
settlement happened, while catalog indexing remains unknown. Any other
non-zero result is not success. The output line supplies the settlement
transaction; the receipt schema does not contain a transaction field and must
not be reported as if it did.

Read the receipts once more, then pause every card through the authenticated
API before interpreting the files. The receipt request's status is retained so
a read failure cannot prevent the pause. If the pause call fails, stop the
worker immediately and investigate before making any other purchase.

```bash
receipts_after="$evidence_dir/receipts-after.json"
pause_response="$evidence_dir/pause.json"
install -m 600 /dev/null "$receipts_after"
install -m 600 /dev/null "$pause_response"

receipt_read_status=0
printf 'header = "Authorization: Bearer %s"\n' "$SEEDED_KEY" |
  curl --disable --noproxy '*' --config - --fail --silent --show-error \
    'https://coinslot.nuanu.ai/v0/receipts' >"$receipts_after" ||
  receipt_read_status="$?"

printf 'header = "Authorization: Bearer %s"\n' "$SEEDED_KEY" |
  curl --disable --noproxy '*' --config - --fail --silent --show-error \
    --request POST 'https://coinslot.nuanu.ai/v0/selling/pause' \
    >"$pause_response"
jq -e '.selling == "paused" and
       (.cards | length > 0) and
       ([.cards[].selling] | all(. == "paused"))' \
  "$pause_response" >/dev/null

test "$receipt_read_status" -eq 0
```

Now stop terminal A with Ctrl-C and wait for its explicit `SIGINT: stopping`
line. The worker is stopped after the API pause, so a new order is refused at
the gateway before there is nobody subscribed to deliver it.

Identify the one receipt added by this sale and verify the claims the API can
actually make: it names the selected card, is delivered, carries the `3.50`
sale price, and says the payment was real. The before/after delta avoids
presenting an old receipt as evidence of this run.

```bash
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
