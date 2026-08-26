/**
 * The queue: the merchant's stream of envelopes, and the reminders the gateway
 * leaves itself.
 *
 * Both halves are the same piece of infrastructure and neither is built by
 * hand (ADR-0003 §9): behind this port sits pg-boss, which carries retries,
 * backoff and delayed jobs, and the hand-rolled mechanism on SKIP LOCKED that
 * a reader might expect here is the thing that rule exists to forbid.
 *
 * Three facts about delivery are worth reading before either method is used,
 * and the first of them is a limit rather than a promise.
 *
 * A drawn envelope does not come back on its own. It is finished when it has
 * been handed over, and nothing in this port returns it to the stream after a
 * visibility window. That is deliberate for orders: an unanswered delivery
 * reaches the order machine as the reminder below, and the machine is the one
 * thing that knows how many attempts are left and whether another could still
 * land inside the deadline, so a queue with its own patience would be a second
 * opinion over the top of it.
 *
 * It is a real gap for events. An order event is acknowledged by nobody — the
 * contract gives it no reply of any kind — so an event drawn into a poll
 * response that never reached its worker is simply lost, and the merchant is
 * never told the thing it carried. Nothing here can close that; it needs an
 * acknowledgement the contract does not have.
 *
 * A reminder is not a decision either. It says a clock ran out; what that
 * means for the order is the machine's to say, and every reminder is fed to it
 * as an event rather than acted on here.
 */

import type { WorkerEnvelope } from "@coinslot/contracts";
import type { DeadlineKind } from "@coinslot/core";

/** One delivery of one envelope, with the handle that finishes it. */
export interface DrawnEnvelope {
  readonly envelope: WorkerEnvelope;
  /**
   * The handle for this delivery, not for the envelope. The same envelope
   * drawn twice carries two handles, and finishing one does not finish the
   * other — which is the honest shape for a queue that delivers at least once.
   */
  readonly handle: string;
}

/**
 * Something the gateway asked to be reminded of.
 *
 * `deadline` carries the instant the deadline runs out at rather than the
 * instant the reminder fired, because that is the number the machine checks
 * against its own arithmetic: a timer that fired early or twice must not close
 * an order whose merchant is still honestly inside his deadline.
 */
export type Reminder = (
  | {
      readonly kind: "deadline";
      readonly deadline: DeadlineKind;
      readonly at: number;
    }
  | {
      readonly kind: "delivery_unanswered";
      /** Which delivery went quiet, so a later answer to it is not undone. */
      readonly envelopeId: string;
    }
) & {
  readonly orderId: string;
  /**
   * How many times this reminder has been asked for. It is here because a
   * reminder is the only thing that ever declares an overdue order, so one
   * dropped on a transient failure is a paid order nobody ever marks for a
   * refund; the count is what lets it be asked for again without asking
   * forever.
   */
  readonly attempt?: number;
};

export interface Queue {
  /** Puts one envelope on the merchant's stream, now or after a wait. */
  publish(envelope: WorkerEnvelope, afterMs?: number): Promise<void>;

  /**
   * Draws at most `max` envelopes, holding the call open until one arrives or
   * `waitMs` runs out. An empty batch is the ordinary answer to a quiet window
   * and not a failure.
   */
  draw(max: number, waitMs: number): Promise<readonly DrawnEnvelope[]>;

  /** This delivery has been answered; it does not come round again. */
  finish(handle: string): Promise<void>;

  /** Asks to be reminded of something once, `afterMs` from now. */
  remind(reminder: Reminder, afterMs: number): Promise<void>;

  /**
   * Where fired reminders go. Set once, before the queue is started; a queue
   * started with nowhere to put them would drop deadlines silently.
   */
  onReminder(fire: (reminder: Reminder) => Promise<void>): void;

  start(): Promise<void>;
  stop(): Promise<void>;
}
