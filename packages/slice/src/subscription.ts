/**
 * What the mock merchant can honestly say about its own subscription.
 *
 * It is a separate file from `serve.ts` because it is the only part of that
 * process worth testing and the only part that can be: everything around it is
 * a timer, a file and a console, and this is the reasoning between them. Given
 * what the SDK has reported and what was known a moment ago, it answers what is
 * known now — and nothing in here reads a clock of its own, opens a file or
 * prints, so a test can walk it through an outage in a few microseconds.
 *
 * The reasoning it carries is one inference, and the inference is weak on
 * purpose. Nothing in the SDK announces a poll that succeeded; the worker
 * reports only what it could not get through. So the strongest thing available
 * is the absence of a reported failure over a window wide enough that a broken
 * subscription could not have stayed quiet across it. That is what DOUBT_MS is,
 * and getting its width wrong is the whole of how this file can lie.
 *
 * Two of the problems the worker reports are about the subscription itself: a
 * poll that failed, and anything fatal. The loop ends on a fatal one and the
 * process stays up, deaf, which is the state this whole arrangement exists to
 * make visible. Everything else the worker reports is about one order or one
 * price question — a handler that threw leaves a merchant selling, and calling
 * that a broken subscription would be a claim about the wrong thing.
 */

import { WORKER_PROBLEM_KINDS, type WorkerProblem } from "@nuanu-ai/coinslot";

/**
 * How long one reported poll failure keeps the subscription in doubt.
 *
 * It is the longest a working-but-unreachable gateway can go without producing
 * a second failure, plus a margin, and it is the sum of two SDK constants
 * because the gap between two reports is two waits and not one:
 *
 *   POLL_DEADLINE_MS   50s  how long the worker waits on a poll before giving
 *                           up on it (packages/sdk/src/worker.ts)
 *   RETRY_CEILING_MS   30s  the longest it then rests before asking again
 *                           (packages/sdk/src/backoff.ts)
 *
 * The first term is the one that is easy to miss, and missing it is a lie
 * rather than an imprecision. A gateway that has stopped answering while still
 * accepting connections — paused, wedged, or behind something holding the
 * socket open — fails no call quickly: each poll runs the full deadline before
 * the worker abandons it, and only then does the backoff start. So reports
 * arrive 65 to 80 seconds apart, and a window sized to the backoff alone
 * expires in the quiet between two of them. This file then says `selling` about
 * a worker that has been deaf for minutes, and says it more often as the
 * backoff grows. A refused connection, which fails instantly and is the case
 * one tests first, hides all of it.
 *
 * The cost of the sum is that a recovery is noticed late by up to this window,
 * and that a gateway restarted on purpose shows the merchant red for about as
 * long.
 *
 * Neither end of this is immediate, and the near end is the one worth stating
 * because it is the one somebody watching a stack will time with a stopwatch. A
 * gateway that refuses connections fails a poll at once, so the doubt starts
 * within a second of it going down. One that freezes with its socket still open
 * is not noticed until the poll already in flight reaches the deadline above —
 * measured at forty-one seconds against a paused container. So this signal is
 * late at both ends: by up to a poll deadline going in, and by this window
 * coming out. What it does not do, and what the width of the window is entirely
 * for, is go green in the middle of an outage.
 *
 * Both numbers are copied rather than imported, because the SDK publishes
 * neither and a merchant's healthcheck is no reason to widen what it publishes.
 * Both sources carry a line naming this file, so that raising either of them is
 * a change that finds this one.
 */
export const DOUBT_MS = 90_000;

/** What has been read off the SDK's reports, and what it adds up to. */
export interface WhatIsKnown {
  /** How much of the problem list has been read. That list only ever grows. */
  readonly problemsRead: number;
  /** When the last poll failure was reported, while the doubt it raised stands. */
  readonly lastPollFailure: number | undefined;
  /** Why the worker will not poll again, once something has ended it for good. */
  readonly stoppedBecause: string | undefined;
}

export const NOTHING_HAS_GONE_WRONG: WhatIsKnown = Object.freeze({
  problemsRead: 0,
  lastPollFailure: undefined,
  stoppedBecause: undefined,
});

/**
 * A change worth a line in the log, as opposed to a state worth a line in the
 * file.
 *
 * They are separate because they are read by different people at different
 * times. The file is a state and is rewritten twice a second; the log is a
 * history and must not repeat itself, or an outage of an hour buries everything
 * around it. So these are the transitions and nothing else: entering doubt,
 * leaving it, and the end of the subscription — each said once.
 */
export type Announcement =
  | { readonly said: "not_getting_through"; readonly why: string }
  | { readonly said: "over"; readonly why: string }
  | { readonly said: "answering_again" };

export interface Reading {
  readonly known: WhatIsKnown;
  readonly announce: readonly Announcement[];
}

/**
 * Reads the problems that have arrived since last time and says what follows.
 *
 * `problems` is the whole list the SDK has appended to — the same array every
 * call, growing at the end — and `known.problemsRead` is how much of it has
 * already been accounted for.
 */
export const readProblems = (
  problems: readonly WorkerProblem[],
  known: WhatIsKnown,
  now: number,
): Reading => {
  const announce: Announcement[] = [];
  let { lastPollFailure, stoppedBecause } = known;

  for (const problem of problems.slice(known.problemsRead)) {
    if (problem.fatal) {
      if (stoppedBecause === undefined) {
        announce.push({ said: "over", why: problem.message });
      }
      stoppedBecause = problem.message;
      continue;
    }

    if (problem.kind === WORKER_PROBLEM_KINDS.POLL_FAILED) {
      if (lastPollFailure === undefined) {
        announce.push({ said: "not_getting_through", why: problem.message });
      }
      lastPollFailure = now;
    }
  }

  // Nothing outlives a fatal problem. The loop has ended, so no further report
  // is coming and no passage of time means anything: a subscription that is
  // over does not quietly become a subscription that is merely doubted.
  if (
    stoppedBecause === undefined &&
    lastPollFailure !== undefined &&
    now - lastPollFailure >= DOUBT_MS
  ) {
    lastPollFailure = undefined;
    announce.push({ said: "answering_again" });
  }

  return { known: { problemsRead: problems.length, lastPollFailure, stoppedBecause }, announce };
};

/**
 * The one line written to the file, which is the whole of what the healthcheck
 * reads.
 *
 * The first word is what is tested there and the rest is for whoever is reading
 * it with their own eyes, so the first word carries the verdict and the rest
 * never begins with another verdict's word.
 */
export const subscriptionLine = (known: WhatIsKnown, baseUrl: string, now: number): string => {
  if (known.stoppedBecause !== undefined) {
    return `stopped: ${known.stoppedBecause}`;
  }

  if (known.lastPollFailure !== undefined) {
    const ago = Math.round((now - known.lastPollFailure) / 1_000);
    return `doubting: a poll failed ${ago}s ago, and nothing here is told when one succeeds`;
  }

  return `selling: subscribed to ${baseUrl}`;
};
