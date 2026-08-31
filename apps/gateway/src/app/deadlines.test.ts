import type { Card } from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../ports/queue.js";
import { authorisation, type Harness, harness, workUntilStopped } from "../testing/harness.js";

/** The buyer, for the one test here that turns on which wallet signed. */
const BUYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * The clocks, from the outside.
 *
 * Every row of the portal's "time ran out" table is a promise to somebody, and
 * each of these is one row of it: what happens when a deadline runs out, and
 * whose money is where afterwards. The numbers are in tens of milliseconds so
 * that a whole life of an order fits in a test, and they come from the same
 * configuration a deployment uses.
 */

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const asyncCard: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
};

/**
 * Deadlines short enough that an order lives and dies inside one test.
 *
 * The synchronous budget is the odd one out, and it is deliberately nowhere
 * near the rest. Every other number here is arithmetic against a clock that
 * does not move, so it is exact. The budget is not: it is the real wait an
 * agent parked on a synchronous purchase actually sits out, and it races the
 * real timer carrying the synchronous deadline that is supposed to end the
 * order first. Because the harness clock is frozen, the two are counted from
 * two different real instants — the park from the moment the payment reaches
 * the gateway, the deadline from the moment the machine arms it a few lines
 * later — so the distance between the two numbers is the whole slack absorbing
 * whatever the process was doing in between.
 *
 * At 200 that slack was 120ms, which is inside what this machine loses to a
 * worker importing its own modules while other suites have the cores. It went
 * the wrong way roughly once in eighty runs, always on the first test in the
 * file: the park gave up first, and the agent was told `under_way` about a
 * purchase whose deadline was a microtask away from closing it. A deployment
 * cannot invert the two — there the clock moves, and the park and the deadline
 * are both anchored to the order's own creation, with the gateway refusing to
 * start at all unless the answer fits inside the budget — so the margin is
 * bought here rather than in the gateway.
 */
const brisk = {
  QUOTE_RESPONSE_MS: "20",
  QUOTE_TTL_MS: "60",
  SYNC_RESPONSE_MS: "80",
  SETTLE_RESPONSE_MS: "40",
  SYNC_BUDGET_MS: "2000",
  HANDLER_ANSWER_MS: "1000",
  DEFAULT_ASYNC_FULFILLMENT_MS: "80",
};

let open: Harness | null = null;
const started = async (overrides: Record<string, string> = {}) => {
  open = await harness({ ...brisk, ...overrides });
  return open;
};

afterEach(async () => {
  await open?.stop();
  open = null;
});

const bought = async (harnessed: Harness, card: Card): Promise<string> => {
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, card);
  if (!("ok" in published)) throw new Error("the card would not publish");
  const offered = await harnessed.gateway.beginPurchase(published.ok.id, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  return offered.order.order.id;
};

const state = async (harnessed: Harness, orderId: string) =>
  (await harnessed.store.orderById(orderId))?.order;

describe("when the time runs out", () => {
  it("closes a synchronous purchase nobody answered, and charges nothing", async () => {
    // The portal's row: "you are delivering a synchronous order" — the purchase
    // did not happen, there was no charge. Which is what the mode is for: the
    // buyer's money never moves until the goods exist.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    const settled = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    expect(settled.step).toBe("settled");
    if (settled.step !== "settled") throw new Error("the purchase did not settle");
    expect(settled.order.order.state).toBe("expired");
    expect(settled.order.order.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "sync_response",
    });
    expect(harnessed.facilitator.settles).toHaveLength(0);
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
  });

  it("does not tell a merchant a closed order still stands", async () => {
    // Goods are weighed against the card before the machine sees the call, and
    // that check does not ask whether the order is still alive. Its refusal
    // said the order "still stands where it did" and marked itself worth
    // calling again — literally true of a call that moved nothing, and read as
    // "the sale is still yours". A merchant told that on an order whose
    // deadline has passed goes and fixes his handler for a sale he has already
    // lost, and finds out on the next call.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    const settled = await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    if (settled.step !== "settled") throw new Error("the purchase did not settle");
    expect(settled.order.order.state).toBe("expired");

    // The card declares an access code; this handler sends a serial. Both
    // things are true at once here — the goods are wrong and the order is
    // over — and it is the second that decides what he can do next.
    const refused = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      serial: "89310410106543789301",
    });

    if (refused?.ok !== false) throw new Error("goods were taken against a closed order");
    expect(refused.error.code).toBe("delivery_does_not_match_card");
    expect(refused.error.message).toContain("expired");
    expect(refused.error.message).not.toContain("still stands where it did");
    expect(refused.error.retryable).toBe(false);
    // He is still told which fields were wrong: the order being over is the
    // news, not a reason to stop naming what he sent.
    expect(refused.error.message).toContain("serial");

    // And still nothing was written against the order.
    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
  });

  it("still says an open order stands where it did", async () => {
    // The negative control for the sentence above. The clause is right on an
    // order the merchant can still finish, and a fix that removed it from
    // everything would take away the one thing that tells him his goods are
    // still wanted.
    const harnessed = await started({ DEFAULT_ASYNC_FULFILLMENT_MS: "5000" });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const refused = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      serial: "89310410106543789301",
    });

    if (refused?.ok !== false) throw new Error("goods the card never declared were taken");
    expect(refused.error.message).toContain("still stands where it did");
    expect(refused.error.retryable).toBe(true);
  });

  it("marks an asynchronous order for a refund, because the money is already gone", async () => {
    // The other row of the same table, and the reason the two are different
    // words: here the charge went through at the purchase, so an ending that
    // said "nothing happened" would leave a buyer out of pocket with the
    // system claiming otherwise.
    const harnessed = await started();
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      {
        timeout: 2_000,
        interval: 5,
      },
    );

    const owing = await state(harnessed, orderId);
    expect(owing?.payment).toBe("settled");
    expect(owing?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });

    const told = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);
    const events = told.envelopes.flatMap((e) => (e.kind === "order_event" ? [e.payload] : []));
    expect(events.map((e) => e.type)).toContain("order.refund_due");
  });

  it("keeps the first of two late answers in the drawer, and the buyer collects that one", async () => {
    // The one place "the first delivery is what the buyer keeps" applies to
    // goods nobody has been handed yet, so it is pinned rather than inferred.
    //
    // A synchronous purchase ran out of time and the handler finished after
    // it. The work is not thrown away: it goes in the drawer and a repeat
    // purchase collects it. If the handler is sent the order again and makes a
    // second set of goods, the first stays. That is consistent with every
    // other repeat, and it is worth knowing that it cuts differently here: a
    // handler that issues a fresh code per run — the natural thing when the
    // first was released back to stock on the timeout — has its later code
    // discarded, and the buyer collects the earlier one. Which of the two
    // belongs to the buyer is a question about the product rather than about
    // this code, and this test is where the answer would change.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    const paid = authorisation(harnessed, BUYER, "0x01");
    const settled = await harnessed.gateway.payPurchase(orderId, paid.payment, paid.fingerprint);
    expect(settled.step).toBe("settled");
    expect((await state(harnessed, orderId))?.state).toBe("expired");

    const first = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "CODE-ONE" },
    });
    const second = await harnessed.gateway.answerOrder(harnessed.merchant.id, orderId, {
      delivered: { access_code: "CODE-TWO" },
    });

    expect(first).toStrictEqual({ ok: true, result: "purchase_already_closed" });
    expect(second).toStrictEqual({ ok: true, result: "purchase_already_closed" });
    expect((await state(harnessed, orderId))?.heldFulfillment).toBe(true);
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual({
      access_code: "CODE-ONE",
    });

    // And the repeat purchase that collects the drawer gets that same one. A
    // fresh authorisation from the same wallet, which is how the owner of the
    // order is recognised across a repeat.
    const repeat = authorisation(harnessed, BUYER, "0x02");
    const collected = await harnessed.gateway.payPurchase(
      orderId,
      repeat.payment,
      repeat.fingerprint,
    );
    expect(collected.step).toBe("settled");
    if (collected.step !== "settled") throw new Error("the repeat did not settle");
    expect(collected.delivery).toStrictEqual({ access_code: "CODE-ONE" });
  });

  it("brings the money back when a handler never sends what the card declares", async () => {
    // The cost of the choice made when goods do not match the card: the
    // delivery is refused and the order is left open, so the merchant can fix
    // his handler and deliver. That is only defensible if an order nobody ever
    // fixes still ends — otherwise the refusal is a way of parking a buyer's
    // money forever. The deadline is what ends it, and this is that promise:
    // a merchant who keeps sending the wrong shape runs out of time exactly as
    // one who sends nothing at all does, and the buyer is owed his money back.
    const harnessed = await started();
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const refused = await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, {
      // The card declares an activation code; this handler sends a serial.
      serial: "89310410106543789301",
    });
    if (refused?.ok !== false) throw new Error("goods the card never declared were taken");
    expect(refused.error.code).toBe("delivery_does_not_match_card");

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      { timeout: 2_000, interval: 5 },
    );

    const owing = await state(harnessed, orderId);
    expect(owing?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });
    // And nothing of his was ever written against the order.
    expect((await harnessed.store.orderById(orderId))?.delivery).toBeNull();
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
  });

  it("lets a price the agent sat on stop being a price", async () => {
    // "The agent got a price and is thinking" — the price stops applying, and
    // an agent who still wants it asks for a fresh one. Nothing was charged, so
    // the ending is free.
    const harnessed = await started();
    const orderId = await bought(harnessed, syncCard);

    await vi.waitFor(async () => expect((await state(harnessed, orderId))?.state).toBe("expired"), {
      timeout: 2_000,
      interval: 5,
    });

    expect((await state(harnessed, orderId))?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "quote_expiry",
    });
    expect(harnessed.facilitator.verifies).toHaveLength(0);
  });
});

describe("a card that names no delivery deadline", () => {
  it("holds its merchant to ours, and shows the agent no deadline at all", async () => {
    // The delivery deadline is optional on an asynchronous card, and this is
    // what leaving it out costs. Our own number applies, and an order that runs
    // past it is marked as needing a refund exactly as one past a number the
    // merchant chose would be — while the card an agent reads carries no
    // deadline for it to see. So the clock the merchant is held to was shown to
    // neither of them, and the page has to say so rather than promise the agent
    // a deadline that is not there.
    const harnessed = await started();
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, asyncCard);
    if (!("ok" in published)) throw new Error("the card would not publish");
    expect(asyncCard.fulfill_deadline_seconds).toBeUndefined();

    const shown = (await harnessed.gateway.catalog()).items[0];
    if (shown === undefined) throw new Error("the card did not reach the catalog");
    expect(shown.fulfillment).toBe("async");
    expect("fulfill_deadline_seconds" in shown).toBe(false);

    const offered = await harnessed.gateway.beginPurchase(published.ok.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      {
        timeout: 2_000,
        interval: 5,
      },
    );
    expect((await state(harnessed, orderId))?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });
  });
});

describe("when a delivery goes unanswered", () => {
  it("sends the order again, after the wait the machine asked for", async () => {
    // An exception in the handler, a dead process and a broken connection are
    // the same thing to us — the answer never came — and they are answered with
    // another delivery, not with a refusal.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "10",
      DEFAULT_ASYNC_FULFILLMENT_MS: "3000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // A worker that draws its stream and never answers anything.
    const silent = workUntilStopped(harnessed, {});
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.dispatch.attempts).toBeGreaterThan(1),
      { timeout: 2_000, interval: 5 },
    );
    await silent.stop();

    // Still open, still owed the goods, and never refused on our own account.
    expect((await state(harnessed, orderId))?.state).toBe("dispatched");
  });

  it("wraps each repeat in a new message, so only the order's identifier holds still", async () => {
    // The mirror of the event that is never sent twice, and the reason the
    // portal gives two rules rather than one for a subscription that carries
    // both. An order does come again — and what does not come with it is the
    // message it arrived in the first time: a redelivery is built fresh, with a
    // new envelope identifier. A handler telling a repeat apart by that would
    // read the second hand-over as a new sale and make the goods twice. The
    // order's own identifier is what does not move, and it is what the portal
    // tells a merchant to answer from.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "10",
      DEFAULT_ASYNC_FULFILLMENT_MS: "3000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // A worker that draws its stream and answers nothing, keeping what it was
    // handed rather than only how much of it there was.
    const seen: { readonly message: string; readonly order: string }[] = [];
    let running = true;
    const drawing = (async () => {
      while (running) {
        const { envelopes } = await harnessed.gateway.poll(harnessed.merchant.id, 10, 20);
        for (const envelope of envelopes) {
          if (envelope.kind === "order") {
            seen.push({ message: envelope.id, order: envelope.payload.id });
          }
        }
      }
    })();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1), { timeout: 2_000, interval: 5 });
    running = false;
    await drawing;

    expect(new Set(seen.map((each) => each.order))).toStrictEqual(new Set([orderId]));
    expect(new Set(seen.map((each) => each.message)).size).toBe(seen.length);
  });

  it("stops repeating once the attempts are spent, and leaves the debt behind", async () => {
    // The repeats are not endless. Here the merchant's own deadline is far
    // away — far enough that reaching the ending inside this test can only be
    // the attempt cap — and the money moved at the purchase, so what is left
    // when we stop trying is a debt rather than a free ending.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "5",
      REDELIVERY_MAX_ATTEMPTS: "2",
      DEFAULT_ASYNC_FULFILLMENT_MS: "60000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const silent = workUntilStopped(harnessed, {});
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      { timeout: 2_000, interval: 5 },
    );
    await silent.stop();

    const owing = await state(harnessed, orderId);
    expect(owing?.dispatch.attempts).toBe(2);
    expect(owing?.payment).toBe("settled");
  });

  it("does not send an order again to a merchant who answered the delivery he was given", async () => {
    // A merchant who took the order on has a day to fulfill it. The reminder
    // left against the delivery he answered must not fire behind him, or he
    // would be handed the same order every window until his deadline.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      // Short enough that a redelivery, if one were decided on, would be drawn
      // and answered long before the order's own deadline arrives.
      REDELIVERY_BASE_DELAY_MS: "5",
      // The order's own deadline, and the only thing this test waits for. It is
      // far behind the reminder above so that the reminder has had its whole
      // life by the time the deadline is reached.
      DEFAULT_ASYNC_FULFILLMENT_MS: "150",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const taking = workUntilStopped(harnessed, {
      onOrder: () => ({ accepted: { eta_seconds: 60 } }),
    });

    // The wait is for the order's own deadline to expire, and not for a stretch
    // of wall time. That is the whole difference: a sleep and then "he was not
    // asked again" passes on a machine so loaded that the reminder had not run
    // yet, which is the test agreeing with itself. The deadline is a later
    // reminder on the same queue, so reaching it means the earlier one has been
    // and gone — and on a loaded machine this waits longer rather than
    // concluding sooner, or gives up and says so.
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      { timeout: 5_000, interval: 5 },
    );
    await taking.stop();

    // One hand-over for the whole life of the order. Every repeat is counted
    // here, so a reminder that fired behind the merchant shows up as two.
    const owed = await state(harnessed, orderId);
    expect(owed?.dispatch.attempts).toBe(1);
    expect(owed?.dispatch.accepted).toBe(true);
    expect(owed?.closure).toStrictEqual({
      cause: "deadline_expired",
      deadline: "async_fulfillment",
    });
  });

  it("spends one delivery on one silence, though the same reminder arrives twice", async () => {
    // The queue hands a reminder out again when the process that took it never
    // answered — it died, or the completion never reached the database. That is
    // not a failure mode invented here: reminders are published with the
    // library's own retries, where envelopes are published with none, and the
    // queue adapter's database test watches a taken-and-unanswered reminder
    // come back as the same job carrying the same payload.
    //
    // What must not follow is a second redelivery. Every hand-over is counted
    // against the order's attempt cap, the order closes the moment the cap is
    // reached, and closing an order that has been paid for is a debt: the
    // merchant loses the sale and owes the money back. So a second arrival of
    // one reminder has to cost nothing, or a silence the merchant had once
    // spends two of the deliveries he was owed.
    const harnessed = await started({
      // Long enough that the gateway's own reminder for this hand-over does not
      // fire inside the test: the two arrivals below are the whole of the input.
      HANDLER_ANSWER_MS: "60000",
      REDELIVERY_BASE_DELAY_MS: "5",
      DEFAULT_ASYNC_FULFILLMENT_MS: "60000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // One hand-over, drawn and answered by nobody.
    const handed = await harnessed.gateway.poll(harnessed.merchant.id, 10, 1_000);
    expect(handed.envelopes).toHaveLength(1);
    const handOver = (await harnessed.store.orderById(orderId))?.openDeliveryId ?? null;
    if (handOver === null) {
      throw new Error("the hand-over was not recorded, so there is nothing to remind against");
    }

    // The reminder for that hand-over, and then the same one over again. It is
    // put on the queue twice rather than repeated from inside it because what
    // reaches the gateway is the same either way: one payload, naming one
    // hand-over. The in-memory queue repeats a reminder only when the handler
    // throws, and a handler that got as far as deciding on a redelivery did not
    // throw — so its own repeat is the one path that cannot produce this.
    const unanswered: Reminder = { kind: "delivery_unanswered", orderId, handOver };
    await harnessed.queue.remind(unanswered, 0);
    await vi.waitFor(
      async () =>
        expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(true),
      { timeout: 2_000, interval: 5 },
    );
    await harnessed.queue.remind(unanswered, 0);
    // Long enough for the second arrival to have been dealt with and for
    // anything it decided on to have come off its redelivery delay.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // One silence, one repeat. Two envelopes here is the merchant being asked
    // twice for goods he was asked for once, and two of his five attempts gone.
    const again = await harnessed.gateway.poll(harnessed.merchant.id, 10, 100);
    expect(again.envelopes).toHaveLength(1);
    expect((await state(harnessed, orderId))?.dispatch.attempts).toBe(2);
  });

  it("sends the order again when the next hand-over goes quiet in its turn", async () => {
    // The other side of the guard, and the one an over-eager fix breaks. A
    // hand-over that has been given up on is finished, but the order is not:
    // the redelivery arms a hand-over of its own when it is drawn, and the
    // silence after that one has to be worth another delivery. A guard shut for
    // good would leave the order sitting in `dispatched` with nobody working on
    // it and nothing sending it out again — its attempts would stop at two, and
    // it would run to its deadline instead.
    const harnessed = await started({
      HANDLER_ANSWER_MS: "10",
      REDELIVERY_BASE_DELAY_MS: "5",
      DEFAULT_ASYNC_FULFILLMENT_MS: "60000",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // A worker that draws its stream and answers nothing, silence after silence.
    const silent = workUntilStopped(harnessed, {});
    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.dispatch.attempts).toBeGreaterThan(2),
      { timeout: 2_000, interval: 5 },
    );
    await silent.stop();

    expect((await state(harnessed, orderId))?.state).toBe("dispatched");
  });
});

describe("a timer that fires at the wrong moment", () => {
  it("hands the machine's refusal back rather than closing the order on it", async () => {
    // A stale reminder off the queue, or one for a clock this order never had.
    // Closing an order on it would refund a buyer whose merchant is not late.
    //
    // Which timers the machine refuses is the machine's own subject and is
    // settled in `packages/core`, where the deadline that is not running and
    // the one that has not come due yet are two cases over the transition. What
    // is the gateway's is everything after that word: the refusal reaches the
    // caller as a refusal, carrying the machine's own code and not a code
    // invented here, and nothing at all is written down. A runner that
    // swallowed it would leave a caller told the event was applied and an order
    // that had quietly closed.
    const harnessed = await started();
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
    await harnessed.gateway.deliverOrder(harnessed.merchant.id, orderId, { activation_code: "A" });

    const refused = await harnessed.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      at: harnessed.now() + 1_000_000,
      deadline: "async_fulfillment",
    });

    expect(refused.outcome).toBe("refused");
    if (refused.outcome !== "refused") throw new Error("the stale timer was taken");
    expect(refused.rejection.code).toBe("deadline_not_armed");
    expect((await state(harnessed, orderId))?.state).toBe("delivered");
  });
});

describe("a reminder that could not be carried out", () => {
  it("is asked for again rather than lost in silence", async () => {
    // A reminder is the only thing that ever declares an overdue order, so one
    // dropped on a store that was briefly unreachable is a paid order nobody
    // ever marks for a refund. It is asked for again, and a defect that will
    // never work stops rather than looping.
    const harnessed = await started({
      DEFAULT_ASYNC_FULFILLMENT_MS: "20",
      REDELIVERY_BASE_DELAY_MS: "5",
      REMINDER_ATTEMPTS: "3",
      // The queue takes both of these from the configuration, so a test that
      // set one and watched the other would be asserting against a default.
      REMINDER_RETRY_DELAY_MS: "5",
    });
    const orderId = await bought(harnessed, asyncCard);
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    // The store fails the first two times the reminder tries to move the order.
    const deciding = harnessed.store.withOrder.bind(harnessed.store);
    let failures = 0;
    harnessed.store.withOrder = (async (id: string, change: never) => {
      if (failures < 2) {
        failures += 1;
        throw new Error("the store was briefly unreachable");
      }
      return deciding(id, change);
    }) as typeof harnessed.store.withOrder;

    await vi.waitFor(
      async () => expect((await state(harnessed, orderId))?.state).toBe("refund_due"),
      {
        timeout: 2_000,
        interval: 5,
      },
    );
    expect(failures).toBe(2);
  });
});
