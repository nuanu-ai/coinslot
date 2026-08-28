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
  DisabledKeySchema,
  expandPath,
  type IssuedKey,
  IssuedKeySchema,
  MERCHANT_KEY_HEADER,
  type MerchantCard,
  type MerchantCardList,
  MerchantCardListSchema,
  MerchantCardSchema,
  type MerchantKey,
  type MerchantKeyList,
  MerchantKeyListSchema,
  merchantKeyHeaderValue,
  type OrderList,
  OrderListSchema,
  type ReceiptList,
  ReceiptListSchema,
  type RegisteredMerchant,
  RegisteredMerchantSchema,
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
  keys(): Promise<Answer<MerchantKeyList>>;
  issueKey(label: string): Promise<Answer<IssuedKey>>;
  disableKey(keyId: string): Promise<Answer<MerchantKey>>;
}

/**
 * The one call the cabinet makes with no key at all.
 *
 * Separate from the client above rather than a method on it, because it is a
 * different thing: every other call is made as some merchant, and this one is
 * made by somebody who is not a merchant yet. A `register` sitting on a client
 * bound to a key would be a method whose key is ignored, which is the kind of
 * shape somebody later reads as an accident.
 */
export interface Registrar {
  register(name: string, invitation: string): Promise<Answer<RegisteredMerchant>>;
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

/** What one call needs beyond its route and the shape of its answer. */
interface Sending {
  /** The values for a path that names parameters, such as `:key_id`. */
  readonly values?: Readonly<Record<string, string>>;
  readonly query?: string;
  /** A document to send, for the routes that take one. */
  readonly body?: unknown;
}

/**
 * One caller, bound to a key or to nothing at all.
 *
 * A null key means no key header on the request, which is registration and
 * nothing else. It is spelled as an absence rather than as an empty string
 * because the gateway would read an empty bearer token as a key it does not
 * know, and a 401 is a worse answer than the one a keyless route gives.
 */
const caller =
  (baseUrl: string, key: string | null, answerWithinMs: number) =>
  async <T>(
    route: { readonly method: string; readonly path: string },
    schema: { parse: (value: unknown) => T },
    sending: Sending = {},
  ): Promise<Answer<T>> => {
    const url = `${baseUrl}${expandPath(route.path, sending.values ?? {})}${sending.query ?? ""}`;

    let answered: Response;
    try {
      answered = await fetch(url, {
        method: route.method,
        headers: {
          ...(key === null ? {} : { [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(key) }),
          ...(sending.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(sending.body === undefined ? {} : { body: JSON.stringify(sending.body) }),
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
  const call = caller(baseUrl, key, answerWithinMs);

  return {
    cards: () => call(API_ROUTES.list_merchant_cards, MerchantCardListSchema),
    pauseCard: (itemId, paused) =>
      call(paused ? API_ROUTES.pause_card : API_ROUTES.resume_card, MerchantCardSchema, {
        values: { item_id: itemId },
      }),
    setSelling: (selling) =>
      call(selling ? API_ROUTES.resume_selling : API_ROUTES.pause_selling, MerchantCardListSchema),
    orders: (open) =>
      call(API_ROUTES.list_orders, OrderListSchema, { query: open ? "?open=true" : "" }),
    receipts: () => call(API_ROUTES.list_receipts, ReceiptListSchema),
    keys: () => call(API_ROUTES.list_keys, MerchantKeyListSchema),
    issueKey: (label) => call(API_ROUTES.issue_key, IssuedKeySchema, { body: { label } }),
    disableKey: async (keyId) => {
      // Unwrapped here rather than at the screen. The contract wraps the key in
      // an object so that the answer can grow a field beside it without
      // changing shape under every reader; what the one screen that draws it
      // needs is the key, and a page reaching through a wrapper is a page that
      // has to be edited the day the wrapper grows.
      const answered = await call(API_ROUTES.disable_key, DisabledKeySchema, {
        values: { key_id: keyId },
      });
      return answered.ok ? { ok: true, document: answered.document.key } : answered;
    },
  };
};

/**
 * A caller with no key, which can do exactly one thing.
 *
 * The invitation is not the cabinet's to check and is not in its configuration:
 * it is one value out of the gateway's, handed to a merchant along with the
 * address of the site (ADR-0014 §3). What arrives here is whatever was typed
 * into the form, and what comes back says only that it was accepted or that it
 * was not.
 */
export const registrarFor = (
  baseUrl: string,
  answerWithinMs: number = ANSWER_WITHIN_MS,
): Registrar => {
  const call = caller(baseUrl, null, answerWithinMs);
  return {
    register: (name, invitation) =>
      call(API_ROUTES.register_merchant, RegisteredMerchantSchema, { body: { name, invitation } }),
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
