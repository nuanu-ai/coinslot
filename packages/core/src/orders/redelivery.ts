/**
 * Whether an undelivered order gets another delivery, and how long the wait
 * before it is.
 *
 * The three answers a handler can give are a fulfillment, a refusal and an
 * acceptance. Anything else — an exception inside the handler, a process that
 * died, a connection that broke — is not an answer at all, and the order is
 * simply delivered again. That is why a temporary failure has to be thrown
 * rather than refused: a refusal is understood as a final "this cannot be
 * fulfilled" and closes the order.
 *
 * The repeating is not endless. It stops when the policy's attempts are spent
 * and, sooner than that, when the next attempt would land past the mode's own
 * deadline: the worker does not start the handler after the deadline, so a
 * delivery that could only arrive late is not attempted at all.
 *
 * There is no jitter here and no clock. The gateway is free to spread its own
 * load, but a decision that could not be replayed from the same numbers would
 * make the machine untestable, and the delay is part of what an order does
 * with someone else's money.
 *
 * The numbers themselves belong to the policy, not to this file: how long we
 * wait and how many times we try are still open questions before the pilot.
 */

import type { RedeliveryPolicy } from "./model.js";

export type RedeliveryDecision =
  | { readonly retry: true; readonly attempt: number; readonly delayMs: number }
  | { readonly retry: false; readonly reason: "attempts_exhausted" | "past_deadline" };

export type RedeliveryQuestion = {
  /** How many deliveries have been made so far. */
  readonly attempts: number;
  readonly now: number;
  /** When the mode's own deadline runs out, or null when none is running. */
  readonly deadlineAt: number | null;
  readonly policy: RedeliveryPolicy;
};

export function nextRedelivery(question: RedeliveryQuestion): RedeliveryDecision {
  const { attempts, now, deadlineAt, policy } = question;

  if (attempts >= policy.maxAttempts) {
    return { retry: false, reason: "attempts_exhausted" };
  }

  const growth = policy.baseDelayMs * policy.factor ** Math.max(attempts - 1, 0);
  const delayMs = Math.min(growth, policy.maxDelayMs);

  if (deadlineAt !== null && now + delayMs >= deadlineAt) {
    return { retry: false, reason: "past_deadline" };
  }

  return { retry: true, attempt: attempts + 1, delayMs };
}
