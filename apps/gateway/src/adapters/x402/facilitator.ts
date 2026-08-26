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
 * Two things are worth reading before this is trusted.
 *
 * A silence is not a no. Both calls answer "unknown" when the facilitator could
 * not be asked or did not answer, and the settle's silence in particular is the
 * one place where money may or may not have moved. Turning either into a
 * refusal here would put a guess where the order machine has a word for not
 * knowing.
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
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
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
      // A timeout here is an indeterminate outcome by the protocol's own
      // account: the facilitator may have completed the settlement. Nothing is
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

/** What an agent accepted, against what we asked for. */
function wrongOffer(
  accepted: { amount?: string; asset?: string; network?: string; payTo?: string } | undefined,
  ours: { amount: string; asset: string; network: string; payTo: string },
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

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
