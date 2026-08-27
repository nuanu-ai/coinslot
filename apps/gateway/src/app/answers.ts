/**
 * Turning the machine's answer to a merchant into the document the contract
 * puts on the wire.
 *
 * The two shapes are nearly the same and the difference is the point: the
 * machine says which of three things went wrong, and the contract also carries
 * a sentence a person can read. The sentences live here, once, because an error
 * text is a claim like any other — it is what a merchant's engineer reads at
 * three in the morning — and one written at each call site would drift into
 * three different accounts of the same fact.
 *
 * The answer this file used to be unable to give is the lesson it was written
 * out of. The answer route carries what a handler returned — the goods, a
 * refusal, or an acceptance — and answers in a shape whose success has to name
 * a published result. For a while none of them named a successful acceptance,
 * so the route answered every accepted order with an error explaining, in
 * words, that it had nowhere to put its yes. The words were true and nobody
 * read them: the SDK reports anything that is not a success to the merchant,
 * so every asynchronous order that went through perfectly well left a problem
 * in his log. A gap between two vocabularies is not closed by a sentence
 * apologising for it, and `accepted` is now a word in both.
 */

import type { OrderCallResponse } from "@coinslot/contracts";
import type { MerchantAnswer, MerchantAnswerError } from "@coinslot/core";

const WHY: Record<MerchantAnswerError, string> = {
  refund_already_settled:
    "the buyer has his money back for this order, so there is nothing left to deliver against",
  order_already_closed: "this order reached an ending that no call reopens",
  not_applicable_in_mode:
    "this call does not exist for this card's mode — in the synchronous one the handler's own answer is the delivery and the refusal",
};

export function orderCallResponseOf(answer: MerchantAnswer): OrderCallResponse {
  if (answer.ok) {
    return { ok: true, result: answer.result };
  }
  return {
    ok: false,
    error: { code: answer.error, message: WHY[answer.error], retryable: answer.retryable },
  };
}
