/**
 * This gateway's own buyer, walking a purchase of a merchant's card the way a
 * stranger's agent would.
 *
 * It exists so that a merchant on the test site can prove their integration
 * with nobody else in the room. Everything it does it does over HTTP against
 * the address in `PUBLIC_BASE_URL` — the catalog an agent reads, the address it
 * buys at, the door it comes back to — and never against the flows in this
 * process. That is the whole value of the thing: an in-process short cut would
 * produce the same document while proving nothing about the front door, which
 * is the only door a merchant's buyers will ever knock on.
 *
 * The addresses are taken from the contract's own route table rather than
 * written out, which is the rule the mounting loop keeps for the same reason:
 * an address transcribed by hand is an address that drifts.
 *
 * Nothing here throws for anything that happens on the wire. A refusal, an
 * answer nobody can read, a door that does not answer at all — each becomes a
 * step that says so, and the walk stops there. The merchant asked what a buyer
 * would meet, and "the storefront refused with these words" is the answer; an
 * exception would throw that answer away and leave a 500 in its place.
 *
 * The payment is the official x402 client, driven the way `packages/slice`'s
 * own sandbox buyer drives it — the exact-EVM scheme signs against the
 * challenge this gateway itself issued. That buyer is not reused, and the
 * reason is a package cycle rather than a preference: the slice depends on this
 * gateway, so this gateway cannot depend on the slice. What that costs is two
 * pieces of code that walk one exchange, and what keeps them honest is that
 * each is exercised end to end against a real gateway over a real socket.
 */

import {
  AgentOrderStatusSchema,
  API_ROUTES,
  CatalogPageSchema,
  type Delivery,
  DeliverySchema,
  ErrorEnvelopeSchema,
  expandPath,
  type TestPurchase,
  type TestPurchaseStep,
  type TestPurchaseStepName,
} from "@nuanu-ai/coinslot-contracts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { ORDER_ID_IN_EXTRA } from "./x402.js";

/** Everything one walk needs to know before it starts knocking on doors. */
export interface TestPurchaseWalk {
  /** The public storefront, which is the only address this walk ever calls. */
  readonly baseUrl: string;
  readonly itemId: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The wallet the buyer signs with; never printed and never in the document. */
  readonly privateKey: string;
  readonly network: string;
  /** The most this walk may pay, in the token's own smallest unit. */
  readonly maxAtomic: bigint;
  /** The same ceiling written as an amount, for the sentences. */
  readonly maxUsd: string;
  /**
   * How long any one call may take before the walk gives up on it.
   *
   * It is the gateway's own published ceiling on a synchronous purchase, so a
   * walk that runs into it has caught this gateway failing a promise it makes
   * to every buying agent — which is worth telling the merchant rather than
   * waiting out.
   */
  readonly callDeadlineMs: number;
  /** The fetch every call goes through; the global one where none is given. */
  readonly fetch?: typeof fetch;
}

/** One answer off the wire, or the reason there was not one. */
type Answered =
  | {
      readonly landed: true;
      readonly status: number;
      readonly body: unknown;
      readonly header: (name: string) => string | null;
    }
  | { readonly landed: false; readonly why: string };

const asJson = { "content-type": "application/json", accept: "application/json" };

/**
 * The sentence a refusal of ours carries, where the answer was one.
 *
 * Null covers everything that is not one of our refusals, and also a refusal
 * whose sentence is blank — which the envelope forbids, and which something
 * standing in front of this gateway could still produce. The caller then writes
 * its own account rather than putting an empty space where the reason belongs.
 */
const refusalIn = (body: unknown): string | null => {
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const said = parsed.data.error.message;
  return said.trim() === "" ? null : said;
};

/**
 * An amount in the token's smallest unit, written back as dollars, exactly.
 *
 * String arithmetic and no division: a ceiling compared as a float is a ceiling
 * that lets a payment through for a rounding reason nobody can see afterwards.
 * Null where the value is not a whole number of units at all.
 */
export const dollarsOf = (atomic: string, decimals: number): string | null => {
  if (!/^\d+$/.test(atomic)) {
    return null;
  }
  if (decimals === 0) {
    return atomic;
  }
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
};

/** What a chain is paid in, or nothing where this gateway has no table for it. */
export const tokenOf = (
  network: string,
): { readonly asset: string; readonly decimals: number; readonly symbol: string } | null => {
  try {
    const asset = getDefaultAsset(network as `${string}:${string}`);
    return { asset: asset.asset, decimals: asset.decimals, symbol: asset.symbol };
  } catch {
    return null;
  }
};

/** The message of something thrown, without the object it was thrown on. */
const saidBy = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown);

async function callOnce(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  deadlineMs: number,
): Promise<Answered> {
  try {
    const response = await request(url, { ...init, signal: AbortSignal.timeout(deadlineMs) });
    const text = await response.text();
    let body: unknown = text === "" ? null : text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Kept as the text it arrived as. A proxy in front of the gateway answers
      // its own page in HTML, and that page is an answer about the proxy: shown
      // as it came, a merchant can see what stood in the way.
    }
    return {
      landed: true,
      status: response.status,
      body,
      header: (name) => response.headers.get(name),
    };
  } catch (thrown) {
    const timedOut = thrown instanceof Error && thrown.name === "TimeoutError";
    return {
      landed: false,
      why: timedOut
        ? `the storefront did not answer within the ${deadlineMs}ms this gateway allows one synchronous purchase`
        : `the storefront could not be reached at ${url}: ${saidBy(thrown)}`,
    };
  }
}

/**
 * Walks one purchase and writes down what every door said.
 *
 * The catalog is the one step that does not stop the walk. A card missing from
 * it is worth knowing about on its own — it is the difference between a card
 * that cannot be bought and a card no agent would ever find — and the reason it
 * is missing is what the next door says out loud.
 */
export async function walkTestPurchase(walk: TestPurchaseWalk): Promise<TestPurchase> {
  const request = walk.fetch ?? fetch;
  const base = walk.baseUrl.replace(/\/+$/, "");
  const deadline = walk.callDeadlineMs;
  const steps: TestPurchaseStep[] = [];
  let orderId: string | null = null;

  const note = (step: TestPurchaseStepName, ok: boolean, address: string, said: string): void => {
    steps.push({ step, ok, address, said });
  };
  const stopped = (): TestPurchase => ({
    outcome: "stopped",
    steps,
    order_id: orderId,
    delivered: null,
  });

  const account = privateKeyToAccount(walk.privateKey as `0x${string}`);
  const core = new x402Client();
  registerExactEvmScheme(core, { signer: account });
  // The buyer's own ceiling, over the one checked below: the explicit check is
  // what produces a sentence a merchant can read, and this is what stops a
  // signature if that check is ever wrong.
  core.setSpendControls({ maxAmountPerPayment: `$${walk.maxUsd}` });
  const http = new x402HTTPClient(core);

  // --- the catalog an agent chooses from ------------------------------------

  const catalogUrl = `${base}${API_ROUTES.list_catalog.path}`;
  const listed = await callOnce(request, catalogUrl, { headers: asJson }, deadline);
  if (!listed.landed) {
    note("catalog", false, catalogUrl, listed.why);
  } else {
    const page = CatalogPageSchema.safeParse(listed.body);
    const found = page.success && page.data.items.some((item) => item.id === walk.itemId);
    note(
      "catalog",
      found,
      catalogUrl,
      found
        ? "this card is in the catalog a buying agent reads"
        : (refusalIn(listed.body) ??
            (page.success
              ? "this card is not in the catalog a buying agent reads, so an agent browsing for it would not find it"
              : "the catalog did not come back in the shape a buying agent reads")),
    );
  }

  // --- what it costs, which is the call that opens the order ----------------

  const purchaseUrl = `${base}${expandPath(API_ROUTES.purchase_item.path, { item_id: walk.itemId })}`;
  const body = JSON.stringify({ params: walk.params });
  const asked = await callOnce(
    request,
    purchaseUrl,
    { method: "POST", headers: asJson, body },
    deadline,
  );
  if (!asked.landed) {
    note("price", false, purchaseUrl, asked.why);
    return stopped();
  }

  let challenge: PaymentRequired | null = null;
  if (asked.status === 402) {
    try {
      challenge = http.getPaymentRequiredResponse(asked.header, asked.body);
    } catch {
      // A 402 whose challenge cannot be read is a 402 that named no price, and
      // the sentence below says exactly that rather than blaming our parser.
      challenge = null;
    }
  }
  const wanted: PaymentRequirements | null = challenge?.accepts[0] ?? null;
  if (challenge === null || wanted === null) {
    note(
      "price",
      false,
      purchaseUrl,
      refusalIn(asked.body) ??
        `the storefront answered ${asked.status} to the call that asks a price, and named nothing to pay`,
    );
    return stopped();
  }

  const named = wanted.extra?.[ORDER_ID_IN_EXTRA];
  orderId = typeof named === "string" ? named : null;

  const token = tokenOf(walk.network);
  const readable =
    token !== null && wanted.asset.toLowerCase() === token.asset.toLowerCase()
      ? dollarsOf(wanted.amount, token.decimals)
      : null;
  note(
    "price",
    true,
    purchaseUrl,
    readable === null || token === null
      ? `the storefront asked for ${wanted.amount} of ${wanted.asset} on ${wanted.network}, paid to ${wanted.payTo}`
      : `the storefront asked for $${readable} in ${token.symbol} on ${wanted.network}, paid to ${wanted.payTo}`,
  );

  // --- the ceiling, checked before anything is signed -----------------------

  if (readable === null) {
    note(
      "payment",
      false,
      purchaseUrl,
      `the storefront asked for ${wanted.amount} of ${wanted.asset}, which this gateway cannot read as dollars, so it cannot be held to the $${walk.maxUsd} a test purchase may spend and nothing was signed`,
    );
    return stopped();
  }
  if (BigInt(wanted.amount) > walk.maxAtomic) {
    note(
      "payment",
      false,
      purchaseUrl,
      `the storefront asked for $${readable} and this gateway's test buyer pays at most $${walk.maxUsd} in one purchase, so nothing was signed`,
    );
    return stopped();
  }

  // --- the payment ----------------------------------------------------------

  let paid: Answered;
  try {
    const payload = await http.createPaymentPayload(challenge);
    paid = await callOnce(
      request,
      purchaseUrl,
      {
        method: "POST",
        headers: { ...asJson, ...http.encodePaymentSignatureHeader(payload) },
        body,
      },
      deadline,
    );
  } catch (thrown) {
    note(
      "payment",
      false,
      purchaseUrl,
      `this gateway's test buyer could not sign what the storefront asked for: ${saidBy(thrown)}`,
    );
    return stopped();
  }

  if (!paid.landed) {
    note("payment", false, purchaseUrl, paid.why);
    return stopped();
  }
  const answered = AgentOrderStatusSchema.safeParse(paid.body);
  if (answered.success) {
    orderId = answered.data.order_id;
  }
  if (paid.status !== 200) {
    note(
      "payment",
      false,
      purchaseUrl,
      refusalIn(paid.body) ??
        (answered.success
          ? `the payment was answered with the order, which stands at ${answered.data.status}, and no goods came back with it`
          : `the storefront answered ${paid.status} to the payment`),
    );
    return stopped();
  }
  if (orderId === null) {
    note(
      "payment",
      false,
      purchaseUrl,
      "the storefront took the payment and named no order, so there is nothing to come back to for the goods",
    );
    return stopped();
  }
  note(
    "payment",
    true,
    purchaseUrl,
    answered.success
      ? `the payment went through and the storefront answered with the order, which stands at ${answered.data.status}`
      : "the payment went through",
  );

  // --- the door the buyer comes back to -------------------------------------

  const statusUrl = `${base}${expandPath(API_ROUTES.get_order_status.path, { order_id: orderId })}`;
  const collected = await callOnce(request, statusUrl, { headers: asJson }, deadline);
  if (!collected.landed) {
    note("delivery", false, statusUrl, collected.why);
    return stopped();
  }
  const read = AgentOrderStatusSchema.safeParse(collected.body);
  if (!read.success) {
    note(
      "delivery",
      false,
      statusUrl,
      refusalIn(collected.body) ??
        `the order's own door answered ${collected.status}, and not the document a buying agent reads`,
    );
    return stopped();
  }

  const order = read.data;
  if (order.status === "delivered") {
    const goods: Delivery | null = order.delivered;
    const held = goods === null ? null : DeliverySchema.safeParse(goods);
    if (held === null || !held.success) {
      note(
        "delivery",
        false,
        statusUrl,
        "the order reads delivered and the door handed over no goods with it",
      );
      return stopped();
    }
    note(
      "delivery",
      true,
      statusUrl,
      "the buyer is holding the goods this order was delivered with",
    );
    return { outcome: "delivered", steps, order_id: orderId, delivered: held.data };
  }

  if (order.status === "in_progress") {
    note(
      "delivery",
      true,
      statusUrl,
      "the order is paid for and its goods come later; the buyer collects them at this same address once the merchant has delivered",
    );
    return { outcome: "accepted", steps, order_id: orderId, delivered: null };
  }

  note("delivery", false, statusUrl, `the order stands at ${order.status}, and no goods are on it`);
  return stopped();
}
