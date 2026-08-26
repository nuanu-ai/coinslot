import { describe, expect, it } from "vitest";
import { createOrder } from "./create.js";
import { createInput, TEST_PRICE } from "./fixtures.js";
import {
  CLOSED_ORDER_STATES,
  FULFILLMENT_MODES,
  isOpen,
  modeOf,
  OPEN_ORDER_STATES,
  ORDER_STATES,
} from "./model.js";

describe("the order vocabulary", () => {
  it("splits every state into exactly one of open and closed", () => {
    // The merchant asks us for his unclosed orders after a restart, and the
    // agent asks whether his purchase is over. A state that belongs to both
    // sets, or to neither, makes one of those two answers a lie.
    const open = new Set<string>(OPEN_ORDER_STATES);
    const closed = new Set<string>(CLOSED_ORDER_STATES);

    for (const state of ORDER_STATES) {
      expect(open.has(state) !== closed.has(state), `state ${state}`).toBe(true);
    }
    expect(open.size + closed.size).toBe(ORDER_STATES.length);
  });

  it("reads each published fulfillment mode as a pair of switches", () => {
    // The three modes of the card are not three machines: they are the two
    // switches of `docs/research/16-order-state-machine.md`. If this drifts,
    // a card sold as `sync` starts taking money before the goods exist.
    expect(modeOf("sync")).toStrictEqual({ needsConfirmation: false, settle: "after_fulfillment" });
    expect(modeOf("async")).toStrictEqual({ needsConfirmation: false, settle: "on_purchase" });
    expect(modeOf("confirm")).toStrictEqual({ needsConfirmation: true, settle: "on_purchase" });
    expect(FULFILLMENT_MODES).toStrictEqual(["sync", "async", "confirm"]);
  });

  it("keeps every state that is not a resting place of the purchase open", () => {
    expect(isOpen("dispatched")).toBe(true);
    expect(isOpen("refund_due")).toBe(true);
    expect(isOpen("delivered_unpaid")).toBe(true);
    expect(isOpen("delivered")).toBe(false);
  });
});

describe("creating an order", () => {
  it("asks the merchant for a price when the card carries a price check", () => {
    // Promise to the agent: a card with a live price check is never sold off a
    // stale snapshot without asking first.
    const created = createOrder(createInput("sync", { priceCheck: "merchant" }));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.state).toBe("created");
    expect(created.order.price).toBeNull();
    expect(created.effects).toStrictEqual([{ kind: "request_quote" }]);
  });

  it("prices a static card off its own snapshot and goes straight to a quote", () => {
    // Canon: "статичные товары живут снапшотом без проверки" (ADR-0002 §2).
    const created = createOrder(createInput("sync"));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.state).toBe("quoted");
    expect(created.order.price).toStrictEqual(TEST_PRICE);
    expect(created.order.quoteSource).toBe("card_snapshot");
    expect(created.effects).toStrictEqual([{ kind: "verify_payment" }]);
  });

  it("asks the merchant to confirm before any money when the card needs it", () => {
    const created = createOrder(createInput("confirm"));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.state).toBe("quoted");
    expect(created.effects).toStrictEqual([{ kind: "dispatch_confirmation_request" }]);
  });

  it("carries the test flag through to the order", () => {
    // The handler is entitled to route a test order into its own circuit; it
    // can only do that if the flag survives creation.
    const created = createOrder(createInput("async", { test: true }));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.test).toBe(true);
  });

  it("takes no new order while the merchant is paused", () => {
    // Pause is not leaving: new purchases stop, and that is the whole of it.
    const created = createOrder(createInput("async", { selling: "paused" }));

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.rejection.code).toBe("selling_paused");
  });

  it("takes no new order from a merchant who left", () => {
    const created = createOrder(createInput("async", { selling: "departed" }));

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.rejection.code).toBe("merchant_departed");
  });

  it("starts every order with untouched money and no closure", () => {
    // Nothing in creation may move money or claim an outcome: the fifth gate
    // wants "I do not know yet" to be distinguishable from "I know there is
    // none".
    const created = createOrder(createInput("async"));

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.payment).toBe("none");
    expect(created.order.closure).toBeNull();
    expect(created.order.heldFulfillment).toBe(false);
    expect(created.order.dispatch).toStrictEqual({ attempts: 0, accepted: false });
  });
});
