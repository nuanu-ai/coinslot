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
 * One answer this file cannot give is written down rather than guessed at, and
 * it is a gap in the contract rather than in the code. The answer route carries
 * what a handler returned — the goods, a refusal, or an acceptance — and it
 * answers in a shape whose success has to name one of five published results.
 * None of them names a successful acceptance. The separate accept call has the
 * shape for that and answers with a bare success; the answer route does not,
 * and inventing a sixth word here would be a wire value no decision stands
 * behind. So an acceptance that arrives on the answer route is recorded and
 * then told, in words, that this contract has nowhere to put its yes.
 */

import type { OrderCallError, OrderCallResponse } from "@coinslot/contracts";
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

/**
 * What an acceptance on the answer route is told. The order has taken it —
 * the merchant will be held to his delivery deadline and not sent the order
 * again for having answered — and the message says so, because a merchant who
 * read this as "your acceptance was lost" would answer again and again.
 */
export const ACCEPTANCE_HAS_NO_WORD: OrderCallError = {
  code: "acceptance_has_no_word_in_this_contract",
  message:
    "the acceptance is recorded and the order is yours to deliver; this call's answer can only name one of five published results and none of them is a successful acceptance, so it cannot say yes. The accept call answers acceptances properly.",
  retryable: false,
};
