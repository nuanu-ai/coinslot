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

export class ScriptedFacilitator implements Facilitator {
  readonly verifies: Charge[] = [];
  readonly settles: Charge[] = [];

  #verifyOutcomes: VerifyOutcome[] = [];
  #settleOutcomes: SettleOutcome[] = [];
  #settlements = 0;

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

  async verify(charge: Charge): Promise<VerifyOutcome> {
    this.verifies.push(charge);
    return next(this.#verifyOutcomes, this.verifies.length, { verified: true, payer: "0xpayer" });
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
