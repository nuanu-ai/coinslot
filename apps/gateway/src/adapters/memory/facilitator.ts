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
import type { Charge, Facilitator, SettleOutcome, VerifyOutcome } from "../../ports/facilitator.js";

/**
 * Who the payment layer would say paid, faked from the payment itself so a test
 * can model two buyers and a buyer's own repeat without a real signature.
 *
 * The real facilitator returns the address that actually signed the payment;
 * here the payment string stands in for that signature, and the payer is the
 * part of it before a `#` or `:`. So "alice#first" and "alice#second" are one
 * wallet presenting two authorisations — a repeat — while "alice" and "bob" are
 * two different buyers. A payment with neither separator is its own payer.
 */
export const scriptedPayer = (payment: string): string => payment.split(/[#:]/, 1)[0] ?? payment;

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
