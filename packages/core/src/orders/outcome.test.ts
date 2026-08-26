import { describe, expect, it } from "vitest";
import { reach, T0, walk } from "./fixtures.js";
import type { OrderState } from "./model.js";
import { ORDER_STATES } from "./model.js";
import { ORDER_OUTCOMES, outcomeFor } from "./outcome.js";

/**
 * The projection an agent reads. The promise it carries is the fifth gate: the
 * status says exactly what the machine knows, and "I do not know yet" has to be
 * a different word from "I know there is none".
 */
describe("what the agent is told an order came to", () => {
  it("says the answer is not in yet while the order is still moving", () => {
    const inFlight: readonly OrderState[] = [
      "created",
      "quoted",
      "awaiting_confirmation",
      "confirmed",
      "paid",
      "dispatched",
      "fulfilled",
    ];

    for (const state of inFlight) {
      expect(outcomeFor(reach(state)), `an order in ${state}`).toBe("in_progress");
    }
  });

  it("never leaves an order without an outcome", () => {
    for (const state of ORDER_STATES) {
      expect(ORDER_OUTCOMES, `an order in ${state}`).toContain(outcomeFor(reach(state)));
    }
  });

  it("tells a refusal apart from a deadline, and both from a confirmation refused", () => {
    // Three rows of the portal's table of endings, and they are three
    // different sentences to the agent: a refusal with a reason, an order
    // closed on time, and a merchant who said he would not fulfill.
    expect(outcomeFor(reach("failed"))).toBe("rejected");
    expect(outcomeFor(reach("rejected"))).toBe("rejected");
    expect(outcomeFor(reach("expired"))).toBe("expired");
    expect(outcomeFor(reach("declined"))).toBe("declined");
  });

  it("leaves the order able to say what the agent's one word cannot", () => {
    // The agent gets one word for both, and that word says the purchase did
    // not happen. What the machine actually knows is different in the two
    // cases — one charge was reported as failed, the other never reported at
    // all — and the order has to go on carrying that difference for the
    // dispute, the error text and the merchant's reconciliation that read it.
    const silent = walk(reach("fulfilled"), [
      { kind: "deadline_expired", at: T0 + 999_999, deadline: "settle_response" },
    ]);
    const reported = walk(reach("fulfilled"), [{ kind: "payment_settle_failed", at: T0 + 5 }]);

    expect(outcomeFor(silent)).toBe(outcomeFor(reported));
    expect(silent.payment).not.toBe(reported.payment);
  });

  it("shows the two endings where money is owed as what they are", () => {
    expect(outcomeFor(reach("refund_due"))).toBe("refund_due");
    expect(outcomeFor(reach("delivered_unpaid"))).toBe("delivered_unpaid");
    expect(outcomeFor(reach("refunded"))).toBe("refunded");
  });

  it("calls a success a success only once the money has actually moved", () => {
    const delivered = reach("delivered");

    expect(outcomeFor(delivered)).toBe("delivered");
    expect(delivered.payment).toBe("settled");
  });

  it("does not call a purchase closed by the merchant's departure a refusal", () => {
    expect(outcomeFor(reach("cancelled"))).toBe("cancelled");
  });

  it("changes its answer the moment a late delivery closes a debt", () => {
    const closed = walk(reach("refund_due"), [{ kind: "deliver_called", at: T0 + 999 }]);

    expect(outcomeFor(closed)).toBe("delivered");
  });
});
