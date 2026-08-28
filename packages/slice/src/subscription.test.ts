/**
 * What the merchant's health signal is allowed to claim.
 *
 * Every case here is a sentence somebody reads off `docker compose ps` and acts
 * on. If one of these goes red, that sentence is wrong in the direction that
 * matters: a container reporting itself healthy while its subscription is dead
 * is worse than one reporting nothing at all, because it is the answer to the
 * question somebody thought to ask.
 *
 * The window case is the one that earned this file. The first version of this
 * signal sized its doubt to the SDK's retry backoff alone and called that the
 * longest a broken subscription could stay quiet. It is not: the worker waits
 * out its own poll deadline before it gives up on a call, and only then does it
 * rest, so a gateway that accepts connections and never answers produces
 * reports far further apart than the backoff. The signal went green in the gaps
 * and grew greener as the backoff climbed. Nothing caught it but a probe run by
 * hand, which is why the arithmetic now has a test with the two terms named
 * separately.
 */

import { WORKER_PROBLEM_KINDS, type WorkerProblem } from "@coinslot/sdk";
import { describe, expect, it } from "vitest";
import {
  DOUBT_MS,
  NOTHING_HAS_GONE_WRONG,
  readProblems,
  subscriptionLine,
  type WhatIsKnown,
} from "./subscription.js";

const GATEWAY = "http://gateway:3000";

const pollFailed: WorkerProblem = {
  kind: WORKER_PROBLEM_KINDS.POLL_FAILED,
  fatal: false,
  message: "poll_worker could not be reached: TypeError: fetch failed — asking again after a wait",
};

const handlerThrew: WorkerProblem = {
  kind: WORKER_PROBLEM_KINDS.HANDLER_FAILED,
  fatal: false,
  subject: "ord_1",
  message: "the handler threw on order ord_1, so nothing was answered",
};

const versionMismatch: WorkerProblem = {
  kind: WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH,
  fatal: true,
  message: "the gateway speaks contract version 9.0 and this SDK speaks 0.1; the worker stopped",
};

/** What the file would say, given these problems and this much time. */
const lineAfter = (
  problems: readonly WorkerProblem[],
  now: number,
  from = NOTHING_HAS_GONE_WRONG,
) => subscriptionLine(readProblems(problems, from, now).known, GATEWAY, now);

describe("what the merchant may say about its subscription", () => {
  it("says it is selling when the worker has reported nothing", () => {
    expect(lineAfter([], 1_000)).toBe(`selling: subscribed to ${GATEWAY}`);
  });

  it("says it is not sure the moment a poll fails", () => {
    expect(lineAfter([pollFailed], 1_000)).toMatch(/^doubting: a poll failed 0s ago/);
  });

  it("goes on selling when a handler threw, because that order is not the subscription", () => {
    // A merchant whose handler threw on one order is still subscribed and still
    // selling every other card. Turning the container red for it would send
    // somebody to look at the wrong thing.
    expect(lineAfter([handlerThrew], 1_000)).toBe(`selling: subscribed to ${GATEWAY}`);
  });

  it("stays stopped after a fatal problem, and says nothing more about it", () => {
    // The order of these two is the case that matters, and it is how a real
    // death arrives: the polls fail for a while, and then the loop ends on
    // something fatal. A subscription that is over does not quietly become a
    // subscription that is merely doubted, and — the part a mutation caught
    // missing here — the quiet after it is not a recovery to announce. Saying
    // "answering again" about a worker that will never poll again is the same
    // lie as a green container, told in the log instead of the file.
    const failing = readProblems([pollFailed], NOTHING_HAS_GONE_WRONG, 1_000);
    const over = readProblems([pollFailed, versionMismatch], failing.known, 2_000);

    expect(over.announce).toEqual([{ said: "over", why: versionMismatch.message }]);

    const muchLater = readProblems(
      [pollFailed, versionMismatch],
      over.known,
      2_000 + DOUBT_MS * 10,
    );

    expect(subscriptionLine(muchLater.known, GATEWAY, 2_000 + DOUBT_MS * 10)).toMatch(
      /^stopped: the gateway speaks contract version 9\.0/,
    );
    expect(muchLater.announce).toEqual([]);
  });

  it("holds the doubt for the whole window and clears it exactly at the end", () => {
    const doubting = readProblems([pollFailed], NOTHING_HAS_GONE_WRONG, 1_000).known;

    const aMomentEarly = readProblems([pollFailed], doubting, 1_000 + DOUBT_MS - 1);
    expect(subscriptionLine(aMomentEarly.known, GATEWAY, 1_000 + DOUBT_MS - 1)).toMatch(
      /^doubting:/,
    );
    expect(aMomentEarly.announce).toEqual([]);

    const onTheDot = readProblems([pollFailed], doubting, 1_000 + DOUBT_MS);
    expect(subscriptionLine(onTheDot.known, GATEWAY, 1_000 + DOUBT_MS)).toBe(
      `selling: subscribed to ${GATEWAY}`,
    );
    expect(onTheDot.announce).toEqual([{ said: "answering_again" }]);
  });

  it("is wide enough for a gateway that answers nothing rather than refusing", () => {
    // The arithmetic this signal lives or dies by, with its two terms named
    // apart. A refused connection fails at once and reports every backoff; a
    // socket that is accepted and never answered fails only when the worker
    // gives up on it, so the gap between two reports is the poll deadline plus
    // the rest that follows. A window narrower than that sum goes green in the
    // quiet between two failures of a subscription that is entirely dead.
    const POLL_DEADLINE_MS = 50_000;
    const RETRY_CEILING_MS = 30_000;

    expect(DOUBT_MS).toBeGreaterThan(POLL_DEADLINE_MS + RETRY_CEILING_MS);
  });

  it("says a thing once, so an outage of an hour is not an hour of logging", () => {
    const first = readProblems([pollFailed], NOTHING_HAS_GONE_WRONG, 1_000);
    expect(first.announce).toEqual([{ said: "not_getting_through", why: pollFailed.message }]);

    // Two more failures inside the window: the state stands, and nothing is said
    // a second time.
    const again = readProblems([pollFailed, pollFailed, pollFailed], first.known, 2_000);
    expect(again.announce).toEqual([]);
    expect(subscriptionLine(again.known, GATEWAY, 2_000)).toMatch(/^doubting:/);
  });

  it("reads each problem once, however often it is asked", () => {
    const problems = [pollFailed];
    const known: WhatIsKnown = readProblems(problems, NOTHING_HAS_GONE_WRONG, 1_000).known;

    expect(known.problemsRead).toBe(1);
    // The same list again, unchanged: nothing new to account for, so the failure
    // is not re-dated and the window does not slide out from under the clock.
    expect(readProblems(problems, known, 5_000).known.lastPollFailure).toBe(1_000);
  });
});
