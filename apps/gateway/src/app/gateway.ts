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
 * One thing in stage one is narrower than the model and is written here rather
 * than discovered later: every order is a test order, because the separation of
 * the sandbox from the real thing is stage two of the pilot plan and there is
 * nothing yet to tell them apart with.
 */

import {
  type Acceptance,
  type CabinetKey,
  CardSchema,
  type CatalogPage,
  CONTRACT_VERSION,
  type Delivery,
  type DisabledKey,
  deliveryCheckFor,
  type ForgottenCabinetKeys,
  type HandlerAnswer,
  type IssuedKey,
  type MerchantCard,
  type MerchantCardList,
  type MerchantKey,
  type MerchantKeyList,
  type OrderAcceptResponse,
  type OrderCallError,
  type OrderCallResponse,
  type PayoutWallet,
  type PublishError,
  type PublishResult,
  publicCardOf,
  purchaseCheckFor,
  type QuoteAnswerAck,
  type QuoteResponse,
  type ReceiptList,
  type Refusal,
  type RegisteredMerchant,
  type SellerName,
  type WorkerEnvelope,
  type WorkerPollResponse,
} from "@coinslot/contracts";
import type { MerchantSelling, TransitionRejection } from "@coinslot/core";
import { createOrder, fulfillmentDeadline, isOpen, outcomeFor } from "@coinslot/core";
import { asTimestamp } from "../ports/clock.js";
import type { Reminder } from "../ports/queue.js";
import type { KeyPurpose, StoredCard, StoredKey, StoredOrder } from "../ports/store.js";
import { orderCallResponseOf } from "./answers.js";
import {
  invitationAccepted,
  issueCabinetKey,
  issueKey,
  keyDigest,
  registerMerchant,
  setPayoutWallet,
  setServiceName,
} from "./merchants.js";
import { OrderRunner, orderDocumentOf, SWEEP_EFFECTS } from "./runner.js";
import {
  listedUnder,
  modeForCard,
  payableTo,
  policyFor,
  priceCheckOf,
  quoteReachesTheMerchant,
  type Runtime,
  sellableBy,
  sellingFor,
} from "./runtime.js";
import { purchaseOf, Waiting } from "./waiting.js";

/**
 * Stage one sells nothing for real money: the separation of the sandbox from
 * the live network is stage two, so every order is marked as what it is.
 */
const STAGE_ONE_ORDERS_ARE_TESTS = true;

/** The queue's name for the daily sweep of claims on payments. */
export const SWEEP_CLAIMS = "coinslot_forget_old_claims";

/**
 * What the selling switch came to: the catalog as it now stands, or a refusal.
 *
 * A refusal rather than a thrown error, because a merchant who has left
 * pressing "start selling again" is an ordinary thing that happens and the
 * caller has to answer it rather than crash on it.
 */
export type SellingChange =
  | { readonly ok: true; readonly cards: MerchantCardList }
  | { readonly ok: false; readonly why: string };

/**
 * One product as a thing that can be paid for, and everything a challenge for
 * it has to say: the card, whether it may be sold at this moment, the name its
 * seller is listed under, and the address its seller is paid at.
 */
export interface PaidResource {
  /** The card as it is held, under the catalog identifier we issued for it. */
  readonly stored: StoredCard;
  /** What a purchase of this card would meet right now. */
  readonly selling: MerchantSelling;
  /** The seller's name in a discovery catalog, or nothing where none is set. */
  readonly serviceName: string | null;
  /**
   * Where this card's own merchant is paid, or nothing where none is set.
   *
   * It travels with the card because it is the card's merchant's and nobody
   * else's: the address an agent is invited to pay has to belong to the seller
   * of the thing it is buying, and read anywhere but from this card's owner it
   * would be somebody's takings going to somebody else.
   */
  readonly payoutWallet: string | null;
}

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
  /** The payment layer did not vouch for this payment; nothing was touched. */
  | { readonly step: "payment_not_verified"; readonly why: string; readonly retryable: boolean }
  /** This order is somebody else's purchase, and this payment is not its own. */
  | { readonly step: "not_this_purchase" };

export class Gateway {
  readonly runtime: Runtime;
  readonly runner: OrderRunner;
  /** Purchases parked on a price question, by the identifier of the question. */
  readonly quotes = new Waiting<QuoteResponse>();
  /**
   * Which order each open price question belongs to, and whose it is.
   *
   * The merchant is here because the answer route is a merchant's, and a price
   * identifier is not a secret: it travels on a stream and it lands in a
   * receipt. Without the merchant beside it, anybody holding one out of a log
   * could name the price somebody else's purchase settled at.
   */
  readonly #questions = new Map<string, { orderId: string; merchantId: string }>();

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
    // a timer of ours: it survives a restart, and one tick of the schedule puts
    // one job on the queue however many gateways are running, which a timer in
    // each of them would not. Registering the same name replaces what was
    // there, so a restart does not accumulate schedules.
    //
    // What that does not promise is that the job is only ever handled once.
    // Nothing here needs it to be — forgetting claims older than an instant is
    // the same work whoever does it and however often — but the sweep below
    // does, and the paragraph there says why the promise is not available.
    await this.runtime.queue.everyDay(SWEEP_CLAIMS, () => this.forgetOldClaims());

    // And what the orders are still owed, on the same scheduler and for the
    // same reasons (ADR-0013). It asks the orders themselves what is missing
    // rather than keeping a second record of what was meant to happen, and it
    // is written to be safe run twice, because it will be.
    //
    // Twice at once, in fact, and not only one after another. One process
    // cannot do that to itself: there is one worker on this queue and it waits
    // for the handler to return before it fetches again, so however long a run
    // takes, the next one cannot start beside it here. What reaches two at once
    // is two gateways, and the road there is the queue's expiry. A job is
    // active from the moment it is fetched, the library fails an active job
    // once it has been running longer than its expiry — fifteen minutes, on the
    // defaults this job takes — and a failed job with retries left goes back on
    // the queue rather than to a dead letter. The default allows two. So a
    // sweep that runs past fifteen minutes is offered again while it is still
    // going, and the idle worker in the other process takes it.
    //
    // That is not survivable by the argument that covers a second run
    // afterwards: every arm reads the world and then acts on what it read, so
    // two at once both find the same thing missing and both do it. The sweep
    // takes the work under a name for that, and the run that finds the name
    // held does nothing.
    //
    // The lock is in the sweep rather than here on purpose. Registering with a
    // queue policy would leave it to a call whose settings the library writes
    // only when the queue is first made — every database that has already run
    // this would ignore it in silence — and a policy is about jobs on one
    // queue, which is not what two gateways are.
    //
    // A skipped run is logged and nothing else: pg-boss is told the job
    // finished, because it did. Worth knowing when reading those logs, since
    // this is the safety net for effects that went missing — a name wedged
    // permanently would show up as nothing but that line, every day.
    await this.runtime.queue.everyDay(SWEEP_EFFECTS, () => this.runner.sweep());
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

    // A delivery went unanswered. It only counts while it is still the delivery
    // the order is waiting on — the merchant who answered the one he was given
    // must not be sent the order again for a reminder left against it — and it
    // stops being that delivery here, in the same write, because giving up on a
    // hand-over is the last thing that happens to it.
    //
    // Both halves are one call, and the reason is that this is the only place
    // in the gateway where reading the order and acting on what was read are
    // the same decision. Everything that can happen between the two is a change
    // to the very thing being checked. The merchant's answer lands and clears
    // the hand-over, and a redelivery goes out to a merchant who is already
    // working on the order. A worker draws the order and records a hand-over of
    // its own, and a clearing written on top of that takes away the hand-over
    // the order is now waiting on, so the silence on it is noticed by nobody.
    // Another delivery of this same reminder does the whole thing once already,
    // and the second one does it again.
    //
    // That last one is the one the queue produces on its own. Reminders go on
    // it with the library's own retries where envelopes go on with none, so a
    // reminder whose delivery was never completed — the process took it and
    // died, the completion never reached the database — is handed out again
    // carrying the same hand-over. Two envelopes for one silence spend two of
    // the order's deliveries, running out of deliveries closes the order, and
    // closing an order that has been paid for is a debt: the merchant loses a
    // sale he could still have made and owes the money back.
    //
    // What is written is the same fact the three answer routes write when they
    // pass `openDeliveryId: null`, reached from the other side. There the
    // hand-over is over because the merchant answered it; here it is over
    // because we have stopped waiting for him. It does not shut the guard for
    // good: the redelivery this decides on mints a hand-over of its own the
    // moment a worker draws it and arms its own reminder against that one, so
    // the next silence is worth a delivery in its turn.
    await this.runner.apply(
      reminder.orderId,
      { kind: "handler_undelivered", at: this.runtime.clock() },
      { openDeliveryId: null },
      undefined,
      reminder.handOver,
    );
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

  /**
   * Puts one card in the catalog, or says everything standing in its way.
   *
   * The findings are gathered rather than returned at the first one, and two of
   * them are not about the card at all. A merchant who has set no name for
   * buyers to read cannot publish: a card of theirs would be offered for sale
   * through a payment request that names no seller, so the agent reading it is
   * invited to pay somebody the request does not name. That has been shipped
   * from here once, silently. And on a deployment that settles on a real chain,
   * a merchant who has set no wallet cannot publish either, for the same shape
   * of reason one step further along: the money from that card's sales would
   * have nowhere to go, and the gateway has no address of its own to stand in
   * for theirs — the operator's configured address is the operator's, and
   * paying a merchant's sales into it is exactly the custodial arrangement this
   * design refuses.
   *
   * Both refusals come back beside whatever is wrong with the card because the
   * merchant is going to have to fix all of it, and told one at a time they fix
   * the card, publish again, and only then find out about the rest. They lead
   * the list for the same reason: a screen that shows one finding shows the one
   * that is not on the card, which is the one nothing on the card explains.
   */
  async publishCard(merchantId: string, body: unknown): Promise<PublishResult> {
    const parsed = CardSchema.safeParse(body);

    // A merchant the store cannot find is refused along with one who has chosen
    // no name, and for the same reason read the other way: the safe answer to
    // "I cannot say who this is" is that nothing of theirs goes on sale. The
    // door resolved this key to a merchant a moment ago, so it does not happen.
    const merchant = await this.runtime.store.merchantById(merchantId);
    const missing: PublishError[] = [];
    if (merchant === null || !listedUnder(merchant.serviceName)) {
      missing.push(NO_SELLER_NAME);
    }
    // The same question the selling word asks of every card afterwards, put
    // here where the merchant is in front of somebody who can be told: there is
    // nowhere for this product's money to go. The sandbox asks for no address,
    // and that is not leniency — it settles against nothing, so there is no
    // money to send anywhere and no chain to send it on (ADR-0008).
    if (!payableTo(merchant?.payoutWallet ?? null, this.runtime.config)) {
      missing.push(NO_PAYOUT_WALLET);
    }

    if (!parsed.success) {
      return { errors: [...missing, ...findingsOf(parsed.error.issues)] };
    }
    if (missing.length > 0) {
      return { errors: missing };
    }

    const stored = await this.runtime.store.publishCard(
      merchantId,
      parsed.data,
      this.runtime.clock(),
    );
    return { ok: { id: stored.id } };
  }

  /**
   * The catalog an agent reads, which is the cards that are actually for sale.
   *
   * A paused card is left out rather than listed and then refused. A catalog is
   * an offer, and an entry every purchase of which comes back `not_selling` is
   * an offer we would not honour — the agent budgets against it, chooses it
   * over a competitor, and finds out at the till. That is the same reason the
   * portal tells the merchant a pause means their cards stop selling rather
   * than that they stop working.
   */
  async catalog(): Promise<CatalogPage> {
    // One catalog across every merchant, which is the product (ADR-0010). The
    // selling word is read per card because it is per merchant: one merchant
    // stopping all selling takes their own cards out of this and leaves
    // everybody else's exactly where they were.
    const entries = await this.runtime.store.catalogEntries();
    return {
      items: entries
        .filter(
          (entry) =>
            sellingFor(entry.merchant, entry.card, sellableBy(entry, this.runtime.config)) ===
            "open",
        )
        .map((entry) =>
          publicCardOf(entry.card.card, {
            id: entry.card.id,
            as_of: asTimestamp(entry.card.asOf),
          }),
        ),
    };
  }

  /**
   * One product as a thing that can be paid for: the card, the word it is
   * selling under right now, and the name its seller is listed under.
   *
   * It is one read rather than three at the edge because the three answer one
   * question — may this product be offered for sale, and what does a challenge
   * for it say. The selling word is the same fold the order machine is given,
   * so a card this reports as anything but open is a card whose purchase the
   * machine would refuse; a challenge issued for one would be an invitation to
   * pay for something that cannot be bought, and it would be that invitation
   * that a discovery catalog listed.
   *
   * Null where there is no such card. Unscoped, like every other read on the
   * buying surface: an agent has no key and no merchant.
   */
  async paidResource(itemId: string): Promise<PaidResource | null> {
    const stored = await this.runtime.store.cardById(itemId);
    if (stored === null) {
      return null;
    }
    const merchant = await this.runtime.store.merchantById(stored.merchantId);
    return {
      stored,
      // The same fold every other reader of this question gets, and the same
      // one the machine is given: the merchant's word, the card's own pause and
      // whether that merchant could make a sale at all — somewhere to send the
      // money, a name to sell under — become one word. A merchant the store
      // cannot find is a card with no owner, which the database refuses — and if
      // it ever happened, the safe reading of "I cannot say" is that this is not
      // for sale.
      selling:
        merchant === null
          ? "paused"
          : sellingFor(merchant.selling, stored, sellableBy(merchant, this.runtime.config)),
      serviceName: merchant?.serviceName ?? null,
      payoutWallet: merchant?.payoutWallet ?? null,
    };
  }

  // --- the merchant's own catalog -------------------------------------------

  /**
   * Every card this merchant published, with the word each is selling under.
   *
   * "This merchant" is the merchant the key on the call resolved to, and the
   * scoping is the store's — the query carries the merchant, so another
   * merchant's card is never selected rather than selected and dropped.
   */
  async merchantCards(merchantId: string): Promise<MerchantCardList> {
    const { selling, sellable } = await this.#howTheySell(merchantId);
    const cards = await this.runtime.store.cards(merchantId);
    return { selling, cards: cards.map((stored) => merchantCardOf(stored, selling, sellable)) };
  }

  /**
   * The two facts every card of one merchant is read through: the word they
   * sell under, and whether a sale of theirs could be made at all — paid for,
   * and made under a name.
   *
   * One read rather than two, and a merchant the store cannot find is a defect
   * rather than a case — every key names a merchant that exists and every card
   * carries one — so this throws exactly as the store's own read of the word
   * does. Answering "open" would be selling on behalf of somebody nobody can
   * find.
   */
  async #howTheySell(
    merchantId: string,
  ): Promise<{ readonly selling: MerchantSelling; readonly sellable: boolean }> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(`there is no merchant ${merchantId}, so there is no word for their selling`);
    }
    return {
      selling: merchant.selling,
      sellable: sellableBy(merchant, this.runtime.config),
    };
  }

  /**
   * Takes one card off sale, or puts it back. Null where there is no such card.
   *
   * Nothing about the orders already open is touched, and that is the whole
   * shape of a pause: the guard the machine keeps is at the birth of an order
   * and nowhere else, so an order accepted a minute ago plays out exactly as it
   * would have.
   */
  async setCardPaused(
    merchantId: string,
    itemId: string,
    paused: boolean,
  ): Promise<MerchantCard | null> {
    const stored = await this.runtime.store.setCardPaused(merchantId, itemId, paused);
    if (stored === null) {
      // Either there is no such card or it is not this merchant's, and the
      // answer is the same one on purpose: a pause call is not a way of
      // finding out what somebody else is selling.
      return null;
    }
    const { selling, sellable } = await this.#howTheySell(merchantId);
    return merchantCardOf(stored, selling, sellable);
  }

  /**
   * Stops all selling for this merchant, or starts it again.
   *
   * Resuming does not put back the cards that were paused in their own right.
   * Stopping everything did not forget which those were, and putting them all
   * on sale would sell products their merchant took off — the answer carries
   * the whole catalog so which cards actually came back is a fact rather than
   * something to infer.
   */
  async setSelling(merchantId: string, selling: MerchantSelling): Promise<SellingChange> {
    const now = await this.runtime.store.selling(merchantId);
    if (now === "departed") {
      // A departure is not a heavier pause and this switch does not undo one.
      // Leaving closed the orders that were open and left the merchant owing
      // refunds on whatever was paid for and not delivered; setting the word
      // back to "open" here would put a merchant who has left back in the
      // catalog with none of that unwound, and the only sign of it would be
      // sales arriving again. The contract's own documents argue that leaving
      // cannot be reached by this switch; this is the same rule in the other
      // direction, which is the half that was missing.
      return { ok: false, why: "this merchant has left, and selling is not resumed by a switch" };
    }
    await this.runtime.store.setSelling(merchantId, selling);
    return { ok: true, cards: await this.merchantCards(merchantId) };
  }

  /**
   * Every receipt this merchant has, and nobody else's.
   *
   * Scoped the way `merchantCards` is and by the same means: the merchant is in
   * the query, so a receipt of somebody else's is never read at all.
   */
  async receipts(merchantId: string): Promise<ReceiptList> {
    return { receipts: [...(await this.runtime.store.receipts(merchantId))] };
  }

  // --- merchants and their keys ---------------------------------------------

  /**
   * Registers a merchant: the merchant and their cabinet's key, in one act. Null
   * where the invitation is not the one this gateway holds, or where it holds
   * none.
   *
   * The two refusals are one value on purpose. Registration being closed is a
   * fact about this deployment rather than about the caller, and the route above
   * answers both in the same words and the same status — otherwise the form is
   * a way of asking whether registration is open here, which is what the code in
   * the door exists to stop being findable (ADR-0014 §3).
   *
   * What comes back names no seller, because nobody has chosen one. The merchant
   * is listed under nothing until they set a name, and until then publishing is
   * refused — so the caller's next screen is the one that asks for it.
   */
  async registerMerchant(invitation: string): Promise<RegisteredMerchant | null> {
    if (!invitationAccepted(this.runtime.config.registrationInvitation, invitation)) {
      return null;
    }

    const registered = await registerMerchant(
      this.runtime.store,
      this.runtime.ids,
      this.runtime.clock(),
    );

    if (registered === null) {
      // The identifier is generated with the same source every other one of ours
      // comes from, so this is a collision rather than somebody registering
      // twice, and there is nothing a caller could do about it.
      throw new Error(
        "registering made no merchant: the identifier it generated was already taken",
      );
    }

    // The key's own row stays here. It is a cabinet's, which is in no list and
    // is not disabled through the merchant's calls, so an identifier for it is
    // a value with nothing to do — and the caller already holds the one thing
    // it needs, which is the key.
    const { merchant, secret } = registered;
    return { merchant_id: merchant.id, secret };
  }

  /**
   * What this merchant's products are sold under, as it stands.
   *
   * A merchant who has chosen no name is answered with null rather than with a
   * refusal: having none is an ordinary state a settings screen has to draw.
   * The merchant not being there at all is a different matter — every caller of
   * this is behind the merchant's key, which the door resolved to a merchant a
   * moment ago, so a merchant missing here is this gateway disagreeing with
   * itself rather than anything the caller did.
   */
  async sellerName(merchantId: string): Promise<SellerName> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(
        `the key on this call resolved to ${merchantId}, and there is no such merchant`,
      );
    }
    return { seller_name: merchant.serviceName };
  }

  /**
   * Sets what this merchant's products are sold under.
   *
   * There is no taking one away here, and that is the contract's rule rather
   * than this method's: what arrives is a name, because a merchant with no name
   * has nobody for a payment request to name as the seller and every card of
   * theirs comes off sale — an end to their selling arriving under the name of
   * editing a setting. The flow underneath still writes a null, because the
   * terminal has a verb for it and somebody with the whole database in front of
   * them is a different caller from a merchant with one key.
   *
   * The name is checked before it is written, by the one function that checks
   * it — a name the catalog cannot carry is dropped there in silence, so the
   * refusal has to happen at the moment somebody can still be told. The route
   * above holds the same rule on the way in, so a throw from here is a caller
   * that skipped it rather than a merchant with a bad name.
   *
   * What comes back is read off the row that was written, not off the argument.
   * Echoed, this answer would look identical whether the write landed or not.
   */
  async setSellerName(merchantId: string, sellerName: string): Promise<SellerName> {
    const named = await setServiceName(
      this.runtime.store,
      merchantId,
      sellerName,
      this.runtime.clock(),
    );
    if (named === null) {
      throw new Error(
        `the key on this call resolved to ${merchantId}, and there is no such merchant`,
      );
    }
    return { seller_name: named.serviceName };
  }

  /**
   * Where this merchant's sales are paid, as it stands.
   *
   * Null for a merchant who has set nothing, exactly as the listing name is
   * null: having none is an ordinary state a settings screen has to draw, and
   * on a deployment with a chain behind it, it is also the state that explains
   * why nothing of theirs can be published.
   */
  async payoutWallet(merchantId: string): Promise<PayoutWallet> {
    const merchant = await this.runtime.store.merchantById(merchantId);
    if (merchant === null) {
      throw new Error(
        `the key on this call resolved to ${merchantId}, and there is no such merchant`,
      );
    }
    return { payout_wallet: merchant.payoutWallet };
  }

  /**
   * Sets where this merchant's sales are paid.
   *
   * There is no taking one away, and unlike the listing name there is no verb
   * at a terminal for it either: the address is what a payment request is
   * written around, so a merchant without one has cards on sale that cannot be
   * offered at all, and there is no caller for whom that is the right outcome.
   *
   * The address is checked and written out in the one spelling anything here
   * holds — the mixed-case one a wallet shows — by the one function that does
   * both. The route above holds the same rule on the way in, so a throw from
   * here is a caller that skipped it.
   *
   * That is the opposite spelling from the one a payer's wallet is kept in a
   * few hundred lines below, and the two are not in conflict. A payer's address
   * arrives from a facilitator and is only ever compared, so it is lowered to
   * make two spellings one identity; this one is read by a person off a screen,
   * so it is kept in the form they can recognise.
   *
   * What comes back is read off the row that was written. Echoed, this answer
   * would look identical whether the write landed or not — which for the one
   * field in this system that money is sent to is not a difference to leave to
   * chance.
   */
  async setPayoutWallet(merchantId: string, wallet: string): Promise<PayoutWallet> {
    const paid = await setPayoutWallet(
      this.runtime.store,
      merchantId,
      wallet,
      this.runtime.clock(),
    );
    if (paid === null) {
      throw new Error(
        `the key on this call resolved to ${merchantId}, and there is no such merchant`,
      );
    }
    return { payout_wallet: paid.payoutWallet };
  }

  /**
   * The keys this merchant made for their own code, and the one the call was
   * made with.
   *
   * The keys a cabinet holds are not in the list, and the read that leaves them
   * out is the store's rather than a filter here: a merchant's list is a place
   * they act, and a row they did not make and cannot revoke does not belong on
   * it.
   *
   * So `this_call` is not always one of the keys beside it — a cabinet calls
   * with a key of its own — and it is answered all the same, because the field
   * means the same thing on every call: which key opened this one. The caller's
   * own key travels through rather than being looked up again: the door
   * resolved it a moment ago, and a second lookup would be a second chance for
   * the two to disagree about which key opened this call.
   */
  async merchantKeys(merchantId: string, thisCall: string): Promise<MerchantKeyList> {
    const keys = await this.runtime.store.codeKeysOf(merchantId);
    return { keys: keys.map(merchantKeyOf), this_call: thisCall };
  }

  /** Issues another key for this merchant's own code, and hands it back once. */
  async issueMerchantKey(merchantId: string, label: string): Promise<IssuedKey> {
    const issued = await issueKey(
      this.runtime.store,
      this.runtime.ids,
      merchantId,
      label,
      this.runtime.clock(),
    );
    return { key: merchantKeyOf(issued.key), secret: issued.secret };
  }

  /**
   * Makes a key for a cabinet to go on calling as this merchant with, and hands
   * it back once. Refused to anything but a cabinet's own key.
   *
   * The refusal is here rather than at the route because it is a judgement
   * about who may make this call rather than a status code, and it is a word
   * rather than a thrown error because the route has to answer it in the
   * contract's own envelope.
   *
   * What it protects is not this call — a key one merchant made for their own
   * code could ask for a cabinet key of their own merchant and gain nothing
   * they did not already have. It is the pair: the sweep beside this one is
   * reachable with whatever key reaches this one, and made with a key of the
   * merchant's own it would take away the credential a cabinet is signed in on.
   * One door for the two of them is a door somebody can reason about.
   */
  async issueCabinetKey(
    merchantId: string,
    madeWith: KeyPurpose,
  ): Promise<CabinetKey | "not_a_cabinet_key"> {
    if (madeWith !== "cabinet") {
      return "not_a_cabinet_key";
    }
    const issued = await issueCabinetKey(
      this.runtime.store,
      this.runtime.ids,
      merchantId,
      this.runtime.clock(),
    );
    return { secret: issued.secret };
  }

  /**
   * Removes every key this merchant has for a cabinet except the one this call
   * was made with. Refused to anything but a cabinet's own key.
   *
   * The refusal is the reason the call is safe at all. Made with a key of the
   * merchant's own code, "all but mine" would name no cabinet key at all — so
   * every one of them would go, and whoever is signed into a cabinet would be
   * holding a credential the gateway no longer knows.
   *
   * There is no parameter and there is nothing to choose. "All but the key on
   * this call" is the one shape that cannot take away the credential its own
   * caller is holding, and it strands nothing: "the one before mine" would
   * leave whichever of two simultaneous sign-ins lost the race alive for good,
   * with nobody left who could remove it. What it does not do is keep two
   * sign-ins alive at once — the second sweep removes the first sweeper's key —
   * which is right because the key hangs on the account rather than on the
   * session (ADR-0014 §2), so one live key serves every page of that account.
   */
  async forgetCabinetKeys(
    merchantId: string,
    thisCall: string,
    madeWith: KeyPurpose,
  ): Promise<ForgottenCabinetKeys | "not_a_cabinet_key"> {
    if (madeWith !== "cabinet") {
      return "not_a_cabinet_key";
    }
    return { removed: await this.runtime.store.forgetCabinetKeysOf(merchantId, thisCall) };
  }

  /**
   * Stops one of this merchant's keys working.
   *
   * Four answers, and three of them are refusals with different shapes because
   * they are different facts. `locked_out` is the key this very call was made
   * with: whoever holds it would be left calling with something the gateway no
   * longer takes (ADR-0014 §5), so it is refused before anything is read, which
   * also means it can never half-happen — and it is asked first for that reason
   * rather than for any other, since every answer below it costs a write or a
   * read. `made_for_a_cabinet` is a key of theirs they did not issue: a
   * merchant switches off what they made, and this one is a cabinet's way in.
   * `null` is every other key that is not this merchant's to disable — one that
   * does not exist and one belonging to somebody else, told apart nowhere, so a
   * refusal is not a way of counting another merchant's keys.
   *
   * How far these refusals reach is worth stating. A merchant with two keys
   * they issued can still disable either with the other, and two calls made at
   * the same moment with two such keys, each naming the other, both pass the
   * first line and leave the merchant with none of their own. That is not
   * refused here and is not refused anywhere else: widening it would mean
   * refusing a merchant their own last working key, which takes something away
   * from them and is a decision rather than a fix; §5 of ADR-0014 says as much
   * and says nobody has taken it. What it costs them is their own code going
   * quiet, and not the way back in — their cabinet signs in on a key of a kind
   * this call does not touch, and issuing another is a page away.
   */
  async disableMerchantKey(
    merchantId: string,
    keyId: string,
    thisCall: string,
  ): Promise<DisabledKey | "locked_out" | "made_for_a_cabinet" | null> {
    if (keyId === thisCall) {
      return "locked_out";
    }
    const disabled = await this.runtime.store.disableKeyOf(merchantId, keyId, this.runtime.clock());
    return typeof disabled === "string" || disabled === null
      ? disabled
      : { key: merchantKeyOf(disabled) };
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
    const theirs = await this.#howTheySell(stored.merchantId);
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
      // One word out of the two switches a merchant has — the whole catalog and
      // this card — and out of whether that merchant could make a sale at all:
      // an address for the money, a name to sell under. Whichever of them it
      // is, the machine hears the same word and refuses the same way, before an
      // order exists: the orders already accepted are untouched, and none is
      // opened that could never be paid or never be described. Whose word it is
      // comes off the card: a buyer walks one catalog across every merchant,
      // and what governs this sale is the card's own merchant.
      selling: sellingFor(theirs.selling, stored, theirs.sellable),
    });

    if (!created.ok) {
      return { step: "not_selling", message: created.rejection.message };
    }

    const record: StoredOrder = {
      order: created.order,
      // The sale belongs to whoever published the card it was made against, and
      // it is settled here and never again: this is what puts the order on that
      // merchant's stream and what every later read of it is checked against.
      merchantId: stored.merchantId,
      itemId: stored.id,
      merchantItemId: stored.card.merchant_item_id,
      params: { ...params },
      priceId: null,
      delivery: null,
      payment: null,
      // Nothing has been verified yet, so there is no address this order's money
      // was promised to. It arrives with the payment and not before: a challenge
      // is an invitation, and the merchant may still move their wallet between
      // this moment and the one an agent pays in.
      payTo: null,
      paidBy: null,
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
  ): Promise<PurchaseAttempt> {
    const before = await this.runtime.store.orderById(orderId);
    if (before === null) {
      return { step: "no_such_item" };
    }

    const price = before.order.price;
    if (price === null) {
      // A payment for an order that was never priced. The agent is only ever
      // given a challenge for a priced order, so this is a payment for the
      // wrong order or one built without one; there is nothing to check it
      // against.
      return {
        step: "payment_not_verified",
        why: "this order has no price for a payment to be checked against",
        retryable: false,
      };
    }

    // The payment layer is asked whether this payment is good, and this happens
    // before any lock is taken: it is a network round-trip and must not hold a
    // row. Only a payment it vouches for goes any further — a payment that does
    // not check out closes nothing and claims nothing, so a stranger's junk
    // cannot spend the life of an order somebody else was issued a challenge
    // for. The order stays open and ends on its own deadline; the agent is told
    // what the layer said and may present a better payment while the quote
    // still stands.
    // Where this order's own merchant is paid, read once, here. What the
    // payment is checked against has to be this merchant's address and nobody
    // else's — a payment made out to anything else is not a payment for this
    // sale, whatever else is right about it — and the same string is then kept
    // on the order for the charge, so the money goes where the payer signed for
    // it to go rather than wherever the merchant's wallet has got to by then.
    const payTo = (await this.runtime.store.merchantById(before.merchantId))?.payoutWallet ?? null;

    const verified = await this.runtime.facilitator.verify({
      orderId,
      amount: price.amount,
      currency: price.currency,
      payment,
      payTo,
    });

    if (verified.verified !== true) {
      // Both ways a verification can fail carry their own message, and the
      // agent is told it whichever it was. What the two are told apart by is
      // the retryable flag below, not by the words.
      const why = verified.message;
      console.warn(`[gateway] a payment for ${orderId} did not verify: ${why}`);
      return {
        step: "payment_not_verified",
        why,
        // "unknown" is nobody having said no: the layer did not answer, or
        // could not be asked at all because something on our side of the call
        // was missing. Trying again may reach it, and the words say which of
        // the two it was. "false" is the layer saying no — the same payment
        // will not pass, though the order is still open for a corrected one.
        retryable: verified.verified === "unknown",
      };
    }

    // The owner is who the payment layer says paid, never the address the
    // payment declares of itself: a declared address that did not sign does not
    // verify. Where the layer vouches for a payment without naming a payer, the
    // payment's own fingerprint stands in — it is derived from what was signed,
    // so it is no more forgeable.
    const owner = walletThatPaid(verified.payer) ?? fingerprint;

    // One authorisation buys one order. This is a different guard from
    // ownership: it stops the same payment being spent on two different orders,
    // which owning-by-payer cannot, because the same wallet would own both. It
    // comes after verification, so a payment that never checked out never burns
    // a claim against the order it named.
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

    // The park, keyed on the order and its owner. In the synchronous mode the
    // goods reach the agent through this and nowhere else. Two different buyers
    // racing one order carry two owners and park on two keys, so neither takes
    // the other's goods; the same buyer's two concurrent calls share one key
    // and both are woken. The wait is what is left of the promised ceiling,
    // counted from the purchase itself, and never longer.
    const key = purchaseOf(orderId, owner);
    const waits = before.order.mode.settle === "after_fulfillment";
    const spent = this.runtime.clock() - before.order.timestamps.createdAt;
    const left = Math.max(this.runtime.config.deadlines.syncBudgetMs - spent, 0);
    const parked = waits ? this.runner.purchases.wait(key, left) : null;

    // The ownership decision and the state change, both inside the order's lock.
    const taken = await this.runner.presentVerifiedPayment(
      orderId,
      owner,
      payment,
      payTo,
      this.runtime.clock(),
    );

    // Both of these turned the payment away before it spent anything, so the
    // claim taken a moment ago goes back. Held, it would bind a live
    // authorisation to an order that can never accept it, and the buyer who
    // lost the race would be told their next attempt was already spent — on
    // somebody else's order. `refused` is deliberately not here: its causes
    // want reading one at a time, and some of them have moved money.
    if (taken.kind === "no_such_order") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      return { step: "no_such_item" };
    }
    if (taken.kind === "not_owner") {
      this.runner.purchases.giveUp(key);
      await this.runtime.store.releaseClaim(fingerprint, orderId);
      return { step: "not_this_purchase" };
    }
    if (taken.kind === "refused") {
      this.runner.purchases.giveUp(key);
      return {
        step: "payment_not_taken",
        why: taken.rejection.message,
        retryable: taken.rejection.retryable,
      };
    }

    // Took it, or it was already the owner's: the goods, if any, come through
    // the park.
    if (parked !== null) {
      const settled = await this.runtime.store.orderById(orderId);
      if (settled !== null && outcomeFor(settled.order) !== "in_progress") {
        // It is already answered — an order that was over before this payment
        // arrived, for instance. There is nothing left to wait for.
        this.runner.purchases.giveUp(key);
      }
      await parked;
    }

    return this.#wherePurchaseStands(orderId);
  }

  /**
   * One order, whoever it belongs to — the buying surface's read.
   *
   * Two routes use it and neither takes a key, for two different reasons. On
   * the purchase the payment presented against the order stands in for one; on
   * the agent's own read of what became of that purchase the order's identifier
   * does (ADR-0011). Both callers are the buyer's side, which has no merchant
   * to be scoped to — an agent walking one catalogue is not shopping inside a
   * tenant. What keeps the second from becoming a way of reading across the
   * merchants is the shape of what it answers with, not this read.
   *
   * A merchant's own read of one order is {@link merchantOrder}, which is
   * scoped, and a merchant asking about a stranger's order is told there is no
   * such order.
   */
  async orderById(orderId: string): Promise<StoredOrder | null> {
    return this.runtime.store.orderById(orderId);
  }

  /** One of this merchant's orders. Another merchant's is not found. */
  async merchantOrder(merchantId: string, orderId: string): Promise<StoredOrder | null> {
    return this.runtime.store.merchantOrder(merchantId, orderId);
  }

  /**
   * Which key a request presented, or nothing at all.
   *
   * The lookup is by the digest of what was presented, so nothing here compares
   * one secret against another and the time it takes says nothing about how
   * much of a key was right. A key nobody was ever issued and a key that has
   * been disabled come back identically, which is the store's promise and not
   * this line's.
   *
   * The whole row and not the merchant alone, because the door is the only place
   * that knows which key opened a call, and one route needs that: a merchant
   * cannot disable the key they are holding.
   */
  async keyBehind(presented: string): Promise<StoredKey | null> {
    return this.runtime.store.workingKey(keyDigest(presented));
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
  async poll(merchantId: string, max: number, waitMs: number): Promise<WorkerPollResponse> {
    const { config, queue, clock } = this.runtime;
    const drawn = await queue.draw(
      merchantId,
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
      // A token for this hand-over, and neither of the two names already in
      // hand would do. The envelope's identifier names this envelope, and a
      // redelivery is built as a fresh one, so it does not last long enough to
      // be matched against. The order's identifier does last, and is the same
      // for every attempt, so it cannot tell one hand-over from another. That
      // distinction is exactly what the reminder needs — whether the delivery
      // it was armed for is still the one the order is waiting on — so it is
      // minted per hand-over and stored as `openDeliveryId`.
      const handOver = this.runtime.ids("dlv");
      let applied: Awaited<ReturnType<OrderRunner["apply"]>>;
      try {
        applied = await this.runner.apply(
          orderId,
          { kind: "order_dispatched", at },
          { openDeliveryId: handOver },
          // The envelope came off this merchant's own stream and an envelope
          // only ever reaches the stream of the merchant on its own order, so
          // this cannot fire today: no test dies when it is taken out, and that
          // is the honest state of it rather than a gap in the tests.
          //
          // It stays because of what it guards against and what that would
          // cost. If the two ever came apart — one shared stream, a document
          // and a column that disagree — a hand-over would be recorded against
          // a stranger's order and the order then handed to the wrong merchant
          // to work on. With this, the envelope is finished and nobody is given
          // the order, which is also wrong but is the smaller of the two and is
          // the one a merchant notices.
          { merchantId },
        );
      } catch (thrown) {
        // Recording this one hand-over failed. The rest of the batch is not
        // taken down with it — an envelope already in this answer would
        // otherwise be drawn, discarded with the failed response, and never
        // seen again — and this one goes back on the stream rather than being
        // lost with it.
        console.error(`[gateway] could not record the hand-over of ${orderId}`, thrown);
        await queue.publish(
          merchantId,
          sentNow(delivery.envelope, at),
          config.settleInFlightRetryMs,
        );
        finished.push(delivery.handle);
        continue;
      }

      if (applied.outcome === "refused" && applied.rejection.retryable) {
        // The machine will take this hand-over, just not yet — a charge on this
        // order is being executed and it will not answer anything else until it
        // reports. The order goes back on the stream rather than being dropped,
        // because dropping it is how an order that was paid for never reaches a
        // merchant at all.
        await queue.publish(
          merchantId,
          sentNow(delivery.envelope, at),
          config.settleInFlightRetryMs,
        );
        finished.push(delivery.handle);
        continue;
      }

      if (applied.outcome !== "moved") {
        if (applied.outcome === "no_such_order") {
          // Orders are never deleted, so inside this loop that answer has one
          // meaning: the scope above refused an envelope whose order is not
          // this merchant's. It cannot happen while an envelope only ever
          // reaches the stream of the merchant on its own order — which is why
          // it is said out loud rather than counted as an ordinary ending. A
          // silence here is the one way the belt could catch something and
          // nobody find out.
          console.error(
            `[gateway] ${merchantId} drew an envelope for ${orderId}, which is not their order`,
          );
        }
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
      await queue.finish(merchantId, handle);
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
  async answerQuote(
    merchantId: string,
    priceId: string,
    response: QuoteResponse,
  ): Promise<QuoteAnswerAck> {
    const asked = this.#questions.get(priceId);
    // A question this merchant was not the one asked is answered exactly as a
    // question we no longer hold — a worker replaying an envelope from an hour
    // ago, or one already answered. It priced nothing, and the answer says
    // nothing about whether the identifier names a live sale of somebody
    // else's.
    if (asked === undefined || asked.merchantId !== merchantId) {
      return { used: false };
    }

    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      asked.orderId,
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
      { merchantId },
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

  /**
   * What the merchant's handler returned for an order it was given.
   *
   * Every one of the four routes below names the merchant whose key opened the
   * call, and hands it to the store as the scope of the hold on the order. An
   * order belonging to somebody else is not found — the same answer an order
   * that never existed gets — so a merchant holding an identifier out of a log
   * cannot deliver, refuse or accept a stranger's sale, and learns nothing from
   * trying.
   */
  async answerOrder(
    merchantId: string,
    orderId: string,
    answer: HandlerAnswer,
  ): Promise<OrderCallResponse | null> {
    if ("delivered" in answer) {
      return this.deliverOrder(merchantId, orderId, answer.delivered, "handler");
    }
    if ("refused" in answer) {
      return this.refuseOrder(merchantId, orderId, answer.refused, "handler");
    }

    return this.#takeOrderOn(merchantId, orderId, answer.accepted);
  }

  /**
   * The goods, held to the card that sold them before anything is written down.
   *
   * The check is here rather than in the machine because it is a fact about a
   * card and the machine knows nothing about cards — it decides what a delivery
   * does to an order, not whether these are the goods. And it is before the
   * interpreter rather than inside it because the answer to a delivery that
   * does not fit is that nothing happened: no goods on the order, no receipt,
   * no instant moved, and the delivery still open with the merchant so his own
   * clock and our redelivery are unchanged. That is the same shape as an event
   * the machine refuses, arrived at one step earlier.
   */
  async deliverOrder(
    merchantId: string,
    orderId: string,
    delivery: Delivery,
    from: "handler" | "call" = "call",
  ): Promise<OrderCallResponse | null> {
    // Read before the check, so that an order that is not this merchant's is
    // answered exactly as one that never existed — the same silence every other
    // call of his gets, and one that tells him nothing about a stranger's sale.
    const record = await this.runtime.store.merchantOrder(merchantId, orderId);
    if (record === null) {
      return null;
    }

    // Goods are weighed against the card only where they could actually be
    // written, and that is the one condition the interpreter uses for the same
    // fact: this order does not carry goods yet. A repeat is not weighed at
    // all, and the reason is what a refusal would tell the merchant. The
    // answer to a repeat is that the order already has its goods and nothing
    // was done — true whatever the repeat carried — while a refusal is marked
    // as worth calling again, which on a delivered order is an invitation to
    // loop on a call that can never take anything. Delivery is at least once
    // by design, so repeats are ordinary rather than a sign of trouble, and
    // making one of them fail would turn a merchant's safe retry into a
    // failure branch on a sale that went through.
    const misfit =
      record.delivery === null ? await this.#goodsAgainstTheCard(record, delivery) : null;
    if (misfit !== null) {
      return { ok: false, error: misfit };
    }

    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      from === "handler" ? { kind: "handler_delivered", at } : { kind: "deliver_called", at },
      { delivery, openDeliveryId: null },
      { merchantId },
    );
    return this.#answerFor(applied, "delivered");
  }

  async refuseOrder(
    merchantId: string,
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
      { merchantId },
    );
    return this.#answerFor(applied, "refused");
  }

  /**
   * Takes an order on, through the route written for it. Its answer is the
   * same one the answer route gives with the word taken out, because the shape
   * this route publishes has nowhere to put a word.
   *
   * That is thinner than it looks and is worth knowing rather than discovering.
   * The word is not always `accepted`: an acceptance of an order already
   * delivered is answered `already_delivered`, and a merchant who called this
   * route rather than answering his handler does not hear it. He is not told
   * anything untrue — a bare success is what this route promises — but he is
   * told less, and widening the shape is a change to a published document
   * rather than something to do here.
   */
  async acceptOrder(
    merchantId: string,
    orderId: string,
    acceptance: Acceptance,
  ): Promise<OrderAcceptResponse | null> {
    const taken = await this.#takeOrderOn(merchantId, orderId, acceptance);
    return taken === null || !taken.ok ? taken : { ok: true };
  }

  /**
   * Taking an order on, once, for both the routes that do it.
   *
   * The full answer with the word in it, because the caller that needs it is
   * the one that cannot say anything else: the SDK posts every handler answer
   * to the answer route without the merchant asking and reports anything short
   * of a success to him, so an acceptance that came back as a failure wrote a
   * problem into his log for every asynchronous order that went through.
   */
  async #takeOrderOn(
    merchantId: string,
    orderId: string,
    _acceptance: Acceptance,
  ): Promise<OrderCallResponse | null> {
    // The expected time to deliver is the merchant's estimate and not a
    // commitment: what he is held to is the deadline on his card, which the
    // order already carries. Writing his guess down beside it would put two
    // numbers next to each other where only one is enforced.
    const at = this.runtime.clock();
    const applied = await this.runner.apply(
      orderId,
      { kind: "handler_accepted", at },
      { openDeliveryId: null },
      { merchantId },
    );

    return this.#answerFor(applied, "accepted");
  }

  /** This merchant's orders, or with `open` only the ones still owed work or money. */
  async orders(merchantId: string, open: boolean | undefined): Promise<readonly StoredOrder[]> {
    return this.runtime.store.orders(merchantId, open === undefined ? undefined : { open });
  }

  // --- the parts the flows above lean on ------------------------------------

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
    this.#questions.set(priceId, { orderId, merchantId: record.merchantId });
    const parked = this.quotes.wait(priceId, config.deadlines.quoteResponseMs);

    await queue.publish(record.merchantId, {
      kind: "quote_request",
      id: ids("env"),
      sent_at: asTimestamp(askedAt),
      payload: {
        merchant_item_id: stored.card.merchant_item_id,
        params: { ...record.params },
        price_id: priceId,
        purpose: "purchase",
        // Until when the price the merchant names will be honoured, which is
        // what this field means to the merchant holding stock against it — not
        // how long we are prepared to wait for the answer. The two are
        // different numbers and the second is much the shorter, so sending it
        // here told a merchant to release a unit while the gateway was still
        // selling at that price.
        //
        // It cannot be exact at the moment of asking, because the price's own
        // life starts when the answer lands and nobody knows yet when that will
        // be. So this is the upper bound: an answer later than our patience is
        // refused outright, so the price can never be alive past that patience
        // plus its own life. Long is the safe direction — a merchant holds
        // stock a little longer than needed; short is the direction that
        // oversells.
        expires_at: asTimestamp(
          askedAt + config.deadlines.quoteResponseMs + config.deadlines.quoteTtlMs,
        ),
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
   * What is wrong with these goods against this order's card, or null where
   * nothing is.
   *
   * The card is read by the order's own catalog identifier, which is what the
   * order carries. There is a window in that, it runs both ways, and both are
   * written down here rather than left to be discovered.
   *
   * A merchant may republish under the same key while an order of his is still
   * in flight — the catalog keeps one version per key and republishing
   * overwrites it — and the goods are then held to the card as it now stands
   * rather than to the one the agent read before it paid. One way, a result
   * loosened after the sale lets through goods the agent was not promised. The
   * other way is the expensive one: for an order already paid for under the
   * old card, delivering exactly what the agent read is refused, the merchant
   * cannot close that sale at all, and it runs to its deadline and becomes a
   * refund. Nothing here can tell the two apart, because nothing anywhere
   * remembers what the older card said.
   *
   * So this is narrower than it should be rather than merely imperfect, and
   * what it wants is versioned cards — an order naming the version it was sold
   * under, and that version still being readable. That is a change to the
   * catalog and not to this check, and it is somebody's decision to take.
   * Until then: every case this gets wrong needs the merchant to have
   * republished mid-sale, and every case it gets right is one the gateway used
   * not to look at at all.
   */
  async #goodsAgainstTheCard(
    record: StoredOrder,
    delivery: Delivery,
  ): Promise<OrderCallError | null> {
    const stored = await this.runtime.store.cardById(record.itemId);
    if (stored === null) {
      // Our own catalog has lost the card an order of ours was made against.
      // Nothing removes a card, so this cannot be reached by anything a
      // merchant does; if it ever is, the honest thing is to stop rather than
      // to wave through goods nothing can be compared with.
      throw new Error(
        `the order ${record.order.id} was sold against ${record.itemId}, and there is no such card to hold its goods to`,
      );
    }

    const fit = deliveryCheckFor(stored.card).safeParse(delivery);
    if (fit.success) {
      return null;
    }

    const goods = `these goods are not what the card "${cutShort(stored.card.merchant_item_id)}" declares it delivers, so nothing was written down`;
    const misfits = misfitsIn(findingsOf(fit.error.issues));

    // Two facts are true of a misfit delivery to an order whose ending has
    // already come, and only one of them was being said. "Nothing was written
    // down and this order still stands where it did" is literally true — the
    // call moved nothing — and reads as "the sale is still yours"; marked
    // retryable beside it, it is an instruction to fix the handler and send
    // again. There is nothing to send it to. He would find out on the next
    // call, having made the goods twice.
    //
    // So a closed order says it is closed, in the same words `refusedCall`
    // uses for the machine's own refusals, and the fields that did not fit are
    // still named: what he sent is his to know either way, and it is the
    // ending rather than the misfit that decides what he can do next.
    if (!isOpen(record.order.state)) {
      return {
        code: "delivery_does_not_match_card",
        message: `${goods} — and this order ended as ${record.order.state}, so there is nothing left to deliver against — ${misfits}`,
        retryable: false,
      };
    }

    return {
      code: "delivery_does_not_match_card",
      message: `${goods} and this order still stands where it did — ${misfits}`,
      // He can fix his handler and deliver again; the order is his to finish
      // until its own deadline says otherwise. The alternative — closing the
      // order on the merchant's behalf — would end a sale he could still make,
      // and would do it on the strength of one bad call.
      retryable: true,
    };
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
   * answer is that his own answer landed — and which word that is depends on
   * what he answered, not on what the machine happened to do next. A refusal
   * answered with "delivered" because the machine went quiet would be a receipt
   * for goods that do not exist.
   *
   * The machine is quiet wherever it settles the order itself and has nothing
   * left to add — a handler's own delivery or refusal is the common case, and
   * an acceptance of an order already owed a refund is another. What the
   * merchant is owed then is the news that his answer landed, in his own word
   * for it.
   */
  #answerFor(
    applied: Awaited<ReturnType<OrderRunner["apply"]>>,
    landed: "delivered" | "refused" | "accepted",
  ): OrderCallResponse | null {
    if (applied.outcome === "no_such_order") {
      return null;
    }
    if (applied.outcome === "refused") {
      return { ok: false, error: refusedCall(applied.rejection) };
    }
    if (applied.outcome === "moved_on") {
      // Only a caller that held the order to a hand-over is ever told this, and
      // that is the reminder rather than any of the merchant's calls. Reaching
      // it means somebody added a hand-over to one of those calls and left the
      // merchant's answer to be worked out here; saying so is cheaper than
      // guessing a word for him.
      throw new Error(
        `a merchant's ${landed} was held to a hand-over, and there is no answer written for an order that moved on`,
      );
    }
    if (applied.answer === null) {
      // The machine took the event and had nothing to say back about it.
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
 * One wallet in one spelling, or nobody.
 *
 * Every facilitator's answer about who paid passes through here, and none of
 * them promises a canonical address. The official exact-EVM facilitator returns
 * `authorization.from` exactly as the agent's client wrote it, and a client
 * writes it checksummed — mixed case. Two spellings of one wallet reaching the
 * ownership guard, which compares exactly, are two buyers, and the buyer who
 * paid is refused their own repeat because their client changed its mind about
 * capitals. So the address is lowercased once, here, where an outside answer
 * becomes an identity this system decides ownership with — not in any one
 * adapter, or the next adapter would need the rule again and the one that
 * forgot it would be the one nobody tested.
 *
 * A blank is not a name, and it has to become nothing rather than survive as an
 * empty string: the caller falls back to the payment's fingerprint with `??`,
 * which an empty string does not trigger. Left as it is, `""` would be one
 * identity shared by every payer nobody named, and the second sender of one
 * would be handed the first sender's purchase.
 *
 * What comes out of here is the only thing ever written to `paidBy`, so the
 * guard in `presentVerifiedPayment` compares normalised against normalised.
 */
function walletThatPaid(payer: string | null): string | null {
  const wallet = (payer ?? "").toLowerCase();
  return wallet === "" ? null : wallet;
}

/**
 * The same envelope, going back on the stream now.
 *
 * Both callers are paths where it was drawn and then handed to nobody — the
 * hand-over could not be recorded, or the machine will take it but not yet. No
 * worker has seen this envelope, so the identifier it keeps costs nothing. The
 * stamp is what would be wrong: left alone it would date the message to a draw
 * that came to nothing.
 *
 * This is not how a merchant is sent an order a second time. That decision is
 * the machine's, and it produces a fresh envelope with a fresh identifier
 * (`redeliver_order` in runner.ts). So nothing here gives a worker a way to
 * recognise a repeat; the order's own identifier is what does that.
 */
function sentNow(envelope: WorkerEnvelope, at: number): WorkerEnvelope {
  return { ...envelope, sent_at: asTimestamp(at) };
}

/**
 * One stored card as its own merchant reads it.
 *
 * The two selling fields come from different places on purpose. `selling` is
 * what a purchase of this card would actually meet, which is the merchant's own
 * word, the card's pause and whether that merchant could make a sale at all
 * folded into one by `sellingFor` — the same fold the order machine is given.
 * `paused` is the card's own flag, untouched, so a merchant can still see which
 * cards they took off themselves while everything is stopped.
 */
function merchantCardOf(
  stored: StoredCard,
  merchant: MerchantSelling,
  sellable: boolean,
): MerchantCard {
  return {
    id: stored.id,
    as_of: asTimestamp(stored.asOf),
    card: stored.card,
    selling: sellingFor(merchant, stored, sellable),
    paused: stored.paused,
  };
}

/**
 * One stored key as its own merchant reads it.
 *
 * Built field by field rather than by taking the row and dropping what should
 * not go out. The row carries no secret today — what is kept is a digest — so
 * the two would produce the same document; assembled by addition, a column added
 * to the row later arrives nowhere until somebody writes a line for it, and
 * assembled by subtraction it would arrive on every screen the moment it exists.
 */
function merchantKeyOf(stored: StoredKey): MerchantKey {
  return {
    id: stored.id,
    label: stored.label,
    created_at: asTimestamp(stored.createdAt),
    disabled_at: stored.disabledAt === null ? null : asTimestamp(stored.disabledAt),
  };
}

/**
 * How many misfits a refusal names before it starts counting instead.
 *
 * The answer a merchant's call comes back in has one line for the reason, not a
 * list, so everything wrong with a delivery has to fit in a sentence somebody
 * will read in a log. A card may declare a dozen fields and a broken handler
 * can miss all of them; naming them all makes a paragraph nobody reads, and
 * naming one makes a merchant fix his handler a field per round trip. Five is
 * enough to see the shape of the mistake, and what is left over is counted
 * rather than dropped in silence — a reader has to be able to tell "these five"
 * from "these five and eleven more".
 */
const MISFITS_NAMED = 5;

/**
 * How much of one misfit is quoted before it is cut short.
 *
 * Counting the findings is not enough on its own and the reason is worth
 * writing down, because it is not obvious and it was found by measurement
 * rather than by reading. Every field the card never declared arrives as a
 * single finding whose own text lists all of them — three hundred undeclared
 * names come back as one finding fourteen thousand characters long, and a cap
 * on the number of findings never fires. What the merchant sends is what sets
 * that length, so this bound is on the letters as well as on the count.
 *
 * A hundred and sixty is a wide log line: enough for a path and a sentence
 * about it, or for the first several names in a list of them. A cut is marked
 * where it happens rather than left to look like the whole of the finding.
 */
const LETTERS_PER_MISFIT = 160;

/**
 * One piece of somebody else's text, held to a length, saying where it was cut.
 *
 * Everything this trims comes from outside and none of it has a maximum of its
 * own: a card's `merchant_item_id` is any non-blank string the contract will
 * take, and a finding's words are set by what the merchant delivered. Marked
 * rather than silent, so nobody reads a cut as the whole of it.
 */
function cutShort(text: string): string {
  return text.length <= LETTERS_PER_MISFIT
    ? text
    : `${text.slice(0, LETTERS_PER_MISFIT)}… (cut short)`;
}

/** Everything wrong with a delivery, in one line a person can act on. */
function misfitsIn(findings: readonly PublishError[]): string {
  // An unrecognized key carries no path — zod names it in the message instead —
  // so the path is a prefix where there is one rather than the whole of it.
  const named = findings
    .slice(0, MISFITS_NAMED)
    .map((finding) =>
      cutShort(
        finding.path.length === 0
          ? finding.message
          : `${finding.path.join(".")}: ${finding.message}`,
      ),
    )
    .join("; ");

  const rest = findings.length - MISFITS_NAMED;
  return rest > 0 ? `${named} (and ${rest} more)` : named;
}

/**
 * The finding a merchant who has chosen no name for buyers meets when they try
 * to publish.
 *
 * Its path is empty because it is not about a field of the card: a merchant
 * reading this would search their card for what is missing and find nothing,
 * which is why the message names the call that fixes it instead. The address is
 * written out rather than described, so that the sentence works for whoever is
 * reading it — a person in a cabinet, and an engineer with a terminal and this
 * response.
 */
const NO_SELLER_NAME: PublishError = {
  path: [],
  code: "no_seller_name",
  message:
    "this merchant has not set the name their products are sold under, and a card published" +
    " without one is offered for sale through a payment request that names no seller at all;" +
    " set a name with POST /v0/seller-name and publish this card again",
};

/**
 * The finding a merchant who has said nothing about where their money goes
 * meets when they try to publish, on a deployment where the money is real.
 *
 * Its path is empty for the reason the one above is: it is not about a field of
 * the card, and a merchant reading it would search the card for what is missing
 * and find nothing. The sentence says what is missing, why it is refused here
 * rather than at the sale, and the one call that fixes it.
 *
 * Nothing here offers to stand an address of ours in for theirs, and the
 * silence is the decision (ADR-0019): the gateway is configured with an
 * address, it is the operator's, and a card published against it would send a
 * merchant's takings to somebody else with nobody the wiser.
 */
const NO_PAYOUT_WALLET: PublishError = {
  path: [],
  code: "no_payout_wallet",
  message:
    "this merchant has not set a wallet to be paid at, so the money from sales of this card" +
    " would have nowhere to go — a buyer's agent pays the merchant's own address directly and" +
    " nothing of it is held here; set one with POST /v0/payout-wallet and publish this card" +
    " again",
};

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
