import { describe, expect, it } from "vitest";
import { A_NAME_PG_BOSS_ACCEPTS, ENVELOPES, REMINDERS } from "./queue.js";

/**
 * The one thing about this adapter that can be checked without a database.
 *
 * Everything else it does is pg-boss doing it, and `pnpm test` has no Postgres
 * to watch that against — the rest is covered by `pnpm test:db`. But a queue
 * name that pg-boss will not accept fails at the first call, which in
 * production is start-up and in an offline suite is nowhere, and the obvious
 * name for a queue in this system is exactly the shape it refuses.
 */
describe("the queue names", () => {
  it("are names pg-boss will take", () => {
    // A queue name becomes a database object name, and pg-boss holds an
    // unquoted one to letters, digits and underscores, not starting with a
    // digit. A dot — the natural separator, and the first thing anybody writes
    // — is refused.
    for (const name of [ENVELOPES, REMINDERS]) {
      expect(name, name).toMatch(A_NAME_PG_BOSS_ACCEPTS);
    }
    expect("coinslot.envelopes").not.toMatch(A_NAME_PG_BOSS_ACCEPTS);
    expect("1st").not.toMatch(A_NAME_PG_BOSS_ACCEPTS);
  });

  it("are two different queues", () => {
    // One queue for both would hand a worker polling for orders the reminders
    // the gateway left itself.
    expect(ENVELOPES).not.toBe(REMINDERS);
  });
});
