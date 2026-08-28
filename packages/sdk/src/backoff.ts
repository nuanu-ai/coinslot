/**
 * How long the worker waits before asking a gateway that did not answer.
 *
 * This is protocol behaviour rather than infrastructure, which is why it is
 * written here at all. The hand-rolling rule (ADR-0003 §9) reads a wish to
 * build retries by hand as a signal that the wrong component was chosen — and
 * it is right about the general case. This is not the general case: it is the
 * one wait between two calls of one long poll, three constants and a formula,
 * and a retry framework brought in to hold them would be a dependency in the
 * tree a merchant installs (ADR-0003 §8) for something the loop above it does
 * in four lines. If this file ever grows a policy, a registry or a second
 * caller with different needs, that is the trigger to stop and choose one.
 *
 * The numbers are ours and they are not a claim about the gateway. Half a
 * second is short enough that a dropped connection costs a merchant nothing
 * visible, and thirty seconds is close to the long poll's own window, so a
 * worker that waited out an outage comes back within about one window of the
 * gateway returning rather than an hour later.
 *
 * The jitter is the part that is easy to leave out and expensive to lack. Every
 * worker that lost the same gateway failed in the same second; without jitter
 * they all come back in the same millisecond, forever, and the gateway that was
 * struggling is now being hit by the whole fleet in step. Half the delay is
 * fixed and half is drawn, so the delay stays inside the bounds above while no
 * two workers keep the same phase.
 */

/** The wait after the first failed call. */
export const FIRST_RETRY_MS = 500;

/**
 * The longest this file will ever ask a worker to wait.
 *
 * Copied outside this package, and the copy is named here rather than only
 * where it is read, because whoever raises this number opens this file and not
 * that one. `DOUBT_MS` in packages/slice/src/subscription.ts is the window a
 * mock merchant waits before it decides its subscription is alive again, and it
 * is this ceiling plus the poll deadline plus a margin. Raise this and that
 * window is too narrow, which makes a healthcheck report a dead subscription as
 * a live one.
 */
export const RETRY_CEILING_MS = 30_000;

/** What the wait is multiplied by for each further failure in a row. */
export const RETRY_GROWTH = 2;

/**
 * The wait before attempt number `attempt`, given one draw from [0, 1].
 *
 * The draw is a parameter rather than a call to `Math.random` inside, because
 * a test cannot assert a bound it cannot reproduce, and a delay whose bounds
 * are not tested is a delay nobody has checked.
 *
 * Both refusals are bugs in the caller rather than conditions to handle, so
 * they are thrown. A zeroth attempt or a draw outside the range would produce
 * a number outside the bounds this file promises, and nothing downstream could
 * tell that it had.
 */
export const retryDelayMs = (attempt: number, random: number): number => {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError(`the attempt is a whole number from 1 upwards, and was ${attempt}`);
  }

  if (!(random >= 0 && random <= 1)) {
    throw new TypeError(`the random draw is a number from 0 to 1, and was ${random}`);
  }

  const capped = Math.min(RETRY_CEILING_MS, FIRST_RETRY_MS * RETRY_GROWTH ** (attempt - 1));

  return capped / 2 + (capped / 2) * random;
};
