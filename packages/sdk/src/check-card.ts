/**
 * Is this card enough for an agent to buy from?
 *
 * The check is the contracts schema and nothing beside it. A second opinion
 * written here would be a second definition of a complete card, and the day the
 * two disagreed a merchant would pass one and be refused by the other.
 *
 * What the check cannot see is worth stating, because a merchant reading a
 * short list of findings would otherwise assume it is the whole list. A card is
 * checked in two stages: first its shape — which fields are there, what they
 * hold, whether any field was invented — and then the rules that compare one
 * field against another, such as a delivery deadline being allowed only on the
 * modes that wait. The second stage is only reached when the first passes. So a
 * card that failed on its shape may still have a finding waiting behind the
 * ones it was given, and the report says so instead of implying a clean second
 * run. A card that passes has passed both stages and there is nothing behind
 * it.
 *
 * What no local check can decide at all: whether the gateway will accept the
 * card. Publishing is the authority — a currency we do not settle in, a
 * merchant key already in use, a policy nobody has written into a schema — and
 * this check makes no claim about any of that.
 */

import { CardSchema, type PublishError } from "@coinslot/contracts";
import { problemsOf } from "./schema.js";

export interface CardCheck {
  /**
   * Everything wrong with the card that one pass could see, in the shape the
   * publish call answers in. Empty means the card is complete as far as the
   * contract can tell.
   */
  readonly problems: readonly PublishError[];
}

export const checkCard = (card: unknown): CardCheck => {
  const result = CardSchema.safeParse(card);

  return { problems: result.success ? [] : problemsOf(result.error.issues) };
};
