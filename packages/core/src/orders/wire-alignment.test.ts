/**
 * The seam between the two stage-0 packages, held by a test.
 *
 * Contracts owns the wire vocabulary and the machine follows it — that was
 * the boundary both packages were built against, in parallel, each writing
 * its own literals from the same canon. Parallel work means the seam is
 * exactly where they can drift apart without either package noticing: every
 * suite on both sides stays green while the gateway translates between two
 * dialects at runtime. This file is the only place that reads both.
 *
 * Comparison is by set, not by sequence: each package orders its lists for
 * its own reader (the machine keeps `payment_unresolved` next to `rejected`,
 * where its contrast lives), and a failure over ordering would be a failure
 * about nothing.
 *
 * Contracts is a devDependency of core: the seam is checked at test time and
 * the merchant's tree gains nothing.
 */

import {
  FulfillmentSchema,
  ORDER_CALL_ERROR_CODES,
  ORDER_CALL_RESULTS,
  ORDER_EVENT_TYPES,
  ORDER_STATUSES,
  SELLING_STATES,
  RECOMMENDED_REFUSAL_CODES as WIRE_REFUSAL_CODES,
} from "@nuanu-ai/coinslot-contracts";
import { describe, expect, it } from "vitest";

import { MERCHANT_SELLING } from "./create.js";
import {
  FULFILLMENT_MODES,
  MERCHANT_ANSWER_ERRORS,
  MERCHANT_ANSWER_RESULTS,
  MERCHANT_EVENTS,
  RECOMMENDED_REFUSAL_CODES,
} from "./model.js";
import { ORDER_OUTCOMES } from "./outcome.js";

const asSet = (values: readonly string[]): ReadonlySet<string> => new Set(values);

describe("the wire vocabulary and the machine speak one language", () => {
  it("agent-visible outcomes are the wire's order statuses, exactly", () => {
    expect(asSet(ORDER_OUTCOMES)).toStrictEqual(asSet(ORDER_STATUSES));
  });

  it("merchant events carry the wire's event names, exactly", () => {
    expect(asSet(MERCHANT_EVENTS)).toStrictEqual(asSet(Object.values(ORDER_EVENT_TYPES)));
  });

  it("deliver/refuse answers use the wire's result words, exactly", () => {
    expect(asSet(MERCHANT_ANSWER_RESULTS)).toStrictEqual(asSet(ORDER_CALL_RESULTS));
  });

  it("every error the machine answers with is one the wire knows", () => {
    // A subset and not an equality, which is a real difference and is checked
    // rather than waved at below. The direction that matters is unchanged: a
    // word the machine says and the wire does not know is the gateway
    // translating between two dialects, which is what this file exists to
    // catch. The other direction opened when the machine stopped being the
    // only place a merchant's call is refused — the goods are held to the
    // card that sold them before any event reaches the machine, and the
    // machine knows nothing about cards.
    for (const code of MERCHANT_ANSWER_ERRORS) {
      expect(asSet(ORDER_CALL_ERROR_CODES)).toContain(code);
    }
  });

  it("names the wire's error codes that no arm of the machine can produce", () => {
    // The half the subset above gives up, put back as a list. A code added to
    // the wire that the machine ought to be speaking and is not would
    // otherwise pass unnoticed; here it lands in this list and has to be
    // argued for.
    const machineless = ORDER_CALL_ERROR_CODES.filter(
      (code) => !asSet(MERCHANT_ANSWER_ERRORS).has(code),
    );

    expect(machineless).toStrictEqual(["delivery_does_not_match_card"]);
  });

  it("fulfillment modes match the card's enum, exactly", () => {
    expect(asSet(FULFILLMENT_MODES)).toStrictEqual(asSet(FulfillmentSchema.options));
  });

  it("recommended refusal codes match, exactly", () => {
    expect(asSet(RECOMMENDED_REFUSAL_CODES)).toStrictEqual(
      asSet(Object.values(WIRE_REFUSAL_CODES)),
    );
  });

  it("the words for whether a merchant is selling match, exactly", () => {
    // The pause switch a merchant presses ends up as this input to
    // `createOrder`, and the cabinet shows the same word back. Two lists would
    // mean a screen that says one thing and a machine that does another, with
    // the gateway translating in between and neither package failing.
    expect(asSet(MERCHANT_SELLING)).toStrictEqual(asSet(SELLING_STATES));
  });
});
