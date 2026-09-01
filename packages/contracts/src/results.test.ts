import { describe, expect, it } from "vitest";
import {
  CARD_REJECTED,
  CallErrorSchema,
  ORDER_CALL_ERROR_CODES,
  ORDER_CALL_RESULTS,
  OrderCallResultSchema,
  ProblemSchema,
  PublishResultSchema,
} from "./results.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

describe("what publishing a card returns", () => {
  // The promise: publishing a card never throws. An invalid card comes back as
  // a list of findings, each pointing at a field, so the edit-and-retry loop
  // stays short enough to run from a script.

  it("returns the catalog id when the card is accepted", () => {
    const result = { ok: true, id: "itm_9f2c4a" };
    expect(PublishResultSchema.parse(result)).toStrictEqual(result);
  });

  it("returns findings when the card is not", () => {
    const result = {
      ok: false,
      error: {
        code: CARD_REJECTED,
        message: "this card was not published",
        retryable: false,
        problems: [
          {
            path: ["params", "email", "type"],
            code: "unknown_type",
            message: 'unknown type "date"',
          },
          { path: ["result"], code: "empty_result", message: "a card declares what it delivers" },
        ],
      },
    };
    expect(PublishResultSchema.parse(result)).toStrictEqual(result);
  });

  it("says which of the two it is in one field, and never in both at once", () => {
    // The whole of the envelope's promise: a consumer reads `ok` and knows —
    // in a language where an object under a key would have read as false, and
    // in one where it would not. An answer that is both is not an answer.
    expect(PublishResultSchema.parse({ ok: true, id: "itm_9f2c4a" }).ok).toBe(true);
    expect(
      PublishResultSchema.safeParse({
        ok: true,
        id: "itm_9f2c4a",
        error: {
          code: CARD_REJECTED,
          message: "…",
          retryable: false,
          problems: [{ path: [], code: "x", message: "y" }],
        },
      }).success,
    ).toBe(false);
  });

  it("refuses a refusal with an empty list of findings, and names the field", () => {
    // An empty `problems` says the card was refused and names nothing, which is
    // the one answer a merchant cannot act on. Acceptance has its own branch
    // and does not need to be spelled as "no problems".
    const message = errorOf(PublishResultSchema, {
      ok: false,
      error: { code: CARD_REJECTED, message: "this card was not published", retryable: false },
    });

    expect(message).toContain("problems");

    const emptied = errorOf(PublishResultSchema, {
      ok: false,
      error: {
        code: CARD_REJECTED,
        message: "this card was not published",
        retryable: false,
        problems: [],
      },
    });

    expect(emptied).toContain("problems");
  });

  it("refuses an acceptance that names no catalog id, and names the field", () => {
    // The id is the whole point of the call: it is what the card is known by
    // in catalogs, in orders and in receipts afterwards.
    expect(errorOf(PublishResultSchema, { ok: true })).toContain("id");
  });

  it("refuses an answer that is neither", () => {
    for (const result of [
      {},
      null,
      { id: "itm_9f2c4a" },
      { ok: "itm_9f2c4a" },
      { ok: { id: "itm_9f2c4a" } },
      { errors: [{ path: [], code: "x", message: "y" }] },
    ]) {
      expect(PublishResultSchema.safeParse(result).success, JSON.stringify(result)).toBe(false);
    }
  });

  it("names the refusal in the word a merchant's code branches on", () => {
    // The constant is the wire word and not a label for it: an integration
    // writes `error.code === 'card_rejected'`, so renaming the string is
    // changing the contract even where every call site here still compiles.
    expect(CARD_REJECTED).toBe("card_rejected");
  });

  it("carries a finding that is about the merchant rather than the card", () => {
    // A merchant with no name set for buyers, or no wallet for their sales to
    // be paid into, is refused at the publish under the same code and in the
    // same list — so one answer carries everything standing between this card
    // and the catalog rather than handing it over one round trip at a time.
    const result = {
      ok: false,
      error: {
        code: CARD_REJECTED,
        message: "this card was not published",
        retryable: false,
        problems: [
          { path: [], code: "no_seller_name", message: "set the name you sell under first" },
        ],
      },
    };

    expect(PublishResultSchema.parse(result)).toStrictEqual(result);
  });
});

describe("one finding about what was sent", () => {
  const finding = { path: ["price", "amount"], code: "invalid_amount", message: "not a decimal" };

  it("points at a field, in a code and in words", () => {
    expect(ProblemSchema.parse(finding)).toStrictEqual(finding);
  });

  for (const field of ["path", "code", "message"]) {
    it(`refuses a finding without ${field} and names it`, () => {
      expectMissingFieldRejected(ProblemSchema, finding, field);
    });
  }

  it("says with an empty path that the finding is about the card as a whole", () => {
    // The empty path is a statement, not a missing value: "this is about the
    // card, not about one of its fields". A finding with no path at all would
    // leave the two indistinguishable.
    expect(ProblemSchema.safeParse({ ...finding, path: [] }).success).toBe(true);
  });

  it("refuses a path that is not a list of field names", () => {
    for (const path of ["price.amount", ["price", 0], [null]]) {
      expect(ProblemSchema.safeParse({ ...finding, path }).success, JSON.stringify(path)).toBe(
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

describe("the error codes the calls answer with", () => {
  it("names the ones the merchant is expected to branch on", () => {
    expect([...ORDER_CALL_ERROR_CODES]).toStrictEqual([
      "refund_already_settled",
      "order_already_closed",
      "not_applicable_in_mode",
      "delivery_does_not_match_card",
    ]);
  });

  it("says in the dictionary what each of them means", () => {
    // The description is the only thing a client generated outside TypeScript
    // ever reads about these codes; a code promised in the list and missing
    // from the dictionary is a promise made to nobody. The publish refusal is
    // asked for by name because it belongs to no list of order-call codes and
    // would otherwise be promised in prose and documented nowhere.
    const dictionary = CallErrorSchema.shape.code.meta()?.description ?? "";
    for (const code of [...ORDER_CALL_ERROR_CODES, CARD_REJECTED]) {
      expect(dictionary, code).toContain(code);
    }
  });

  it("still accepts a code outside the promised ones", () => {
    // The list is what we promise to mean the same way, not a gate. An error
    // we have not anticipated has to be able to reach the merchant in words
    // rather than be flattened into the nearest of them.
    expect(
      CallErrorSchema.safeParse({
        code: "gateway_unavailable",
        message: "…",
        retryable: true,
      }).success,
    ).toBe(true);
  });

  it("carries each of them in an error a merchant can act on", () => {
    for (const code of ORDER_CALL_ERROR_CODES) {
      const error = { code, message: "…", retryable: false };
      expect(CallErrorSchema.safeParse(error).success, code).toBe(true);
    }
  });
});

describe("an error from a call that did not go through", () => {
  const error = {
    code: "refund_settled",
    message: "the refund for this order has already been paid out",
    retryable: false,
  };

  it("says whether repeating the call could help", () => {
    expect(CallErrorSchema.parse(error)).toStrictEqual(error);
    expect(CallErrorSchema.parse({ ...error, retryable: true })).toStrictEqual({
      ...error,
      retryable: true,
    });
  });

  for (const field of ["code", "message", "retryable"]) {
    it(`refuses an error without ${field} and names it`, () => {
      expectMissingFieldRejected(CallErrorSchema, error, field);
    });
  }

  it("refuses a retry flag that is not one", () => {
    // The loop above asks about the flag being absent. This is about it being
    // present and unreadable. The point of the flag is to separate "the
    // network dropped, call again, the call is idempotent" from "nothing you
    // do will change this, write the case down", and a truthy string turns one
    // of those into a retry loop and the other into a lost order.
    for (const retryable of ["true", 1, null, "yes"]) {
      expect(
        CallErrorSchema.safeParse({ ...error, retryable }).success,
        JSON.stringify(retryable),
      ).toBe(false);
    }
  });

  it("refuses a blank code or a blank message", () => {
    expect(CallErrorSchema.safeParse({ ...error, code: "" }).success).toBe(false);
    expect(CallErrorSchema.safeParse({ ...error, message: "  " }).success).toBe(false);
  });

  it("carries the findings where the call is refusing what it was handed", () => {
    // The delivery that is not what its card declares is the case this field
    // exists for: the merchant is told which fields did not fit rather than
    // being sent to compare their delivery against the card by hand.
    const misfit = {
      code: "delivery_does_not_match_card",
      message: "the goods are not the ones this card declares",
      retryable: true,
      problems: [{ path: ["access_url"], code: "unexpected_field", message: "not declared" }],
    };

    expect(CallErrorSchema.parse(misfit)).toStrictEqual(misfit);
  });

  it("leaves the findings out where there is nothing to point at", () => {
    // Most failures are about the state of the world rather than about a field
    // of the request, and an empty list beside them would read as "we looked
    // and found nothing wrong with what you sent" — which is not what happened.
    expect(CallErrorSchema.parse(error)).not.toHaveProperty("problems");
  });

  it("refuses an empty list of findings", () => {
    // Present and empty says "here are the things at fault" and names none of
    // them. Absent is how an error says there is nothing to point at.
    expect(CallErrorSchema.safeParse({ ...error, problems: [] }).success).toBe(false);
  });
});
