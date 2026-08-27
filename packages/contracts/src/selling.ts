/**
 * Whether a merchant is taking new orders.
 *
 * These are wire names for a switch the merchant presses and the order machine
 * reads. The machine keeps the same three words at the birth of an order and
 * refuses to create one for two of them; a second list written anywhere else
 * would be a screen saying one thing while the machine did another, with the
 * gateway translating in between and neither side failing. A test at the seam
 * holds the two lists identical.
 *
 * Three words and not a boolean, because leaving is not a heavier pause. A
 * pause takes the cards off sale and lets the orders already accepted play out;
 * leaving closes those orders and leaves the merchant owing refunds on whatever
 * was paid for and never delivered. A merchant who read one word for both would
 * expect a departure to be undone the way a pause is.
 */

import { z } from "zod";

export const SELLING_STATES = Object.freeze([
  /** Selling: new orders are taken. */
  "open",
  /**
   * Paused: no new order is taken, and the orders already accepted play out in
   * the ordinary way. Nothing about an open order changes when a pause begins.
   */
  "paused",
  /**
   * Gone: the merchant left. Their cards are off sale, the orders that were
   * open closed with them, and the money for anything paid for and not
   * delivered is theirs to return.
   */
  "departed",
] as const);

export const SellingStateSchema = z.enum(SELLING_STATES).meta({
  description:
    'Whether a merchant is taking new orders. "open" — new orders are taken. "paused" — no new order is taken and the orders already accepted play out in the ordinary way, so a pause never closes anything. "departed" — the merchant left, their cards are off sale and the orders that were open closed with them. Leaving is not a heavier pause and is not reachable by pausing.',
});

export type SellingState = z.infer<typeof SellingStateSchema>;
