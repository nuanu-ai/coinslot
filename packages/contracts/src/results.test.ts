import { describe, expect, it } from "vitest";
import {
  ORDER_CALL_ERROR_CODES,
  ORDER_CALL_RESULTS,
  OrderCallErrorSchema,
  OrderCallResultSchema,
  PublishErrorSchema,
  PublishResultSchema,
} from "./results.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

describe("what publishing a card returns", () => {
  // The promise: publishing a card never throws. An invalid card comes back as
  // a list of findings, each pointing at a field, so the edit-and-retry loop
  // stays short enough to run from a script.

  it("returns the catalog id when the card is accepted", () => {
    const result = { ok: { id: "itm_9f2c4a" } };
    expect(PublishResultSchema.parse(result)).toStrictEqual(result);
  });

  it("returns findings when the card is not", () => {
    const result = {
      errors: [
        { path: ["params", "email", "type"], code: "unknown_type", message: 'unknown type "date"' },
        { path: ["result"], code: "empty_result", message: "a card declares what it delivers" },
      ],
    };
    expect(PublishResultSchema.parse(result)).toStrictEqual(result);
  });

  it("refuses a result that is both accepted and refused", () => {
    const message = errorOf(PublishResultSchema, {
      ok: { id: "itm_9f2c4a" },
      errors: [{ path: [], code: "x", message: "y" }],
    });
    expect(message).toContain("ok");
    expect(message).toContain("errors");
  });

  it("refuses a refusal with an empty list of findings", () => {
    // An empty list under `errors` says the card was refused and names
    // nothing, which is the one answer a merchant cannot act on. Acceptance
    // has its own shape and does not need to be spelled as "no errors".
    expect(PublishResultSchema.safeParse({ errors: [] }).success).toBe(false);
  });

  it("refuses an acceptance that names no catalog id", () => {
    // The id is the whole point of the call: it is what the card is known by
    // in catalogs, in orders and in receipts afterwards.
    expect(PublishResultSchema.safeParse({ ok: {} }).success).toBe(false);
  });

  it("refuses an answer that is neither", () => {
    for (const result of [{}, null, { id: "itm_9f2c4a" }, { ok: "itm_9f2c4a" }]) {
      expect(PublishResultSchema.safeParse(result).success, JSON.stringify(result)).toBe(false);
    }
  });
});

describe("one finding about a card", () => {
  const finding = { path: ["price", "amount"], code: "invalid_amount", message: "not a decimal" };

  it("points at a field, in a code and in words", () => {
    expect(PublishErrorSchema.parse(finding)).toStrictEqual(finding);
  });

  for (const field of ["path", "code", "message"]) {
    it(`refuses a finding without ${field} and names it`, () => {
      expectMissingFieldRejected(PublishErrorSchema, finding, field);
    });
  }

  it("says with an empty path that the finding is about the card as a whole", () => {
    // The empty path is a statement, not a missing value: "this is about the
    // card, not about one of its fields". A finding with no path at all would
    // leave the two indistinguishable.
    expect(PublishErrorSchema.safeParse({ ...finding, path: [] }).success).toBe(true);
  });

  it("refuses a path that is not a list of field names", () => {
    for (const path of ["price.amount", ["price", 0], [null]]) {
      expect(PublishErrorSchema.safeParse({ ...finding, path }).success, JSON.stringify(path)).toBe(
        false,
      );
    }
  });
});

describe("what delivering or refusing an order answers with", () => {
  // The promise: the merchant's code branches on these, so they are words we
  // owe them rather than prose we are free to reword. Each one is a different
  // thing to do next, which is why none of them collapses into another.

  it("names every way the call can succeed", () => {
    expect([...ORDER_CALL_RESULTS]).toStrictEqual([
      "accepted",
      "delivered",
      "already_delivered",
      "debt_closed_by_delivery",
      "refused",
      "purchase_already_closed",
    ]);
  });

  it("names a successful acceptance among them, and not among the failures", () => {
    // The promise: a merchant who takes an order on is not told that something
    // went wrong. Every handler answer is posted to the answer route, whose
    // success has to name one of these words; without one for an acceptance
    // the route can only answer ok:false, and a merchant's integration writes
    // that down as a problem with an order that is going through perfectly
    // well. The word being a success rather than an error code is the whole of
    // what makes the difference.
    expect(ORDER_CALL_RESULTS).toContain("accepted");
    expect(ORDER_CALL_ERROR_CODES).not.toContain("accepted");
  });

  it("accepts each of them and nothing else", () => {
    for (const result of ORDER_CALL_RESULTS) {
      expect(OrderCallResultSchema.safeParse(result).success, result).toBe(true);
    }
    for (const result of ["ok", "success", "delivered_twice", ""]) {
      expect(OrderCallResultSchema.safeParse(result).success, JSON.stringify(result)).toBe(false);
    }
  });
});

describe("the error codes those calls answer with", () => {
  it("names the three the merchant is expected to branch on", () => {
    expect([...ORDER_CALL_ERROR_CODES]).toStrictEqual([
      "refund_already_settled",
      "order_already_closed",
      "not_applicable_in_mode",
    ]);
  });

  it("carries each of them in an error a merchant can act on", () => {
    for (const code of ORDER_CALL_ERROR_CODES) {
      const error = { code, message: "…", retryable: false };
      expect(OrderCallErrorSchema.safeParse(error).success, code).toBe(true);
    }
  });

  it("still accepts a code outside the three", () => {
    // The list is what we promise to mean the same way, not a gate. An error
    // we have not anticipated has to be able to reach the merchant in words
    // rather than be flattened into the nearest of three.
    expect(
      OrderCallErrorSchema.safeParse({
        code: "gateway_unavailable",
        message: "…",
        retryable: true,
      }).success,
    ).toBe(true);
  });
});

describe("an error from delivering or refusing an order", () => {
  const error = {
    code: "refund_settled",
    message: "the refund for this order has already been paid out",
    retryable: false,
  };

  it("says whether repeating the call could help", () => {
    expect(OrderCallErrorSchema.parse(error)).toStrictEqual(error);
    expect(OrderCallErrorSchema.parse({ ...error, retryable: true })).toStrictEqual({
      ...error,
      retryable: true,
    });
  });

  for (const field of ["code", "message", "retryable"]) {
    it(`refuses an error without ${field} and names it`, () => {
      expectMissingFieldRejected(OrderCallErrorSchema, error, field);
    });
  }

  it("refuses an error that leaves the merchant to guess whether to retry", () => {
    // The whole point of the flag is to separate "the network dropped, call
    // again, the call is idempotent" from "nothing you do will change this,
    // write the case down". A missing flag turns one of those into a retry
    // loop and the other into a lost order.
    expect(errorOf(OrderCallErrorSchema, { code: error.code, message: error.message })).toContain(
      "retryable",
    );
    for (const retryable of ["true", 1, null, "yes"]) {
      expect(
        OrderCallErrorSchema.safeParse({ ...error, retryable }).success,
        JSON.stringify(retryable),
      ).toBe(false);
    }
  });

  it("refuses a blank code or a blank message", () => {
    expect(OrderCallErrorSchema.safeParse({ ...error, code: "" }).success).toBe(false);
    expect(OrderCallErrorSchema.safeParse({ ...error, message: "  " }).success).toBe(false);
  });
});
