/**
 * The flows: what happens when an agent buys, when a merchant's worker draws
 * its stream, and when either of them answers.
 *
 * Nothing here decides anything about an order. Each flow does the same shape
 * of work — read the world, put one event to the interpreter, answer with what
 * the machine made of it — and where a flow appears to make a choice, look
 * again: it is choosing which event happened, not what the order should do
 * about it. A price question that went unanswered becomes the event "the
 * merchant was silent", and whether silence sells is decided elsewhere, by
 * mode, exactly as ADR-0002 §3 says.
 *
 * Two things in stage one are narrower than the model and are written here
 * rather than discovered later. Every order is a test order, because the
 * separation of the sandbox from the real thing is stage two of the pilot plan
 * and there is nothing yet to tell them apart with. And the merchant is always
 * selling, because the pause switch lives in a cabinet that does not exist yet;
 * the machine's guard for it is in place and takes the answer from here the day
 * there is one.
 */

import {
  type Acceptance,
  CardSchema,
  type CatalogPage,
  CONTRACT_VERSION,
  type Delivery,
  type HandlerAnswer,
  type OrderAcceptResponse,
  type OrderCallError,
  type OrderCallResponse,
  type PublishError,
  type PublishResult,
  publicCardOf,
  purchaseCheckFor,
  type QuoteAnswerAck,
  type QuoteResponse,
  type Refusal,
  type WorkerEnvelope,
  type WorkerPollResponse,
} from "@coinslot/contracts";
import type { TransitionRejection } from "@coinslot/core";
import { createOrder, fulfillmentDeadline, isOpen, outcomeFor } from "@coinslot/core";
import { asTimestamp } from "../ports/clock.js";
import type { Reminder } from "../ports/queue.js";
import type { StoredCard, StoredOrder } from "../ports/store.js";
import { ACCEPTANCE_HAS_NO_WORD, orderCallResponseOf } from "./answers.js";
import { OrderRunner, orderDocumentOf } from "./runner.js";
import {
  modeForCard,
  policyFor,
  priceCheckOf,
  quoteReachesTheMerchant,
  type Runtime,
} from "./runtime.js";
import { purchaseOf, Waiting } from "./waiting.js";

/**
 * Stage one sells nothing for real money: the separation of the sandbox from
 * the live network is stage two, so every order is marked as what it is.
 */
const STAGE_ONE_ORDERS_ARE_TESTS = true;

/**
 * Stage one has no cabinet and therefore no pause switch. The machine refuses
 * new orders for a paused or departed merchant; this is the answer it gets
 * until there is somewhere for a merchant to say otherwise.
 */
const STAGE_ONE_MERCHANT_IS_SELLING = "open" as const;

/** The queue's name for the daily sweep of claims on payments. */
export const SWEEP_CLAIMS = "coinslot_forget_old_claims";

/** What a purchase attempt came to. */
export type PurchaseAttempt =
  /** The order is priced and waiting to be paid for: here is what it costs. */
  | { readonly step: "pay"; readonly order: StoredOrder }
  /** The purchase is over, one way or another. */
  | { readonly step: "settled"; readonly order: StoredOrder; readonly delivery: Delivery | null }
  /** The purchase is under way and the agent is not waiting on it. */
  | { readonly step: "under_way"; readonly order: StoredOrder }
  | { readonly step: "no_such_item" }
  | { readonly step: "params_rejected"; readonly problems: readonly PublishError[] }
  | { readonly step: "not_selling"; readonly message: string }
  /** This payment has already been presented for a different order. */
  | {
      readonly step: "payment_already_spent";
      readonly heldBy: string;
      /** Whether that order is still one an agent could collect anything from. */
      readonly collectable: boolean;
    }
  /** The machine would not take this payment on this order, and said why. */
  | { readonly step: "payment_not_taken"; readonly why: string; readonly retryable: boolean }
  /** This order is somebody else's purchase, and this payment is not its own. */
  | { readonly step: "not_this_purchase" };

export class Gateway {
  readonly runtime: Runtime;
  readonly runner: OrderRunner;
  /** Purchases parked on a price question, by the identifier of the question. */
  readonly quotes = new Waiting<QuoteResponse>();
  /** Which order each open price question belongs to. */
  readonly #questions = new Map<string, string>();

  constructor(runtime: Runtime) {
    this.runtime = runtime;
    this.runner = new OrderRunner(runtime);
  }

  /**
   * Starts the queue and points its reminders at the machine. Every reminder
   * becomes an event and nothing more: a clock running out is a fact, and what
   * it means for an order is not this file's to say.
   */
  async start(): Promise<void> {
    this.runtime.queue.onReminder(async (reminder) => {
      try {
        await this.#onReminder(reminder);
      } catch (thrown) {
        // Said out loud and then thrown on. A reminder is the only thing that
        // ever declares an overdue order, and the queue is what delivers it
        // again — catching it here and re-arming would mean writing to the very
        // database whose unavailability had just thrown.
        console.error(
          `[gateway] a reminder failed (${reminder.kind}, order ${reminder.orderId})`,
          thrown,
        );
        throw thrown;
      }
    });

    await this.runtime.queue.start();

    // Claims on payments are swept by the queue's own scheduler rather than by
    // a timer of ours: it survives a restart and does not run twice when there
    // are two processes. Registering the same name replaces what was there, so
    // a restart does not accumulate schedules.
    await this.runtime.queue.everyDay(SWEEP_CLAIMS, () => this.forgetOldClaims());
  }

  /** One reminder, turned into one event and nothing more. */
  async #onReminder(reminder: Reminder): Promise<void> {
    if (reminder.kind === "deadline") {
      await this.runner.apply(reminder.orderId, {
        kind: "deadline_expired",
        at: reminder.at,
        deadline: reminder.deadline,
      });
      return;
    }

    // A delivery went unanswered. It only counts if it is still the delivery
    // the order is waiting on: the merchant who answered the one he was given
    // must not be sent the order again for a reminder left against it.
    const record = await this.runtime.store.orderById(reminder.orderId);
    if (record === null || record.openDeliveryId !== reminder.handOver) {
      return;
    }
    await this.runner.apply(reminder.orderId, {
      kind: "handler_undelivered",
      at: this.runtime.clock(),
    });
  }

  /**
   * Forgets the claims on payments too old to be guarding anything, and says
   * how many went.
   *
   * A claim stops one signed authorisation from buying two orders, and what it
   * has to cover is the window between a payment being verified and the charge
   * being executed — after that the token itself refuses the same authorisation
   * a second time. They cannot be kept forever: the route that makes them takes
   * no key, so anybody may make as many as they like.
   */
  async forgetOldClaims(): Promise<number> {
    const gone = await this.runtime.store.forgetClaimsBefore(
      this.runtime.clock() - this.runtime.config.claimRetentionMs,
    );
    if (gone > 0) {
      console.log(`[gateway] forgot ${gone} claims on payments older than the retention`);
    }
    return gone;
  }

  async stop(): Promise<void> {
    await this.runtime.queue.stop();
    this.quotes.giveUpAll();
    this.runner.purchases.giveUpAll();
  }

  // --- the catalog ----------------------------------------------------------

  async publishCard(body: unknown): Promise<PublishResult> {
    const parsed = CardSchema.safeParse(body);
    if (!parsed.success) {
      return { errors: findingsOf(parsed.error.issues) };
    }

    const stored = await this.runtime.store.publishCard(parsed.data, this.runtime.clock());
    return { ok: { id: stored.id } };
  }

  async catalog(): Promise<CatalogPage> {
    const cards = await this.runtime.store.cards();
    return {
      items: cards.map((stored) =>
        publicCardOf(stored.card, { id: stored.id, as_of: asTimestamp(stored.asOf) }),
      ),
    };
  }

  // --- buying ---------------------------------------------------------------

  /**
   * The first half of a purchase: an order is opened, the merchant is asked
   * what the goods cost if his card says to ask, and the agent is told what to
   * pay — or told the purchase is already over, which is what a card that is
   * out of stock comes to.
   */
  async beginPurchase(
    itemId: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<PurchaseAttempt> {
    const stored = await this.runtime.store.cardById(itemId);
    if (stored === null) {
      return { step: "no_such_item" };
    }

    // The parameters are checked against this card's own declaration, which is
    // the only place that knows what this product needs. No schema written in
    // advance of a catalog can do it.
    const fit = purchaseCheckFor(stored.card).safeParse(params);
    if (!fit.success) {
      return { step: "params_rejected", problems: findingsOf(fit.error.issues) };
    }

    const at = this.runtime.clock();
    const created = createOrder({
      id: this.runtime.ids("ord"),
      at,
      mode: modeForCard(stored.card),
      policy: policyFor(stored.card, this.runtime.config),
      priceCheck: priceCheckOf(stored.card),
      cardPrice: {
        amount: stored.card.price.amount,
        currency: stored.card.price.currency,
        asOf: stored.asOf,
      },
      test: STAGE_ONE_ORDERS_ARE_TESTS,
      selling: STAGE_ONE_MERCHANT_IS_SELLING,
    });

    if (!created.ok) {
      return { step: "not_selling", message: created.rejection.message };
    }

    const record: StoredOrder = {
      order: created.order,
      itemId: stored.id,
      merchantItemId: stored.card.merchant_item_id,
      params: { ...params },
      priceId: null,
      delivery: null,
      payment: null,
      paidBy: null,
      paidFrom: null,
      settlement: null,
      paymentWords: [],
      paymentWordsDropped: 0,
      openDeliveryId: null,
    };
    await this.runner.create(record, created.effects, at);

    if (created.effects.some((effect) => effect.kind === "request_quote")) {
      await this.#askThePrice(record, stored);
    }

    return this.#wherePurchaseStands(record.order.id);
  }

  /**
   * The second half: the agent has paid. What follows is the machine's, and
   * how long the agent waits for it depends on the mode — a synchronous
   * purchase is answered with the goods, so the agent stays on the call until
   * the order has an answer or the promised ceiling runs out.
   */
  async payPurchase(
    orderId: string,
    payment: string,
    fingerprint: string,
    payer: string | null = null,
  ): Promise<PurchaseAttempt> {
    const before = await this.runtime.store.orderById(orderId);
    if (before === null) {
      return { step: "no_such_item" };
    }

    // A signed payment says how much, to whom and on which chain, and nothing
    // at all about which purchase it is for. Two orders at the same price are
    // therefore payable with one signature: both would verify, both would go to
    // a merchant, both would be delivered, and only the second charge would
    // fail — leaving a merchant who handed over goods for nothing. The first
    // order to present a payment owns it, and that is decided here, before
    // anything is verified and before any merchant is asked to do work.
    const claim = await this.runtime.store.claimPayment(fingerprint, orderId);
    if (!claim.claimed) {
      const holder = await this.runtime.store.orderById(claim.heldBy);
      return {
        step: "payment_already_spent",
        heldBy: claim.heldBy,
        // Whether pointing the agent at that order is any use to it. A claim
        // held by an order that is over is a dead end, and saying "go and
        // collect it" would send the agent somewhere with nothing to collect.
        collectable: holder !== null && outcomeFor(holder.order) === "in_progress",
      };
    }

    // Whose purchase this is. An order's identifier travels — in the challenge,
    // on the merchant's stream, in a receipt — and the route that takes a
    // payment takes no key, so without this anybody holding one could act as
    // the buyer of somebody else's order. The first payment presented owns it.
    const taken = await this.#present(orderId, payment, fingerprint, payer, before);
    if (taken !== null) {
      return taken;
    }

    // The place in the call to start waiting is here, and the key is the
    // purchase rather than the order. In the synchronous mode the goods reach
    // the agent through this park and nowhere else, so a second call parking
    // under the order's own identifier would take them from whoever was already
    // waiting — and the buyer, who paid, would be told nothing happened.
    //
    // The whole exchange, the goods and then the charge, is promised to the
    // agent inside one ceiling counted from the purchase itself. What is left
    // of that ceiling is how long this waits, and never longer.
    const waits = before.order.mode.settle === "after_fulfillment";
    const spent = this.runtime.clock() - before.order.timestamps.createdAt;
    const left = Math.max(this.runtime.config.deadlines.syncBudgetMs - spent, 0);
    const parked = waits
      ? this.runner.purchases.wait(purchaseOf(orderId, fingerprint), left)
      : null;

    if (parked !== null) {
      const settled = await this.runtime.store.orderById(orderId);
      if (settled !== null && outcomeFor(settled.order) !== "in_progress") {
        // It is already answered — an order that was over before this payment
        // arrived, for instance. There is nothing left to wait for.
        this.runner.purchases.giveUp(purchaseOf(orderId, fingerprint));
      }
      await parked;
    }

    return this.#wherePurchaseStands(orderId);
  }

  async orderById(orderId: string): Promise<StoredOrder | null> {
    return this.runtime.store.orderById(orderId);
  }

  // --- the merchant's stream ------------------------------------------------

  /**
   * Draws the next batch off the merchant's stream and records the hand-over of
   * every order in it.
   *
   * An order that has moved on since it was queued is not handed out: the
   * machine refuses the hand-over, and passing it to a handler anyway would ask
   * a merchant to work on a purchase that is over.
   */
  async poll(max: number, waitMs: number): Promise<WorkerPollResponse> {
    const { config, queue, clock } = this.runtime;
    const drawn = await queue.draw(
      Math.min(max, config.worker.pollMaxEnvelopes),
      Math.min(waitMs, config.worker.pollWaitMs),
    );

    const handing: WorkerPollResponse["envelopes"] = [];
    const finished: string[] = [];

    for (const delivery of drawn) {
      if (delivery.envelope.kind !== "order") {
        handing.push(delivery.envelope);
        finished.push(delivery.handle);
        continue;
      }

      const orderId = delivery.envelope.payload.id;
      const at = clock();
      // A token for this hand-over rather than for the message. The envelope's
      // own identifier names the order and stays the same however many times it
      // goes out, which is what lets a worker tell a repeat from a new message;
      // telling one hand-over from another is ours, and needs its own name.
      const handOver = this.runtime.ids("dlv");
      let applied: Awaited<ReturnType<OrderRunner["apply"]>>;
      try {
        applied = await this.runner.apply(
          orderId,
          { kind: "order_dispatched", at },
          { openDeliveryId: handOver },
        );
      } catch (thrown) {
        // Recording this one hand-over failed. The rest of the batch is not
        // taken down with it — an envelope already in this answer would
        // otherwise be drawn, discarded with the failed response, and never
        // seen again — and this one goes back on the stream rather than being
        // lost with it.
        console.error(`[gateway] could not record the hand-over of ${orderId}`, thrown);
        await queue.publish(sentNow(delivery.envelope, at), config.settleInFlightRetryMs);
        finished.push(delivery.handle);
        continue;
      }

      if (applied.outcome === "refused" && applied.rejection.retryable) {
        // The machine will take this hand-over, just not yet — a charge on this
        // order is being executed and it will not answer anything else until it
        // reports. The order goes back on the stream rather than being dropped,
        // because dropping it is how an order that was paid for never reaches a
        // merchant at all.
        await queue.publish(sentNow(delivery.envelope, at), config.settleInFlightRetryMs);
        finished.push(delivery.handle);
        continue;
      }

      if (applied.outcome !== "moved") {
        // The machine will not record the hand-over, so nobody is given the
        // order. Not every ending refuses it — an order that is delivered or
        // owes a refund is handed over again and answered from where it stands,
        // which is what makes a repeat safe — but where the machine says the
        // hand-over has no meaning, passing it on would ask a merchant to work
        // on a purchase that is over.
        finished.push(delivery.handle);
        continue;
      }

      await this.#remindMeIfNobodyAnswers(applied.order, handOver, at);
      handing.push(delivery.envelope);
      finished.push(delivery.handle);
    }

    // The queue is told last, once every hand-over in the batch has been
    // recorded. Told first, a throw part way through the batch would leave
    // envelopes finished that nobody was ever handed.
    for (const handle of finished) {
      await queue.finish(handle);
    }

    return { contract_version: CONTRACT_VERSION, envelopes: handing };
  }

  /**
   * The price and availability for a question that came off the stream.
   *
   * The acknowledgement is the merchant's cue to release stock he set aside, so
   * `used` has to mean what it says: the answer priced this purchase. It used to
   * mean only that somebody was still listening, which is a different thing and
   * wrong in the case that matters — the clock on our own patience can close the
   * question a moment before an answer lands, and the merchant would have been
   * told his price was taken while the sale went through at another one.
   *
   * So the answer is put to the machine here, and what the machine made of it is
   * what comes back.
   */
  async answerQuote(priceId: string, response: QuoteResponse): Promise<QuoteAnswerAck> {
    const asked = this.#questions.get(priceId);
    if (asked === undefined) {
      // A question we no longer hold — a worker replaying an envelope from an
      // hour ago, or one already answered. It priced nothing.
      return { used: false };
    }

    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      asked,
      response.available
        ? {
            kind: "quote_answered",
            at,
            available: true,
            price: {
              amount: response.price.amount,
              currency: response.price.currency,
              asOf: Date.parse(response.as_of),
            },
          }
        : { kind: "quote_answered", at, available: false },
      { priceId },
    );

    // The question is finished either way: it has been put to the machine, and
    // a second answer to it can only be told the same thing. Whoever is parked
    // on the purchase is woken either way too — if the answer priced it they
    // have their price, and if it did not the order has already moved on and
    // there is nothing left to wait for.
    this.#questions.delete(priceId);
    this.quotes.answer(priceId, response);

    return { used: applied.outcome === "moved" };
  }

  /** What the merchant's handler returned for an order it was given. */
  async answerOrder(orderId: string, answer: HandlerAnswer): Promise<OrderCallResponse | null> {
    if ("delivered" in answer) {
      return this.deliverOrder(orderId, answer.delivered, "handler");
    }
    if ("refused" in answer) {
      return this.refuseOrder(orderId, answer.refused, "handler");
    }

    const taken = await this.acceptOrder(orderId, answer.accepted);
    if (taken === null) {
      return null;
    }
    return taken.ok ? { ok: false, error: ACCEPTANCE_HAS_NO_WORD } : taken;
  }

  async deliverOrder(
    orderId: string,
    delivery: Delivery,
    from: "handler" | "call" = "call",
  ): Promise<OrderCallResponse | null> {
    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      from === "handler" ? { kind: "handler_delivered", at } : { kind: "deliver_called", at },
      { delivery, openDeliveryId: null },
    );
    return this.#answerFor(applied, "delivered");
  }

  async refuseOrder(
    orderId: string,
    refusal: Refusal,
    from: "handler" | "call" = "call",
  ): Promise<OrderCallResponse | null> {
    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      from === "handler"
        ? { kind: "handler_refused", at, code: refusal.code, message: refusal.message }
        : { kind: "refuse_called", at, code: refusal.code, message: refusal.message },
      { openDeliveryId: null },
    );
    return this.#answerFor(applied, "refused");
  }

  /**
   * Takes an order on. The success carries no word, which is the contract's own
   * admission: nothing published names a successful acceptance, and the same
   * order is taken on again every time it is redelivered, so an answer with no
   * word in it has nothing to get wrong on the second pass.
   */
  async acceptOrder(orderId: string, _acceptance: Acceptance): Promise<OrderAcceptResponse | null> {
    // The expected time to deliver is the merchant's estimate and not a
    // commitment: what he is held to is the deadline on his card, which the
    // order already carries. Writing his guess down beside it would put two
    // numbers next to each other where only one is enforced.
    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      { kind: "handler_accepted", at },
      { openDeliveryId: null },
    );

    if (applied.outcome === "no_such_order") {
      return null;
    }
    if (applied.outcome === "refused") {
      return { ok: false, error: refusedCall(applied.rejection) };
    }
    if (applied.answer !== null && !applied.answer.ok) {
      const answered = orderCallResponseOf(applied.answer);
      return answered.ok ? { ok: true } : answered;
    }
    return { ok: true };
  }

  async orders(open: boolean | undefined): Promise<readonly StoredOrder[]> {
    return this.runtime.store.orders(open === undefined ? undefined : { open });
  }

  // --- the parts the flows above lean on ------------------------------------

  /**
   * Hands the payment to the order, and tells the machine what kind of
   * presentation it is. Answers with a refusal to give the agent, or nothing
   * when the payment was taken.
   *
   * A payment on an order that already has one is a repeat of the purchase, and
   * the two facts travel together: the machine is told the purchase was
   * repeated and given the new authorisation in the same breath. Told first and
   * given the payment after, the verification the machine asks for on a repeat
   * would run against the authorisation that had just failed — charging the old
   * one and throwing away the one the agent actually presented.
   *
   * And a repeat the machine will not take is not forced through. It refuses
   * one on an order whose charge never reported back, because sending a second
   * one would be spending the buyer's money on a guess about the first; writing
   * the new payment down anyway would erase the record of which authorisation
   * is unaccounted for, which is the only thing anybody could reconcile that
   * order from.
   */
  async #present(
    orderId: string,
    payment: string,
    fingerprint: string,
    payer: string | null,
    before: StoredOrder,
  ): Promise<PurchaseAttempt | null> {
    const take = async (): Promise<PurchaseAttempt | null> =>
      (await this.runner.presentPayment(orderId, payment, fingerprint, payer, this.runtime.clock()))
        ? null
        : { step: "no_such_item" };

    if (before.paidBy === null) {
      // Nobody owns this order yet, so this presentation does.
      return take();
    }

    if (before.paidBy === fingerprint) {
      // The owner, asking again. Still waiting for a payment means a dropped
      // connection and a retry, which the portal promises is safe; anything
      // else means the purchase is already under way and there is nothing to
      // present — the answer is whatever it has come to.
      return before.order.payment === "none" ? take() : null;
    }

    // A payment that is not the one this order took. The one way another can
    // take over is a repeat of the purchase, and two things have to hold for
    // that. It has to come from the agent who bought — a repeat carries a fresh
    // authorisation, so the fingerprint cannot say that and the address it
    // spends from is what does — and the machine has to agree that a repeat
    // means anything here at all: it knows that one collects goods already
    // made, that it must not send a second charge on top of one whose fate is
    // unknown, and that in most states it means nothing.
    if (before.paidFrom !== null && before.paidFrom !== payer) {
      return { step: "not_this_purchase" };
    }

    // The new authorisation travels with the event, so the verification the
    // machine asks for runs against the payment the agent actually presented
    // rather than the one before it.
    const repeated = await this.runner.apply(
      orderId,
      { kind: "purchase_repeated", at: this.runtime.clock() },
      { payment, paidBy: fingerprint, paidFrom: payer },
    );

    if (repeated.outcome === "no_such_order") {
      return { step: "no_such_item" };
    }
    if (repeated.outcome === "refused") {
      return {
        step: "payment_not_taken",
        why: repeated.rejection.message,
        retryable: repeated.rejection.retryable,
      };
    }
    if (repeated.order.paidBy !== fingerprint) {
      // The machine did not reopen the order, so it is still being fulfilled
      // against the payment it took and nothing about it changed.
      return { step: "not_this_purchase" };
    }

    return repeated.effects.some((effect) => effect.kind === "verify_payment")
      ? // The machine asked for the new payment to be checked and the runner
        // has already done it. Presenting it again would put a second question
        // to the facilitator about the same authorisation.
        null
      : take();
  }

  /**
   * Puts the price question to the merchant and waits out our own patience for
   * it. Whatever comes back — an answer, a refusal to sell, or nothing at all —
   * reaches the machine as an event, and what it costs the order is decided
   * there.
   */
  async #askThePrice(record: StoredOrder, stored: StoredCard): Promise<void> {
    const { queue, ids, clock, config } = this.runtime;
    const orderId = record.order.id;

    if (!quoteReachesTheMerchant(stored.card)) {
      // The card asks for its price at an address of the merchant's own. That
      // transport is not served in this stage, and the honest thing to report
      // is the same fact an unanswered question produces: nobody told us what
      // this costs.
      //
      // Said out loud as well, because it is otherwise invisible from every
      // side. The merchant's pricing is never once consulted, the merchant is
      // never told so, and on a synchronous card the product simply sells at
      // its snapshot price forever.
      console.warn(
        `[gateway] ${stored.id} asks for its price at an address, which this stage does not call — ${orderId} is priced as if nobody answered`,
      );
      await this.runner.apply(orderId, { kind: "quote_silent", at: clock() });
      return;
    }

    const priceId = ids("prc");
    const askedAt = clock();

    // Registered and parked before the question goes out, not after. A worker
    // sitting on a poll is woken by that publish, and a merchant whose handler
    // answers inside a millisecond would otherwise find nobody listening and
    // have his price thrown away.
    this.#questions.set(priceId, orderId);
    const parked = this.quotes.wait(priceId, config.deadlines.quoteResponseMs);

    await queue.publish({
      kind: "quote_request",
      id: ids("env"),
      sent_at: asTimestamp(askedAt),
      payload: {
        merchant_item_id: stored.card.merchant_item_id,
        params: { ...record.params },
        price_id: priceId,
        purpose: "purchase",
        expires_at: asTimestamp(askedAt + config.deadlines.quoteResponseMs),
      },
    });

    const answered = await parked;
    this.#questions.delete(priceId);

    if (answered === null) {
      // Nobody said what it costs. The machine decides what that is worth, by
      // mode: where the merchant's live answer still stands between the price
      // and the charge, the card's own number sells; where the money moves at
      // the purchase, the sale does not happen.
      await this.runner.apply(orderId, { kind: "quote_silent", at: clock() });
    }
  }

  /**
   * Leaves a reminder that this delivery has gone unanswered, but never one
   * that would land after the order's own deadline has already closed it —
   * a redelivery decided after the ending is a decision about a purchase that
   * is over.
   */
  async #remindMeIfNobodyAnswers(record: StoredOrder, handOver: string, at: number): Promise<void> {
    const { config, queue } = this.runtime;
    const deadline = fulfillmentDeadline(record.order)[0];
    const untilDeadline = deadline === undefined ? Number.POSITIVE_INFINITY : deadline.at - at;
    const wait = Math.min(config.deadlines.handlerAnswerMs, untilDeadline);

    if (wait <= 0) {
      return;
    }
    await queue.remind({ kind: "delivery_unanswered", orderId: record.order.id, handOver }, wait);
  }

  async #wherePurchaseStands(orderId: string): Promise<PurchaseAttempt> {
    const record = await this.runtime.store.orderById(orderId);
    if (record === null) {
      return { step: "no_such_item" };
    }

    if (outcomeFor(record.order) !== "in_progress") {
      return { step: "settled", order: record, delivery: record.delivery };
    }

    // An order that has a price and no payment behind it is one the agent has
    // been told the price of and has not paid. Everything else in progress is
    // ours or the merchant's to finish, and the agent is not sitting on it.
    const waitingToBePaid = record.order.price !== null && record.order.payment === "none";
    return waitingToBePaid ? { step: "pay", order: record } : { step: "under_way", order: record };
  }

  /**
   * The document one of the merchant's calls is answered with.
   *
   * Where the machine had a word for him it is his; where it had none, the
   * answer is that his own answer landed — and which of the five that is
   * depends on what he answered, not on what the machine happened to do next.
   * A refusal answered with "delivered" because the machine went quiet would be
   * a receipt for goods that do not exist.
   */
  #answerFor(
    applied: Awaited<ReturnType<OrderRunner["apply"]>>,
    landed: "delivered" | "refused",
  ): OrderCallResponse | null {
    if (applied.outcome === "no_such_order") {
      return null;
    }
    if (applied.outcome === "refused") {
      return { ok: false, error: refusedCall(applied.rejection) };
    }
    if (applied.answer === null) {
      // The machine took the event and had nothing to say back about it, which
      // is what a handler's own answer looks like in the synchronous mode: the
      // goods go to the agent, or the order is closed on the refusal, and
      // either way what the merchant is owed is the news that it landed.
      return { ok: true, result: landed };
    }
    return orderCallResponseOf(applied.answer);
  }
}

/**
 * Why the machine would not take a merchant's call, in words that are true.
 *
 * The contract promises three codes mean one thing each, and the one this used
 * to send for every refusal — "the order reached an ending that no call
 * reopens" — was a lie about four of the five things the machine can say. A
 * merchant walking their own list of open orders and calling deliver on one in
 * the wrong state was told, in a code they are invited to branch on, that a
 * live order was dead.
 *
 * So a closed order says it is closed, and everything else sends the machine's
 * own word for what happened. Those are outside the promised three, which the
 * contract allows for — the set is open — and each carries the state it was in,
 * because "this has no meaning here" is only useful alongside where "here" is.
 */
function refusedCall(rejection: TransitionRejection): OrderCallError {
  const closed = !isOpen(rejection.state);
  return {
    code: closed ? "order_already_closed" : rejection.code,
    message: closed
      ? `this order ended as ${rejection.state}, and ${rejection.event} does not reopen it`
      : `this order is in ${rejection.state}: ${rejection.message}`,
    retryable: rejection.retryable,
  };
}

/**
 * The same message, going out again now.
 *
 * The identifier names the message and does not change when it is delivered
 * again; the instant names this delivery of it and does. A worker tells a
 * repeat from a new message by exactly that pair, and one sent out again with
 * its original stamp would look like the delivery that had already been.
 */
function sentNow(envelope: WorkerEnvelope, at: number): WorkerEnvelope {
  return { ...envelope, sent_at: asTimestamp(at) };
}

/** Zod's account of what is wrong, in the shape the contract publishes. */
function findingsOf(
  issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[],
): PublishError[] {
  return issues.map((issue) => ({
    path: issue.path.map((step) => String(step)),
    code: issue.code,
    message: issue.message,
  }));
}

export { orderDocumentOf };
