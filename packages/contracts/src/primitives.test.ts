import { describe, expect, it } from "vitest";
import {
  AmountSchema,
  CurrencyCodeSchema,
  IdentifierSchema,
  MoneySchema,
  SalePriceSchema,
  TimestampSchema,
} from "./primitives.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

describe("amount", () => {
  // The promise: an amount is an exact decimal number written as text. A
  // consumer that reads an amount and formats it back gets the same string,
  // and no rounding happens on the way.
  it("accepts decimal strings the way a merchant writes prices", () => {
    for (const amount of ["5.00", "0", "0.01", "12", "1999.99", "0.000001"]) {
      expect(AmountSchema.safeParse(amount).success, amount).toBe(true);
    }
  });

  it("carries the eighteen decimals a stablecoin can have", () => {
    expect(AmountSchema.safeParse(`0.${"1".repeat(18)}`).success).toBe(true);
    expect(AmountSchema.safeParse(`0.${"1".repeat(19)}`).success).toBe(false);
  });

  it("refuses a number, because money that travels as a float stops being exact", () => {
    expect(AmountSchema.safeParse(5).success).toBe(false);
    expect(AmountSchema.safeParse(5.0).success).toBe(false);
  });

  it("refuses spellings that are not one exact decimal number", () => {
    // Every entry here is a real way a caller gets it wrong: exponent
    // notation, a thousands separator, a negative price, a padded number that
    // would sit in a receipt as a different string for the same money.
    for (const amount of ["1e3", "5,00", "-1", "05.00", "5.", ".5", "", " 5.00", "5.00 ", "NaN"]) {
      expect(AmountSchema.safeParse(amount).success, JSON.stringify(amount)).toBe(false);
    }
  });

  it("says what it wanted when it refuses", () => {
    expect(errorOf(AmountSchema, "5,00")).toContain("decimal");
  });
});

describe("currency code", () => {
  // The promise: whatever the gateway ends up accepting, the code on the wire
  // is a plain uppercase code, so "USD" and "usd" are never two currencies.
  it("accepts the codes this contract has to carry", () => {
    for (const code of ["USD", "EUR", "USDC", "EURC"]) {
      expect(CurrencyCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it("refuses codes that are not uppercase letter codes", () => {
    for (const code of ["usd", "Usd", "US", "U$D", "US D", "", "TOOLONGCODE"]) {
      expect(CurrencyCodeSchema.safeParse(code).success, JSON.stringify(code)).toBe(false);
    }
  });
});

describe("money", () => {
  const money = { amount: "5.00", currency: "USD" };

  it("accepts an amount with its currency", () => {
    expect(MoneySchema.parse(money)).toStrictEqual(money);
  });

  for (const field of ["amount", "currency"]) {
    it(`refuses money without ${field} and names it`, () => {
      expectMissingFieldRejected(MoneySchema, money, field);
    });
  }

  it("refuses a field it does not know", () => {
    // A price that carries something we ignore is a price we silently
    // truncated. The merchant hears about it here instead of wondering later
    // why the field never arrived anywhere.
    expect(errorOf(MoneySchema, { ...money, currency_symbol: "$" })).toContain("currency_symbol");
  });
});

describe("timestamp", () => {
  // The promise: a moment on the wire is a moment, not a time of day in an
  // unnamed place. `as_of` decides whether we trust a price; a naive local
  // time cannot be compared with a freshness threshold at all.
  it("accepts ISO 8601 moments with a zone", () => {
    for (const moment of [
      "2026-08-26T10:15:00Z",
      "2026-08-26T13:15:00+03:00",
      "2026-08-26T10:15:00.123Z",
      new Date("2026-08-26T10:15:00Z").toISOString(),
    ]) {
      expect(TimestampSchema.safeParse(moment).success, moment).toBe(true);
    }
  });

  it("refuses a moment without a zone, a date alone and free text", () => {
    for (const moment of [
      "2026-08-26T10:15:00",
      "2026-08-26",
      "26.08.2026 10:15",
      "yesterday",
      "",
    ]) {
      expect(TimestampSchema.safeParse(moment).success, JSON.stringify(moment)).toBe(false);
    }
  });

  it("refuses a unix timestamp, which is the tempting wrong answer", () => {
    expect(TimestampSchema.safeParse(1_787_000_000).success).toBe(false);
    expect(TimestampSchema.safeParse("1787000000").success).toBe(false);
  });
});

describe("identifier", () => {
  // The promise: an identifier identifies something. Blank strings are the
  // shape a missing value takes when it travels through a template, and an
  // order keyed by "" is an order nobody can find again.
  it("accepts identifiers from both sides of the contract", () => {
    for (const id of ["ord_7c1e05", "itm_9f2c4a", "access-monthly", "SKU 100/1"]) {
      expect(IdentifierSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("refuses an empty or blank identifier", () => {
    for (const id of ["", " ", "\t", "\n"]) {
      expect(IdentifierSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });

  it("refuses an identifier padded with whitespace", () => {
    // Republishing a card matches on the merchant's own key. A trailing space
    // reads as the same key on every screen and in every log, and would
    // quietly create the second card the portal promises cannot appear.
    for (const id of [" access-monthly", "access-monthly ", "\taccess-monthly", "ord_7c1e05\n"]) {
      expect(IdentifierSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });

  it("refuses an identifier carrying a character that shows nothing", () => {
    // The characters that make the harm real. A trailing space at least looks
    // like something in a monospaced log; a zero-width space is a key that is
    // pixel-for-pixel identical to another one and republishes as a second
    // card the portal promises cannot appear. Refused in the middle too, for
    // the same reason: a zero-width space between two letters of a key leaves
    // it reading exactly like the key without one.
    for (const id of [
      "\u200baccess-monthly",
      "access-monthly\u200b",
      "\u200eaccess-monthly",
      "access-monthly\u2060",
      "\ufeffaccess-monthly",
      "access-monthly\ufeff",
      "acce\u200bss-monthly",
      "acce\ufeffss-monthly",
    ]) {
      expect(IdentifierSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });

  it("still accepts the keys a merchant legitimately writes", () => {
    for (const id of ["SKU 100/1", "тариф-месяц", "item.v2", "a b c", "A"]) {
      expect(IdentifierSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("refuses an identifier carrying control characters", () => {
    for (const id of ["a\u0000b", "a\u0007b", "a\u001fb", "a\u007fb"]) {
      expect(IdentifierSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });
});

describe("sale price", () => {
  // The promise to the merchant's handler: the sum, its currency, when the
  // purchase happened and how fresh the price behind it was. Enough to write
  // the sale down without looking the card up.
  const salePrice = {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  };

  it("accepts a sale price with both moments", () => {
    expect(SalePriceSchema.parse(salePrice)).toStrictEqual(salePrice);
  });

  for (const field of ["amount", "currency", "at", "as_of"]) {
    it(`refuses a sale price without ${field} and names it`, () => {
      expectMissingFieldRejected(SalePriceSchema, salePrice, field);
    });
  }
});
