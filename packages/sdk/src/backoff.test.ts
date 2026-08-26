import { describe, expect, it } from "vitest";
import { FIRST_RETRY_MS, RETRY_CEILING_MS, RETRY_GROWTH, retryDelayMs } from "./backoff.js";

/**
 * Every attempt number a worker can reach in a long outage, and the two ends
 * of the jitter range at each of them.
 */
const attempts = Array.from({ length: 40 }, (_unused, index) => index + 1);

describe("the delay between attempts at a gateway that is not answering", () => {
  it("never hammers: the first retry waits, and no delay is shorter than half the first", () => {
    // The promise: a gateway that dropped one request does not receive a
    // thousand more in the second that follows.
    for (const attempt of attempts) {
      for (const random of [0, 0.25, 0.5, 0.999999]) {
        expect(retryDelayMs(attempt, random)).toBeGreaterThanOrEqual(FIRST_RETRY_MS / 2);
      }
    }
  });

  it("never gives up: no delay exceeds the ceiling, however long the outage runs", () => {
    // The promise: a worker that waited out a two-hour outage comes back on
    // its own, within a bounded time of the gateway returning, rather than
    // having backed off to an hour between attempts.
    for (const attempt of attempts) {
      for (const random of [0, 0.5, 0.999999]) {
        expect(retryDelayMs(attempt, random)).toBeLessThanOrEqual(RETRY_CEILING_MS);
      }
    }
  });

  it("grows by the named factor until it reaches the ceiling", () => {
    // Without growth the backoff is a fixed sleep and a queue of workers
    // retrying in lockstep keeps a struggling gateway down.
    const withoutJitter = (attempt: number): number => retryDelayMs(attempt, 1);

    expect(withoutJitter(1)).toBe(FIRST_RETRY_MS);
    expect(withoutJitter(2)).toBe(FIRST_RETRY_MS * RETRY_GROWTH);
    expect(withoutJitter(3)).toBe(FIRST_RETRY_MS * RETRY_GROWTH * RETRY_GROWTH);
    expect(withoutJitter(40)).toBe(RETRY_CEILING_MS);
  });

  it("spreads two workers that failed at the same moment", () => {
    // The promise this one keeps is about the second worker: without jitter,
    // every worker that lost the same gateway retries in the same
    // millisecond forever, and the gateway is hit by the whole fleet at once.
    const earliest = retryDelayMs(5, 0);
    const latest = retryDelayMs(5, 1);

    expect(earliest).toBeLessThan(latest);
    expect(earliest).toBe(latest / 2);
  });

  it("refuses an attempt number and a random draw that are not what it takes", () => {
    // A caller that passed a zeroth attempt or a random draw out of range
    // would get a delay that is not in the range this file promises, and
    // nothing downstream could tell. That is a bug in the caller, so it is
    // thrown rather than returned.
    expect(() => retryDelayMs(0, 0.5)).toThrow(/attempt/);
    expect(() => retryDelayMs(1.5, 0.5)).toThrow(/attempt/);
    expect(() => retryDelayMs(1, -0.1)).toThrow(/random/);
    expect(() => retryDelayMs(1, 1.1)).toThrow(/random/);
    expect(() => retryDelayMs(1, Number.NaN)).toThrow(/random/);
  });
});
