/**
 * Making one call of the surface.
 *
 * Every address, method and answer document comes out of the route table in
 * `@coinslot/contracts`. No path is written down in this package, and the
 * table's own `expandPath` does the substituting, because an identifier we
 * accept may hold a slash or a space and pasted into an address unencoded it
 * becomes two segments and a different route.
 *
 * Three things the table deliberately does not carry, and this file has to
 * decide. They are named here rather than left to be inferred from the code,
 * because each is a place where the two sides can disagree in silence.
 *
 * The header the merchant's key travels in. The table says which door a call
 * is behind and not how the door is built, so the choice is the gateway's and
 * ours to match: this package sends `Authorization: Bearer <key>`, and if the
 * gateway reads the key somewhere else, every call behind that door fails with
 * an authorisation error and nothing in either repository says why.
 *
 * The status code. The table says nothing about them either, and some of the
 * answers this surface gives are refusals that are still documents — a card
 * that was not accepted, an order call that did not go through. Rather than
 * guess which of those arrive under a 200 and which under a 400, the answer is
 * read the same way whatever the status: if the body is the document the route
 * names, that is the answer. Only a body that is not that document is a
 * failure, and then the status is part of what the failure says.
 *
 * What a failure is. Nothing here throws: a call comes back as the document or
 * as a failure with a sentence in it, and the layer above decides which of
 * those the merchant is entitled to see as a return value and which is an
 * exception. That decision is in `client.ts`, where the contract says which
 * calls have a failure branch of their own.
 */

import { API_ROUTES, expandPath, type RouteName } from "@coinslot/contracts";

/** Where the gateway is and which key opens its doors. */
export interface Gateway {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/**
 * The document a route answers with, taken from the schema the table names.
 *
 * It is written against the shape of a parse result rather than with zod's own
 * `infer`, for the reason given in `schema.ts`: zod is not this package's
 * dependency to import. The effect is the same — rename a field in a contract
 * schema and the call sites here stop compiling.
 */
export type DocumentOf<N extends RouteName> = (typeof API_ROUTES)[N]["response"] extends {
  document: { safeParse(value: unknown): infer Result };
}
  ? Result extends { success: true; data: infer Document }
    ? Document
    : never
  : never;

/** A call that did not produce the document the route promises. */
export interface TransportFailure {
  readonly route: RouteName;
  /** What happened, in one sentence, naming the route and the address. */
  readonly reason: string;
}

export type Answer<N extends RouteName> =
  | { readonly ok: true; readonly document: DocumentOf<N> }
  | { readonly ok: false; readonly failure: TransportFailure };

export interface CallOptions {
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * How much of an answer we could not read is quoted back in the failure.
 *
 * A quote is worth more than a length — an HTML error page from a proxy names
 * the thing that is actually broken — and a whole one is worth less than
 * nothing, because a gateway can answer with a megabyte and this text ends up
 * in a merchant's log. What is cut is said in the same sentence rather than
 * left as an ellipsis a reader has to interpret.
 */
const QUOTED_CHARACTERS = 200;

const quote = (text: string): string =>
  text.length <= QUOTED_CHARACTERS
    ? JSON.stringify(text)
    : `${JSON.stringify(text.slice(0, QUOTED_CHARACTERS))} and ${text.length - QUOTED_CHARACTERS} more characters, not shown`;

/** The address of one call: the gateway's base, then the route's own path. */
export const addressOf = (baseUrl: string, name: RouteName, path: CallOptions["path"]): string =>
  `${baseUrl.replace(/\/+$/, "")}${expandPath(API_ROUTES[name].path, path ?? {})}`;

const failure = (route: RouteName, reason: string): { ok: false; failure: TransportFailure } => ({
  ok: false,
  failure: { route, reason },
});

/**
 * One call, answered with the route's document or with a sentence about why
 * there is no document.
 *
 * The cast at the end is the one place this file steps outside what the
 * compiler can follow. `API_ROUTES[name]` for an unresolved `name` is a union
 * of every route, so the schema reached at runtime is the right one while its
 * static type is the union of all of them. `DocumentOf<N>` names the same
 * schema for the caller, and the two are the same object.
 */
export const callRoute = async <N extends RouteName>(
  gateway: Gateway,
  name: N,
  options: CallOptions = {},
): Promise<Answer<N>> => {
  const route = API_ROUTES[name];
  const address = addressOf(gateway.baseUrl, name, options.path);
  const url = new URL(address);

  for (const [field, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(field, value);
  }

  const hasBody = route.method === "POST";

  let response: Response;

  try {
    response = await fetch(url, {
      method: route.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${gateway.apiKey}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(options.body ?? {}) } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    return failure(name, `${name} at ${url.href} could not be reached: ${String(cause)}`);
  }

  const text = await response.text().catch((cause: unknown) => {
    return `<the answer could not be read: ${String(cause)}>`;
  });

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    return failure(
      name,
      `${name} at ${url.href} answered ${response.status} with something that is not JSON: ${quote(text)}`,
    );
  }

  if (!("document" in route.response)) {
    return failure(
      name,
      `${name} does not answer with a document: ${route.response.not_one_document}`,
    );
  }

  const parsed = route.response.document.safeParse(body);

  if (!parsed.success) {
    return failure(
      name,
      `${name} at ${url.href} answered ${response.status} with something that is not the document it promises: ${quote(text)}`,
    );
  }

  return { ok: true, document: parsed.data as DocumentOf<N> };
};
