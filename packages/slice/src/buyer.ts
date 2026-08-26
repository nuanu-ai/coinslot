/**
 * The sandbox buyer: an agent that finds a card, buys it, and reads back what
 * it got.
 *
 * The payment side is the official x402 client, driven exactly as the pilot's
 * own spike drove it: a viem account signs, `x402Client` with the exact-EVM
 * scheme turns a challenge into a signed authorisation, and
 * `wrapFetchWithPayment` makes the two-step exchange — the first request comes
 * back a 402 carrying the challenge, the second carries the signature the
 * client produced from it. None of the protocol is written here; what is
 * written here is which product to buy and what to check about the answer.
 *
 * The money is non-custodial by construction: the challenge names the
 * merchant's own address as where the payment goes, and the buyer signs a
 * transfer to it. On the scripted facilitator nothing moves; on the testnet it
 * is a real Base Sepolia USDC transfer from the buyer's wallet to the
 * merchant's. The buyer's own spend control is a hard ceiling on any single
 * payment, so a challenge for more than the buyer meant to spend is refused
 * before anything is signed.
 */

import { CatalogPageSchema, type PublicCard } from "@coinslot/contracts";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

/** What one purchase came back as, once the x402 exchange is done. */
export interface Bought {
  /** The final HTTP status the resource answered with after the payment. */
  readonly status: number;
  /** The resource's own answer: the goods, or an order and its receipt, or an error. */
  readonly body: unknown;
  /**
   * The settlement receipt the payment layer wrote, where the answer carried
   * one. The synchronous purchase does; the asynchronous one moves the money at
   * the purchase and answers with an order rather than a settlement header.
   */
  readonly settlement: SettleResponse | null;
}

export interface Buyer {
  /** The buyer's public wallet address — never the key, which is never printed. */
  readonly address: string;
  /** Everything offered for sale, held to the real catalog schema. */
  catalog(): Promise<readonly PublicCard[]>;
  /**
   * The payment challenge for a product, read without paying: the GET the
   * validators use produces one, and it names the amount, the asset and the
   * address the money would go to. The smoke's dry run stops here.
   */
  challenge(itemId: string): Promise<PaymentRequired>;
  /** Buys one product by its catalog identifier, walking the x402 exchange. */
  buy(itemId: string, params: Readonly<Record<string, unknown>>): Promise<Bought>;
}

export interface BuyerOptions {
  readonly baseUrl: string;
  /** A throwaway key with no real value; on testnet it holds test USDC only. */
  readonly privateKey: string;
  /** The hard ceiling on any single payment, in US dollars. */
  readonly maxUsd: number;
}

export function makeBuyer(options: BuyerOptions): Buyer {
  const account = privateKeyToAccount(options.privateKey as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  client.setSpendControls({ maxAmountPerPayment: `$${options.maxUsd}` });

  const payFetch = wrapFetchWithPayment((input, init) => fetch(input, init), client);
  const base = options.baseUrl.replace(/\/+$/, "");

  return {
    address: account.address,

    async catalog() {
      const response = await fetch(`${base}/v0/catalog`, {
        headers: { accept: "application/json" },
      });
      const page = CatalogPageSchema.parse(await response.json());
      return page.items;
    },

    async challenge(itemId) {
      const response = await fetch(`${base}/v0/items/${encodeURIComponent(itemId)}/purchase`, {
        headers: { accept: "application/json" },
      });
      const header = response.headers.get("payment-required");
      // The challenge rides in the header; the body is drained rather than left
      // dangling on the socket.
      await response.body?.cancel();
      if (header === null) {
        throw new Error(
          `expected a 402 challenge for ${itemId} but the gateway answered ${response.status} with no PAYMENT-REQUIRED header`,
        );
      }
      return decodePaymentRequiredHeader(header);
    },

    async buy(itemId, params) {
      const response = await payFetch(`${base}/v0/items/${encodeURIComponent(itemId)}/purchase`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ params }),
      });

      const text = await response.text();
      const body: unknown = text === "" ? null : JSON.parse(text);

      const settleHeader = response.headers.get("payment-response");
      const settlement = settleHeader === null ? null : decodePaymentResponseHeader(settleHeader);

      return { status: response.status, body, settlement };
    },
  };
}
