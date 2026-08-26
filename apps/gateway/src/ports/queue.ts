/**
 * The queue: the merchant's stream of envelopes, and the reminders the gateway
 * leaves itself.
 *
 * Both halves are the same piece of infrastructure and neither is built by
 * hand (ADR-0003 §9): behind this port sits pg-boss, which carries retries,
 * backoff and delayed jobs, and the hand-rolled mechanism on SKIP LOCKED that
 * a reader might expect here is the thing that rule exists to forbid.
 *
 * Two facts about delivery are worth reading before either method is used.
 *
 * Delivery is at least once and an envelope is finished by hand. A delivery
 * that is drawn and never answered comes back — that is what makes a worker
 * that died mid-order harmless — and the merchant's own idempotency by the
 * order's identifier is what makes the repeat safe. Nothing here decides how
 * often that happens: the reminder below is what tells the gateway a delivery
 * went unanswered, and the order machine decides whether there is another
 * attempt and how long the wait before it is.
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
export type Reminder =
  | {
      readonly kind: "deadline";
      readonly orderId: string;
      readonly deadline: DeadlineKind;
      readonly at: number;
    }
  | {
      readonly kind: "delivery_unanswered";
      readonly orderId: string;
      /** Which delivery went quiet, so a later answer to it is not undone. */
      readonly envelopeId: string;
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
