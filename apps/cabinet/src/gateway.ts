/**
 * How the cabinet talks to the gateway: over the public API, with a merchant's
 * key, holding no database of its own (ADR-0005 §3).
 *
 * Every address and every document comes out of the contract's route table
 * rather than being written here. That is the same rule the gateway and the
 * SDK already follow, and the cabinet is the third reader of that table — a
 * third transcription of the surface is a third chance for the addresses to
 * come apart. It is also the dogfooding the decision asks for: a screen the
 * cabinet cannot draw is API the merchant does not have either.
 *
 * Answers are held to the schema the table names before anything is rendered.
 * A gateway that sent a document the contract would not recognise is a gateway
 * we cannot draw a truthful page from, and failing here is how that is found
 * rather than as a blank cell in front of a merchant.
 */

import {
  API_ROUTES,
  expandPath,
  MERCHANT_KEY_HEADER,
  type MerchantCard,
  type MerchantCardList,
  MerchantCardListSchema,
  MerchantCardSchema,
  merchantKeyHeaderValue,
  type OrderList,
  OrderListSchema,
  type ReceiptList,
  ReceiptListSchema,
} from "@coinslot/contracts";

/** What a call came to, in the two shapes a page has to draw differently. */
export type Answer<T> =
  | { readonly ok: true; readonly document: T }
  /**
   * The call did not produce a document. `status` is the gateway's, or 0 where
   * the gateway could not be reached at all — which is a different thing from
   * a gateway that answered, and a page that folded the two would tell a
   * merchant their catalog is empty when the truth is that nothing answered.
   */
  | { readonly ok: false; readonly status: number; readonly why: string };

export interface GatewayClient {
  cards(): Promise<Answer<MerchantCardList>>;
  pauseCard(itemId: string, paused: boolean): Promise<Answer<MerchantCard>>;
  setSelling(selling: boolean): Promise<Answer<MerchantCardList>>;
  orders(open: boolean): Promise<Answer<OrderList>>;
  receipts(): Promise<Answer<ReceiptList>>;
}

/**
 * How long the cabinet waits for the gateway before giving up on one call.
 *
 * A number here rather than in the configuration on purpose: this is not the
 * kind of waiting the order machine takes from an environment, where the value
 * is policy somebody decides. It is a guard on a client, and its only job is to
 * be shorter than a person's patience with a page that has stopped.
 *
 * It is an argument with this as its default so that the promise can be tested
 * against a server that never answers without the suite waiting ten seconds to
 * find out. Nothing in the cabinet passes it.
 */
const ANSWER_WITHIN_MS = 10_000;

/**
 * A client bound to one merchant's key.
 *
 * The key is a parameter rather than something this module reads, and the
 * cabinet builds one of these per request from the key on the row of whoever is
 * signed in (ADR-0014 §2). Two people signed into one cabinet are therefore two
 * merchants, which is what a client held for the life of the process could
 * never be.
 */
export const gatewayFor = (
  baseUrl: string,
  key: string,
  answerWithinMs: number = ANSWER_WITHIN_MS,
): GatewayClient => {
  const call = async <T>(
    route: { readonly method: string; readonly path: string },
    schema: { parse: (value: unknown) => T },
    values: Readonly<Record<string, string>> = {},
    query = "",
  ): Promise<Answer<T>> => {
    const url = `${baseUrl}${expandPath(route.path, values)}${query}`;

    let answered: Response;
    try {
      answered = await fetch(url, {
        method: route.method,
        headers: { [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(key) },
        signal: AbortSignal.timeout(answerWithinMs),
      });
    } catch (thrown) {
      // Nothing answered. Said as its own thing, because "the gateway is not
      // there" and "the gateway says you have nothing" are different news and
      // only one of them means the merchant should do something.
      //
      // And a third: a connection that was accepted and then went quiet. It
      // reaches here only because of the deadline above — without one this call
      // never returns, and the page a merchant is holding is sometimes the one
      // that stops their selling.
      const late = thrown instanceof Error && thrown.name === "TimeoutError";
      const why = late ? "the gateway did not answer in time" : "the gateway could not be reached";
      console.error(`[cabinet] ${why}`, thrown);
      return { ok: false, status: 0, why };
    }

    if (!answered.ok) {
      return { ok: false, status: answered.status, why: await reasonIn(answered) };
    }

    const document = schema.parse(await answered.json());
    return { ok: true, document };
  };

  return {
    cards: () => call(API_ROUTES.list_merchant_cards, MerchantCardListSchema),
    pauseCard: (itemId, paused) =>
      call(paused ? API_ROUTES.pause_card : API_ROUTES.resume_card, MerchantCardSchema, {
        item_id: itemId,
      }),
    setSelling: (selling) =>
      call(selling ? API_ROUTES.resume_selling : API_ROUTES.pause_selling, MerchantCardListSchema),
    orders: (open) => call(API_ROUTES.list_orders, OrderListSchema, {}, open ? "?open=true" : ""),
    receipts: () => call(API_ROUTES.list_receipts, ReceiptListSchema),
  };
};

/**
 * What the gateway said went wrong, where it said anything we can read.
 *
 * The gateway's refusal document is the gateway's own and not the contract's,
 * so this reads it defensively and falls back to the status rather than
 * inventing a sentence. An error text is a claim like any other.
 */
const reasonIn = async (answered: Response): Promise<string> => {
  try {
    const body = (await answered.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    return typeof message === "string" && message !== ""
      ? message
      : `the gateway answered ${answered.status}`;
  } catch {
    return `the gateway answered ${answered.status}`;
  }
};
