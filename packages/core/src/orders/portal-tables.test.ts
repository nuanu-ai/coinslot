import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOrder } from "./create.js";
import { createInput, must, newOrder, reach, T0, walk } from "./fixtures.js";
import { transition } from "./machine.js";
import type { Effect, Order } from "./model.js";
import { MERCHANT_EVENTS } from "./model.js";
import { outcomeFor } from "./outcome.js";

/**
 * The portal's tables are the contract the merchant reads, and the charter
 * makes them test cases of this machine: documentation and code are not
 * allowed to drift apart quietly. Every row below is encoded as a scenario and
 * cited by its own first cell, and the guard at the bottom of this file reads
 * the portal back and fails if the rows moved.
 *
 * The parser is deliberately tiny. It finds the section by its heading, takes
 * the first table in it, and returns one named column of every row. If it ever
 * needs to be cleverer than that, the portal has grown a structure that the
 * tests should be reading differently anyway.
 *
 * Every column of every table is pinned, not only the one the row is named by.
 * The first cell says which case the row is about; the ones after it are the
 * promise, and the promise is what a merchant acts on and what an agent is
 * quoted. A guard that read the labels alone would let the page keep its rows
 * and change what they say.
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
 * One named cell of every data row of the first table in a section. The
 * column is given by its position, counting from one: the first is what the
 * row is about, and the ones after it are the promise the row makes.
 */
function tableRows(page: string, heading: string, column = 1): readonly string[] {
  const lines = section(page, heading).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  if (first === -1) throw new Error(`the section "${heading}" has no table`);

  const rows: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith("|")) break;
    // A row is bounded by a pipe at each end, so splitting it leaves an empty
    // piece on both sides: a two-column row is four pieces. The row has column
    // N only if there is a piece after the Nth one.
    const pieces = line.split("|");
    if (pieces.length <= column + 1) {
      throw new Error(`the table in "${heading}" has no column ${column}`);
    }
    const cells = pieces.slice(1, -1).map((piece) => piece.trim());
    // Being the separator is a property of the whole row rather than of the
    // cell this call happens to select. Read off one cell, a data row whose
    // selected cell was written as "---" would drop out and shift every promise
    // after it up by one — silently, and into the wrong row.
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    rows.push(cells[column - 1] ?? "");
  }
  return rows.slice(1);
}

function headings(page: string): readonly string[] {
  return page
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
}

function kinds(effects: readonly Effect[]): readonly string[] {
  return effects.map((effect) => effect.kind);
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
  "You left, and the open orders closed",
  "The money was charged and no delivery happened",
  "You delivered synchronously and the payment did not execute",
  "The payment network did not say whether the money was charged",
] as const;

describe('portal/orders.md, "How an order can end"', () => {
  it(`${ENDINGS[0]}: the money is the merchant's, the agent has goods and a receipt`, () => {
    const { order, effects } = must(paidAsync(), { kind: "deliver_called", at: T0 + 60 });

    expect(outcomeFor(order)).toBe("delivered");
    expect(order.payment).toBe("settled");
    expect(kinds(effects)).toContain("release_goods_to_agent");
    expect(kinds(effects)).toContain("issue_receipt");
  });

  it(`${ENDINGS[1]}: nothing moved, the agent sees a refusal with a reason`, () => {
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
      expect(order.payment, `from ${order.state}`).not.toBe("settled");
    }
  });

  it(`${ENDINGS[2]}: a refusal, and nothing was charged`, () => {
    const order = reach("declined");

    expect(outcomeFor(order)).toBe("declined");
    expect(order.payment).toBe("none");
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
      expect(order.payment).not.toBe("settled");
    }
  });

  it(`${ENDINGS[4]}: what was not delivered comes back to the buyer`, () => {
    const free = must(reach("dispatched"), { kind: "merchant_departed", at: T0 + 5 }).order;
    const charged = must(paidAsync(), { kind: "merchant_departed", at: T0 + 5 }).order;

    expect(outcomeFor(free)).toBe("cancelled");
    expect(free.payment).not.toBe("settled");

    // The money did move on this one, so closing it as though nobody owed
    // anything would lose the buyer's money. It is recorded as a debt.
    expect(outcomeFor(charged)).toBe("refund_due");
    expect(charged.closure).toStrictEqual({ cause: "merchant_departed" });
  });

  it(`${ENDINGS[5]}: the money is the merchant's and the order waits for a refund`, () => {
    const order = reach("refund_due");

    expect(outcomeFor(order)).toBe("refund_due");
    expect(order.payment).toBe("settled");
  });

  it(`${ENDINGS[7]}: the agent is told the outcome is unknown, not that he was refused`, () => {
    // The row's own third column, pinned verbatim by the guard at the bottom of
    // this file: "the outcome of the payment is not known", not "refused" — a
    // repeat under the same key is safe. The two are different answers to an
    // agent deciding whether to go and buy the same thing somewhere else, and
    // the machine may not give the cheaper one when it does not know.
    const unresolved = walk(newOrder("async"), [
      { kind: "payment_verified", at: T0 + 1 },
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);

    expect(unresolved.closure).toStrictEqual({ cause: "payment_outcome_unknown" });
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
    expect(order.payment).not.toBe("settled");

    const closed = walk(order, [
      { kind: "purchase_repeated", at: T0 + 6 },
      { kind: "payment_verified", at: T0 + 7 },
      { kind: "payment_settled", at: T0 + 8 },
    ]);

    expect(outcomeFor(closed)).toBe("delivered");
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
    expect(order.payment).toBe("none");
  });

  it(`${TIMEOUTS[1]}: the order closes and the buyer's money never moved`, () => {
    const { order } = must(reach("awaiting_confirmation"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "confirmation_response",
    });

    expect(outcomeFor(order)).toBe("expired");
    expect(order.payment).toBe("none");
  });

  it(`${TIMEOUTS[2]}: the order closes, the merchant is free and is told so`, () => {
    const { order, effects } = must(reach("confirmed"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "payment_after_confirmation",
    });

    expect(outcomeFor(order)).toBe("expired");
    expect(effects).toStrictEqual([
      { kind: "emit_merchant_event", event: "order.unpaid_after_confirmation" },
    ]);
  });

  it(`${TIMEOUTS[3]}: the purchase did not happen, and late goods are not lost`, () => {
    const closed = must(reach("dispatched"), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "sync_response",
    }).order;

    expect(outcomeFor(closed)).toBe("expired");
    expect(closed.payment).not.toBe("settled");

    const late = must(closed, { kind: "handler_delivered", at: T0 + 1_000_000 });

    expect(late.order.heldFulfillment).toBe(true);
    expect(late.effects).toContainEqual({
      kind: "answer_merchant",
      answer: { ok: true, result: "purchase_already_closed" },
    });

    const picked = walk(late.order, [
      { kind: "purchase_repeated", at: T0 + 1_000_001 },
      { kind: "payment_verified", at: T0 + 1_000_002 },
      { kind: "payment_settled", at: T0 + 1_000_003 },
    ]);

    expect(outcomeFor(picked)).toBe("delivered");
  });

  it(`${TIMEOUTS[4]}: the money is already the merchant's and a refund is owed`, () => {
    const { order, effects } = must(paidAsync(), {
      kind: "deadline_expired",
      at: T0 + 999_999,
      deadline: "async_fulfillment",
    });

    expect(outcomeFor(order)).toBe("refund_due");
    expect(order.payment).toBe("settled");
    expect(kinds(effects)).toStrictEqual(["mark_refund_due", "emit_merchant_event"]);
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

    expect(sync.state).toBe("quoted");
    expect(sync.quoteSource).toBe("card_snapshot");
    expect(confirm.state).toBe("quoted");
    expect(async.state).toBe("rejected");
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

    expect(inSync.payment).not.toBe("settled");
    expect(outcomeFor(inSync)).toBe("rejected");
    expect(atConfirmation.payment).toBe("none");
    expect(outcomeFor(afterTheCharge)).toBe("refund_due");
  });

  it(`${FAILURES[2]}: the order comes again rather than closing`, () => {
    const { order, effects } = must(reach("dispatched"), {
      kind: "handler_undelivered",
      at: T0 + 4,
    });

    expect(order.state).toBe("dispatched");
    expect(kinds(effects)).toStrictEqual(["redeliver_order"]);
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

    expect(sync.payment).not.toBe("settled");
    expect(outcomeFor(async)).toBe("refund_due");
  });

  it(`${FAILURES[4]}: no second fulfillment and no second charge`, () => {
    const delivered = reach("delivered");
    const again = must(delivered, { kind: "order_dispatched", at: T0 + 50 });
    const accepted = must(again.order, { kind: "handler_accepted", at: T0 + 51 });

    expect(accepted.order.state).toBe("delivered");
    expect(kinds(again.effects)).toStrictEqual([]);
    // The row promises no second fulfillment and no second charge, not that
    // the merchant hears nothing back: he is answered, and answered with the
    // state the order is already in.
    expect(accepted.effects).toStrictEqual([
      { kind: "answer_merchant", answer: { ok: true, result: "already_delivered" } },
    ]);
  });

  it(`${FAILURES[5]}: the repeat gets what is already there`, () => {
    const delivered = reach("delivered");
    const { order, effects } = must(delivered, { kind: "purchase_repeated", at: T0 + 99 });

    expect(order).toStrictEqual(delivered);
    expect(effects).toStrictEqual([]);
  });

  it(`${FAILURES[6]}: said in time, the buyer's money does not move`, () => {
    const { order } = must(newOrder("async", { priceCheck: "merchant" }), {
      kind: "quote_answered",
      at: T0 + 1,
      available: false,
    });

    expect(order.state).toBe("rejected");
    expect(order.payment).toBe("none");
  });

  it(`${FAILURES[7]}: the automatic stop is the same pause, switched on for you`, () => {
    // No new orders, and the ones already taken play out in the ordinary way.
    const paused = createOrder(createInput("async", { selling: "paused" }));
    expect(paused.ok).toBe(false);

    const open = paidAsync();
    const delivered = must(open, { kind: "deliver_called", at: T0 + 60 });

    expect(delivered.order.state).toBe("delivered");
  });
});

// --- the guard --------------------------------------------------------------

describe("the portal and this machine cannot drift apart quietly", () => {
  it('has exactly the encoded rows in "How an order can end"', () => {
    expect(tableRows(ORDERS_PAGE, "How an order can end")).toStrictEqual([...ENDINGS]);
  });

  it("still says where the money is in each of those endings", () => {
    // The row label alone is not the promise. The middle column is where the
    // page tells the merchant whose money it is, and that is the sentence the
    // scenarios above are written against.
    expect(tableRows(ORDERS_PAGE, "How an order can end", 2)).toStrictEqual([
      "with you",
      "never moved",
      "never moved",
      "never moved",
      "for what was not delivered, [you send it back](/money)",
      "with you",
      "never arrived",
      "not known — we are finding out and will tell you when we do",
    ]);
  });

  it("still tells the agent the same thing about each of those endings", () => {
    // The third column is the sentence the agent is given, and it is the one
    // place in the portal where the machine's refusal to overstate can be
    // undone by an edit: "the outcome is not known" rewritten as "refused"
    // would have the page promise the very claim the code will not make, and
    // the agent would go and buy the same thing again on a wallet already
    // lighter.
    expect(tableRows(ORDERS_PAGE, "How an order can end", 3)).toStrictEqual([
      "the goods and a receipt",
      "a refusal with a reason; the purchase did not happen",
      "a refusal, and nothing was charged",
      "the order was closed on its deadline",
      "the order is closed, the money will come back",
      "the order is waiting for a refund",
      "the purchase did not happen; a repeat drives the payment home",
      '"the outcome of the payment is not known", not "refused": a repeat under the same key is safe',
    ]);
  });

  it('has exactly the encoded rows in "Time ran out"', () => {
    expect(tableRows(ORDERS_PAGE, "Time ran out")).toStrictEqual([...TIMEOUTS]);
  });

  it("still says what running out of each of those times costs", () => {
    // The label names the waiting; the second column is what the merchant is
    // owed and what the buyer paid, and the scenarios above are written against
    // that sentence rather than against the label.
    expect(tableRows(ORDERS_PAGE, "Time ran out", 2)).toStrictEqual([
      "the price no longer holds; if it still wants to buy, it asks for a fresh one",
      "the order closed, and the buyer's money never moved",
      "the order closed and you are free; an event comes to you",
      "the purchase did not happen and nothing was charged; a late delivery is not lost — a repeat collects it",
      "the money is already with you, and the order is marked as needing a refund",
    ]);
  });

  it('has exactly the encoded rows in "Events on the same subscription"', () => {
    expect(tableRows(ORDERS_PAGE, "Events on the same subscription")).toStrictEqual([...EVENTS]);
  });

  it("still says what each of those events means", () => {
    // The event name is the wire word; the second column is what the merchant
    // is told it means, and it is the half he acts on.
    expect(tableRows(ORDERS_PAGE, "Events on the same subscription", 2)).toStrictEqual([
      "you did not deliver in time, or refused after the charge",
      "you answered that you would deliver and the agent did not pay in its own time; you are free",
      "you delivered and the money never arrived",
    ]);
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
    // And a column the table does not have is an error rather than a row of
    // empty strings, which is what a guard against a moved column would
    // otherwise compare itself against.
    expect(() => tableRows(ORDERS_PAGE, "Time ran out", 3)).toThrowError(/no column 3/);
    expect(() => tableRows(ORDERS_PAGE, "How an order can end", 4)).toThrowError(/no column 4/);
  });
});
