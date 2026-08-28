/**
 * The facilitator, scripted.
 *
 * A test says what the payment layer will answer and then reads back what it
 * was asked. The record of calls is the part that earns its keep: the one thing
 * about money that must never happen is the same order being charged twice,
 * and "it did not happen" is only checkable against a list of what was
 * actually asked for.
 *
 * The default answers are the happy ones. A test that cares about a failure
 * says so; a test about something else should not have to.
 */

import type { PaymentVerificationFailure } from "@coinslot/core";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { Charge, Facilitator, SettleOutcome, VerifyOutcome } from "../../ports/facilitator.js";

/**
 * Who the payment layer would say paid: the wallet the authorisation names,
 * read out of the payment the agent actually sent.
 *
 * The real facilitator answers with the address that signed, and one wallet's
 * two authorisations come back under one address however differently the two
 * were spelled — which is the whole reason a repeat is recognisable as the same
 * buyer's. So this reads the same field the wire carries rather than a
 * convention of its own: a payment header is base64 JSON, and the exact-EVM
 * scheme puts the signer at `payload.authorization.from`. That is one field and
 * this reaches exactly that far; nothing is verified, because this is the
 * sandbox and no signature here is evidence of anything.
 *
 * This used to derive the payer from the shape of the payment string — the part
 * before a `#` or `:` — which no real header has, so every fresh authorisation
 * was a fresh owner and a buyer's own repeat was refused as a stranger's.
 *
 * A payment that will not decode, or one carrying no authorisation, names
 * nobody, and `null` says so. It is not a refusal: the port has a word for a
 * verified payment whose payer is unnamed, the real facilitator answers `null`
 * in the same place when the layer vouches without naming an address, and the
 * gateway's stand-in for it is the payment's own fingerprint. A test that wants
 * a refusal asks for one.
 */
const scriptedPayer = (payment: string): string | null => {
  let signed: unknown;
  try {
    signed = decodePaymentSignatureHeader(payment).payload;
  } catch {
    return null;
  }

  const from = (signed as { authorization?: { from?: unknown } } | undefined)?.authorization?.from;
  return typeof from === "string" ? from : null;
};

export class ScriptedFacilitator implements Facilitator {
  readonly verifies: Charge[] = [];
  readonly settles: Charge[] = [];

  #verifyOutcomes: VerifyOutcome[] = [];
  #settleOutcomes: SettleOutcome[] = [];
  #settlements = 0;
  #verifyGate: Promise<void> | null = null;

  /** The next verification answers this, and the ones after it the last one. */
  willVerify(...outcomes: VerifyOutcome[]): this {
    this.#verifyOutcomes = outcomes;
    return this;
  }

  willRefuseVerification(
    reason: PaymentVerificationFailure,
    message = "refused in the script",
  ): this {
    return this.willVerify({ verified: false, reason, message });
  }

  willSettle(...outcomes: SettleOutcome[]): this {
    this.#settleOutcomes = outcomes;
    return this;
  }

  /**
   * Holds every verification until the returned function is called.
   *
   * A concurrency test uses it to put two presentations of one order past
   * verification at the same instant, so that what decides between them is the
   * ownership guard under the store's lock and not the order the two calls
   * happened to reach the facilitator in.
   */
  holdVerification(): () => void {
    let release: () => void = () => undefined;
    this.#verifyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async verify(charge: Charge): Promise<VerifyOutcome> {
    this.verifies.push(charge);
    if (this.#verifyGate !== null) {
      await this.#verifyGate;
    }
    return next(this.#verifyOutcomes, this.verifies.length, {
      verified: true,
      payer: scriptedPayer(charge.payment),
    });
  }

  async settle(charge: Charge): Promise<SettleOutcome> {
    this.settles.push(charge);
    this.#settlements += 1;
    return next(this.#settleOutcomes, this.#settlements, {
      settled: true,
      transaction: `0xtx${this.#settlements}`,
    });
  }
}

function next<T>(scripted: readonly T[], call: number, fallback: T): T {
  if (scripted.length === 0) {
    return fallback;
  }
  return scripted[Math.min(call, scripted.length) - 1] ?? fallback;
}
