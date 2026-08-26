import { describe, expect, it } from "vitest";
import {
  HandlerAnswerSchema,
  RECOMMENDED_REFUSAL_CODES,
  RefusalSchema,
} from "./handler.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

describe("what a handler may answer", () => {
  // The promise: a handler has exactly three final answers, and a temporary
  // failure is none of them. An exception, a dead process or a dropped
  // connection is an order that was not delivered and comes back; a refusal is
  // final and closes the order. Widening this set would blur that line, and a
  // supplier who timed out once would look like a product that cannot be sold.

  it("accepts a delivery", () => {
    const answer = { delivered: { access_url: "https://example.com/a/9f2c4a" } };
    expect(HandlerAnswerSchema.parse(answer)).toStrictEqual(answer);
  });

  it("accepts a refusal", () => {
    const answer = { refused: { code: "out_of_stock", message: "Мест на тарифе нет" } };
    expect(HandlerAnswerSchema.parse(answer)).toStrictEqual(answer);
  });

  it("accepts an order taken on, with or without an estimate", () => {
    expect(HandlerAnswerSchema.parse({ accepted: { eta_seconds: 60 } })).toStrictEqual({
      accepted: { eta_seconds: 60 },
    });
    expect(HandlerAnswerSchema.parse({ accepted: {} })).toStrictEqual({ accepted: {} });
  });

  it("refuses an answer that says two things at once", () => {
    // Delivered and refused at the same time is not an answer we can act on,
    // and picking one of them for the merchant would be picking what happens
    // to someone's money.
    const message = errorOf(HandlerAnswerSchema, {
      delivered: { access_url: "https://example.com/a" },
      refused: { code: "out_of_stock", message: "нет" },
    });
    expect(message).toContain("delivered");
    expect(message).toContain("refused");
    expect(message).toContain("accepted");
  });

  it("refuses an answer that is none of the three", () => {
    for (const answer of [{}, { ok: true }, null, "delivered", { delivery: {} }]) {
      expect(HandlerAnswerSchema.safeParse(answer).success, JSON.stringify(answer)).toBe(false);
    }
  });

  it("refuses a delivery that is not shaped like a card's result", () => {
    // The delivery is handed to the agent as it is, against the result the
    // card declared. A bare string has no field names to check against it.
    for (const delivered of ["https://example.com/a", 42, null, ["a"]]) {
      expect(HandlerAnswerSchema.safeParse({ delivered }).success, JSON.stringify(delivered)).toBe(
        false,
      );
    }
  });

  it("refuses an estimate that is not a whole number of seconds", () => {
    for (const eta of [-1, 0, 1.5, "60"]) {
      expect(
        HandlerAnswerSchema.safeParse({ accepted: { eta_seconds: eta } }).success,
        JSON.stringify(eta),
      ).toBe(false);
    }
  });
});

describe("a refusal", () => {
  const refusal = { code: "out_of_stock", message: "Поставщик не подтвердил номер" };

  it("carries a code we read and a reason a person reads", () => {
    expect(RefusalSchema.parse(refusal)).toStrictEqual(refusal);
  });

  for (const field of ["code", "message"]) {
    it(`refuses a refusal without ${field} and names it`, () => {
      expectMissingFieldRejected(RefusalSchema, refusal, field);
    });
  }

  it("accepts a code no dictionary of ours contains", () => {
    // The set is open on purpose: a merchant whose reason fits none of ours
    // says so in their own word rather than flattening it into the nearest
    // approximation. What they lose by doing that is the availability metric,
    // which only `out_of_stock` feeds — and that is a documented trade, not a
    // validation error.
    for (const code of ["supplier_declined", "kyc_required", "route_unavailable"]) {
      expect(RefusalSchema.safeParse({ ...refusal, code }).success, code).toBe(true);
    }
  });

  it("refuses a blank code or a blank reason", () => {
    // A refusal with no code is a refusal nobody can count, and one with no
    // reason leaves the person who picks up the case with nothing to read.
    expect(RefusalSchema.safeParse({ ...refusal, code: "" }).success).toBe(false);
    expect(RefusalSchema.safeParse({ ...refusal, code: "  " }).success).toBe(false);
    expect(RefusalSchema.safeParse({ ...refusal, message: "" }).success).toBe(false);
  });

  it("refuses a code that is not text", () => {
    expect(RefusalSchema.safeParse({ ...refusal, code: 404 }).success).toBe(false);
  });

  it("names three codes we understand the same way the merchant does", () => {
    expect(Object.values(RECOMMENDED_REFUSAL_CODES)).toStrictEqual([
      "out_of_stock",
      "invalid_params",
      "cannot_fulfill",
    ]);
    for (const code of Object.values(RECOMMENDED_REFUSAL_CODES)) {
      expect(RefusalSchema.safeParse({ ...refusal, code }).success, code).toBe(true);
    }
  });
});
