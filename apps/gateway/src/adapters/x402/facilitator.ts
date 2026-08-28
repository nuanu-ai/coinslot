/**
 * The facilitator, over HTTP, through the official client.
 *
 * The two calls are the library's — `@x402/core` carries the request shapes,
 * the retries and the timeouts — and what is added here is the part no library
 * can know: which order a payment is for, and therefore what it should have
 * been paid against. The requirements handed to the facilitator are rebuilt
 * from our own order rather than taken from the payment, so a payment made
 * against a price the agent invented is checked against the price we issued and
 * fails, which is the point.
 *
 * Three things are worth reading before this is trusted.
 *
 * A silence is not a no. Both calls answer "unknown" when the facilitator could
 * not be asked or did not answer, and the settle's silence in particular is the
 * one place where money may or may not have moved. Turning either into a
 * refusal here would put a guess where the order machine has a word for not
 * knowing.
 *
 * A no is not a silence either, and that is the other half of the same rule.
 * The facilitator sends some of its verdicts with a refusing status, and the
 * client raises those rather than returning them; read as silences they would
 * leave an agent waiting on an answer that already arrived. So a 4xx carrying
 * the facilitator's own verdict is read as the verdict it is, and everything
 * else — a 5xx, a timeout, a connection that was never made — stays a silence.
 * `refused` below is where that line is drawn and why.
 *
 * And the reason a verification failed is a best fit rather than a fact. The
 * order machine takes one of three reasons; a facilitator returns an open set
 * of strings and adds to it. The string it actually sent is kept in the message
 * and the closest of the three is chosen for the code, so the record is a
 * little coarser than what happened — never wrong about whether the payment was
 * refused, only about which of three shapes the refusal had.
 */

import type { PaymentVerificationFailure } from "@coinslot/core";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import {
  SettleError,
  type SettleResponse,
  VerifyError,
  type VerifyResponse,
} from "@x402/core/types";
import type { PaymentEdge } from "../../http/x402.js";
import type { Charge, Facilitator, SettleOutcome, VerifyOutcome } from "../../ports/facilitator.js";

export class X402Facilitator implements Facilitator {
  readonly #client: FacilitatorClient;
  readonly #edge: PaymentEdge;

  constructor(client: FacilitatorClient, edge: PaymentEdge) {
    this.#client = client;
    this.#edge = edge;
  }

  async verify(charge: Charge): Promise<VerifyOutcome> {
    const asked = this.#asked(charge);
    if (asked === null) {
      return {
        verified: false,
        reason: "signature",
        message: "the payment presented could not be read as a payment at all",
      };
    }

    const mismatch = wrongOffer(asked.payload.accepted, asked.requirements);
    if (mismatch !== null) {
      // The agent paid against something other than what we asked for. It never
      // reaches the facilitator: whatever it would say, this is not a payment
      // for this order.
      return { verified: false, reason: "price_stale", message: mismatch };
    }

    let answered: VerifyResponse;
    try {
      answered = await this.#client.verify(asked.payload, asked.requirements);
    } catch (thrown) {
      // A facilitator that judged the payment and said so with a refusing
      // status has answered, and the answer is the same one it sends with a
      // 200. Reported as a silence it would leave an agent waiting on a verdict
      // that already arrived.
      if (thrown instanceof VerifyError && refused(thrown.statusCode)) {
        const said = thrown.invalidMessage ?? thrown.invalidReason ?? "no reason was given";
        return { verified: false, reason: shapeOf(thrown.invalidReason), message: said };
      }
      return { verified: "unknown", message: describe(thrown) };
    }

    if (answered.isValid) {
      return { verified: true, payer: answered.payer ?? null };
    }
    const said = answered.invalidMessage ?? answered.invalidReason ?? "no reason was given";
    return { verified: false, reason: shapeOf(answered.invalidReason), message: said };
  }

  async settle(charge: Charge): Promise<SettleOutcome> {
    const asked = this.#asked(charge);
    if (asked === null) {
      throw new Error(
        `the charge on ${charge.orderId} was to be executed and the payment kept for it cannot be read`,
      );
    }

    let answered: SettleResponse;
    try {
      answered = await this.#client.settle(asked.payload, asked.requirements);
    } catch (thrown) {
      // A charge the facilitator turned away is a charge that did not happen:
      // it refused the request rather than failing inside one, so no money
      // moved. The spike met one of these — `self_send_not_allowed`, a payer
      // paying himself — and held as a silence it would park an order waiting
      // on an answer that had already come.
      if (thrown instanceof SettleError && refused(thrown.statusCode)) {
        return {
          settled: false,
          reason: thrown.errorMessage ?? thrown.errorReason ?? "no reason was given",
        };
      }
      // Everything else is a silence, and the difference is where the money
      // is. A timeout is an indeterminate outcome by the protocol's own
      // account, and so is a facilitator failing inside itself: either may have
      // completed the settlement before it stopped answering. Nothing is
      // claimed and no second charge is sent.
      return { settled: "unknown", reason: describe(thrown) };
    }

    if (answered.success) {
      return { settled: true, transaction: answered.transaction };
    }
    return {
      settled: false,
      reason: answered.errorMessage ?? answered.errorReason ?? "no reason was given",
    };
  }

  #asked(charge: Charge) {
    try {
      return {
        payload: decodePaymentSignatureHeader(charge.payment),
        requirements: this.#edge.requirementsFor(charge, charge.orderId),
      };
    } catch {
      return null;
    }
  }
}

/**
 * What an agent accepted, against what we asked for.
 *
 * Every field here is the agent's own unsigned copy of our requirements, so
 * none of it is evidence of anything — a payment that passes this check has
 * only shown that the agent copied our offer down accurately. What actually
 * binds a payment to an order is the claim taken on it before any of this runs,
 * and what binds it to an amount is the signature the facilitator checks
 * against the requirements we rebuilt. This is the cheap early refusal of a
 * request that was never going to work.
 */
function wrongOffer(
  accepted:
    | {
        amount?: string;
        asset?: string;
        network?: string;
        payTo?: string;
        extra?: Record<string, unknown>;
      }
    | undefined,
  ours: {
    amount: string;
    asset: string;
    network: string;
    payTo: string;
    extra: Record<string, unknown>;
  },
): string | null {
  if (accepted === undefined) {
    return "the payment names no offer, so there is nothing to check it against";
  }
  if (accepted.amount !== ours.amount) {
    return `this order is priced at ${ours.amount} and the payment was made for ${accepted.amount ?? "nothing"}`;
  }
  if (accepted.asset !== ours.asset || accepted.network !== ours.network) {
    return "the payment was made in a different asset or on a different chain from the one asked for";
  }
  if (accepted.payTo !== ours.payTo) {
    return "the payment was made out to a different address from the one asked for";
  }
  if (accepted.extra?.order_id !== ours.extra.order_id) {
    return "the payment was made against a different order from the one it was presented for";
  }
  return null;
}

/**
 * The closest of the machine's three reasons to what the facilitator said.
 *
 * The facilitator's set is open and grows; these are the shapes seen so far.
 * An unrecognised reason is recorded as a refused authorisation, which is what
 * every one of them is at bottom, and the string itself travels in the message.
 */
function shapeOf(reason: string | undefined): PaymentVerificationFailure {
  const said = (reason ?? "").toLowerCase();
  if (said.includes("funds") || said.includes("balance") || said.includes("revert")) {
    return "insufficient_funds";
  }
  if (said.includes("authorization_value") || said.includes("amount") || said.includes("expired")) {
    return "price_stale";
  }
  return "signature";
}

/**
 * Whether a status carries the facilitator's own decision about this request,
 * as opposed to news about the facilitator.
 *
 * This is the line that decides which failures are answers and which are
 * silences, and it is drawn at the one place HTTP already draws it: a 4xx is
 * the facilitator declining the request, a 5xx is the facilitator failing
 * inside one. A decline happened before anything moved; a failure may have
 * happened after.
 *
 * Only a body the facilitator wrote in the shape of a verdict reaches either
 * branch — the client throws its structured error only when the failing
 * response parses as a verify or settle response — so a proxy's HTML error page
 * or a rate limiter's empty 429 is a plain throw and stays a silence. What is
 * being read here is a facilitator that answered, not a status seen on its own.
 *
 * The line is inferred from what the statuses mean, not measured against
 * Coinbase's facilitator: no test here has ever spoken to one. If it turns out
 * to answer a definite refusal with a 5xx, this reads that as "nobody knows",
 * which is the safe direction to be wrong in — an order waits for a person
 * instead of a buyer being told something false about his money.
 */
function refused(status: number): boolean {
  return status >= 400 && status < 500;
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
