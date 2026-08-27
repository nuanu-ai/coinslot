/**
 * The gate in front of the database suite.
 *
 * Without it, `pnpm test:db` with no Postgres reachable skips every file and
 * exits zero. A person watching the output sees the sentence explaining why and
 * is not misled — but a script reading the exit code, and CI, see a suite that
 * passed while nothing ran at all. That is the failure `coinslot verify`
 * refuses by name: it will not report success for a check that never happened.
 *
 * So the absence of a database fails this command rather than quietly doing
 * nothing. It is one sentence and not a wall of connection errors, which is
 * what the per-file skips were written to avoid — and those stay where they
 * are, because they still answer for a server that goes away between this probe
 * and a test.
 */

import {
  noDatabaseHere,
  readyDatabase,
  testDatabaseUrl,
} from "./apps/gateway/src/testing/database.js";

export async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  if ((await readyDatabase(url)) !== null) {
    return;
  }

  // `noDatabaseHere` already names the address and the command to run, so this
  // adds only the part it cannot know: that skipping is not on offer here.
  throw new Error(
    `${noDatabaseHere(url)}\n  This command is the suite that needs one, so there is nothing it can\n  honestly report.\n`,
  );
}
