/**
 * The account command, wired to the database and to standard input.
 *
 * A merchant registers for themselves now (ADR-0014), so this is not the only
 * way an account comes into being. It is the way one is made for a merchant
 * that already exists at the gateway — the first account on a deployed server —
 * and it is still the answer to a lost password. In the local stack it is one
 * line, run against the cabinet that is already up, with the merchant's key
 * arriving on standard input rather than on the command line:
 *
 *   docker compose exec -T cabinet \
 *     pnpm --filter @coinslot/cabinet account add you@example.com mer_x
 *
 * Outside Docker it needs the same DATABASE_URL the cabinet itself is given and
 * nothing else — the key comes in on standard input, and nothing here talks to
 * the gateway:
 *
 *   DATABASE_URL=postgres://coinslot:coinslot@localhost:5432/coinslot \
 *     pnpm --filter @coinslot/cabinet account list
 *
 * What the file itself does is only the wiring. The commands are in
 * `account-command.ts`, where they are tested without a database.
 */

import { runAccount } from "./account-command.js";
import { loadConfig } from "./config.js";
import { connect } from "./database.js";
import { identityFor } from "./identity.js";

// The whole configuration, not the database address alone. What this command
// makes is a password the component derives, and the component is built from
// the same values the cabinet is built from — so a command run with a different
// secret from the process it is making an account for would be a puzzle nobody
// wants to solve at a terminal. Reading it here means the same refusal, in the
// same words, before anything is written.
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (thrown) {
  console.error(thrown instanceof Error ? thrown.message : String(thrown));
  process.exit(1);
}

/**
 * Everything on standard input, as one string.
 *
 * Read only when a verb asks for it, so that the three verbs with no key to
 * take do not sit waiting on a terminal nobody is piping into. Where standard
 * input is a terminal rather than a pipe, that wait is what a person would see,
 * so it is said out loud first — otherwise the command looks hung.
 */
const readStandardInput = async (): Promise<string> => {
  if (process.stdin.isTTY === true) {
    console.log("Waiting for the merchant's key on standard input. Ctrl-D when it is in.");
  }
  process.stdin.setEncoding("utf8");
  let said = "";
  for await (const chunk of process.stdin) {
    said += chunk;
  }
  return said;
};

const identity = identityFor(config, { pool: connect(config.databaseUrl) });
let code = 1;
try {
  code = await runAccount(process.argv.slice(2), identity, {
    say: (line) => {
      console.log(line);
    },
    readKey: readStandardInput,
  });
} catch (thrown) {
  // Whatever the command did not have a better sentence for. The one failure
  // that has a better sentence — a database the migrations have never been run
  // against — is answered inside `runAccount`, where it is tested; putting the
  // recognition here is what made it unreachable, because the store's own error
  // and the driver's are not the same object.
  console.error(thrown);
} finally {
  await identity.close();
}

// `process.exitCode` and not `process.exit`, because this command's whole
// output is a password shown once. Node's own documentation says writes to
// stdout are asynchronous when it is a pipe — which is what it is under
// `docker compose exec` — and `process.exit` does not wait for them. I could
// not make it truncate on this machine; the cost of not finding out the hard
// way is one word.
process.exitCode = code;
