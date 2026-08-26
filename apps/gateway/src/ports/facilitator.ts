/**
 * The payment facilitator: the two questions the gateway asks about money.
 *
 * Verification and execution are separate calls here because the order machine
 * leans on the gap between them. In the synchronous mode the payment is
 * verified before the order goes to the merchant and executed only after the
 * goods come back, which is the literal reading of "a refusal costs the buyer
 * nothing"; in the asynchronous mode both happen before the merchant sees
 * anything. A port that folded them into one call could serve neither.
 *
 * Three outcomes, not two, and the third is the point. "I could not find out"
 * is a different fact from "no", and the difference is worth someone's money:
 * an agent told his purchase did not happen goes and buys the same thing
 * elsewhere without checking his wallet. So neither call throws on a silence
 * and neither invents an answer. The machine already has the words for it — a
 * charge whose outcome is unknown, and the deadline that declares one — and
 * the executor's job is to hand it the silence unchanged rather than round it
 * to the nearest verdict.
 */

import type { PaymentVerificationFailure } from "@coinslot/core";

/**
 * One charge, as the payment layer needs to see it. The payment is the thing
 * the agent presented, verbatim and unread by us: what is inside it belongs to
 * the protocol and to the facilitator, and a gateway that took it apart would
 * be a second implementation of somebody else's specification.
 */
export interface Charge {
  readonly orderId: string;
  readonly amount: string;
  readonly currency: string;
  /** What the agent presented, exactly as it arrived. */
  readonly payment: string;
}

export type VerifyOutcome =
  | { readonly verified: true; readonly payer: string | null }
  | {
      readonly verified: false;
      readonly reason: PaymentVerificationFailure;
      readonly message: string;
    }
  /** The facilitator could not be asked, or did not answer. Nothing is claimed. */
  | { readonly verified: "unknown"; readonly message: string };

export type SettleOutcome =
  | { readonly settled: true; readonly transaction: string }
  | { readonly settled: false; readonly reason: string }
  /**
   * The charge was asked for and nothing came back. The money may have moved
   * and may not. Nobody is told either way, and no second charge is sent: only
   * the payment layer can end this, by finally answering.
   */
  | { readonly settled: "unknown"; readonly reason: string };

export interface Facilitator {
  verify(charge: Charge): Promise<VerifyOutcome>;
  settle(charge: Charge): Promise<SettleOutcome>;
}
