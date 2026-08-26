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
  RECOMMENDED_REFUSAL_CODES as WIRE_REFUSAL_CODES,
} from "@coinslot/contracts";
import { describe, expect, it } from "vitest";

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

  it("deliver/refuse errors use the wire's error codes, exactly", () => {
    expect(asSet(MERCHANT_ANSWER_ERRORS)).toStrictEqual(asSet(ORDER_CALL_ERROR_CODES));
  });

  it("fulfillment modes match the card's enum, exactly", () => {
    expect(asSet(FULFILLMENT_MODES)).toStrictEqual(asSet(FulfillmentSchema.options));
  });

  it("recommended refusal codes match, exactly", () => {
    expect(asSet(RECOMMENDED_REFUSAL_CODES)).toStrictEqual(
      asSet(Object.values(WIRE_REFUSAL_CODES)),
    );
  });
});
