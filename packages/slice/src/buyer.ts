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
 *
 * One thing here looks like carelessness and is the point of the file. The
 * addresses are written out as strings and the answers are read field by field,
 * where importing the route table and the schemas from `@nuanu-ai/coinslot-contracts`
 * would be shorter and safer. This is a stranger's agent: it has the portal and
 * no package of ours, so code that leaned on our types would prove only that
 * our types agree with themselves. Written this way, a green run says the wire
 * is readable by somebody who was never given anything but the documentation.
 * The catalog page is the exception and is read against the real schema, so
 * that what an agent is handed to choose from is held to its published shape.
 *
 * The risk that buys is silent drift: an address renamed in the contract leaves
 * these strings pointing at nothing, and a 404 inside a poll reads as an order
 * that never arrived. `buyer.test.ts` is what stops that — it drives this buyer
 * against a server that records the request line, and holds every address that
 * went out against the contract's own table. The staple is in the test, where
 * importing the contracts costs nothing, and not here.
 */

import { CatalogPageSchema, type PublicCard } from "@nuanu-ai/coinslot-contracts";
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
  /**
   * The resource's own answer: where the order stands, in the same document
   * the status door answers with — the goods included where the purchase
   * ended in them — or a refusal.
   */
  readonly body: unknown;
  /**
   * The settlement receipt the payment layer wrote, where the answer carried
   * one. The synchronous purchase does; the asynchronous one moves the money at
   * the purchase and answers with an order rather than a settlement header.
   */
  readonly settlement: SettleResponse | null;
}

/**
 * What became of one order, read back through the door that is the agent's.
 *
 * Deliberately smaller and looser than the document the contract publishes,
 * because this is what an outside agent can actually hold: three things read
 * off a JSON body by hand, and the body itself for anything this shape does not
 * name. A field this buyer does not understand is not lost, it is in `body`.
 *
 * Everything here describes an answer that arrived. A call that never landed is
 * not one of these and is thrown instead — the two are different situations for
 * a caller holding a paid order, and collapsing them would hide the one where
 * the door is gone.
 */
export interface OrderStatus {
  /** The HTTP status: 200 for an order the door knows, 404 for one it does not. */
  readonly status: number;
  /**
   * The door's whole answer: the status document, the refusal, or — where what
   * came back was not JSON at all — the text of it exactly as it arrived.
   *
   * The last of those is not hypothetical. A proxy in front of the gateway
   * answers its own bad-gateway page in HTML, and that page is an answer about
   * the proxy rather than about the order. Kept as text, a caller can print it
   * and see what it was; parsed or dropped, it becomes a crash or a silence.
   */
  readonly body: unknown;
  /**
   * Where the order stands, in the door's own word, and null where the answer
   * carried no such word at all — a refusal, an error page, anything else.
   *
   * Null is not an ending and must not be read as one: it says this buyer was
   * not told, which is a different thing from being told the purchase failed.
   */
  readonly state: string | null;
  /** The goods, once they are the buyer's, and null while there are none. */
  readonly delivered: unknown;
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
  /**
   * What became of an order, asked with the order's identifier and nothing
   * else. It is how an agent that bought a product whose goods come later
   * collects them, and knowing the identifier is the whole of the proof
   * (ADR-0011) — this buyer holds no key and sends none.
   *
   * Anything that arrives is data, and that is the whole of the split. An
   * identifier the gateway does not know comes back as the refusal it is; a
   * proxy's error page comes back as its text. Only a call that never landed
   * throws, because for a caller holding a paid order "the door said something
   * I could not read" and "the door is gone" are different situations and want
   * different next moves.
   */
  status(orderId: string): Promise<OrderStatus>;
  /**
   * The address this order's status is read at, without reading it.
   *
   * It exists because the address has to be printable when nothing landed —
   * that is exactly when a caller has to tell somebody where to collect an
   * order it has stopped watching, and it is exactly when there is no answer to
   * take the address off. `status` builds its own request through this, so the
   * address a caller prints is the address that was asked at, and there is one
   * place in this file where that string is written.
   */
  statusUrl(orderId: string): string;
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

  const statusUrl = (orderId: string): string =>
    `${base}/v0/orders/${encodeURIComponent(orderId)}/status`;

  return {
    address: account.address,
    statusUrl,

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

    async status(orderId) {
      const response = await fetch(statusUrl(orderId), {
        headers: { accept: "application/json" },
      });

      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        // The door answered and what it said was not JSON — a proxy's own error
        // page, most often, which is an answer about the proxy and not about
        // the order. It is kept as the text it arrived as rather than thrown,
        // because the caller of this is holding a paid order: a parse failure
        // raised here ends its wait in a stack trace, and the address it owed
        // somebody never gets printed. What cannot be read is reported as not
        // read, which is what `state` being null already means.
        body = text;
      }
      // Read by hand, field by field, the way an agent that has this contract
      // as a page of documentation rather than as a package would read it. A
      // body that is not an object at all, or one whose `status` is not a
      // word, leaves `state` null rather than inventing something to return.
      const document =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const state = typeof document.status === "string" ? document.status : null;

      return {
        status: response.status,
        body,
        state,
        delivered: document.delivered ?? null,
      };
    },
  };
}
