/**
 * The merchant command, wired to the database.
 *
 * This is how a merchant and a key come into being until the cabinet's own
 * screens for it exist (ADR-0010). Against the local stack it is one line, run
 * on the gateway that is already up:
 *
 *   docker compose exec gateway \
 *     pnpm --filter @coinslot/gateway merchant add "Someone's shop"
 *
 * Outside Docker it needs the same DATABASE_URL and the same PAYMENT_NETWORK
 * the gateway itself is given, and nothing else — no key of any kind, because
 * nothing here goes over the API:
 *
 *   DATABASE_URL=postgres://coinslot:coinslot@localhost:5432/coinslot \
 *     PAYMENT_NETWORK=eip155:84532 \
 *     pnpm --filter @coinslot/gateway merchant list
 *
 * Outside Docker the chain is explicit because a key carries the environment
 * it was issued in, and a database address says nothing about which chain the
 * gateway in front of it settles on. Inside Docker the command inherits the
 * channel's PAYMENT_NETWORK from Compose.
 *
 * What this file does is only the wiring. The commands are in
 * `merchant-command.ts`, where they are tested without a database.
 */

import { environmentOf } from "@coinslot/core";
import { connect, PostgresStore } from "./adapters/postgres/store.js";
import { runMerchant } from "./merchant-command.js";
import { randomIds, systemClock } from "./ports/clock.js";

/** Postgres's own answer for "there is no table by that name". */
const NO_SUCH_TABLE = "42P01";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error(
    "DATABASE_URL is not set, so there is no database to keep a merchant in." +
      " It is the same address the gateway is given.",
  );
  process.exit(1);
}

// Told, never defaulted. Inside the container this is the same value the
// gateway was given; outside it — which this file's own header describes — it
// is the one thing that cannot be inferred from a database address, and
// guessing it wrong mints a key for the other site that opens nothing here.
//
// `loadConfig` is the wrong tool for exactly that reason: PAYMENT_NETWORK
// defaults to Base Sepolia there, so the invocation the header documents,
// pointed at the live database, would derive `test` and hand somebody a key the
// live gateway refuses. A default towards play money is the safe direction for
// the process that moves money and the wrong one for the command that issues
// the keys to move it with.
const network = process.env.PAYMENT_NETWORK;
if (network === undefined || network === "") {
  console.error(
    "[merchant] PAYMENT_NETWORK is not set, and a key carries the environment it was issued " +
      "in. Give this command the same chain the gateway it belongs to was given; there is no " +
      "default for it, because a key made for the wrong site opens nothing and says nothing " +
      "about why",
  );
  process.exit(1);
}
const environment = environmentOf(network);

const { db, pool } = connect(databaseUrl);
let code = 1;
try {
  code = await runMerchant(
    process.argv.slice(2),
    new PostgresStore(db, randomIds),
    randomIds,
    systemClock,
    (line) => {
      console.log(line);
    },
    environment,
  );
} catch (thrown) {
  // The tables are not there. Said as its own thing, because the database's own
  // sentence names a table nobody has heard of and does not say what to run.
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    String((thrown as { code: unknown }).code) === NO_SUCH_TABLE
  ) {
    console.error(
      "The gateway's tables are not in this database yet." +
        " Run: pnpm --filter @coinslot/gateway db:migrate",
    );
  } else {
    console.error(thrown);
  }
} finally {
  await pool.end();
}

// `process.exitCode` and not `process.exit`, because this command's whole
// output can be a key shown once, and writes to stdout are asynchronous when it
// is a pipe — which is what it is under `docker compose exec`.
process.exitCode = code;
