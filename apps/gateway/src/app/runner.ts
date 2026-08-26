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
 * The effects run after the order is written and outside the hold on it. They
 * do real work — a network call to the facilitator, an envelope onto the queue
 * — and several of them produce the next event about the same order. Run under
 * the hold, the first of those would wait for a hold that only it could
 * release.
 *
 * And time is a value. Every event carries the instant it happened at, taken
 * from the clock once at the edge, so the same purchase replayed produces the
 * same order.
 */

import type { Delivery, Order as OrderDocument, WorkerEnvelope } from "@coinslot/contracts";
import type {
  Deadline,
  Effect,
  MerchantAnswer,
  Order,
  OrderEvent,
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
import type { OrderChange, PaymentWord, StoredOrder } from "../ports/store.js";
import type { Runtime } from "./runtime.js";
import { Waiting } from "./waiting.js";

/**
 * What is written down about the purchase alongside the machine's own order.
 * It is applied before the transition, so the event and the fact it is about
 * land together — the goods are stored and then the machine is told the handler
 * delivered, never the other way round.
 */
export interface OrderFacts {
  readonly delivery?: Delivery;
  readonly settlement?: { readonly transaction: string };
  /** Something the payment layer said, appended to what it has said before. */
  readonly paymentWord?: PaymentWord;
  readonly payment?: string | null;
  readonly priceId?: string;
  readonly openDeliveryId?: string | null;
}

/** What one hold on an order came to, before its effects are carried out. */
interface Decided {
  readonly moved: TransitionResult;
  readonly before: Order;
  readonly known: StoredOrder;
}

export type Applied =
  | {
      readonly outcome: "moved";
      readonly order: StoredOrder;
      readonly effects: readonly Effect[];
      /** What the merchant's own call is answered with, where the event was one. */
      readonly answer: MerchantAnswer | null;
    }
  | { readonly outcome: "refused"; readonly rejection: TransitionRejection }
  | { readonly outcome: "no_such_order" };

/** What a parked purchase is woken with: the order as it finally stands. */
export type PurchaseSettled = StoredOrder;

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
    await this.#runtime.store.addOrder(record);
    await this.#run(record, record.order, effects, at);
    return record;
  }

  /** Feeds one event to the machine and carries out whatever comes back. */
  async apply(orderId: string, event: OrderEvent, facts: OrderFacts = {}): Promise<Applied> {
    const decided = await this.#runtime.store.withOrder(
      orderId,
      async (found): Promise<OrderChange<Decided>> => {
        const known: StoredOrder = {
          ...found,
          ...(facts.delivery === undefined ? {} : { delivery: facts.delivery }),
          ...(facts.settlement === undefined ? {} : { settlement: facts.settlement }),
          ...(facts.paymentWord === undefined
            ? {}
            : { paymentWords: [...found.paymentWords, facts.paymentWord] }),
          ...(facts.payment === undefined ? {} : { payment: facts.payment }),
          ...(facts.priceId === undefined ? {} : { priceId: facts.priceId }),
          ...(facts.openDeliveryId === undefined ? {} : { openDeliveryId: facts.openDeliveryId }),
        };

        const moved = transition(known.order, event);
        if (!moved.ok) {
          // Nothing is written for a refused event, not even the facts that
          // came with it: an event the machine says has no meaning here should
          // leave no trace of having been believed.
          return { result: { moved, before: known.order, known } };
        }

        refuseToWriteAnImpossibleOrder(moved.order);
        const next: StoredOrder = { ...known, order: moved.order };

        // The clocks the order will be waiting on are started before the change
        // to it is committed, and that ordering is the whole of the guarantee.
        // Started afterwards, a failure here would leave an order that had
        // moved and had no clock on it: the event would be delivered again,
        // the machine would say it no longer applies, the delivery would be
        // marked done, and the order would hang forever with nobody waiting on
        // anything. Started first, a failure writes nothing and the event comes
        // back; the other way round leaves a reminder for a change that did not
        // happen, which the machine refuses as a deadline that is not running.
        await this.#arm(deadlines(known.order), deadlines(next.order), orderId);

        return { save: next, result: { moved, before: known.order, known: next } };
      },
    );

    if (!decided.found) {
      return { outcome: "no_such_order" };
    }

    const { moved, before, known } = decided.result;
    if (!moved.ok) {
      return { outcome: "refused", rejection: moved.rejection };
    }

    const answer = await this.#run(known, before, moved.effects, event.at);
    this.#wakeTheAgent(known);

    return { outcome: "moved", order: known, effects: moved.effects, answer };
  }

  /**
   * The agent has presented a payment for an order that was waiting for one.
   *
   * The machine asked for the payment to be verified the moment it had a price;
   * there was nothing to verify then, because the agent had only just been told
   * what to pay. This is that same effect, carried out now that there is
   * something to carry it out with — and whether a payment means anything in
   * the state the order is actually in is still the machine's to say, from the
   * event this produces.
   */
  async presentPayment(orderId: string, payment: string, at: number): Promise<boolean> {
    const held = await this.#runtime.store.withOrder(orderId, (found): OrderChange<StoredOrder> => {
      const next: StoredOrder = { ...found, payment };
      refuseToWriteAnImpossibleOrder(next.order);
      return { save: next, result: next };
    });

    if (!held.found) {
      return false;
    }
    await this.#verify(held.result, at);
    return true;
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

  /** Carries out the effects, and hands back the answer the merchant is owed. */
  async #run(
    record: StoredOrder,
    before: Order,
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
          await this.#verify(record, at);
          break;

        case "execute_payment":
          await this.#settle(record, at);
          break;

        case "dispatch_order":
          await this.#runtime.queue.publish(this.#orderEnvelope(record, at));
          break;

        case "redeliver_order":
          await this.#runtime.queue.publish(this.#orderEnvelope(record, at), effect.delayMs);
          break;

        case "issue_receipt":
          await this.#issueReceipt(record, before, at);
          break;

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

        case "emit_merchant_event":
          await this.#runtime.queue.publish(this.#eventEnvelope(record, effect.event, at));
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

  async #verify(record: StoredOrder, at: number): Promise<void> {
    const payment = record.payment;
    const price = record.order.price;
    if (payment === null || price === null) {
      // Nothing has been presented yet. The order is priced and the challenge
      // stands; the agent comes back with a payment and this runs then.
      return;
    }

    const outcome = await this.#runtime.facilitator.verify({
      orderId: record.order.id,
      amount: price.amount,
      currency: price.currency,
      payment,
    });

    if (outcome.verified === true) {
      await this.apply(
        record.order.id,
        { kind: "payment_verified", at },
        {
          paymentWord: {
            at,
            about: "verify",
            said: `checked out, paid by ${outcome.payer ?? "an address the payment layer did not name"}`,
          },
        },
      );
      return;
    }
    if (outcome.verified === false) {
      // The machine's three reasons are coarser than what the payment layer
      // actually said, and what it said is the only thing an operator can work
      // from later, so both are written down.
      await this.apply(
        record.order.id,
        { kind: "payment_verification_failed", at, reason: outcome.reason },
        { paymentWord: { at, about: "verify", said: outcome.message } },
      );
      return;
    }

    // The facilitator could not be asked. Nothing is claimed and no event is
    // sent: the order keeps the price it was quoted and the clock on that price
    // is the thing that ends it, which is a slower answer than a guess and the
    // only one there is evidence for. What it did say is written down, because
    // an order that quietly stopped moving is otherwise a mystery.
    await this.#writeDown(record.order.id, { at, about: "verify", said: outcome.message });
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

  async #issueReceipt(record: StoredOrder, before: Order, at: number): Promise<void> {
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

    await this.#runtime.store.putReceipt({
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
    });
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
    if (outcomeFor(record.order) !== "in_progress") {
      this.purchases.answer(record.order.id, record);
    }
  }
}

/** The order as the merchant's worker reads it. */
export function orderDocumentOf(record: StoredOrder): OrderDocument {
  const price = record.order.price;
  if (price === null) {
    throw new Error(`the order ${record.order.id} was sent to a merchant with no price on it`);
  }

  return {
    id: record.order.id,
    merchant_item_id: record.merchantItemId,
    params: { ...record.params },
    price: {
      amount: price.amount,
      currency: price.currency,
      at: asTimestamp(record.order.timestamps.quotedAt ?? record.order.timestamps.createdAt),
      as_of: asTimestamp(price.asOf),
    },
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
