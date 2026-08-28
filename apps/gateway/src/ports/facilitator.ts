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
  /**
   * The address this order's own merchant is paid at, or nothing where they
   * have set none and the deployment is one that asks for none.
   *
   * It travels with the charge because the requirements a payment is checked
   * against are rebuilt from our own side rather than read out of the payment,
   * and the address is part of them: the agent's copy of it is compared against
   * this, and the facilitator signs off on the pair. Left out, every real
   * payment would be checked against an address nobody was ever offered.
   *
   * It is read at the moment of the charge rather than kept from the challenge,
   * so a merchant who has moved their wallet since the challenge was issued has
   * the payment to the old address refused rather than executed — which is the
   * safe reading of a wallet that moved, since the likeliest reason to move one
   * is that it is no longer the merchant's to spend from.
   */
  readonly payTo: string | null;
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
