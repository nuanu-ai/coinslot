/**
 * The interpreter.
 *
 * Everything this file does is the same four steps: load the order, hand it and
 * one event to `transition`, write down what comes back, and carry out the
 * effects it asked for. It decides nothing. Every branch that looks like a
 * decision — whether a silence sells, whether an order is charged, whether
 * there is another delivery and how long the wait before it is — was taken in
 * `@coinslot/core`, and the reason it was taken there is that it is the
 * product. A gateway that answered any of those questions itself would be a
 * second machine disagreeing with the first, and the two would disagree about
 * somebody's money.
 *
 * Three rules hold everywhere below.
 *
 * The money invariants are checked on every order about to be written down and
 * a violation is thrown, not handled. `moneyInvariantViolations` is a list of
 * things a person would notice — a buyer whose money is gone with nothing
 * recording it, a debt with no charge behind it — and if one of them is true
 * the safe thing is to stop, because the alternative is to write it down and
 * carry on selling.
 *
 * The effects fall in two halves and the split is ADR-0013. The ones that must
 * not be lost — the envelope that hands the order to the merchant, the receipt
 * — are written down inside the same hold that writes the state implying them,
 * so a process that dies mid-flight either did both or did neither. There is no
 * repair for the other way round: an order that says the merchant was handed
 * the work has already moved past the transition that emits the dispatch, and
 * nothing re-emits it. Everything else runs after the order is written and
 * outside the hold, because it does real work — a network call to the
 * facilitator — and produces the next event about the same order; run under the
 * hold, it would wait for a hold that only it could release.
 *
 * None of this makes delivery exactly-once and none of it tries to. Everything
 * here is at least once, which is what the contract already promises a merchant
 * and what their handler is already told to survive.
 *
 * And time is a value. Every event carries the instant it happened at, taken
 * from the clock once at the edge, so the same purchase replayed produces the
 * same order.
 */

import type {
  Delivery,
  Order as OrderDocument,
  Receipt,
  SalePrice,
  WorkerEnvelope,
} from "@coinslot/contracts";
import type {
  Deadline,
  Effect,
  MerchantAnswer,
  Order,
  OrderEvent,
  OrderState,
  StateEvent,
  TransitionRejection,
  TransitionResult,
} from "@coinslot/core";
import {
  assertNever,
  deadlines,
  moneyInvariantViolations,
  outcomeFor,
  transition,
} from "@coinslot/core";
import { asTimestamp } from "../ports/clock.js";
import type { Reminder } from "../ports/queue.js";
import type {
  MerchantScope,
  OrderChange,
  PaymentWord,
  StoredOrder,
  WithTheOrder,
} from "../ports/store.js";
import type { Runtime } from "./runtime.js";
import { purchaseOf, Waiting } from "./waiting.js";

/** The queue's name for the daily sweep of what an order is still owed. */
export const SWEEP_EFFECTS = "coinslot_sweep_effects";

/**
 * What is written down about the purchase alongside the machine's own order.
 * Every one of these lands in the same write as the order the event moved, so
 * a fact and the event it is about are never stored one without the other.
 *
 * The goods are the one fact with a condition on them, and it lives in
 * `goodsToKeep` below rather than here because part of it is about what became
 * of the event, which is not known until the machine has seen it.
 */
export interface OrderFacts {
  readonly delivery?: Delivery;
  readonly settlement?: { readonly transaction: string };
  /** Something the payment layer said, appended to what it has said before. */
  readonly paymentWord?: PaymentWord;
  readonly priceId?: string;
  readonly openDeliveryId?: string | null;
}

/**
 * What presenting a verified payment came to.
 *
 * `took` is ownership settled by this payment — the order moved and its effects
 * ran. `already_yours` is the same owner asking again about a purchase already
 * under way. `not_owner` is somebody else's payment turned away without a mark
 * on the order. `refused` is the machine declining the event the payment would
 * have driven — a repeat on an order whose charge is still unaccounted for.
 */
export type PresentResult =
  | { readonly kind: "took"; readonly order: StoredOrder; readonly answer: MerchantAnswer | null }
  | { readonly kind: "already_yours"; readonly state: OrderState }
  | { readonly kind: "not_owner"; readonly state: OrderState }
  | { readonly kind: "refused"; readonly rejection: TransitionRejection }
  | { readonly kind: "no_such_order" };

/** What one hold on an order came to, before its effects are carried out. */
type Decided =
  | {
      readonly kind: "decided";
      readonly moved: TransitionResult;
      readonly known: StoredOrder;
    }
  /** The caller's `whileWaitingOn` was no longer true; nothing was written. */
  | { readonly kind: "moved_on" };

/** What the hold in `presentVerifiedPayment` came to, before its effects run. */
type PresentDecided =
  | {
      readonly kind: "took";
      readonly known: StoredOrder;
      readonly effects: readonly Effect[];
    }
  | { readonly kind: "already_yours"; readonly state: OrderState }
  | { readonly kind: "not_owner"; readonly state: OrderState }
  | { readonly kind: "refused"; readonly rejection: TransitionRejection };

export type Applied =
  | {
      readonly outcome: "moved";
      readonly order: StoredOrder;
      readonly effects: readonly Effect[];
      /** What the merchant's own call is answered with, where the event was one. */
      readonly answer: MerchantAnswer | null;
    }
  | { readonly outcome: "refused"; readonly rejection: TransitionRejection }
  /**
   * The order had moved on from what the caller was holding it to, and nothing
   * was written. Only a caller that passed `whileWaitingOn` can be told this.
   */
  | { readonly outcome: "moved_on" }
  | { readonly outcome: "no_such_order" };

/** What a parked purchase is woken with: the order as it finally stands. */
export type PurchaseSettled = StoredOrder;

/** What one run of the sweep repaired, and what it could not. */
export interface Swept {
  /** Orders paid for that had reached nobody and were sent out again. */
  dispatched: number;
  /** Delivered orders that had no receipt and now have one. */
  receipted: number;
  /** Clocks that had run out with nothing waiting on them, started again. */
  rearmed: number;
  /** Orders the sweep could not repair, each of which was said out loud. */
  refused: number;
}

/**
 * Whether this effect is carried out after the order is written, rather than
 * written down with it (ADR-0013).
 *
 * The list is exhaustive rather than a set of names, so an effect added to the
 * machine cannot quietly fall into the wrong half: the compiler asks for it
 * here. What belongs on the written-down side is an effect that cannot be
 * re-driven once the order has moved past the transition that asked for it —
 * that, and nothing else, is what this line decides.
 *
 * Whether the sweep may write one again is a second question with a different
 * answer, and the two are easy to run together. Of the four written down here,
 * three have receivers that are promised a repeat and one does not: a merchant
 * event is delivered at most once, so it is written where the state is and is
 * never re-sent. `sweep` carries that distinction, and no arm may be added
 * there for an effect whose receiver was not promised a repeat.
 */
function carriedOutAfterwards(effect: Effect): boolean {
  switch (effect.kind) {
    case "dispatch_order":
    case "redeliver_order":
    case "emit_merchant_event":
    case "issue_receipt":
      return false;
    case "request_quote":
    case "verify_payment":
    case "execute_payment":
    case "invite_payment":
    case "dispatch_confirmation_request":
    case "release_goods_to_agent":
    case "hold_fulfillment":
    case "mark_refund_due":
    case "answer_merchant":
      return true;
    default:
      return assertNever(effect, "effect");
  }
}

export class OrderRunner {
  readonly #runtime: Runtime;
  /** Agents parked on a purchase, by order identifier. */
  readonly purchases = new Waiting<PurchaseSettled>();

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /**
   * Writes down an order that does not exist yet and carries out the effects
   * its creation asked for. The machine has already decided whether there is an
   * order at all; this is the part that makes it real.
   */
  async create(record: StoredOrder, effects: readonly Effect[], at: number): Promise<StoredOrder> {
    refuseToWriteAnImpossibleOrder(record.order);
    // The clock is started before the order is written and not after it. Of the
    // two ways that can go wrong, one is harmless and the other is not: a
    // reminder for an order that was never written finds nothing and says so,
    // while an order written with no clock on it is one nothing will ever close.
    await this.#arm([], deadlines(record.order), record.order.id);

    // Nothing the birth of an order asks for has to be written down with it:
    // the machine's effects here are a price question and a request to verify a
    // payment, and neither leaves a record. That is checked rather than
    // assumed, and checked here rather than after the order is written, because
    // this is the one path with no unit of work to put such an effect in —
    // `addOrder` takes no writes to go alongside. An effect that must not be
    // lost reaching creation is a change nobody has thought through, and it
    // stops before the order exists rather than after.
    const written = this.#writesWithTheOrder(record, record.order, effects, at);
    if (written.length > 0) {
      throw new Error(
        `creating ${record.order.id} asked for ${written.length} thing(s) to be written down with it, and the birth of an order has nowhere to write them`,
      );
    }

    await this.#runtime.store.addOrder(record);
    await this.#run(record, effects, at);
    return record;
  }

  /**
   * Feeds one event to the machine and carries out whatever comes back.
   *
   * `scope` is how a merchant's own call is held to their own orders. Given
   * one, the store finds nothing where the order belongs to somebody else, and
   * the ownership is read under the same hold as the order itself — so there is
   * no window between learning whose it is and acting on it, and the caller
   * cannot tell "not yours" from "not there". It is left out where the caller
   * has no merchant to be held to: a reminder of ours running out, and a
   * payment presented by an agent that carries no key.
   *
   * `whileWaitingOn` is the hand-over the caller decided about, and it is read
   * here rather than by the caller for the reason the hold exists at all. A
   * caller that read the order first and then asked for a change has a window
   * between the two, and everything that can happen in that window is a change
   * to the very thing it was checking: the merchant's answer landing, a worker
   * drawing the order and recording a hand-over of its own, another delivery of
   * the same reminder doing all of it once already. Given one, the event and
   * the facts are applied only while the order is still waiting on that
   * hand-over, and the caller is told the order moved on.
   */
  async apply(
    orderId: string,
    event: OrderEvent,
    facts: OrderFacts = {},
    scope?: MerchantScope,
    whileWaitingOn?: string,
  ): Promise<Applied> {
    const decided = await this.#runtime.store.withOrder(
      orderId,
      async (found): Promise<OrderChange<Decided>> => {
        if (whileWaitingOn !== undefined && found.openDeliveryId !== whileWaitingOn) {
          // Somebody else got here first. Nothing is written — not the event
          // and not the facts, the cleared hand-over included, because writing
          // that one would take away whatever hand-over the order is waiting on
          // now and leave the silence on it unnoticed by anybody.
          return { result: { kind: "moved_on" } };
        }

        const known: StoredOrder = {
          ...found,
          ...(facts.settlement === undefined ? {} : { settlement: facts.settlement }),
          ...(facts.paymentWord === undefined ? {} : this.#alsoSaid(found, facts.paymentWord)),
          ...(facts.priceId === undefined ? {} : { priceId: facts.priceId }),
          ...(facts.openDeliveryId === undefined ? {} : { openDeliveryId: facts.openDeliveryId }),
        };

        const moved = transition(known.order, event);
        if (!moved.ok) {
          // Nothing is written for a refused event, not even the facts that
          // came with it: an event the machine says has no meaning here should
          // leave no trace of having been believed.
          return { result: { kind: "decided", moved, known } };
        }

        refuseToWriteAnImpossibleOrder(moved.order);
        const next: StoredOrder = {
          ...known,
          order: moved.order,
          ...goodsToKeep(found, facts.delivery, moved.effects),
        };

        // The clocks the order will be waiting on are started before the change
        // to it is committed, because of which way the two failures fall.
        // Arming first and failing writes nothing, and the event comes back;
        // arming first and having the write fail afterwards leaves a reminder
        // for a change that did not happen, which the machine refuses as a
        // deadline that is not running. Arming after the write and failing is
        // the one that cannot be repaired: the order has moved, no clock is on
        // it, the event comes back to a machine that says it no longer applies,
        // and the order hangs with nobody waiting on anything.
        await this.#arm(deadlines(known.order), deadlines(next.order), orderId);

        return {
          save: next,
          // The effects that must not be lost go in with the order (ADR-0013).
          alongside: this.#writesWithTheOrder(next, known.order, moved.effects, event.at),
          result: { kind: "decided", moved, known: next },
        };
      },
      scope,
    );

    if (!decided.found) {
      return { outcome: "no_such_order" };
    }
    if (decided.result.kind === "moved_on") {
      return { outcome: "moved_on" };
    }

    const { moved, known } = decided.result;
    if (!moved.ok) {
      return { outcome: "refused", rejection: moved.rejection };
    }

    const answer = await this.#run(known, moved.effects.filter(carriedOutAfterwards), event.at);
    this.#wakeTheAgent(known);

    return { outcome: "moved", order: known, effects: moved.effects, answer };
  }

  /**
   * A payment the payment layer has already vouched for, presented for an
   * order. The ownership decision and the state change both happen here, inside
   * the store's hold on the order, and that is the whole point of the method.
   *
   * Ownership cannot be decided from a copy of the order read before the hold:
   * two verified payments for one order both pass verification, both reach this
   * method, and if each read a stale "nobody owns it yet" they would both take
   * it — two buyers, two merchants asked to deliver, one charge that succeeds
   * and one that fails on a merchant who handed over goods for nothing. So the
   * guard reads `found.paidBy` under the lock: the first to arrive becomes the
   * owner, and the second finds an owner that is not it and is turned away
   * without a mark on the order.
   *
   * The payment is verified before the lock — a network round-trip must not
   * hold a row — so the events driven here are `payment_verified` and, on an
   * order a repeat reopens, the `purchase_repeated` before it. The machine's
   * own request to verify (its `verify_payment` effect) is already answered and
   * is dropped when the effects run.
   *
   * The `owner` arrives already reduced to one spelling — `walletThatPaid` in
   * `gateway.ts` does it, on the way out of the payment layer — and this is the
   * only place that writes `paidBy`. That is what lets the guard below compare
   * exactly: both sides of it came through that one seam. A caller that passed
   * an address as a facilitator happened to spell it would make one wallet into
   * two buyers here, and nothing in this method could tell.
   */
  async presentVerifiedPayment(
    orderId: string,
    owner: string,
    payment: string,
    at: number,
  ): Promise<PresentResult> {
    const word: PaymentWord = { at, about: "verify", said: `checked out, paid by ${owner}` };

    const decided = await this.#runtime.store.withOrder(
      orderId,
      async (found): Promise<OrderChange<PresentDecided>> => {
        if (found.paidBy !== null && found.paidBy !== owner) {
          // Somebody else's payment owns this order. Nothing is written.
          return { result: { kind: "not_owner", state: found.order.state } };
        }

        const events = eventsForVerifiedPayment(found.order, at);
        if (events.length === 0) {
          // The owner is asking again about a purchase already under way. The
          // answer is wherever it has got to, and nothing changes.
          return { result: { kind: "already_yours", state: found.order.state } };
        }

        let order = found.order;
        const effects: Effect[] = [];
        for (const event of events) {
          const moved = transition(order, event);
          if (!moved.ok) {
            // The machine declines — a repeat on an order whose charge never
            // reported back, for one. Nothing is written.
            return { result: { kind: "refused", rejection: moved.rejection } };
          }
          order = moved.order;
          refuseToWriteAnImpossibleOrder(order);
          effects.push(...moved.effects);
        }

        const next: StoredOrder = {
          ...found,
          order,
          payment,
          paidBy: owner,
          ...this.#alsoSaid(found, word),
        };

        // The clocks are armed before the change is committed, for the same
        // reason `apply` arms them there.
        await this.#arm(deadlines(found.order), deadlines(order), orderId);
        return {
          save: next,
          alongside: this.#writesWithTheOrder(next, found.order, effects, at),
          result: { kind: "took", known: next, effects },
        };
      },
    );

    if (!decided.found) {
      return { kind: "no_such_order" };
    }
    const result = decided.result;
    if (result.kind !== "took") {
      return result;
    }

    // The payment is already verified, so the machine's request to verify it is
    // answered and dropped; what was written down with the order is not carried
    // out a second time; and what is left runs outside the lock.
    const runnable = result.effects.filter(
      (effect) => effect.kind !== "verify_payment" && carriedOutAfterwards(effect),
    );
    const answer = await this.#run(result.known, runnable, at);
    this.#wakeTheAgent(result.known);
    return { kind: "took", order: result.known, answer };
  }

  /**
   * What the orders are still owed, asked of the orders themselves (ADR-0013).
   *
   * It keeps no second book of what was meant to happen. Each of its three
   * questions is a fact about an order and is answered by doing the missing
   * thing: an order paid for that has reached nobody is put on its merchant's
   * stream, a delivered order with no receipt gets one, and an open order whose
   * clock ran out has the clock started again so that the machine can end it.
   *
   * It is safe to run twice because it will be, and each of the three is a
   * no-op on a second run for a reason that is in the world rather than in a
   * memory of having run: the receipt is there, so the order is no longer one
   * without a receipt; the reminder ended the order, so the order is no longer
   * open; the envelope the first run wrote is still on the stream, so the order
   * is no longer one that has reached nobody.
   *
   * That argument covers one run after another and it does not cover two at
   * once, which is why only one runs at a time. Every arm reads the world and
   * then acts on what it read, so two runs beside each other both find the
   * envelope missing and both send it — the double hand-over the dispatch arm
   * exists to prevent, and one of that order's deliveries spent.
   *
   * The overlap that makes that reachable is a second gateway, and only a
   * second gateway: inside one process the queue's worker waits for this to
   * return before it fetches anything else. What hands the same run to two
   * processes is the queue's expiry. A run that takes longer than the job's
   * expiry is failed by the library for having taken too long, and a failed job
   * with retries left goes back on the queue — where the other process's idle
   * worker fetches it, while this one is still going. So the work is taken
   * under a name, and a run that finds the name held does nothing at all and
   * says so.
   *
   * Nothing is written down about having run, and a run that skipped is not a
   * run that failed — the work it wanted is already being done. What the name
   * actually holds is one run per live connection: a lock goes when the session
   * holding it goes, and a run whose connection died carries on without it. The
   * port says more about that where the lock is defined.
   *
   * Two things this does not make safe, and both are about reading the world
   * once and acting on it for the length of a run. The orders are a snapshot,
   * so an order that finished while the sweep was working through the list is
   * still acted on as it stood; only the stream is asked again, fresh, for each
   * order. And the receipt arm can write over a receipt the ordinary path wrote
   * after the snapshot was taken — same order, same outcome, a different
   * identifier and a document built from the older reading. A receipt is what a
   * merchant reconciles a wallet against, which is what makes that one worth
   * knowing about rather than shrugging at.
   *
   * What may not be swept, which is the part ADR-0013 asks every future effect
   * to be measured against. An arm here may only re-drive an effect whose
   * receiver is promised it can arrive more than once. The order is: a merchant
   * is told his handler will see the same order again, so a hand-over may be
   * re-driven. The receipt is: it is one row keyed by its order, so writing it
   * again writes the same row. The merchant events are not, and the contract is
   * explicit about it — an order is delivered at least once and an event at
   * most once — so there is no arm for them here and there must not be one. A
   * debt announced twice is a second refund somebody may act on.
   */
  async sweep(): Promise<Swept | null> {
    const ran = await this.#runtime.store.runAlone(SWEEP_EFFECTS, () => this.#sweepAlone());
    if (!ran.ran) {
      console.log("[gateway] the sweep found another run already holding it, and did nothing");
      return null;
    }
    return ran.result;
  }

  /** The sweep itself, with nothing else in the gateway running it. */
  async #sweepAlone(): Promise<Swept> {
    const now = this.#runtime.clock();
    const swept: Swept = { dispatched: 0, receipted: 0, rearmed: 0, refused: 0 };

    for (const record of await this.#runtime.store.openOrders()) {
      try {
        swept.dispatched += await this.#sweepTheDispatch(record, now);
        swept.rearmed += await this.#sweepTheClocks(record, now);
      } catch (thrown) {
        // One order that cannot be repaired does not stop the others being
        // repaired, which is the whole reason there is a sweep. It is said out
        // loud because a sweep that quietly gave up on an order would leave
        // nobody looking at it at all.
        swept.refused += 1;
        console.error(`[gateway] the sweep could not repair ${record.order.id}`, thrown);
      }
    }

    for (const record of await this.#runtime.store.deliveredWithoutReceipt()) {
      try {
        await this.#runtime.store.putReceipt(
          record.merchantId,
          this.#receiptFor(record, record.order, now),
        );
        swept.receipted += 1;
      } catch (thrown) {
        swept.refused += 1;
        console.error(`[gateway] the sweep could not receipt ${record.order.id}`, thrown);
      }
    }

    if (swept.dispatched + swept.receipted + swept.rearmed + swept.refused > 0) {
      console.log(
        `[gateway] the sweep sent ${swept.dispatched} orders out again, wrote ${swept.receipted} receipts, started ${swept.rearmed} clocks, and could not repair ${swept.refused}`,
      );
    }
    return swept;
  }

  /**
   * An order that is paid for and has reached nobody, put on its merchant's
   * stream again.
   *
   * Two guards, and they cover different halves of the same question, because
   * "the merchant has not taken it" and "there is nothing for him to take" are
   * not the same fact and only the second one is a lost envelope.
   *
   * The stream is asked first, and it is the one that matters. A second
   * envelope for one order is ordinary on the wire — the merchant's handler is
   * told to expect exactly that — but it is not ordinary for the order. The
   * machine counts every hand-over, the count is what its attempt cap reads,
   * and the closure at the cap is a refund. So an order whose envelope is still
   * sitting there unclaimed is left alone: sending it again would spend a
   * delivery the merchant never failed.
   *
   * The patience covers part of what the stream cannot answer, and it is worth
   * being exact about which part. An envelope somebody has already drawn is on
   * no stream, and from out here that is indistinguishable from one that was
   * never written — the order stays `paid` until the hand-over is recorded
   * either way. The patience runs from the moment the money landed, not from
   * the moment the envelope was drawn, so what it actually covers is a worker
   * who drew the order promptly and is working through a batch. A merchant
   * whose worker polls once an hour draws long after the patience has run out,
   * and this sends the order again while he is holding it: two hand-overs, one
   * of which he never failed. That is a real cost and it is bounded — one extra
   * per sweep, and the sweep runs daily — and the number that decides it is
   * `sweepDispatchGraceMs`, which is where somebody with a slow-polling
   * merchant should look first.
   *
   * What is left after both is an order that has been paid for longer than the
   * patience allows, with nothing on the stream for it. That one really does
   * look like an envelope that went nowhere, and it goes out again.
   */
  async #sweepTheDispatch(record: StoredOrder, now: number): Promise<number> {
    const paidAt = record.order.timestamps.paidAt;
    if (record.order.state !== "paid" || paidAt === null) {
      return 0;
    }
    if (paidAt + this.#runtime.config.sweepDispatchGraceMs > now) {
      return 0;
    }
    if (await this.#runtime.queue.holdsOrder(record.merchantId, record.order.id)) {
      return 0;
    }

    await this.#runtime.queue.publish(record.merchantId, this.#orderEnvelope(record, now));
    return 1;
  }

  /**
   * The clocks an order is waiting on that have already run out, started again.
   *
   * A reminder is the only thing that ever declares an order overdue, and one
   * that was armed and then lost — a handler that threw past the queue's
   * patience is the way that happens — is an order nothing will ever close and
   * a buyer nothing will ever refund. A clock that has run out on an order
   * still sitting in the state it belongs to is the fact that says so.
   *
   * Repeating it is safe in the machine rather than here: an expiry for a
   * deadline that is not running is refused, and so is one claiming an instant
   * the deadline has not reached. So a second reminder for an order the first
   * one already moved finds nothing to do.
   */
  async #sweepTheClocks(record: StoredOrder, now: number): Promise<number> {
    let rearmed = 0;
    for (const deadline of deadlines(record.order)) {
      if (deadline.at > now) {
        continue;
      }
      await this.#runtime.queue.remind(
        {
          kind: "deadline",
          orderId: record.order.id,
          deadline: deadline.kind,
          at: deadline.at,
        },
        0,
      );
      rearmed += 1;
    }
    return rearmed;
  }

  /**
   * Arms the clocks that are running now and were not before.
   *
   * A reminder that should not have been left is harmless — the machine
   * refuses an expiry for a deadline that is not running, and one that claims
   * an instant the deadline has not reached — so the only mistake worth
   * guarding against is the other one: a clock that nobody started. Comparing
   * kind and instant together means a deadline that moved gets a new reminder
   * rather than keeping a stale one.
   */
  async #arm(
    before: readonly Deadline[],
    after: readonly Deadline[],
    orderId: string,
  ): Promise<void> {
    const now = this.#runtime.clock();
    for (const deadline of after) {
      const alreadyRunning = before.some(
        (was) => was.kind === deadline.kind && was.at === deadline.at,
      );
      if (alreadyRunning) {
        continue;
      }
      const reminder: Reminder = {
        kind: "deadline",
        orderId,
        deadline: deadline.kind,
        at: deadline.at,
      };
      await this.#runtime.queue.remind(reminder, Math.max(deadline.at - now, 0));
    }
  }

  /**
   * The writes that go into the same hold as the order, out of the effects one
   * transition asked for.
   *
   * What every one of these has in common is that it cannot be re-driven once
   * the order has moved past the transition that asked for it, which is why it
   * is written where the state is.
   *
   * What they do not have in common is whether the sweep may write one again
   * afterwards, and the difference is a promise on the wire rather than a
   * detail here. A merchant's handler is told the same order can reach it more
   * than once, and a receipt is one row keyed by its order, so those two may be
   * re-driven. A merchant event may not: an order is delivered at least once
   * and an event at most once, and re-sending a debt is a second refund
   * somebody may act on. So the sweep has an arm for the first two and none for
   * the third, and an effect added here has to be placed in one of those two
   * groups before it has an arm.
   */
  #writesWithTheOrder(
    record: StoredOrder,
    before: Order,
    effects: readonly Effect[],
    at: number,
  ): WithTheOrder[] {
    const writes: WithTheOrder[] = [];

    for (const effect of effects) {
      switch (effect.kind) {
        // Which stream an envelope goes on comes off the order and is never
        // guessed at: the merchant on it was settled when the order was made,
        // from the card it was made against, so a redelivery an hour later
        // reaches the same worker as the first hand-over did.
        case "dispatch_order":
          writes.push({
            kind: "envelope",
            merchantId: record.merchantId,
            envelope: this.#orderEnvelope(record, at),
          });
          break;

        case "redeliver_order":
          writes.push({
            kind: "envelope",
            merchantId: record.merchantId,
            envelope: this.#orderEnvelope(record, at),
            afterMs: effect.delayMs,
          });
          break;

        case "emit_merchant_event":
          writes.push({
            kind: "envelope",
            merchantId: record.merchantId,
            envelope: this.#eventEnvelope(record, effect.event, at),
          });
          break;

        case "issue_receipt":
          writes.push({
            kind: "receipt",
            merchantId: record.merchantId,
            receipt: this.#receiptFor(record, before, at),
          });
          break;

        default:
          // Everything else is carried out after the order is written, and
          // `carriedOutAfterwards` is asked rather than assumed. The two lists
          // have to name the same effects, and the way they could come apart is
          // silent in the direction that costs the most: an effect taken out of
          // what runs afterwards but never added here would be filtered out of
          // one half and never written by the other, and a merchant would
          // simply never be handed the work.
          if (!carriedOutAfterwards(effect)) {
            throw new Error(
              `${effect.kind} on ${record.order.id} is written down with the order and this does not know how to write it`,
            );
          }
          break;
      }
    }

    return writes;
  }

  /** Carries out the effects that were not written down, and hands back the answer the merchant is owed. */
  async #run(
    record: StoredOrder,
    effects: readonly Effect[],
    at: number,
  ): Promise<MerchantAnswer | null> {
    let answer: MerchantAnswer | null = null;

    for (const effect of effects) {
      switch (effect.kind) {
        case "request_quote":
          // The question itself is put by the purchase flow, which is the one
          // that has to wait for the answer. What is guaranteed here is that
          // the clock on it is already running: the machine arms
          // `quote_response` the moment the order is created, so a merchant who
          // never answers is answered by the reminder rather than by nobody.
          break;

        case "verify_payment":
          // The machine asks for a payment to be verified — at quote time, when
          // there is no payment yet, and again when a repeat reopens an order.
          // The gateway verifies eagerly instead, before it takes the order's
          // lock and before it applies the payment: a network round-trip must
          // not hold a row, and the ownership decision needs the verified payer
          // in hand. So by the time any transition runs, the payment this
          // effect names is already checked, and there is nothing to do here.
          break;

        case "execute_payment":
          await this.#settle(record, at);
          break;

        case "dispatch_order":
        case "redeliver_order":
        case "emit_merchant_event":
        case "issue_receipt":
          // These were written down with the state that implies them and are
          // not carried out again here (ADR-0013). Reaching this means a caller
          // handed them over without taking them out first, and doing them a
          // second time would put a duplicate on a merchant's stream while
          // looking exactly like the code working.
          throw new Error(
            `${effect.kind} on ${record.order.id} was written down with the order and must not be carried out again`,
          );

        case "mark_refund_due":
          // The order's own state is the record of the debt, and the merchant
          // is told about it by the event the machine asked for alongside this.
          // There is nothing else to write down.
          //
          // Worth knowing, because it is a gap rather than a decision: a
          // receipt can say "refund due" and none ever does. Receipts are
          // issued when goods are released, and an order reaches this effect
          // without ever having released any, so there is no receipt here to
          // bring into line. A merchant reconciling money that came in and went
          // back out has the order and the event and no receipt for it.
          break;

        case "answer_merchant":
          answer = effect.answer;
          break;

        case "release_goods_to_agent":
          // The goods were written down when the merchant's answer arrived, and
          // handing them to the agent is waking whoever is parked on the
          // purchase. That happens once, after every effect has run, so the
          // agent is never woken to an order that is still half-decided.
          break;

        case "hold_fulfillment":
          // What the merchant produced is already on the order and nothing here
          // throws it away, which is the whole of what holding it means. The
          // machine's own flag is what a repeat of the purchase reads.
          break;

        case "invite_payment":
        case "dispatch_confirmation_request":
          // Both belong to the mode where the merchant is asked before the
          // money moves, and that mode has no shape on the wire yet — which is
          // why a card cannot be published as "confirm" at all. Reaching here
          // means something published one anyway, and inventing a message for
          // it would put a document on the merchant's stream that no contract
          // describes.
          throw new Error(
            `${effect.kind} belongs to the confirmation mode, which has no shape on the wire yet`,
          );

        default:
          throw new Error(`unhandled effect: ${JSON.stringify(effect)}`);
      }
    }

    return answer;
  }

  async #settle(record: StoredOrder, at: number): Promise<void> {
    const payment = record.payment;
    const price = record.order.price;
    if (payment === null || price === null) {
      throw new Error(
        `the machine asked for the charge on ${record.order.id} to be executed and there is nothing to execute`,
      );
    }

    const outcome = await this.#runtime.facilitator.settle({
      orderId: record.order.id,
      amount: price.amount,
      currency: price.currency,
      payment,
    });

    if (outcome.settled === true) {
      await this.apply(
        record.order.id,
        { kind: "payment_settled", at },
        {
          settlement: { transaction: outcome.transaction },
          paymentWord: { at, about: "settle", said: `went through as ${outcome.transaction}` },
        },
      );
      return;
    }
    if (outcome.settled === false) {
      await this.apply(
        record.order.id,
        { kind: "payment_settle_failed", at },
        { paymentWord: { at, about: "settle", said: outcome.reason } },
      );
      return;
    }

    // The charge was asked for and nothing came back. No event, and above all
    // no second charge: the machine's clock on the settle is already running
    // and it is the thing entitled to declare a silence, in the words that keep
    // "nobody knows" apart from "it did not go through".
    //
    // Nothing here will ever ask again, and that is a limitation rather than an
    // oversight. The facilitator offers verifying a payment, executing one, and
    // a list of what it supports — and no way at all to ask what became of a
    // charge already sent. Asking by sending it again is the one thing the
    // machine forbids. So the words below are the whole of what a person has to
    // go on, and they are written down for that person.
    await this.#writeDown(record.order.id, { at, about: "settle", said: outcome.reason });
  }

  /** Records something the payment layer said, without telling the machine. */
  async #writeDown(orderId: string, word: PaymentWord): Promise<void> {
    console.error(`[gateway] ${orderId}: the payment layer ${word.about} — ${word.said}`);
    await this.#runtime.store.withOrder(orderId, (found): OrderChange<null> => {
      return { save: { ...found, ...this.#alsoSaid(found, word) }, result: null };
    });
  }

  /**
   * One more thing the payment layer said, kept alongside the last few, with a
   * count of what fell off.
   *
   * Bounded because the route that fills it takes no key: an order's identifier
   * is enough to present a payment against it, and every presentation appends
   * here — into a document every later decision about that order has to read
   * and write back under a lock. Unbounded, one order could be made too
   * expensive to decide anything about. What is dropped is counted, because a
   * reader of the last twenty needs to know whether there were twenty or two
   * hundred.
   */
  #alsoSaid(
    record: StoredOrder,
    word: PaymentWord,
  ): Pick<StoredOrder, "paymentWords" | "paymentWordsDropped"> {
    const said = [...record.paymentWords, word];
    const kept = this.#runtime.config.paymentWordsKept;
    const dropped = Math.max(said.length - kept, 0);

    return {
      paymentWords: dropped === 0 ? said : said.slice(dropped),
      paymentWordsDropped: record.paymentWordsDropped + dropped,
    };
  }

  /**
   * The receipt for one order, as it should stand.
   *
   * It builds rather than writes, because writing it is the store's to do
   * inside the same hold as the order (ADR-0013). The sweep asks for the same
   * receipt and writes it on its own, which is why this takes the instants it
   * needs rather than reading a clock.
   */
  #receiptFor(record: StoredOrder, before: Order, at: number): Receipt {
    const price = record.order.price;
    if (price === null) {
      throw new Error(`a receipt was asked for on ${record.order.id}, which has no price`);
    }

    // When the money moved. Where it moved on this very transition that is now;
    // everywhere else the order already carries the instant, and a receipt
    // stamped with the moment somebody happened to ask for it would be a claim
    // about a payment nobody made then.
    const moneyMovedNow = before.payment !== "settled" && record.order.payment === "settled";
    const paidAt = moneyMovedNow ? at : (record.order.timestamps.paidAt ?? at);

    // The receipt belongs to the merchant the sale did, which is on the order
    // rather than looked up through the card: a card can be republished or
    // taken off sale, and a receipt names who made the sale whatever became of
    // the catalog afterwards.
    return {
      id: this.#runtime.ids("rcp"),
      order_id: record.order.id,
      item_id: record.itemId,
      price: {
        amount: price.amount,
        currency: price.currency,
        at: asTimestamp(record.order.timestamps.quotedAt ?? record.order.timestamps.createdAt),
        as_of: asTimestamp(price.asOf),
      },
      ...(record.priceId === null ? {} : { price_id: record.priceId }),
      paid_at: asTimestamp(paidAt),
      outcome: receiptOutcomeOf(record.order),
      test: record.order.test,
    };
  }

  #orderEnvelope(record: StoredOrder, at: number): WorkerEnvelope {
    return {
      kind: "order",
      id: this.#runtime.ids("env"),
      sent_at: asTimestamp(at),
      payload: orderDocumentOf(record),
    };
  }

  #eventEnvelope(record: StoredOrder, event: string, at: number): WorkerEnvelope {
    const common = { order_id: record.order.id, at: asTimestamp(at) } as const;

    switch (event) {
      case "order.refund_due": {
        // The sum owed is the sum that was taken, and there is no fallback to
        // the card's list price — there was one, and a debt is money that
        // actually moved, so a guess at how much would be the wrong number in
        // the one message whose whole purpose is naming it.
        const price = record.order.price;
        if (price === null) {
          throw new Error(
            `a refund fell due on ${record.order.id} and the order carries no price, so there is no sum to name`,
          );
        }
        return {
          kind: "order_event",
          id: this.#runtime.ids("env"),
          sent_at: asTimestamp(at),
          payload: {
            type: "order.refund_due",
            ...common,
            price: { amount: price.amount, currency: price.currency },
            reason: refundReasonOf(record.order),
          },
        };
      }
      case "order.unpaid_after_confirmation":
      case "order.payment_failed_after_delivery":
        return {
          kind: "order_event",
          id: this.#runtime.ids("env"),
          sent_at: asTimestamp(at),
          payload: { type: event, ...common },
        };
      default:
        throw new Error(`no shape on the wire for the merchant event ${event}`);
    }
  }

  /**
   * Wakes an agent parked on this purchase, once the order has an answer for
   * him. "In progress" is not an answer, and waking him with it would turn a
   * purchase that is still going through into one he reads as finished.
   */
  #wakeTheAgent(record: StoredOrder): void {
    if (record.paidBy !== null && outcomeFor(record.order) !== "in_progress") {
      this.purchases.answer(purchaseOf(record.order.id, record.paidBy), record);
    }
  }
}

/**
 * What this order sold for, or nothing where nobody ever named a price.
 *
 * Two readers ask: the merchant, through the order they are handed, and the
 * buyer, through the status of their own purchase. It is one function because
 * they have to be told the same number — a sale priced twice is a sale the two
 * sides can disagree about, and neither of them would have any way to tell
 * which figure was the real one.
 */
export function salePriceOf(record: StoredOrder): SalePrice | null {
  const price = record.order.price;
  if (price === null) {
    return null;
  }

  return {
    amount: price.amount,
    currency: price.currency,
    at: asTimestamp(record.order.timestamps.quotedAt ?? record.order.timestamps.createdAt),
    as_of: asTimestamp(price.asOf),
  };
}

/** The order as the merchant's worker reads it. */
export function orderDocumentOf(record: StoredOrder): OrderDocument {
  const price = salePriceOf(record);
  if (price === null) {
    throw new Error(`the order ${record.order.id} was sent to a merchant with no price on it`);
  }

  return {
    id: record.order.id,
    merchant_item_id: record.merchantItemId,
    params: { ...record.params },
    price,
    ...(record.priceId === null ? {} : { price_id: record.priceId }),
    test: record.order.test,
  };
}

/**
 * The receipt's word for where the order stands.
 *
 * Only one state can reach this, and the guard is the point rather than an
 * accident: the machine asks for a receipt on the way into `delivered` and
 * nowhere else. The receipt's vocabulary has three other words and this gateway
 * writes none of them, so a receipt asked for anywhere else is a change nobody
 * has thought through — and it stops here rather than quietly going out saying
 * "delivered" over an order that was not.
 */
function receiptOutcomeOf(order: Order): "in_progress" | "delivered" | "refund_due" | "refunded" {
  if (order.state !== "delivered") {
    throw new Error(
      `a receipt was asked for on an order in ${order.state}, and this gateway has no word for that`,
    );
  }
  return "delivered";
}

/**
 * Why a refund is owed, in the three words the merchant's event carries.
 *
 * Every closure that can reach a debt is named rather than falling into a
 * default, because the default was "a deadline passed" and two of these are not
 * deadlines at all. The sum a merchant sends back and the reason he files it
 * under are what somebody reconciles against; a reason picked because it was
 * the last branch is a claim beyond the evidence in the one place that costs
 * money.
 *
 * One of them is a fold rather than a match and it is said out loud: a charge
 * that reported in after we had given up on it leaves a debt the merchant had
 * no part in, and the nearest of the three words is the deadline — ours, on the
 * charge, not his on the goods. The vocabulary has no word for "our side lost
 * track of the money" and inventing one here would be a wire value no decision
 * stands behind.
 */
function refundReasonOf(order: Order): "refused" | "deadline_passed" | "merchant_left" {
  const closure = order.closure;
  if (closure === null) {
    throw new Error(`a refund fell due on ${order.id} with nothing recording why`);
  }

  switch (closure.cause) {
    case "merchant_refused":
      return "refused";
    case "merchant_departed":
      return "merchant_left";
    case "deadline_expired":
    case "payment_outcome_unknown":
      return "deadline_passed";
    case "unavailable":
    case "quote_silent":
    case "payment_not_verified":
    case "payment_not_settled":
      throw new Error(
        `a refund fell due on ${order.id} closed as ${closure.cause}, which takes no money and so owes none`,
      );
    default:
      return assertNever(closure, "closure cause");
  }
}

/**
 * The goods to write down, out of the ones this call carried.
 *
 * Two conditions, and each is one way the stored order could come to claim
 * something that did not happen.
 *
 * The first delivery is what the buyer keeps. Delivery is at least once by
 * design, so one order is answered with goods more than once as a matter of
 * course: a worker restarting, a redelivery going out beside an answer already
 * on its way, a merchant's own retry after a dropped connection. The machine
 * answers all of those `already_delivered` — a successful transition — so goods
 * riding on a repeat would otherwise be written straight over the ones the
 * agent has already been handed and read, and nothing in the answer would show
 * it: a repeat looks the same whether it carried the same goods or different
 * ones.
 *
 * And goods the machine turned away are not kept either. Some of its refusals
 * to a merchant are successful transitions carrying a failure for him rather
 * than rejections of the event — an order that has closed, or one whose refund
 * is already paid out, answers his delivery call that way while the order
 * itself does not move at all. Told to his face that the call did not go
 * through, he would have had what he sent written down behind it, and the order
 * of a buyer who has his money back would carry goods nobody ever gave him.
 *
 * Nothing here second-guesses the machine: what it answered the merchant is
 * what decides this, and a call it answered with a failure delivered nothing.
 */
function goodsToKeep(
  found: StoredOrder,
  delivery: Delivery | undefined,
  effects: readonly Effect[],
): { readonly delivery?: Delivery } {
  if (delivery === undefined || found.delivery !== null) {
    return {};
  }

  const turnedAway = effects.some(
    (effect) => effect.kind === "answer_merchant" && !effect.answer.ok,
  );

  return turnedAway ? {} : { delivery };
}

/**
 * The last check before an order is written down. A violation here is a defect
 * in the machine or in this interpreter, not a case to be handled: the
 * alternative to stopping is to write down an order that says the buyer's money
 * is somewhere it is not, and then go on selling against it.
 */
function refuseToWriteAnImpossibleOrder(order: Order): void {
  const violations = moneyInvariantViolations(order);
  if (violations.length > 0) {
    throw new Error(
      `the order ${order.id} breaks what must be true about money and will not be written down — ${violations.join("; ")}`,
    );
  }
}

/**
 * The events a verified payment drives an order home with, from where it stands.
 *
 * Almost always one: the order is waiting to be paid, and `payment_verified`
 * carries it forward. An order a repeat reopens — the goods already made and
 * the money never taken, or a synchronous purchase that ran out of time with
 * its work held — takes `purchase_repeated` first, to reset it, and then the
 * verification. Everywhere else a verified payment has nothing to drive, and an
 * empty list is how the owner asking again about a purchase already under way
 * is told the answer is wherever it has got to.
 *
 * The machine has the final say either way: a repeat it will not allow — one on
 * an order whose charge never reported back — is refused when the events run
 * through `transition`, not decided here.
 */
function eventsForVerifiedPayment(order: Order, at: number): StateEvent[] {
  switch (order.state) {
    case "quoted":
    case "confirmed":
      return [{ kind: "payment_verified", at }];
    case "delivered_unpaid":
      return [
        { kind: "purchase_repeated", at },
        { kind: "payment_verified", at },
      ];
    case "expired":
      return order.heldFulfillment
        ? [
            { kind: "purchase_repeated", at },
            { kind: "payment_verified", at },
          ]
        : [];
    default:
      return [];
  }
}
