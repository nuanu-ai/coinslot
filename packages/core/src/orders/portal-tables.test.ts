import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOrder } from "./create.js";
import { createInput, must, newOrder, reach, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Order } from "./model.js";
import { MERCHANT_EVENTS } from "./model.js";
import { outcomeFor } from "./outcome.js";

/**
 * The portal's tables are the contract the merchant reads, and the charter
 * makes them test cases of this machine: documentation and code are not
 * allowed to drift apart quietly. Every row below is encoded as a scenario and
 * cited by its own first cell, and the guard at the bottom of this file reads
 * the portal back and fails if the rows moved.
 *
 * What a scenario asserts is the one thing this file is here for: `outcomeFor`,
 * the word the agent is handed for his purchase, checked against the sentence
 * the row gives him. The state the machine moved to, the effects it asked the
 * gateway for and the record it wrote down are `machine.test.ts`'s subject and
 * are pinned there. Asserting them here again cost more than it saved — the
 * same mutation failed in two files at once and neither said which promise it
 * had broken, the portal's or the machine's. Where a row promises something no
 * outcome can express — which event reaches the merchant's subscription,
 * whether a repeat under the same key is safe — the scenario says that too,
 * because nothing else does.
 *
 * The parser is deliberately tiny. It finds the section by its heading, takes
 * the first table in it, and returns one named column of every row. If it ever
 * needs to be cleverer than that, the portal has grown a structure that the
 * tests should be reading differently anyway.
 *
 * A row is pinned by its first cell and no further. That cell says which case
 * the row is about, and pinning it is what enrolls the row: one added, removed
 * or renamed on the portal fails here until somebody decides which scenario it
 * is. The columns after it are the row's prose — where the money is, what the
 * agent is told, what running out of one clock costs — and they were pinned
 * word for word for a while, which made this file the place a copyeditor's
 * semicolon broke the build.
 *
 * What those columns promise is checked as the machine fact it is, in the
 * scenarios above: against `outcomeFor`, against the effects the machine asks
 * the gateway for, against `MERCHANT_EVENTS`. So a sentence that stops being
 * true fails where it is read against the code, and a sentence that says the
 * same thing in other words does not fail at all. Where a cell enumerates more
 * than the scenarios below name — the four ways an order comes to need a
 * refund is the one — the rest is `machine.test.ts`'s to hold, and pinning the
 * sentence here never checked them either. It froze the wording and called it
 * cover.
 */

const ORDERS_PAGE = readFileSync(new URL("../../../../portal/orders.md", import.meta.url), "utf8");
const FAILURES_PAGE = readFileSync(
  new URL("../../../../portal/failures.md", import.meta.url),
  "utf8",
);

function section(page: string, heading: string): string {
  const lines = page.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`the portal has no section "${heading}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * The first cell of every data row of the first table in a section: what each
 * row is about, which is what the scenarios above are named by.
 */
function tableRows(page: string, heading: string): readonly string[] {
  const lines = section(page, heading).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  if (first === -1) throw new Error(`the section "${heading}" has no table`);

  const rows: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    // A row is bounded by a pipe at each end, so splitting it leaves an empty
    // piece on both sides.
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((piece) => piece.trim());
    if (/^:?-+:?$/.test(cells[0] ?? "")) continue;
    rows.push(cells[0] ?? "");
  }
  return rows.slice(1);
}

function headings(page: string): readonly string[] {
  return page
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
}

function paidAsync(): Order {
  return walk(newOrder("async"), [
    { kind: "payment_verified", at: T0 + 1 },
    { kind: "payment_settled", at: T0 + 2 },
    { kind: "order_dispatched", at: T0 + 3 },
    { kind: "handler_accepted", at: T0 + 4 },
  ]);
}

// --- portal/orders.md, "How an order can end" -----------------------------

const ENDINGS = [
  "You delivered the goods",
  "There is none, the parameters did not fit, the payment failed its check — or you refused in the synchronous mode",
  'You answered "I will not deliver" to a request to confirm',
  "Time ran out: no confirmation, no payment or no synchronous delivery arrived",
  "You left",
  "The money was charged and no delivery happened",
  "You delivered synchronously and the payment did not execute",
  "The payment network did not say whether the money was charged",
] as const;

describe('portal/orders.md, "How an order can end"', () => {
  it(`${ENDINGS[0]}: the money is the merchant's, the agent has goods and a receipt`, () => {
    const { order } = must(paidAsync(), { kind: "deliver_called", at: T0 + 60 });

    expect(outcomeFor(order)).toBe("delivered");
  });

  it(`${ENDINGS[1]}: nothing moved, and the agent sees a refusal`, () => {
    // Four different failures, and the row promises the agent one word for all
    // of them. The machine keeps them apart — the merchant's own metrics need
    // the difference — and this is where the four are held to the single word
    // the page gives the buyer. That word is all the agent gets: nothing in the
    // contract carries a refusal's reason to it, which is why the page no
    // longer says it does.
    const noStock = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: false,
    }).order;
    const badParams = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "invalid_params",
      message: "the address does not parse",
    }).order;
    const badPayment = must(newOrder("sync"), {
      kind: "payment_verification_failed",
      at: T0 + 1,
      reason: "signature",
    }).order;
    const refusedInSync = reach("failed");

    for (const order of [noStock, badParams, badPayment, refusedInSync]) {
      expect(outcomeFor(order), `from ${order.state}`).toBe("rejected");
    }
  });

  it(`${ENDINGS[2]}: a refusal, and nothing was charged`, () => {
    expect(outcomeFor(reach("declined"))).toBe("declined");
  });

  it(`${ENDINGS[3]}: the order is closed on time and nothing moved`, () => {
    const noConfirmation = must(reach("awaiting_confirmation"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "confirmation_response",
    }).order;
    const noPayment = must(reach("confirmed"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "payment_after_confirmation",
    }).order;
    const noSyncGoods = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;

    for (const order of [noConfirmation, noPayment, noSyncGoods]) {
      expect(outcomeFor(order)).toBe("expired");
    }
  });

  it(`${ENDINGS[4]}: what was not delivered comes back to the buyer`, () => {
    const free = must(reach("dispatched"), { kind: "merchant_departed", at: T0 + 5 }).order;
    const charged = must(paidAsync(), { kind: "merchant_departed", at: T0 + 5 }).order;

    expect(outcomeFor(free)).toBe("cancelled");
    // The money did move on this one, so the same departure has to reach the
    // agent as a different word: closing it as though nobody owed anything
    // would lose the buyer's money.
    expect(outcomeFor(charged)).toBe("refund_due");
  });

  it(`${ENDINGS[5]}: the money is the merchant's and the order waits for a refund`, () => {
    expect(outcomeFor(reach("refund_due"))).toBe("refund_due");
  });

  it(`${ENDINGS[7]}: the agent is told the outcome is unknown, not that he was refused`, () => {
    // The row's own promise to the agent: "the outcome of the payment is not
    // known", not "refused" — and a repeat under the same key is safe. The two
    // are different answers to an agent deciding whether to go and buy the same
    // thing somewhere else, and the machine may not give the cheaper one when
    // it does not know. This is where that is held: the page can say it in
    // whatever words it likes, and the word the code hands out is checked here.
    const unresolved = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(outcomeFor(unresolved)).toBe("payment_unresolved");
    expect(outcomeFor(unresolved)).not.toBe("rejected");

    // And the row's promise that a repeat with the same key is safe: it costs
    // the buyer nothing, because no second charge is sent over the first.
    const repeated = transition(unresolved, { kind: "purchase_repeated", at: T0 + 1_000_000 });

    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.effects).toStrictEqual([]);
  });

  it(`${ENDINGS[6]}: the money never came, and a repeat drives the payment home`, () => {
    const order = reach("delivered_unpaid");

    expect(outcomeFor(order)).toBe("delivered_unpaid");

    const closed = walk(order, [
      { kind: "purchase_repeated", at: T0 + 6 },
      { kind: "payment_verified", at: T0 + 7 },
      { kind: "payment_settled", at: T0 + 8 },
    ]);

    expect(outcomeFor(closed)).toBe("delivered");
  });

  it(`${ENDINGS[6]}: where the charge went unanswered instead, the repeat waits`, () => {
    // The other half of the portal's "You delivered and the payment did not
    // execute", and the half the page used to leave out. The same merchant
    // event carries both, so the page sends the merchant to the order's own
    // word to tell them apart — and the two words have to be the two below,
    // or a merchant follows the wrong paragraph.
    const { order } = must(reach("fulfilled"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "settle_response",
    });

    // The word the page tells him to read: not `delivered_unpaid`, which is
    // the paragraph above this one and the paragraph with the repeat in it.
    expect(outcomeFor(order)).toBe("in_progress");

    // "A repeat is refused there": no second charge goes out on a guess about
    // the first.
    expect(transition(order, { kind: "purchase_repeated", at: T0 + 1_000_000 }).ok).toBe(false);

    // "If a late answer does arrive and it says the money moved, the order
    // closes as delivered and the agent gets its goods."
    const paid = must(order, { kind: "payment_settled", at: T0 + 2_000_000 });

    expect(outcomeFor(paid.order)).toBe("delivered");

    // "If it says the money did not move, the order becomes one a repeat
    // purchase can close."
    const unpaid = walk(order, [
      { kind: "payment_settle_failed", at: T0 + 2_000_000 },
      { kind: "purchase_repeated", at: T0 + 2_000_001 },
      { kind: "payment_verified", at: T0 + 2_000_002 },
      { kind: "payment_settled", at: T0 + 2_000_003 },
    ]);

    expect(outcomeFor(unpaid)).toBe("delivered");
  });
});

// --- portal/orders.md, "Time ran out" --------------------------------------

const TIMEOUTS = [
  "The agent has the price and is thinking",
  "A request asking whether you will deliver has arrived",
  "The agent owes payment for a confirmed order",
  "You are delivering a synchronous order",
  "You are delivering an asynchronous order",
] as const;

describe('portal/orders.md, "Time ran out"', () => {
  it(`${TIMEOUTS[0]}: the price stops holding`, () => {
    const { order } = must(newOrder("sync"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "quote_expiry",
    });

    expect(outcomeFor(order)).toBe("expired");
  });

  it(`${TIMEOUTS[1]}: the order closes and the buyer's money never moved`, () => {
    const { order } = must(reach("awaiting_confirmation"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "confirmation_response",
    });

    expect(outcomeFor(order)).toBe("expired");
  });

  it(`${TIMEOUTS[2]}: the order closes, the merchant is free and is told so`, () => {
    const { order } = must(reach("confirmed"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "payment_after_confirmation",
    });

    expect(outcomeFor(order)).toBe("expired");
  });

  it(`${TIMEOUTS[3]}: the purchase did not happen, and late goods are not lost`, () => {
    const closed = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;

    expect(outcomeFor(closed)).toBe("expired");

    // The second half of the row, and the one the agent is promised: goods
    // that arrive after the deadline are not thrown away, and a repeat of the
    // purchase collects them.
    const picked = walk(closed, [
      { kind: "handler_delivered", at: T0 + 1_000_000 },
      { kind: "purchase_repeated", at: T0 + 1_000_001 },
      { kind: "payment_verified", at: T0 + 1_000_002 },
      { kind: "payment_settled", at: T0 + 1_000_003 },
    ]);

    expect(outcomeFor(picked)).toBe("delivered");
  });

  it(`${TIMEOUTS[4]}: the money is already the merchant's and a refund is owed`, () => {
    const { order } = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(outcomeFor(order)).toBe("refund_due");
  });
});

// --- portal/orders.md, "Events on the same subscription" -------------------

const EVENTS = [
  "An order was marked as needing a refund",
  "A confirmed order was not paid for",
  "A payment did not execute after a synchronous delivery",
] as const;

describe('portal/orders.md, "Events on the same subscription"', () => {
  it("emits exactly the three events the portal promises, and no others", () => {
    expect(MERCHANT_EVENTS).toStrictEqual([
      "order.refund_due",
      "order.unpaid_after_confirmation",
      "order.payment_failed_after_delivery",
    ]);
  });

  it(`${EVENTS[0]}: sent when the goods did not come in time`, () => {
    const { effects } = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(effects).toContainEqual({ kind: "emit_merchant_event", event: "order.refund_due" });
  });

  it(`${EVENTS[0]}: sent when the merchant left with the money and the goods undelivered`, () => {
    // The third cause in the row, and the one the row used to leave out. A
    // departure closes the open orders, and one that took money and delivered
    // nothing leaves a debt behind exactly as a passed deadline does — so the
    // merchant is owed the same notice, and it is the same event.
    const { effects } = must(paidAsync(), { kind: "merchant_departed", at: T0 + 5 });

    expect(effects).toContainEqual({ kind: "emit_merchant_event", event: "order.refund_due" });
  });

  it(`${EVENTS[1]}: sent when the agent did not pay in his time`, () => {
    const { effects } = must(reach("confirmed"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "payment_after_confirmation",
    });

    expect(effects).toContainEqual({
      kind: "emit_merchant_event",
      event: "order.unpaid_after_confirmation",
    });
  });

  it(`${EVENTS[2]}: sent when the goods went out and the money did not arrive`, () => {
    const { effects } = must(reach("fulfilled"), { kind: "payment_settle_failed", at: T0 + 5 });

    expect(effects).toContainEqual({
      kind: "emit_merchant_event",
      event: "order.payment_failed_after_delivery",
    });
  });
});

// --- portal/failures.md -----------------------------------------------------

const FAILURES = [
  "The price check is silent",
  "You could not deliver",
  "The handler crashed without answering",
  "No answer about the delivery",
  "An order arrived twice",
  "The buyer paid and the answer was lost",
  "The goods ran out",
  "Your side went quiet for a long time",
] as const;

describe("portal/failures.md", () => {
  it(`${FAILURES[0]}: the sale goes on where the money is still ahead of it`, () => {
    const sync = must(newOrder("sync", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    }).order;
    const confirm = must(newOrder("confirm", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    }).order;
    const async = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_silent",
      at: T0 + 1,
    }).order;

    // Two of the three sales go on and the third does not, which is the whole
    // row: where the merchant's live answer still stands between the price and
    // the charge, a second of silence does not cancel a sale that can be made
    // honestly at the card's own price.
    expect(outcomeFor(sync)).toBe("in_progress");
    expect(outcomeFor(confirm)).toBe("in_progress");
    expect(outcomeFor(async)).toBe("rejected");
  });

  it(`${FAILURES[1]}: what a refusal costs depends on when it arrives`, () => {
    const inSync = must(reach("dispatched"), {
      kind: "handler_refused",
      at: T0 + 4,
      code: "cannot_fulfill",
      message: "no",
    }).order;
    const atConfirmation = must(reach("awaiting_confirmation"), {
      kind: "handler_refused",
      at: T0 + 2,
      code: "cannot_fulfill",
      message: "no",
    }).order;
    const afterTheCharge = must(paidAsync(), {
      kind: "refuse_called",
      at: T0 + 5,
      code: "out_of_stock",
      message: "no",
    }).order;

    // The same refusal, three places, and the row is about what each one
    // costs: before the charge the purchase simply did not happen, and after
    // it the buyer is owed his money back.
    expect(outcomeFor(inSync)).toBe("rejected");
    expect(outcomeFor(atConfirmation)).toBe("declined");
    expect(outcomeFor(afterTheCharge)).toBe("refund_due");
  });

  it(`${FAILURES[2]}: the order comes again rather than closing`, () => {
    // An exception is not an answer, so the agent is not told his purchase
    // failed: it is still going, and the order goes back to the merchant.
    const { order } = must(reach("dispatched"), { kind: "handler_undelivered", at: T0 + 4 });

    expect(outcomeFor(order)).toBe("in_progress");
  });

  it(`${FAILURES[3]}: silence ends the same way a refusal does, only on time`, () => {
    const sync = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;
    const async = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    }).order;

    expect(outcomeFor(sync)).toBe("expired");
    expect(outcomeFor(async)).toBe("refund_due");
  });

  it(`${FAILURES[4]}: no second fulfillment and no second charge`, () => {
    const again = must(reach("delivered"), { kind: "order_dispatched", at: T0 + 50 });
    const accepted = must(again.order, { kind: "handler_accepted", at: T0 + 51 });

    expect(outcomeFor(accepted.order)).toBe("delivered");
  });

  it(`${FAILURES[5]}: the repeat gets what is already there`, () => {
    const delivered = reach("delivered");
    const { order } = must(delivered, { kind: "purchase_repeated", at: T0 + 99 });

    expect(outcomeFor(order)).toBe("delivered");
  });

  it(`${FAILURES[6]}: said in time, the buyer's money does not move`, () => {
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: false,
    });

    expect(outcomeFor(order)).toBe("rejected");
  });

  it(`${FAILURES[7]}: the automatic stop is the same pause, switched on for you`, () => {
    // Both halves of the row: no new orders are taken, and the ones already
    // taken play out in the ordinary way.
    const paused = createOrder(createInput("async", { selling: "paused" }));
    expect(paused.ok).toBe(false);

    const delivered = must(paidAsync(), { kind: "deliver_called", at: T0 + 60 });

    expect(outcomeFor(delivered.order)).toBe("delivered");
  });
});

// --- the guard --------------------------------------------------------------

describe("the portal and this machine cannot drift apart quietly", () => {
  it('has exactly the encoded rows in "How an order can end"', () => {
    expect(tableRows(ORDERS_PAGE, "How an order can end")).toStrictEqual([...ENDINGS]);
  });

  it('has exactly the encoded rows in "Time ran out"', () => {
    expect(tableRows(ORDERS_PAGE, "Time ran out")).toStrictEqual([...TIMEOUTS]);
  });

  it('has exactly the encoded rows in "Events on the same subscription"', () => {
    expect(tableRows(ORDERS_PAGE, "Events on the same subscription")).toStrictEqual([...EVENTS]);
  });

  it("has exactly the encoded failure scenarios", () => {
    // The portal's own open-questions section is not a scenario, so it is the
    // one heading this list excludes.
    expect(headings(FAILURES_PAGE).filter((h) => h !== "What is not settled yet")).toStrictEqual([
      ...FAILURES,
    ]);
  });

  it("reads the portal rather than trusting a copy of it", () => {
    // The negative control for the guard itself: a parser that quietly
    // returned nothing would let every check above pass on an empty page.
    expect(tableRows(ORDERS_PAGE, "Time ran out").length).toBe(5);
    expect(() => tableRows(ORDERS_PAGE, "A section that is not here")).toThrowError(/no section/);
    expect(() => tableRows(ORDERS_PAGE, "Test orders")).toThrowError(/no table/);
  });
});
