import { describe, expect, it } from "vitest";
import { A_NAME_PG_BOSS_ACCEPTS, ENVELOPES, REMINDERS, streamOf } from "./queue.js";

/**
 * The one thing about this adapter that can be checked without a database.
 *
 * Everything else it does is pg-boss doing it, and `pnpm test` has no Postgres
 * to watch that against — the rest is covered by `pnpm test:db`. But a queue
 * name that pg-boss will not accept fails at the first call, which in
 * production is start-up and in an offline suite is nowhere.
 *
 * What this file can check is only that the names agree with the rule written
 * beside them. Whether that rule is pg-boss's rule is a question for pg-boss,
 * and it is asked in `queue.db-test.ts` — the first time anybody asked it, the
 * answer was not what the comment here had been claiming for as long as it had
 * existed.
 */
describe("the queue names", () => {
  it("are names pg-boss will take", () => {
    // pg-boss allows alphanumerics, underscores, hyphens, periods and forward
    // slashes in a queue name, and refuses everything else. These two use a
    // letter and an underscore, which is well inside that.
    for (const name of [ENVELOPES, REMINDERS]) {
      expect(name, name).toMatch(A_NAME_PG_BOSS_ACCEPTS);
    }
    // The separators somebody would reach for that are genuinely refused. A
    // period is not among them, however natural it looks as one.
    expect("coinslot envelopes").not.toMatch(A_NAME_PG_BOSS_ACCEPTS);
    expect("coinslot:envelopes").not.toMatch(A_NAME_PG_BOSS_ACCEPTS);
    expect("").not.toMatch(A_NAME_PG_BOSS_ACCEPTS);
  });

  it("are two different queues", () => {
    // One queue for both would hand a worker polling for orders the reminders
    // the gateway left itself.
    expect(ENVELOPES).not.toBe(REMINDERS);
  });

  it("give two merchants two different streams", () => {
    // Two merchants sharing a stream is the failure ADR-0010 is about, in the
    // one place a filter could not repair it: an envelope drawn to be looked at
    // is one its own merchant is not offered until it is finished.
    expect(streamOf("mch_a")).not.toBe(streamOf("mch_b"));
    expect(streamOf("mch_a")).toMatch(A_NAME_PG_BOSS_ACCEPTS);
    expect(streamOf("mch_a").startsWith(ENVELOPES)).toBe(true);
  });

  it("refuse a merchant whose identifier could not name a queue", () => {
    // Left to pg-boss, this would not be a start-up error somebody sees. It
    // would be one merchant whose orders reach nobody, discovered at the first
    // sale, with the failure looking like a worker that is not connected.
    expect(() => streamOf("a merchant")).toThrow(/cannot name a queue/);
    expect(() => streamOf("mch:a")).toThrow(/cannot name a queue/);
    expect(() => streamOf("")).toThrow(/cannot name a queue/);
  });
});
