/**
 * The agent's side of the console, driven one press at a time.
 *
 * `buyer.ts` is the slice's own agent and walks x402 the way an integrator
 * would: `wrapFetchWithPayment` makes the unpaid call, reads the challenge and
 * sends the signed retry, all inside one call. That is the right shape for a
 * smoke test and the wrong one for a console, where the whole point is to stop
 * between the two halves, read what the challenge demands, and only then decide
 * to sign it. So this file drives the same official client — `x402Client` with
 * the exact-EVM scheme, wrapped in `x402HTTPClient` for the header encoding —
 * with the two halves as two calls.
 *
 * It is deliberately not a change to `buyer.ts`. That file says in its own
 * header that it writes none of the protocol, and the smoke and the bootstrap
 * rest on that claim; needing the exchange in two presses is this console's
 * business, not the agent's.
 *
 * Nothing here decides anything. Every method makes one HTTP call and hands
 * back what came of it, including the refusals — a 402 is an answer and so is a
 * 400, and a caller holding a paid order needs to tell them apart from a call
 * that never landed, which is the only thing that throws.
 */

import { CatalogPageSchema, type PublicCard } from "@nuanu-ai/coinslot-contracts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

/** One answer from the wire, whatever it turned out to be. */
export interface Answered {
  readonly status: number;
  readonly body: unknown;
  /** What a payment must satisfy, where the answer was a challenge. */
  readonly challenge: PaymentRequired | null;
  /** What the payment layer signed, where the answer carried a settlement. */
  readonly settlement: SettleResponse | null;
}

/** A challenge in the words a person reads rather than the shape a client signs. */
export interface ChallengeView {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly payTo: string;
  readonly scheme: string;
  /**
   * The order this challenge was issued for, where it was issued for one.
   *
   * A challenge for a card alone — the GET a crawler makes — names no order,
   * because there is none behind it. The difference is the whole reason this
   * console offers two probes rather than one.
   */
  readonly orderId: string | null;
}

export interface StandBuyer {
  readonly address: string;
  /** Everything on sale, as an agent reads it, held to the real catalog schema. */
  catalog(): Promise<readonly PublicCard[]>;
  /** The GET a crawler makes: a challenge for the card alone, opening no order. */
  askPrice(itemId: string): Promise<Answered>;
  /** The unpaid POST: opens an order, and answers with what a payment must satisfy. */
  startPurchase(itemId: string, params: Readonly<Record<string, unknown>>): Promise<Answered>;
  /** Signs a challenge already in hand and sends it, paying that order and no other. */
  payFor(
    itemId: string,
    params: Readonly<Record<string, unknown>>,
    challenge: PaymentRequired,
  ): Promise<Answered>;
  /** Sends a payment header nothing can decode, to see the door refuse it. */
  payBadly(itemId: string, params: Readonly<Record<string, unknown>>): Promise<Answered>;
  /** What became of an order, asked with the order's identifier and nothing else. */
  status(orderId: string): Promise<Answered>;
  /** The address a card is bought at, for copying and for showing. */
  purchasePath(itemId: string): string;
}

export interface StandBuyerOptions {
  readonly baseUrl: string;
  /** A throwaway key with no real value; on testnet it holds test USDC only. */
  readonly privateKey: string;
  /** The hard ceiling on any single payment, in US dollars. */
  readonly maxUsd: number;
  /** The fetch every call goes through, so the console can record the exchange. */
  readonly fetch: typeof fetch;
}

/** Where in a challenge's requirements an order says which order it is. */
const ORDER_ID_IN_EXTRA = "order_id";

/** Reads a challenge into the six things worth putting on a screen. */
export const readChallenge = (challenge: PaymentRequired): ChallengeView | null => {
  const first = challenge.accepts[0];
  if (first === undefined) return null;
  const extra = first.extra as Record<string, unknown> | undefined;
  const order = extra?.[ORDER_ID_IN_EXTRA];
  return {
    amount: first.amount,
    asset: first.asset,
    network: first.network,
    payTo: first.payTo,
    scheme: first.scheme,
    orderId: typeof order === "string" ? order : null,
  };
};

export function makeStandBuyer(options: StandBuyerOptions): StandBuyer {
  const account = privateKeyToAccount(options.privateKey as `0x${string}`);
  const core = new x402Client();
  registerExactEvmScheme(core, { signer: account });
  core.setSpendControls({ maxAmountPerPayment: `$${options.maxUsd}` });
  const http = new x402HTTPClient(core);

  const request = options.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const purchasePath = (itemId: string): string =>
    `/v0/items/${encodeURIComponent(itemId)}/purchase`;
  const purchaseUrl = (itemId: string): string => `${base}${purchasePath(itemId)}`;

  /** Everything an answer turns out to carry, read without throwing on any of it. */
  const answerOf = async (response: Response): Promise<Answered> => {
    const text = await response.text();
    let body: unknown = text === "" ? null : text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // The door answered and what it said was not JSON — a proxy's own error
      // page, most often, which is an answer about the proxy rather than about
      // the order. Kept as the text it arrived as, so it can be shown.
    }
    const header = (name: string): string | null => response.headers.get(name);

    let challenge: PaymentRequired | null = null;
    if (response.status === 402) {
      try {
        challenge = http.getPaymentRequiredResponse(header, body);
      } catch {
        // A 402 whose challenge cannot be decoded is still a 402, and saying so
        // is more use than a stack trace: the status and the body are already
        // on their way to the screen.
      }
    }

    let settlement: SettleResponse | null = null;
    try {
      settlement = http.getPaymentSettleResponse(header);
    } catch {
      // Most answers carry no settlement, which is not a failure. The
      // asynchronous mode moves the money as the order opens and answers with
      // an order rather than a settlement.
    }

    return { status: response.status, body, challenge, settlement };
  };

  const asJson = { "content-type": "application/json", accept: "application/json" };

  return {
    address: account.address,
    purchasePath,

    async catalog() {
      const response = await request(`${base}/v0/catalog`, {
        headers: { accept: "application/json" },
      });
      const page = CatalogPageSchema.parse(await response.json());
      return page.items;
    },

    async askPrice(itemId) {
      return answerOf(
        await request(purchaseUrl(itemId), { headers: { accept: "application/json" } }),
      );
    },

    async startPurchase(itemId, params) {
      return answerOf(
        await request(purchaseUrl(itemId), {
          method: "POST",
          headers: asJson,
          body: JSON.stringify({ params }),
        }),
      );
    },

    async payFor(itemId, params, challenge) {
      const payload = await http.createPaymentPayload(challenge);
      return answerOf(
        await request(purchaseUrl(itemId), {
          method: "POST",
          headers: { ...asJson, ...http.encodePaymentSignatureHeader(payload) },
          body: JSON.stringify({ params }),
        }),
      );
    },

    async payBadly(itemId, params) {
      return answerOf(
        await request(purchaseUrl(itemId), {
          method: "POST",
          headers: { ...asJson, "payment-signature": "this is deliberately not a payment" },
          body: JSON.stringify({ params }),
        }),
      );
    },

    async status(orderId) {
      return answerOf(
        await request(`${base}/v0/orders/${encodeURIComponent(orderId)}/status`, {
          headers: { accept: "application/json" },
        }),
      );
    },
  };
}
