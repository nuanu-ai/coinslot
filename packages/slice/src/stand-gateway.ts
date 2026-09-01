/**
 * The merchant-key calls the SDK does not carry.
 *
 * The stand needs the merchant's own catalogue and switches as well as the
 * SDK subscription.  These calls use the contract table so their addresses do
 * not become a second, drifting surface.
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

const call = async (
  baseUrl: string,
  apiKey: string,
  route: RouteDefinition,
  values: Readonly<Record<string, string>> = {},
): Promise<GatewayAnswer> => {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${expandPath(route.path, values)}`, {
    method: route.method,
    headers: { [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(apiKey) },
  });
  const text = await response.text();

  try {
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
};

export const listCards = (baseUrl: string, apiKey: string): Promise<GatewayAnswer> =>
  call(baseUrl, apiKey, API_ROUTES.list_merchant_cards);

export const pauseCard = (
  baseUrl: string,
  apiKey: string,
  itemId: string,
): Promise<GatewayAnswer> => call(baseUrl, apiKey, API_ROUTES.pause_card, { item_id: itemId });

export const resumeCard = (
  baseUrl: string,
  apiKey: string,
  itemId: string,
): Promise<GatewayAnswer> => call(baseUrl, apiKey, API_ROUTES.resume_card, { item_id: itemId });

export const pauseSelling = (baseUrl: string, apiKey: string): Promise<GatewayAnswer> =>
  call(baseUrl, apiKey, API_ROUTES.pause_selling);

export const resumeSelling = (baseUrl: string, apiKey: string): Promise<GatewayAnswer> =>
  call(baseUrl, apiKey, API_ROUTES.resume_selling);

export const listOrders = (baseUrl: string, apiKey: string): Promise<GatewayAnswer> =>
  call(baseUrl, apiKey, API_ROUTES.list_orders);

export const listReceipts = (baseUrl: string, apiKey: string): Promise<GatewayAnswer> =>
  call(baseUrl, apiKey, API_ROUTES.list_receipts);
