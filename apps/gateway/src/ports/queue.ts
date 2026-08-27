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
 *
 * A reminder whose handler throws is delivered again, a bounded number of
 * times, and that is the queue's job rather than the handler's. A reminder is
 * the only thing that ever declares an overdue order, so one dropped on a
 * database that was briefly unreachable is a paid order nobody ever marks for a
 * refund — and a handler that tried to re-arm it would be writing to the very
 * thing whose unavailability had just thrown.
 */

import type { WorkerEnvelope } from "@coinslot/contracts";
import type { DeadlineKind } from "@coinslot/core";

/** One delivery of one envelope, with the handle that finishes it. */
export interface DrawnEnvelope {
  readonly envelope: WorkerEnvelope;
  /**
   * The handle for this delivery, not for the envelope.
   *
   * One envelope really can be drawn twice, and never because the queue offered
   * it again — this port does not do that, as the header above says. There is
   * one way it happens: the poll draws an envelope, cannot record the hand-over
   * or is told the machine will take it but not yet, and puts that same
   * envelope back on the stream. A merchant being sent an order a second time
   * is not this; that is the machine's decision and it produces a fresh
   * envelope with an identifier of its own. So the two arrivals that share an
   * identifier need two handles between them, because finishing one must not
   * finish a delivery nobody has answered.
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
      /**
       * Which hand-over went quiet. It names one delivery rather than the
       * message, so a merchant who answered the delivery he was given is not
       * sent the order again by a reminder left against it.
       */
      readonly handOver: string;
    }
) & {
  readonly orderId: string;
};

export interface Queue {
  /**
   * Puts one envelope on one merchant's stream, now or after a wait.
   *
   * The merchant is a parameter and not something inside the envelope: no
   * document on the wire carries a merchant, and a buyer has no reason to be
   * shown whose stream their order went on. So the stream is named here, where
   * only the gateway can see it.
   */
  publish(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<void>;

  /**
   * Draws at most `max` envelopes off one merchant's stream, holding the call
   * open until one arrives or `waitMs` runs out. An empty batch is the ordinary
   * answer to a quiet window and not a failure.
   *
   * A worker draws its own merchant's envelopes and cannot reach anybody
   * else's — not by filtering what came back, which would consume somebody
   * else's message to look at it, but by drawing from that merchant's stream
   * in the first place.
   */
  draw(merchantId: string, max: number, waitMs: number): Promise<readonly DrawnEnvelope[]>;

  /**
   * This delivery has been answered; it does not come round again. The merchant
   * is named because a handle names a delivery on one stream, and the streams
   * are separate things.
   */
  finish(merchantId: string, handle: string): Promise<void>;

  /**
   * Whether this merchant's stream is still holding an order envelope for this
   * order — one nobody has drawn yet, a redelivery waiting out its delay
   * included.
   *
   * The one caller is the sweep, and the reason it has to ask is arithmetic
   * rather than tidiness. A second envelope for one order is ordinary on the
   * wire; it is not ordinary for the order, because the machine counts every
   * hand-over and the count is what its attempt cap reads. A sweep that sent
   * the order again while the first envelope was still sitting here would spend
   * a delivery the merchant never failed, and the closure at the cap is a
   * refund. So the sweep acts on an envelope that is actually missing rather
   * than on a merchant who is between polls.
   *
   * What it cannot answer for is an envelope somebody has already drawn: from
   * here that looks the same as one that was never written. The order's own
   * state does not separate them either — it stays `paid` until the hand-over
   * is recorded — so what covers that gap is patience rather than this, and
   * `sweepDispatchGraceMs` is where the patience is set.
   *
   * It asks about order envelopes only. A merchant event is never re-sent by
   * anybody, so nothing ever needs to know whether one is still waiting.
   */
  holdsOrder(merchantId: string, orderId: string): Promise<boolean>;

  /** Asks to be reminded of something once, `afterMs` from now. */
  remind(reminder: Reminder, afterMs: number): Promise<void>;

  /**
   * Where fired reminders go. Set once, before the queue is started; a queue
   * started with nowhere to put them would drop deadlines silently.
   */
  onReminder(fire: (reminder: Reminder) => Promise<void>): void;

  /**
   * Takes on `work` to be run about once a day, under `name`, once rather than
   * once per process. Registering the same name again replaces what was there.
   *
   * A queue with no clock of its own may hold the work rather than run it, and
   * the in-memory one does exactly that — nothing in an offline suite waits a
   * day, and a fake day would be a schedule its own tests then had to reason
   * about. So nothing may be put here that the gateway depends on happening:
   * this is for keeping the place tidy, not for anything an order is waiting on.
   */
  everyDay(name: string, work: () => Promise<unknown>): Promise<void>;

  start(): Promise<void>;
  stop(): Promise<void>;
}

/** How patient a queue is with a reminder whose handler threw. */
export interface ReminderPatience {
  /**
   * How many deliveries in all, the first one included.
   *
   * It buys two things and only one of them is obvious. The obvious one is the
   * handler that throws. The other is the gateway that took a reminder and died
   * before answering it: a queue takes such a delivery back once its window has
   * run out and then hands it over again, which is the same mechanism counted
   * against the same number. So setting this to one does not merely stop
   * retrying a failing handler — it also means a deadline is lost for good if
   * the process carrying it goes down, and the order it belonged to is never
   * declared overdue by anybody.
   */
  readonly attempts: number;
  readonly retryDelayMs: number;
}
