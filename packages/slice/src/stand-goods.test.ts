/**
 * What the stand puts in the boxes.
 *
 * A card declares what it delivers and what it is bought with, and the stand
 * fills both in before anything goes out. Getting it wrong is not cosmetic: a
 * delivery the checks refuse reads on the page as a gateway that would not take
 * the goods, and a purchase missing a parameter reads as a card published
 * wrong. So what is checked here is not the shape of the values but that they
 * survive the very validators the product applies to them, in both directions.
 */

import { type ParamSpec, paramSpecToValidator } from "@nuanu-ai/coinslot-contracts";
import { describe, expect, it } from "vitest";
import { filledFrom } from "./stand-goods.js";

const EVERY_TYPE: ParamSpec = {
  activation_code: { type: "string", title: "The activation code" },
  seats: { type: "integer" },
  weight: { type: "number" },
  refundable: { type: "boolean" },
};

describe("filling a card's declarations", () => {
  it("produces a delivery the delivery check accepts", () => {
    expect(() =>
      paramSpecToValidator(EVERY_TYPE, "delivery").parse(filledFrom(EVERY_TYPE)),
    ).not.toThrow();
  });

  it("produces purchase parameters the purchase check accepts", () => {
    const params: ParamSpec = {
      email: { type: "string", required: true },
      area_code: { type: "string" },
    };

    expect(() => paramSpecToValidator(params, "purchase").parse(filledFrom(params))).not.toThrow();
  });

  it("gives a declared string something, because an empty one is nothing arriving under a name", () => {
    expect(filledFrom({ code: { type: "string" } }).code).not.toBe("");
  });

  it("answers every declared field, not only the required ones", () => {
    const params: ParamSpec = {
      email: { type: "string", required: true },
      note: { type: "string" },
    };

    expect(Object.keys(filledFrom(params))).toEqual(["email", "note"]);
  });

  it("invents no field the card never declared", () => {
    expect(Object.keys(filledFrom(EVERY_TYPE))).toEqual(Object.keys(EVERY_TYPE));
  });

  it("fills nothing where a card declared nothing", () => {
    expect(filledFrom(undefined)).toEqual({});
  });
});
