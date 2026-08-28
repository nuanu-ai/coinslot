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
import type { BazaarDeclaration, Card } from "@coinslot/contracts";
import { API_ROUTES, bazaarDeclarationOf, expandPath } from "@coinslot/contracts";
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
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { isSandboxFacilitator, type PaymentConfig } from "../config.js";

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
   * What an agent is asked to pay, whose address it is paid to, and which order
   * it is for.
   *
   * The address is the merchant's own, and that is the whole of the payment
   * arrangement this gateway has: the agent pays the seller directly, nothing
   * passes through us, and there is no moment at which a merchant's money is
   * ours (ADR-0019). So the address comes in from the card's own merchant
   * rather than out of our configuration, and a challenge for one merchant's
   * product can never name another's address, because there is no other address
   * in reach of this call.
   *
   * A merchant with none is refused rather than defaulted. The gateway does
   * have an address in its configuration, and it is the operator's: standing it
   * in here would send a merchant's takings to somebody else, in a payment that
   * settles on a chain and cannot be called back, with nobody the wiser. The
   * one place it is used is the sandbox, which settles against nothing — no
   * chain, no money — and where the address is a placeholder a challenge has to
   * name rather than a destination.
   *
   * Nothing reaches here without an address on a deployment that settles for
   * real: the publish door refuses a merchant who has set none, and a wallet
   * cannot be taken away once set. The throw is what that promise is worth if
   * it is ever wrong, and it says which of the two silences it is.
   */
  requirementsFor(
    price: { readonly amount: string; readonly currency: string },
    orderId: string | null,
    payoutWallet: string | null,
  ): PaymentRequirements {
    if (!PAYABLE.has(price.currency.toUpperCase())) {
      throw new Error(
        `${price.currency} is not a currency this gateway can charge in, and it will not invent a rate to one that is`,
      );
    }

    const payTo = payoutWallet ?? this.#sandboxPlaceholder();

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

  /**
   * The canonical address of one product, which is what a listing is keyed on.
   *
   * It is built from the configured base and the route table, never from the
   * request. Behind a reverse proxy that ends the agent's TLS connection and
   * passes the request on to us, the request says `http://` and carries
   * whatever query string the caller wrote, and two spellings of one address
   * are two resources to a catalog — two listings for one product, or one that
   * flickers between them. The identifier is put through the route table's own
   * substitution rather than pasted in, because an identifier may carry
   * characters that would otherwise become extra path segments.
   */
  resourceUrlFor(itemId: string): string {
    return `${this.#baseUrl}${expandPath(API_ROUTES.purchase_item.path, { item_id: itemId })}`;
  }

  /**
   * The whole challenge, as the header carries it: what is being paid for, what
   * it costs, and enough about the product for an agent that has never heard of
   * us to find it and buy it.
   *
   * The last part is the discovery declaration, and it is assembled here rather
   * than written out: `bazaarDeclarationOf` decides what a card says about
   * itself, the protocol's own library turns that into the wire shape, and the
   * same library then stamps the request's method into the declaration and into
   * the schema beside it. Nothing in this file writes the format by hand.
   *
   * The method matters and is not cosmetic. A declaration that names a body is
   * only valid on a method that carries one, and a crawler — and the catalog's
   * own validator — asks with GET. Answering a GET with a body declaration is
   * how a resource becomes invisible to the thing that lists it, so the two
   * methods get the two shapes: a GET is declared as the probe it is, and a
   * POST is declared as the purchase an agent actually makes.
   */
  challengeFor(
    price: { readonly amount: string; readonly currency: string },
    orderId: string | null,
    listed: {
      readonly itemId: string;
      readonly card: Card;
      readonly serviceName: string | null;
      /** Where this card's own merchant is paid, which is who the agent pays. */
      readonly payoutWallet: string | null;
    },
    method: "GET" | "POST",
    why?: string,
  ): string {
    const declared = bazaarDeclarationOf(listed.card, {
      url: this.resourceUrlFor(listed.itemId),
      serviceName: listed.serviceName,
    });

    const challenge: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(why === undefined ? {} : { error: why }),
      resource: {
        url: declared.resource.url,
        description: declared.resource.description,
        mimeType: declared.resource.mimeType,
        ...(declared.resource.serviceName === undefined
          ? {}
          : { serviceName: declared.resource.serviceName }),
        // The contract hands the tags out read-only, and the protocol's own
        // resource block takes a plain array. A copy rather than a cast: what
        // goes into the challenge is nobody else's to change afterwards.
        ...(declared.resource.tags === undefined ? {} : { tags: [...declared.resource.tags] }),
      },
      accepts: [this.requirementsFor(price, orderId, listed.payoutWallet)],
      extensions: discoveryExtensionOf(declared, method),
    };
    return encodePaymentRequiredHeader(challenge);
  }

  /** The settlement receipt, as the header carries it. */
  receiptHeader(settlement: SettleResponse): string {
    return encodePaymentResponseHeader(settlement);
  }

  /**
   * The address the sandbox names where the merchant has set none.
   *
   * It exists so that a local stack sells with nothing configured about a
   * merchant's chain identity, which is the whole reason the sandbox exists.
   * Everywhere else this refuses, and the two refusals are told apart because
   * they are fixed in two different places: on a deployment that settles for
   * real the merchant has to set an address, and in a sandbox with nothing
   * configured at all the operator has to.
   */
  #sandboxPlaceholder(): string {
    if (!isSandboxFacilitator(this.#config.facilitatorUrl)) {
      throw new Error(
        "there is nowhere to send the money: the merchant who published this product has set no wallet to be paid at, and this gateway will not stand its own address in for theirs",
      );
    }
    const configured = this.#config.payTo;
    if (configured === null) {
      throw new Error(
        "there is nowhere to send the money: no payment address is configured, so no payment can be asked for",
      );
    }
    return configured;
  }

  #network(): `${string}:${string}` {
    return this.#config.network as `${string}:${string}`;
  }

  /** The token this gateway charges in, for anything that has to name it. */
  token(): TokenIdentity {
    return { network: this.#config.network, asset: getDefaultAsset(this.#network()).asset };
  }
}

/**
 * One card's declaration in the shape the protocol carries it, for the method
 * this request came in on.
 *
 * Both steps are the library's. `declareDiscoveryExtension` builds the
 * declaration and the schema it is checked against; `enrichDeclaration` is the
 * hook the official resource server calls on every challenge, and it is what
 * writes the request's method into both halves — the declaration says which
 * method it describes, and the schema beside it is narrowed to that one method.
 * Left out, the declaration would fail the check the catalog runs on it, which
 * demands a method and has none to find.
 *
 * The hook wants a transport context, and what it reads out of one is the
 * method and, where it is also given a route pattern, the values of that
 * pattern's parameters. No route pattern is passed: our own route does carry
 * one — the product — but naming it would put the identifier into the
 * declaration a second time, where it is already the resource's own address.
 * So the hook adds nothing but the method, and the empty path below is never
 * read. It is there because the hook decides whether it has a transport
 * context at all by looking for the two keys, and one of them is `adapter`.
 */
function discoveryExtensionOf(
  declared: BazaarDeclaration,
  method: "GET" | "POST",
): Record<string, unknown> {
  const built = declareDiscoveryExtension(
    method === "POST"
      ? {
          bodyType: "json",
          input: declared.input,
          inputSchema: declared.inputSchema,
          output: declared.output,
        }
      : // A crawler's probe carries no body and no parameters of ours, so it is
        // declared with neither. What it does carry is what the agent gets back,
        // which is the part a catalog shows.
        { output: declared.output },
  );

  const enriched = bazaarResourceServerExtension.enrichDeclaration?.(built.bazaar, {
    method,
    adapter: { getPath: () => "" },
  });

  return { bazaar: enriched ?? built.bazaar };
}

/**
 * A fingerprint of one payment: the same for two presentations of the same
 * authorisation, and not something an agent can vary at will.
 *
 * This is the replay guard, so what it keys on has to match what the chain
 * keys on, exactly and in both directions. An EIP-3009 token records
 * `authorizationState[authorizer][nonce]`, so a payment is identified by the
 * pair — the payer and the nonce — and neither half alone will do. The nonce
 * alone makes the nonce space global: the first payer to use a nonce would
 * block every other payer who ever picked the same one, permanently, and a
 * client that counts from one picks exactly those. The payer alone identifies
 * nothing.
 *
 * And it has to be canonical, because the signature is over decoded bytes and
 * this is over text. `0xABCD` and `0xabcd` are one nonce to the token contract,
 * to the facilitator and to the signature, and were two fingerprints here —
 * which is a replay guard an attacker defeats by holding down the shift key.
 * So every hex value is lowercased and required to carry its prefix, and every
 * amount is put through BigInt, where `1000000`, `"1000000"` and `"0xF4240"`
 * are one number rather than three strings — as far out as a JSON number is
 * exact, and no further. Past 2^53 a number is left as it is, because a double
 * that far out is no longer the integer it was written as; the cost is that
 * such an amount and its own text are two fingerprints rather than one.
 *
 * Nothing else goes in, and two omissions are deliberate. The protocol version
 * is a JSON field the agent types and nothing checks; digested, it would let an
 * agent make as many fingerprints out of one authorisation as it liked by
 * counting upwards. And the amount and the address are the agent's own copy of
 * what we asked for — they are checked elsewhere, against our own order, and
 * they are not what a token records.
 *
 * What does go in besides the pair is the token itself, and it comes from our
 * configuration rather than from the payment. A token records that state in its
 * own contract, so one payer and one nonce on two different assets are two
 * payments; taking the asset from the agent would hand back the variation this
 * whole function exists to remove.
 *
 * Where a scheme carries no authorisation under that name the signature is used
 * instead, canonicalised the same way; where it carries neither, the whole
 * payload is, with the amounts inside it normalised. That last one is the weak
 * case and is worth saying plainly: a scheme could accept a payload with a
 * field its verifier ignores, and the addition would change the fingerprint
 * while leaving the payment valid. Reaching into a payload at all is the
 * protocol's business rather than ours, and this reaches in exactly far enough
 * to stop one authorisation buying two orders.
 */
export function paymentFingerprint(payload: PaymentPayload, token: TokenIdentity): string {
  // The payload may be anything at all: the decoder is a base64 JSON parse with
  // no schema behind it, so a header naming a known order and carrying nothing
  // else reaches here.
  const signed = asRecord(payload.payload) ?? {};
  const authorization = asRecord(signed.authorization);

  const chain = { network: token.network.toLowerCase(), asset: token.asset.toLowerCase() };
  const payer = asHex(authorization?.from);
  const nonce = asHex(authorization?.nonce);
  if (payer !== null && nonce !== null) {
    return digestOf({ ...chain, by: "authorization", payer, nonce });
  }

  const signature = asHex(signed.signature);
  if (signature !== null) {
    return digestOf({ ...chain, by: "signature", signature });
  }

  return digestOf({ ...chain, by: "payload", payload: canonical(signed) });
}

/** Which token an authorisation is spent on, as this gateway has configured it. */
export interface TokenIdentity {
  readonly network: string;
  readonly asset: string;
}

/** The amounts a scheme writes, which are numbers however they are spelled. */
const AMOUNTS = new Set(["value", "amount", "validAfter", "validBefore", "maxAmount"]);

/**
 * The payload with every value written one way.
 *
 * Hex is lowercased, numbers are put through BigInt, and everything else is
 * left as it is. Two spellings of one payment come out identical; two payments
 * do not.
 */
function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((held) => canonical(held));
  }
  const record = asRecord(value);
  if (record !== null) {
    return Object.fromEntries(
      Object.entries(record).map(([name, held]) => [name, canonical(held, name)]),
    );
  }
  if (key !== undefined && AMOUNTS.has(key)) {
    return asAmount(value) ?? value;
  }
  return asHex(value) ?? value;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(stably(value)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A hex string in one spelling, or nothing where the value is not one. */
function asHex(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : null;
}

/** A whole number in one spelling, however it was written. */
function asAmount(value: unknown): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value).toString();
  }
  if (typeof value === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    return BigInt(value).toString();
  }
  return null;
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
