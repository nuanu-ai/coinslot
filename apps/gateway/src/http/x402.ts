/**
 * The payment protocol at the edge.
 *
 * The pieces here come from the official x402 packages and none of the protocol
 * is written by hand: the challenge and the payment are encoded and decoded by
 * `@x402/core`, and the asset a network is paid in comes from the same table
 * the official server reads. What this file adds is the one thing no library
 * can supply — which order a payment is for.
 *
 * That is also why the all-in-one middleware is not what mounts the purchase.
 * It verifies a payment and settles it around one handler, in one request, and
 * the order machine needs those two apart: in the synchronous mode the payment
 * is verified before the merchant is asked anything and executed only after the
 * goods come back, and in the asynchronous mode the charge goes through at the
 * purchase while the goods arrive hours later. Neither is a shape a
 * verify-handler-settle sandwich can hold. So the protocol comes from the
 * library and the sequence comes from the machine, which is the division
 * ADR-0003 §9 draws: the commodity is bought, the domain is ours.
 *
 * The order identifier travels in `extra` on the requirements the agent
 * accepts, and comes back inside the payment because a payment carries the
 * requirements it was made against. It is a hint and never an authority: the
 * price a payment is checked against is read from our own order, so a payment
 * naming somebody else's order buys nothing.
 */

import { createHash } from "node:crypto";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import type { PaymentConfig } from "../config.js";

/** The x402 version this edge speaks. */
export const X402_VERSION = 2;

/** The header a challenge travels in, and the two the exchange uses. */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
/** What version one of the protocol called the same header. */
export const PAYMENT_SIGNATURE_HEADER_V1 = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** Where in the requirements an order says which order it is. */
export const ORDER_ID_IN_EXTRA = "order_id";

/**
 * A price in the smallest unit the token has, written out exactly.
 *
 * Money never becomes a float on the way through here. A price with more
 * fractional digits than the token carries is refused rather than rounded: a
 * rounded charge is a different charge, and which way it was rounded is the
 * difference between shorting the buyer and shorting the merchant.
 */
export function atomicUnits(amount: string, decimals: number): string {
  const [whole = "0", fraction = ""] = amount.split(".");

  if (fraction.length > decimals) {
    throw new Error(
      `${amount} is written to ${fraction.length} places and this token carries ${decimals}, so there is no exact amount to charge`,
    );
  }

  const written = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return written;
}

/**
 * The currencies a price may be written in, and the one conversion this gateway
 * does make.
 *
 * A card priced in dollars is charged in the network's own dollar-denominated
 * asset, one for one. That is a decision and not the absence of one, so it is
 * written here rather than left to be inferred from the fact that it works: a
 * merchant who writes "USD" is charging their buyer USDC on the configured
 * chain, and the two are held to be the same number of dollars.
 *
 * Everything else is refused. There is no exchange rate anywhere in this
 * system, nobody has decided where one would come from, and a charge based on
 * an invented one would be the clearest possible claim beyond the evidence.
 */
const PAYABLE = new Set(["USD", "USDC"]);

export class PaymentEdge {
  readonly #config: PaymentConfig;
  readonly #baseUrl: string;
  readonly #timeoutSeconds: number;

  constructor(config: PaymentConfig, baseUrl: string, timeoutSeconds: number) {
    this.#config = config;
    this.#baseUrl = baseUrl;
    this.#timeoutSeconds = timeoutSeconds;
  }

  /**
   * What an agent is asked to pay, and which order it is for.
   *
   * The payTo address has no default and none is invented. Without it there is
   * nowhere for the money to go, and a challenge that named an address nobody
   * chose would invite an agent to pay a stranger.
   */
  requirementsFor(
    price: { readonly amount: string; readonly currency: string },
    orderId: string | null,
  ): PaymentRequirements {
    if (!PAYABLE.has(price.currency.toUpperCase())) {
      throw new Error(
        `${price.currency} is not a currency this gateway can charge in, and it will not invent a rate to one that is`,
      );
    }

    const payTo = this.#config.payTo;
    if (payTo === null) {
      throw new Error(
        "there is nowhere to send the money: no payment address is configured, so no payment can be asked for",
      );
    }

    const asset = getDefaultAsset(this.#network());
    return {
      scheme: "exact",
      network: this.#network(),
      asset: asset.asset,
      amount: atomicUnits(price.amount, asset.decimals),
      payTo,
      maxTimeoutSeconds: this.#timeoutSeconds,
      extra: {
        name: asset.name,
        version: asset.version,
        // A challenge issued for one order says which; one issued for a card
        // alone, to a crawler asking what a resource costs, says nothing,
        // because there is no order behind it to name.
        ...(orderId === null ? {} : { [ORDER_ID_IN_EXTRA]: orderId }),
      },
    };
  }

  /** The whole challenge, as the header carries it. */
  challengeFor(
    price: { readonly amount: string; readonly currency: string },
    orderId: string | null,
    path: string,
    description: string,
    why?: string,
  ): string {
    const challenge: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(why === undefined ? {} : { error: why }),
      resource: {
        url: `${this.#baseUrl}${path}`,
        description,
        mimeType: "application/json",
      },
      accepts: [this.requirementsFor(price, orderId)],
    };
    return encodePaymentRequiredHeader(challenge);
  }

  /** The settlement receipt, as the header carries it. */
  receiptHeader(settlement: SettleResponse): string {
    return encodePaymentResponseHeader(settlement);
  }

  #network(): `${string}:${string}` {
    return this.#config.network as `${string}:${string}`;
  }
}

/**
 * A stable fingerprint of the part of a payment the agent actually signed.
 *
 * It is taken over the scheme's own payload — the signature and whatever it
 * covers — and deliberately not over the requirements beside it, because those
 * are the agent's unsigned copy of what we asked for and can be rewritten
 * freely. Two presentations of one authorisation have one fingerprint however
 * the rest of the envelope is edited, which is what makes a payment spendable
 * once.
 *
 * The payload is not read, only serialised in an order that does not depend on
 * how it happened to be written. What is inside it belongs to the protocol.
 */
export function paymentFingerprint(payload: PaymentPayload): string {
  return createHash("sha256")
    .update(stably({ version: payload.x402Version, signed: payload.payload }))
    .digest("hex");
}

/** JSON with its keys in a fixed order, so the same value has one text. */
function stably(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stably).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${stably(held)}`).join(",")}}`;
}

/**
 * What an agent presented, if anything, and which order it says it is for.
 *
 * A payment that will not decode is the same as no payment: the agent is
 * answered with a fresh challenge rather than an error about our parser, which
 * is the answer that lets it try again.
 */
export function presentedPayment(headers: Record<string, string | string[] | undefined>): {
  readonly raw: string;
  readonly payload: PaymentPayload;
  readonly orderId: string | null;
} | null {
  const header =
    headerValue(headers, PAYMENT_SIGNATURE_HEADER) ??
    headerValue(headers, PAYMENT_SIGNATURE_HEADER_V1);
  if (header === undefined) {
    return null;
  }

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return null;
  }

  const named = payload.accepted?.extra?.[ORDER_ID_IN_EXTRA];
  return { raw: header, payload, orderId: typeof named === "string" ? named : null };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const found = headers[name.toLowerCase()];
  return Array.isArray(found) ? found[0] : found;
}
