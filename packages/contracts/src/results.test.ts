import { describe, expect, it } from "vitest";
import { OrderCallErrorSchema, PublishErrorSchema, PublishResultSchema } from "./results.js";
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
