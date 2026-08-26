import { describe, expect, it } from "vitest";
import { TEST_POLICY } from "./fixtures.js";
import { nextRedelivery } from "./redelivery.js";

const policy = TEST_POLICY.redelivery;

/**
 * An exception in the handler, a dead process and a broken connection are all
 * one thing: the answer never came back. The promise these tests guard is that
 * such an order is delivered again rather than closed, and that the repeating
 * stops before the mode's deadline instead of running past it.
 */
describe("deciding whether to deliver an order again", () => {
  it("backs off further with every attempt", () => {
    const first = nextRedelivery({ attempts: 1, now: 0, deadlineAt: null, policy });
    const second = nextRedelivery({ attempts: 2, now: 0, deadlineAt: null, policy });
    const third = nextRedelivery({ attempts: 3, now: 0, deadlineAt: null, policy });

    expect(first).toStrictEqual({ retry: true, attempt: 2, delayMs: 1_000 });
    expect(second).toStrictEqual({ retry: true, attempt: 3, delayMs: 2_000 });
    expect(third).toStrictEqual({ retry: true, attempt: 4, delayMs: 4_000 });
  });

  it("never backs off further than the policy's ceiling", () => {
    const late = nextRedelivery({ attempts: 20, now: 0, deadlineAt: null, policy });

    expect(late.retry).toBe(false);
    expect(
      nextRedelivery({
        attempts: 8,
        now: 0,
        deadlineAt: null,
        policy: { ...policy, maxAttempts: 100 },
      }),
    ).toStrictEqual({ retry: true, attempt: 9, delayMs: policy.maxDelayMs });
  });

  it("gives up once the policy's attempts are spent", () => {
    const spent = nextRedelivery({ attempts: policy.maxAttempts, now: 0, deadlineAt: null, policy });

    expect(spent).toStrictEqual({ retry: false, reason: "attempts_exhausted" });
  });

  it("gives up when the next attempt would land past the mode's deadline", () => {
    // The worker does not start the handler after the deadline: a delivery
    // that would arrive too late is not attempted at all.
    const decision = nextRedelivery({ attempts: 1, now: 500, deadlineAt: 1_000, policy });

    expect(decision).toStrictEqual({ retry: false, reason: "past_deadline" });
  });

  it("still tries when the next attempt fits inside the deadline", () => {
    const decision = nextRedelivery({ attempts: 1, now: 500, deadlineAt: 5_000, policy });

    expect(decision).toStrictEqual({ retry: true, attempt: 2, delayMs: 1_000 });
  });

  it("gives the same answer for the same question every time", () => {
    // No jitter and no clock: the gateway may spread the load itself, but a
    // decision that could not be replayed would make the machine untestable.
    const once = nextRedelivery({ attempts: 3, now: 77, deadlineAt: 10_000, policy });
    const twice = nextRedelivery({ attempts: 3, now: 77, deadlineAt: 10_000, policy });

    expect(once).toStrictEqual(twice);
  });
});
