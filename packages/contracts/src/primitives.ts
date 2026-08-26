/**
 * The vocabulary every other contract in this package is built from: a sum of
 * money, a currency, a moment in time, an identifier.
 *
 * Two rules run through the file and are worth stating once.
 *
 * Money never travels as a floating point number. An amount is a decimal
 * string, because 0.1 + 0.2 is not 0.3 in binary floating point and a price is
 * a promise about someone else's money. A merchant who writes "5.00" gets
 * "5.00" back, trailing zero and all, in the order and in the receipt.
 *
 * These schemas bound formats, not business policy. How long a title may be,
 * how far away a deadline may sit, how stale a price may get — those numbers
 * are named before the pilot and belong to the gateway. A number invented here
 * would read as a decision that nobody took. Where a bound belongs to the
 * format itself, it is written down together with the reason.
 */

import { z } from "zod";

/**
 * A decimal number written as text: digits, optionally a dot and more digits.
 *
 * Exponent notation, thousands separators and a leading plus are out, because
 * the same money must always be the same string — a receipt compares badly
 * when "5.00" and "5.0e0" both mean five dollars. Leading zeros go for the
 * same reason. Negative amounts are out because nothing in this contract sells
 * for less than nothing; a refund is a direction, not a sign on a price.
 *
 * The bounds are the format's own. Eighteen fractional digits is the most an
 * ERC-20 token carries, so any stablecoin amount fits exactly; eighteen digits
 * before the dot is past any price a catalog will hold. Beyond that a string
 * of digits is not a price and refusing it early is cheaper than carrying it.
 */
export const AmountSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/,
    'an amount is an exact decimal number written as text, such as "5.00"',
  );

/**
 * A currency code, upper case.
 *
 * Three to eight characters, starting with a letter, digits allowed after it.
 * A card is priced in one currency and settled in another and this contract
 * does not yet say which of the two it carries, so the shape has to admit
 * both: a national code is three letters (`USD`), and a token ticker runs to
 * eight and sometimes carries a digit (`USDC`, `USD1`). Eight is where the
 * tickers in circulation stop; nothing longer is a currency anyone quotes in.
 *
 * What this does not do is check membership in any list. We hold no currency
 * table, and a schema that pretended to would be claiming knowledge the
 * package does not have. Which currencies the gateway accepts is a gateway
 * question, and it is not answered here.
 */
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{2,7}$/, 'a currency code is written in upper case, such as "USD"');

/** A sum of money: how much, in what. */
export const MoneySchema = z.strictObject({
  amount: AmountSchema,
  currency: CurrencyCodeSchema,
});

/**
 * A moment in time, ISO 8601, with its zone.
 *
 * The zone is not decoration. A price is trusted or distrusted by comparing
 * `as_of` with a freshness threshold, and a local time with no offset cannot
 * be compared with anything — it is an hour of the day, not a moment. Both an
 * explicit offset and `Z` are accepted; what a merchant's clock reports is
 * their business, as long as it names a point in time.
 */
export const TimestampSchema = z.iso.datetime({ offset: true });

/**
 * An identifier — ours or the merchant's.
 *
 * Three things are asked of it, and each one is a way an identifier stops
 * identifying. It cannot be blank, because a blank string is what a missing
 * value turns into on its way through a template and an order keyed by "" is
 * an order nobody finds again. It cannot begin or end with whitespace: a
 * merchant's key is what republishing a card matches on, and
 * `"access-monthly "` would look identical to `"access-monthly"` in every log
 * and every screen while quietly creating the second card the portal promises
 * cannot appear. And it carries no control characters, which nothing means to
 * type and which make a key unreadable wherever it is printed.
 *
 * The shape beyond that is deliberately left alone: the merchant's own key is
 * theirs and our own key formats are ours to change. So is the length. A
 * ceiling would be a policy number, and the numbers of this contract are named
 * before the pilot rather than invented here; until then the bound on an
 * identifier is whatever the transport carrying it allows.
 */
const UNPRINTABLE = "\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2060-\\u2064\\ufeff";

export const IdentifierSchema = z.string().regex(
  // One pattern, not three checks, because a rule written as a refinement is
  // dropped from the JSON Schema export without a word — the defect this
  // package has already paid for twice. As a pattern it crosses intact, and a
  // generated client refuses the same keys we do.
  //
  // It reads: a first character that is neither whitespace nor unprintable,
  // then anything printable, then a last character under the same rule as the
  // first. One character on its own is allowed; nothing at all is not.
  new RegExp(`^[^\\s${UNPRINTABLE}](?:[^${UNPRINTABLE}]*[^\\s${UNPRINTABLE}])?$`, "u"),
  "an identifier must not be empty, padded with whitespace, or carry characters that show nothing",
);

/**
 * The price a purchase actually went through at.
 *
 * Four fields because the merchant's handler is meant to write the sale down
 * without looking the card up: the sum and its currency, `at` — when the
 * purchase happened, and `as_of` — the moment the price behind it was true.
 * The two moments differ on purpose. A price checked at 10:15 and bought at
 * 10:20 says so, and in the synchronous mode the payment executes later still.
 *
 * A card sold from its own price and never checked live also carries `as_of`:
 * the moment that card price was last published. That is a fact, not a guess,
 * and it keeps the handler from having to treat a missing field as "fresh".
 */
export const SalePriceSchema = z.strictObject({
  amount: AmountSchema,
  currency: CurrencyCodeSchema,
  at: TimestampSchema,
  as_of: TimestampSchema,
});

export type Amount = z.infer<typeof AmountSchema>;
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type Identifier = z.infer<typeof IdentifierSchema>;
export type SalePrice = z.infer<typeof SalePriceSchema>;
