/**
 * The store: everything the gateway remembers.
 *
 * It is a port because the thing behind it is one Postgres (ADR-0003 §6) and
 * the whole of the application logic has to be testable without one. What is
 * written here is therefore the smallest set of questions the flows actually
 * ask, in the words of the domain, and nothing about tables.
 *
 * Almost every question here is asked on behalf of one merchant, and asks so
 * out loud: the merchant is a parameter rather than something the store is
 * configured with, so a read that forgot whose it was would not compile.
 *
 * The ones that name no merchant fall into four groups, and each says which it
 * is in its own words. Four are the buying surface: `cardById`,
 * `catalogEntries`, `orderById` and `receiptForOrder` answer an agent, or a
 * clock of ours, and neither has a key. Three are the claims on payments —
 * `claimPayment`, `releaseClaim`, `forgetClaimsBefore` — which are deliberately
 * across the whole gateway, for the reason written beside the first of them.
 * Two are the sweep's — `openOrders` and `deliveredWithoutReceipt` — which ask
 * what is still owed across every merchant, because an effect that went missing
 * is not one merchant's problem to notice. The rest are the merchants and their
 * keys, whose caller is somebody at a terminal, the door itself, or the one
 * route that makes a merchant and so has none to be scoped to. `withOrder` is
 * in none of the four: it takes the merchant when there is one to take and says
 * in its own place what leaving it out means.
 *
 * Disabling a key comes in a scoped and an unscoped form, and which is which
 * matters. `disableKeyOf` takes the merchant and serves the button a merchant
 * presses in their cabinet; `disableKey` names a key alone and serves the
 * command somebody types, where one identifier is the whole of what they have.
 *
 * One method is not an accessor and is the reason this is an interface rather
 * than three maps. `withOrder` holds an order still while a decision is made
 * about it. Two events about the same order arrive from different places all
 * the time — the agent's payment and a deadline, the merchant's answer and a
 * redelivery — and without that hold both would read the same order, both
 * would decide against it, and the second write would erase the first. Next to
 * someone else's money that is not a race to lose politely: it is how an order
 * gets charged twice.
 */

import type { Card, Delivery, Receipt, WorkerEnvelope } from "@coinslot/contracts";
import type { MerchantSelling, Order } from "@coinslot/core";

/** A card as its merchant published it, under the catalog identifier we issued. */
export interface StoredCard {
  readonly id: string;
  /** Whose card it is. Every card has one, and it is never guessed at. */
  readonly merchantId: string;
  readonly card: Card;
  /** When this version of the card was published. */
  readonly asOf: number;
  /**
   * Whether this card is off sale in its own right.
   *
   * It is a flag on the card and not a second kind of pause. What the order
   * machine is given at the birth of an order is one word for whether the
   * merchant is selling, and a card paused on its own is that word being
   * "paused" for purchases of this card and nothing else — same guard, same
   * refusal, same message. The alternative was a second notion of pause with
   * its own rejection, which is how two switches end up disagreeing about
   * whether a product is for sale.
   */
  readonly paused: boolean;
}

/**
 * One order: the machine's own order, and everything about the purchase the
 * machine has no opinion about.
 *
 * The payment sits here as the opaque thing the agent presented rather than as
 * anything this package understands. It is kept because the charge is executed
 * later than it is verified — in the synchronous mode, after the goods come
 * back — and by then the request that carried it is long over.
 */
export interface StoredOrder {
  readonly order: Order;
  /**
   * Whose sale this is: the merchant who published the card it was made
   * against, settled at the birth of the order and never afterwards.
   *
   * It is on the order rather than looked up through the card because the two
   * questions it answers are asked when there is no card in hand — which
   * stream this order's envelopes go on, and whether the key asking about it
   * is the one entitled to. A card can also be republished, and a sale belongs
   * to the merchant who made it whatever happens to the catalog afterwards.
   */
  readonly merchantId: string;
  /** Our catalog identifier for the product. */
  readonly itemId: string;
  /** The merchant's own identifier for it, so they need no mapping table. */
  readonly merchantItemId: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The price question this order was priced by, where one was asked. */
  readonly priceId: string | null;
  /** What the merchant handed over, once they have. */
  readonly delivery: Delivery | null;
  /** What the agent presented to pay with, verbatim, until the charge is done. */
  readonly payment: string | null;
  /**
   * Who this order belongs to: the payer the payment layer named when it
   * verified the first payment presented for it.
   *
   * An order's identifier is not a secret the way a password is — it travels in
   * the challenge, on the merchant's stream and in a receipt — and the route
   * that takes a payment takes no key, the payment standing in for one. So
   * without an owner, anybody holding an identifier could present a payment
   * against somebody else's order and be treated as its buyer: swapping the
   * authorisation that gets charged, taking the goods when they came back, or
   * closing the order on a payment that failed. Ownership is settled by the
   * first payment the payment layer vouches for, and the owner is the payer it
   * names — never the address a payment declares of itself, because a payment
   * whose declared address did not sign it does not verify. A repeat of the
   * purchase carries a fresh authorisation from the same wallet, so the payer
   * is how the owner is recognised across it. Where the layer verifies a
   * payment without naming a payer, the payment's own fingerprint stands in.
   *
   * The decision that sets this is made inside the store's hold on the order,
   * reading this very field, so two payments racing one order cannot both
   * become its owner.
   */
  readonly paidBy: string | null;
  /**
   * What the payment layer said when the charge went through, kept because the
   * agent's own client reads it off the answer to its purchase. It is the
   * payment layer's word and not ours: the order's own record of the money is
   * the machine's payment stage, and this is only the receipt for it.
   */
  readonly settlement: { readonly transaction: string } | null;
  /**
   * Everything the payment layer has actually said about this order, in its own
   * words and in order.
   *
   * The machine keeps a coarse verdict — verified, settled, unknown — and three
   * reasons a verification can fail. What the facilitator said is richer than
   * that and is the only thing an operator can work from when a charge goes
   * quiet: it is the difference between an outage, an empty wallet and a chain
   * nobody configured. Dropping it left the one order somebody has to
   * reconcile by hand with nothing to reconcile from.
   */
  readonly paymentWords: readonly PaymentWord[];
  /**
   * How many of them fell off the end of that list.
   *
   * The list is bounded, because the route that fills it takes no key and
   * anybody may present as many payments as they like against one order. What
   * is dropped is counted rather than dropped quietly: a reader of the last
   * twenty things the payment layer said needs to know whether there were
   * twenty or two hundred.
   */
  readonly paymentWordsDropped: number;
  /**
   * The delivery that is out with a worker and has not been answered.
   *
   * It is here so that a reminder about one delivery cannot undo the answer to
   * another. A merchant who took an order on and has a day to fulfill it
   * answered the delivery he was given; without this, the reminder left against
   * that same delivery would fire afterwards, the machine would be told his
   * handler never answered, and he would be sent the order again — every window,
   * all day.
   */
  readonly openDeliveryId: string | null;
}

/** One thing the payment layer said, and when. */
export interface PaymentWord {
  readonly at: number;
  readonly about: "verify" | "settle";
  readonly said: string;
}

/**
 * One write that has to land with the order or not at all (ADR-0013).
 *
 * These are the effects that cannot be re-driven once the order has moved past
 * the transition that asked for them. An order that says the merchant was
 * handed the work, with no envelope written, is not repairable by a retry: the
 * state is already past the point that emits the dispatch. So the envelope is
 * written where the order is, and either both are there or neither is.
 *
 * They are described here rather than carried out by the caller on purpose.
 * What each adapter has to arrange is its own — a row in the same transaction
 * for Postgres, one uninterrupted span for the in-memory store — and a caller
 * that held a transaction handle would be holding a Postgres in a port that
 * has never known about one.
 *
 * Two shapes of write are on this list — an envelope for a merchant and a
 * receipt — and adding a third shape is a decision rather than a detail.
 *
 * What is on the list is not the same as what the sweep may write again
 * afterwards, and running the two together is the mistake worth naming here.
 * Landing with the state is about an effect that cannot be re-driven once the
 * order has moved past it. Being re-drivable is about what its receiver was
 * promised, and by that reading the two shapes carry three receivers between
 * them: an order envelope, whose merchant is told his handler can see the same
 * order twice; a receipt, which is one row keyed by its order, so writing it
 * again writes the same row; and an event envelope, which is delivered at most
 * once and must never be sent a second time. All three land with the state.
 * Only the first two have an arm in the sweep, and that is a decision rather
 * than an omission.
 */
export type WithTheOrder =
  | {
      readonly kind: "envelope";
      readonly merchantId: string;
      readonly envelope: WorkerEnvelope;
      /** How long the stream holds it back, where something asked it to wait. */
      readonly afterMs?: number;
    }
  | { readonly kind: "receipt"; readonly merchantId: string; readonly receipt: Receipt };

/**
 * What `withOrder` decided: the order to write back, if any, the writes that go
 * with it, and the answer to give the caller. Leaving `save` out is how a read
 * that changes nothing says so, rather than writing the order it just read.
 *
 * `alongside` is not conditional on `save`, and the honest reading is that
 * these writes belong to the same unit of work rather than to the order
 * document: a decision that returns them and then throws writes none of them,
 * and one that returns normally writes all of them.
 */
export interface OrderChange<T> {
  readonly save?: StoredOrder;
  readonly alongside?: readonly WithTheOrder[];
  readonly result: T;
}

/**
 * What came of asking to run something nobody else is running: the answer, or
 * the news that somebody else has it.
 *
 * Finding it taken is an ordinary outcome rather than a failure — that is the
 * mechanism working — so it is a value the caller reads, exactly as an order
 * that is not there is.
 */
export type Ran<T> = { readonly ran: true; readonly result: T } | { readonly ran: false };

/**
 * An order that is not there. It is a value rather than a thrown error because
 * an agent asking about an order that never existed is an ordinary thing that
 * happens, and the caller has to answer it rather than crash on it.
 */
export type OrderLookup<T> =
  | { readonly found: true; readonly result: T }
  | { readonly found: false };

/** Whether a payment is this order's to spend. */
export type PaymentClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldBy: string };

/**
 * A merchant: a row with an identity, and the one fact the order machine asks
 * about them.
 *
 * The name is what a person reads in a list at a terminal, and nothing on the
 * wire carries it. There is no address, no password and no record of who signed
 * this merchant up, and there is not meant to be: registering makes a merchant
 * and a key here and an account on the other side of the boundary, and the
 * address and the password belong to whatever signs a person in (ADR-0014 §1).
 */
export interface StoredMerchant {
  readonly id: string;
  readonly name: string;
  /**
   * The name this seller is listed under in a discovery catalog, or nothing at
   * all where nobody has named one.
   *
   * It is a second field rather than the name above, and the difference is the
   * whole reason it exists. The name above is read by a person at a terminal
   * and may be written in any alphabet and be any length; this one goes out to
   * strangers through a catalog that carries at most thirty-two characters of
   * printable ASCII and drops anything else in silence. Folded into one field,
   * either a merchant could not be called what they are called, or they would
   * be listed under a cut-down version of it and never be told.
   *
   * Null is the ordinary state and it means what it says: nobody has named one,
   * so nothing about a seller goes out. It is never filled in from the name
   * above, because a name that happens to fit the catalog's rule is still not a
   * name anybody chose to trade under.
   */
  readonly serviceName: string | null;
  readonly selling: MerchantSelling;
  readonly createdAt: number;
}

/**
 * One key a merchant opens the door with.
 *
 * The secret itself is not here and never comes back out of the store: what is
 * kept is its SHA-256 digest, and a request is resolved by looking that digest
 * up. Whoever generated the key showed it to its owner once and has nothing
 * left that can be read back.
 *
 * `disabledAt` carries the flag and the instant together. A boolean would
 * answer "does this key work" and nothing else, and the question somebody
 * actually asks after an incident is when it stopped.
 */
export interface StoredKey {
  readonly id: string;
  readonly merchantId: string;
  /** What its owner called it, so one of several can be told from the others. */
  readonly label: string;
  readonly createdAt: number;
  /** When it was revoked, or null while it still opens the door. */
  readonly disabledAt: number | null;
}

/** One card in the public catalog, with the word its own merchant sells under. */
export interface CatalogEntry {
  readonly card: StoredCard;
  /** The card's own merchant's word, which is not every merchant's word. */
  readonly merchant: MerchantSelling;
}

/** Which merchant an order belongs to, where a read is one merchant's alone. */
export interface MerchantScope {
  readonly merchantId: string;
}

export interface Store {
  // --- merchants and their keys ---------------------------------------------

  /**
   * Writes down a merchant that is not there yet, or answers null where that
   * identifier is taken.
   *
   * Null rather than a thrown error because the one caller is a command
   * somebody typed, and running it twice is a thing people do.
   */
  addMerchant(
    merchant: { readonly id: string; readonly name: string },
    at: number,
  ): Promise<StoredMerchant | null>;

  /**
   * Writes down a merchant, the name they are listed under, and their first
   * key, together or not at all. Null where that identifier is taken, and then
   * nothing was written.
   *
   * The three in one write is ADR-0014 §1, and what it buys is worth stating
   * because the failure it prevents looks harmless. A merchant written without
   * a key is a merchant nobody can reach; the identifier was generated, so
   * nobody outside this call ever held it, and nothing afterwards would point at
   * it. That is litter rather than damage, and it is litter with a foreign key
   * on it — cards, orders and receipts all reference merchants, so the row
   * cannot simply be swept.
   *
   * The listing name is written here rather than by a second call for the same
   * reason. A merchant with none publishes cards whose payment challenge
   * carries no seller declaration at all, and a registration that failed
   * between the merchant and the name would leave one.
   *
   * The name is expected to have been held to the catalog's rule already; the
   * caller that does it is `registerMerchant` in `app/merchants.ts`, beside the
   * other place a listing name is written.
   */
  registerMerchant(
    merchant: { readonly id: string; readonly name: string; readonly serviceName: string },
    key: { readonly id: string; readonly label: string; readonly digest: string },
    at: number,
  ): Promise<{ readonly merchant: StoredMerchant; readonly key: StoredKey } | null>;

  merchantById(id: string): Promise<StoredMerchant | null>;

  /** Every merchant, for the command that lists them. */
  merchants(): Promise<readonly StoredMerchant[]>;

  /**
   * Sets or clears the name one merchant is listed under, and hands back the
   * merchant as they now stand. Null where there is no such merchant.
   *
   * The value is expected to have been held to the catalog's rule already; the
   * caller that does it is `setServiceName` in `app/merchants.ts`, which is the
   * one place a name is checked before it is written.
   */
  setServiceName(
    id: string,
    serviceName: string | null,
    at: number,
  ): Promise<StoredMerchant | null>;

  /** Writes down one key of one merchant. The digest is what is kept, not the key. */
  addKey(
    key: {
      readonly id: string;
      readonly merchantId: string;
      readonly label: string;
      readonly digest: string;
    },
    at: number,
  ): Promise<StoredKey>;

  /**
   * The key a request presented, by its digest — and nothing at all where there
   * is no such key or where the key there is has been disabled.
   *
   * The two silences are deliberately the same one. A door that answered "that
   * key exists but is off" differently from "that is not a key" would be a way
   * of confirming which guesses were once real keys, which is the thing a
   * revoked key must never leak.
   *
   * This is what makes the check constant-time by construction: nothing here
   * compares a secret with a secret. What travels is a digest, always the same
   * size, and what answers is an index.
   *
   * The whole row rather than the merchant alone, and the difference is a rule
   * rather than a convenience: a merchant cannot disable the key their own call
   * was made with (ADR-0014 §5), and the door is the only place that knows
   * which key that was. Answered with a merchant, the route would have to hash
   * the header a second time and look it up again to find out.
   */
  workingKey(digest: string): Promise<StoredKey | null>;

  /**
   * The key with this digest, working or not.
   *
   * Separate from {@link workingKey} because the two questions are different and
   * only one of them is asked at the door: this one is for the command that
   * would otherwise issue a second key with a digest already taken, and it is
   * never reachable from a request.
   */
  keyByDigest(digest: string): Promise<StoredKey | null>;

  /**
   * Every key of one merchant, disabled ones included, never their secrets.
   *
   * Oldest first, with the identifier settling a tie. The order is part of what
   * this promises rather than whatever each adapter's storage happens to give,
   * because a merchant reads this list on a screen: left to the database, two
   * keys made in the same millisecond would swap places between two visits with
   * nothing having changed, and a test about the list would mean one thing in
   * memory and another against Postgres.
   */
  keysOf(merchantId: string): Promise<readonly StoredKey[]>;

  /**
   * Stops one key working and hands back where it now stands. Null where there
   * is no such key.
   *
   * Disabling a key that is already disabled keeps the instant it was first
   * revoked at rather than moving it: the first revocation is the true one, and
   * a retry after a dropped connection must not rewrite history.
   *
   * It names a key and no merchant, and that is safe only because nothing
   * reachable from a request calls it — the callers are the command somebody
   * types, where one identifier already names the row, and the test harness.
   * What the cabinet's own button calls is {@link disableKeyOf}, which takes the
   * merchant the way every other scoped write here does.
   */
  disableKey(id: string, at: number): Promise<StoredKey | null>;

  /**
   * Stops one of this merchant's keys working and hands back where it now
   * stands. Null where this merchant has no such key — which is the same answer
   * as no such key anywhere, on purpose.
   *
   * The sameness is the point rather than a simplification. Told apart, this
   * call would count somebody else's keys: a merchant walking identifiers would
   * learn which of them are real, and the identifiers of a merchant's keys are
   * not secrets — they are printed in their own list and in ours.
   *
   * The merchant is in the predicate rather than checked after the read, so a
   * key of somebody else's is never selected and there is no window between
   * finding out whose it is and writing to it.
   *
   * Disabling a key that is already disabled keeps the instant it was first
   * revoked at, exactly as {@link disableKey} does.
   */
  disableKeyOf(merchantId: string, id: string, at: number): Promise<StoredKey | null>;

  // --- the catalog ----------------------------------------------------------

  /**
   * Publishes one card for one merchant. Republishing under the same
   * `merchant_item_id` changes that merchant's card that is there rather than
   * adding a second one, which is what the portal promises, so the catalog
   * identifier stays what it was.
   *
   * The merchant's own identifier is unique inside their catalog and nowhere
   * else, which is what the card contract has always said it means: two
   * merchants may both sell a "sku-1", and neither publish touches the other.
   */
  publishCard(merchantId: string, card: Card, at: number): Promise<StoredCard>;

  /**
   * One card by the catalog identifier, whoever published it.
   *
   * Deliberately unscoped: this is the buying surface, and an agent has no key
   * and no merchant. The card that comes back carries whose it is, and that is
   * how a purchase reaches the right merchant.
   */
  cardById(id: string): Promise<StoredCard | null>;

  /** The cards one merchant published, and nobody else's. */
  cards(merchantId: string): Promise<readonly StoredCard[]>;

  /**
   * Every card the gateway holds, each with the word its own merchant is
   * selling under — the one catalog the public surface is built from.
   *
   * The merchant's word travels with the card because it is per merchant: one
   * merchant stopping all selling takes their own cards out of the catalog and
   * leaves everybody else's exactly where they were.
   */
  catalogEntries(): Promise<readonly CatalogEntry[]>;

  /**
   * Takes one of this merchant's cards off sale, or puts it back, and hands
   * back the card as it now stands. Null where this merchant has no such card
   * — which is the same answer as no such card anywhere, on purpose.
   *
   * Republishing does not touch this: a merchant editing a price is not asking
   * for a product they took off sale to go back on it, and a pause that
   * evaporated on the next publish would put stock they do not have in front
   * of an agent.
   */
  setCardPaused(merchantId: string, id: string, paused: boolean): Promise<StoredCard | null>;

  /**
   * Whether this merchant is taking new orders at all — the word the order
   * machine is given at the birth of every order made against their cards.
   *
   * A merchant nobody has ever paused is selling. This cannot answer "I do not
   * know": there is no state of the world in which we hold a merchant's cards
   * and cannot say whether they are selling.
   */
  selling(merchantId: string): Promise<MerchantSelling>;

  /** Stops this merchant's selling, or starts it again. */
  setSelling(merchantId: string, selling: MerchantSelling): Promise<void>;

  // --- orders ---------------------------------------------------------------

  /** Writes an order that is not there yet. The record says whose it is. */
  addOrder(record: StoredOrder): Promise<void>;

  /**
   * One order by its identifier, whoever it belongs to.
   *
   * Unscoped because its callers have no merchant to be scoped to: the payment
   * route, which takes no key and is answered by the payment itself; the
   * agent's read of what became of its own purchase, which is answered by the
   * order's identifier (ADR-0011); and the gateway's own clocks, which act on
   * an order rather than for somebody. What keeps the agent's read from
   * becoming a way of reading across the merchants is the shape of the document
   * it answers with, which names none of them.
   *
   * A merchant's own read of one order is {@link merchantOrder}.
   */
  orderById(id: string): Promise<StoredOrder | null>;

  /** One of this merchant's orders. Another merchant's order is not found. */
  merchantOrder(merchantId: string, id: string): Promise<StoredOrder | null>;

  /** This merchant's orders, or with `open` only the ones still owed work or money. */
  orders(merchantId: string, query?: { readonly open?: boolean }): Promise<readonly StoredOrder[]>;

  /**
   * Every order still owed work or money, whoever it belongs to.
   *
   * The one caller is the sweep, which asks the orders themselves what they are
   * missing rather than keeping a second book of what was meant to happen
   * (ADR-0013). It names no merchant because a clock that never fired is not
   * one merchant's problem to notice.
   *
   * What bounds it is that open orders close: every one of them is waiting on a
   * deadline that ends it, so this is the work in flight and not the history.
   * A gateway whose orders stopped closing would find this growing, and that is
   * the same fault seen from another angle rather than a second one.
   */
  openOrders(): Promise<readonly StoredOrder[]>;

  /**
   * Runs `work` if nothing anywhere in the gateway is already running the work
   * called `name`, and otherwise runs nothing and says so.
   *
   * The one caller is the sweep, and what it buys is the thing the sweep is
   * for. Every arm of it reads the world and then acts on what it read — is
   * this order's envelope still on the stream, does this delivered order have a
   * receipt — so two runs at once both read "missing" and both act. The
   * dispatch arm doing that is the double hand-over the arm exists to prevent,
   * arrived at by the thing meant to prevent it, and it spends one of that
   * order's deliveries.
   *
   * It has to hold across processes and not merely across this one, because the
   * overlap that makes it necessary is two gateways running the same work at
   * the same time. One gateway on its own does not need it: the queue's worker
   * waits for the handler before it fetches anything else, so a second run
   * cannot start inside a process where the first has not returned. What puts
   * one run in two processes is the queue's expiry — a run that outlasts it has
   * its job failed for taking too long and offered again while it is still
   * going, and the other process's idle worker takes it.
   *
   * It is a lock and not a record: nothing about having run is written down and
   * nothing has to be cleaned up afterwards.
   *
   * What it holds is one run per live connection, which is not quite one run.
   * A lock is let go the moment the session holding it goes away — a backend
   * terminated by an administrator, a failover, a pooler dropping an idle
   * session — and the process that was doing the work does not necessarily go
   * with it. So a run whose connection died carries on, unprotected, while the
   * next caller is told the name is free and starts beside it. That is the
   * failure this cannot see, and it is a much smaller window than the one it
   * closes.
   *
   * And it promises no fairness and no queue: a caller that finds the name
   * taken does not wait, it goes away, because the work it wanted is already
   * being done.
   */
  runAlone<T>(name: string, work: () => Promise<T>): Promise<Ran<T>>;

  /**
   * Every order that ended delivered with no receipt written against it,
   * whoever it belongs to.
   *
   * A receipt is what a merchant reconciles a wallet against, so a delivered
   * order without one is a sale that is invisible to the person whose money it
   * was. With the receipt written where the order is, the answer to this should
   * always be empty; it is asked because "should always be" is not a thing to
   * take on trust about somebody else's money.
   */
  deliveredWithoutReceipt(): Promise<readonly StoredOrder[]>;

  /**
   * Holds one order still, hands it to `change`, and writes back whatever
   * `change` asks to be written. Nothing else touches that order in between.
   *
   * Given a `scope`, an order belonging to another merchant is not found at
   * all — the ownership is part of the same read as the lock, so a merchant's
   * call can never move a stranger's order and there is no window between
   * checking whose it is and acting on it.
   */
  withOrder<T>(
    id: string,
    change: (found: StoredOrder) => Promise<OrderChange<T>> | OrderChange<T>,
    scope?: MerchantScope,
  ): Promise<OrderLookup<T>>;

  // --- payments -------------------------------------------------------------

  /**
   * Binds one payment to one order, once and for all.
   *
   * A signed payment authorises an amount to an address; nothing inside it says
   * which purchase it is for, and nothing about presenting it twice is visible
   * to the payment layer until the second charge is actually executed. Two
   * orders at the same price are therefore payable with one signature — both
   * verify, both go to a merchant, both are delivered, and only the second
   * charge fails. This is what stops that: the first order to present a payment
   * owns it, and the same payment presented for a second order is refused
   * before anything is verified or dispatched.
   *
   * A claim is the one thing here that is deliberately not per merchant, and
   * the reason is the failure it guards. The two orders one signature would
   * buy are just as likely to be at two different merchants as at one — an
   * agent walking the public catalog is not shopping inside a tenant — and a
   * claim scoped to a merchant would let the same authorisation be spent once
   * at each. So the fingerprint is unique across the gateway, and nothing
   * about which merchant is asking enters into it.
   */
  claimPayment(fingerprint: string, orderId: string): Promise<PaymentClaim>;

  /**
   * Lets go of a claim this order took and then could not use.
   *
   * The claim is taken before the ownership decision, and it has to be: it is
   * what stops one signature being spent on two orders, so it must be in place
   * before anything is verified against a second one. But a presentation the
   * ownership decision turns away never spent anything — the money did not
   * move and no merchant was asked for goods — and a claim left behind then
   * binds a live authorisation to an order that can never accept it. The agent
   * that lost a race for the last unit would find its next attempt answered
   * "already spent" and pointed at somebody else's order.
   *
   * Only the holder can let go: a fingerprint claimed by another order is left
   * exactly as it is, so this can never hand one buyer's signature to another.
   */
  releaseClaim(fingerprint: string, orderId: string): Promise<void>;

  /**
   * Forgets claims older than an instant, and says how many went.
   *
   * They cannot be kept forever. The route that makes them takes no key — the
   * payment is what stands in for one — so anybody can make as many as they
   * like, and a table that only grows under an open door is a table that fills
   * up. What a claim actually guards is the window between a payment being
   * verified and the charge being executed, because after that the token
   * itself refuses the same authorisation twice; how long that window is worth
   * keeping is configuration.
   */
  forgetClaimsBefore(instant: number): Promise<number>;

  /** Writes down one merchant's receipt for one order. */
  putReceipt(merchantId: string, receipt: Receipt): Promise<void>;

  /**
   * The receipt for one order, whoever it belongs to.
   *
   * Unscoped for the same reason {@link orderById} is: the agent's own answer
   * to its purchase carries the receipt, and the agent has no key.
   */
  receiptForOrder(orderId: string): Promise<Receipt | null>;

  /** This merchant's receipts, and nobody else's. */
  receipts(merchantId: string): Promise<readonly Receipt[]>;
}
