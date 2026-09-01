/**
 * The merchant-key calls the SDK does not carry.
 *
 * The stand needs the merchant's own catalogue and switches as well as the
 * SDK subscription.  These calls use the contract table so their addresses do
 * not become a second, drifting surface.
 *
 * The fetch is handed in rather than taken from the global, and that is the
 * whole of why: the console records what crosses its edges by wrapping the
 * fetch, and a call that reached around it left only its answer in the log —
 * a line arriving with nothing before it, which reads as a log out of order
 * rather than as a log missing a half.
 */

import {
  API_ROUTES,
  expandPath,
  MERCHANT_KEY_HEADER,
  merchantKeyHeaderValue,
  type RouteDefinition,
} from "@nuanu-ai/coinslot-contracts";

export interface GatewayAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** Everything one of these calls needs to know about where it is going. */
export interface Reach {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The fetch the console watches its own edges through. */
  readonly fetch: typeof fetch;
}

const call = async (
  reach: Reach,
  route: RouteDefinition,
  values: Readonly<Record<string, string>> = {},
): Promise<GatewayAnswer> => {
  const response = await reach.fetch(
    `${reach.baseUrl.replace(/\/+$/, "")}${expandPath(route.path, values)}`,
    {
      method: route.method,
      headers: { [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(reach.apiKey) },
    },
  );
  const text = await response.text();

  try {
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
};

export const listCards = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.list_merchant_cards);

export const pauseCard = (reach: Reach, itemId: string): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.pause_card, { item_id: itemId });

export const resumeCard = (reach: Reach, itemId: string): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.resume_card, { item_id: itemId });

export const pauseSelling = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.pause_selling);

export const resumeSelling = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.resume_selling);

export const listOrders = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.list_orders);

export const listReceipts = (reach: Reach): Promise<GatewayAnswer> =>
  call(reach, API_ROUTES.list_receipts);
