/**
 * Making one call of the surface.
 *
 * Every address, method and answer document comes out of the route table in
 * `@nuanu-ai/coinslot-contracts`. No path is written down in this package, and the
 * table's own `expandPath` does the substituting, because an identifier we
 * accept may hold a slash or a space and pasted into an address unencoded it
 * becomes two segments and a different route.
 *
 * The table deliberately leaves out three things that a program actually
 * making the calls cannot avoid deciding, and it is worth saying here what was
 * decided, because each of them is a place where the two sides can disagree
 * without either of them noticing.
 *
 * The first is the header the merchant's key travels in. The table says which
 * door a call is behind and not how the door is built, so the choice is the
 * gateway's and ours to match — and matching it by each writing the same two
 * strings down was agreement by luck, where a call behind that door fails with
 * an authorisation error and nothing in either repository says why. So the name
 * and the scheme live in `@nuanu-ai/coinslot-contracts`, in the one place both sides
 * already import: `merchantKeyHeaderValue` builds the value this package sends,
 * and `merchantKeyFrom` is what the gateway reads it back with.
 *
 * The second is the status code, about which the table says nothing either.
 * Some of the answers this surface gives are refusals that are still documents
 * — a card that was not accepted, an order call that did not go through — and
 * rather than guess which of those arrive under a 200 and which under a 400,
 * the answer is read the same way whatever the status. If the body is the
 * document the route names, that is the answer. Otherwise it is asked whether
 * it is the one envelope every route refuses in, and if it is, what the caller
 * is told is the gateway's own code and its own sentence rather than a
 * complaint from here about a document that did not parse — the gateway is the
 * side that knows why, and the reason it wrote is the only thing the caller
 * can act on. Only a body that is neither is a failure this package has to
 * describe itself, and then the status is part of what it says.
 *
 * The third is what a failure is at all. Nothing here throws: a call comes
 * back either as the document or as a failure carrying a sentence and, where
 * there was one, the body that could not be read. The layer above decides
 * which of those the merchant is entitled to see as a return value and which
 * is an exception, and that decision is in `client.ts`, where the contract
 * says which calls have a failure branch of their own. The body travels with
 * the failure because one caller needs it: a poll answer this SDK cannot parse
 * may still name the contract version the gateway speaks, and that is how a
 * genuine difference of dialects is told apart from a broken gateway.
 */

import {
  API_ROUTES,
  ErrorEnvelopeSchema,
  expandPath,
  MERCHANT_KEY_HEADER,
  merchantKeyHeaderValue,
  type RouteName,
} from "@nuanu-ai/coinslot-contracts";

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

/**
 * What is known about whether the call got there.
 *
 * Three and not two, and the third is the one that matters. A first draft had
 * a boolean, which meant every failure that was not an answer was filed as
 * "it did not reach us" — including a request that was fully sent and then
 * abandoned when the worker stopped, or one whose connection broke after the
 * gateway had it. Those are not the same fact, and a merchant reconciling
 * their books from the wrong one of them is reconciling from something we made
 * up.
 *
 * `not_received` is claimed only where the network says so plainly: the
 * connection was refused or the name did not resolve, so nothing was ever
 * handed over. Everything else that produced no readable answer is `unknown`,
 * because it is.
 */
export const REACH = Object.freeze({
  /** No connection was made, so the gateway certainly has nothing. */
  NOT_RECEIVED: "not_received",
  /** The gateway answered, and the answer is not one this package can read. */
  ANSWERED: "answered",
  /**
   * The exchange was cut short. What the call did is not known here.
   *
   * Deliberately silent about direction, because three different things end
   * up here and they do not agree about it: an abort that may have fired
   * before the request left, a connection that broke once it was under way,
   * and an answer that started arriving and stopped. What they share is that
   * no complete answer was had, and that is all this may be read as saying.
   */
  UNKNOWN: "unknown",
} as const);

export type Reach = (typeof REACH)[keyof typeof REACH];

/**
 * The three codes the network gives us that mean nothing was handed over.
 *
 * Kept short on purpose: every code not on this list is read as "unknown",
 * which is the answer that claims least. A code added here is a claim that the
 * request certainly never arrived, and it should be added only when that is
 * true of it.
 */
const NOTHING_WAS_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * The network's own codes for why a call failed, however many there were.
 *
 * There can be several: a name that resolves to more than one address is tried
 * at each of them, and what comes back is one error holding the others. All of
 * them have to say nothing was sent before we say it.
 */
const codesUnder = (cause: unknown): string[] => {
  const inner = (cause as { cause?: unknown })?.cause;
  const gathered = (inner as { errors?: unknown })?.errors;

  if (Array.isArray(gathered)) {
    return gathered
      .map((one) => (one as { code?: unknown })?.code)
      .filter((code): code is string => typeof code === "string");
  }

  const code = (inner as { code?: unknown })?.code;

  return typeof code === "string" ? [code] : [];
};

/**
 * What a failed `fetch` says about whether anything was handed over.
 *
 * Exported for its own test rather than only through a socket: the rule that
 * every address tried has to say nothing was sent — not merely one of them —
 * is not reachable from a test that can only produce one address at a time,
 * and a rule nothing checks is a rule that will be relaxed by accident.
 */
export const reachOf = (cause: unknown): Reach => {
  const codes = codesUnder(cause);

  return codes.length > 0 && codes.every((code) => NOTHING_WAS_SENT.has(code))
    ? REACH.NOT_RECEIVED
    : REACH.UNKNOWN;
};

/** A call that did not produce the document the route promises. */
export interface TransportFailure {
  readonly route: RouteName;
  /** What happened, in one sentence, naming the route and the address. */
  readonly reason: string;
  /** What is known about whether the gateway got the call. */
  readonly reach: Reach;
  /**
   * The body, where it was JSON and simply was not the document.
   *
   * It is here for one reader: the poll loop, which looks in it for the
   * contract version, because a gateway of another dialect answers with
   * something this SDK cannot parse and would otherwise look exactly like a
   * broken one.
   */
  readonly body?: unknown;
  /**
   * The gateway's own refusal, where the answer was one.
   *
   * Present exactly when the body was the contract's error envelope, and it is
   * the difference between a failure this package had to describe and one the
   * gateway described itself. The two want different sentences in front of
   * them: everything else here is some flavour of "we cannot tell you what
   * happened", and this one is the gateway saying what it would not do and
   * why. It carries the code as a value and not only inside the sentence,
   * because a caller that wants to branch on the reason should not be parsing
   * prose to find it.
   *
   * `retryable` travels with it for the same reason and is the gateway's own
   * answer about its own refusal: whether making this call again could get
   * past it. Only the side that refused knows, and this package must not
   * improve on what it was told.
   */
  readonly refusal?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
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

const failure = (
  route: RouteName,
  reason: string,
  reach: Reach,
  body?: unknown,
  refusal?: TransportFailure["refusal"],
): { ok: false; failure: TransportFailure } => ({
  ok: false,
  failure: {
    route,
    reason,
    reach,
    ...(body === undefined ? {} : { body }),
    ...(refusal === undefined ? {} : { refusal }),
  },
});

/**
 * What is known about a failed call, in a clause that can be dropped into a
 * sentence about whatever the call was carrying.
 *
 * It lives here rather than in each caller so that the four cases are
 * described in one place and cannot drift into four different vocabularies.
 * Three of them are the reaches; the fourth is a refusal the gateway wrote in
 * words we recognise, which is the one failure here that is not a silence and
 * so does not belong to any of them.
 *
 * Each clause is held to what its own case actually knows, and the last reach
 * is the one that has to be written carefully, because it is one sentence in
 * front of three different situations. A call abandoned on an abort throws
 * with no code at all and may never have left this process. A connection that
 * broke in flight was certainly sent. And an answer that stopped mid-sentence
 * means the gateway certainly had the call — a status and part of a body came
 * back. So this clause says nothing about direction: not that the call was
 * sent, not that nothing came back, and not that whether it arrived is
 * unknown, because on the third road it is known and the answer is yes. What
 * the three share is that the exchange was cut short, and so what the call did
 * is not known — and that is the whole of what may be claimed here. The
 * specifics belong to the failure's own `reason`, which every caller prints
 * immediately after this clause and which names the road it came down.
 */
export const whatIsKnown = (failure: TransportFailure): string => {
  // The fourth case, ahead of the three reaches. Each of those says some
  // version of "we cannot tell you what this call did"; here the gateway told
  // us, in a shape we recognise, that it would not do it. Sending a merchant
  // "what came back could not be read" in front of a reason we are about to
  // quote is the message arguing with itself, and the half they believe is the
  // first one.
  if (failure.refusal !== undefined) {
    return "it reached us and the answer says the call did not go through";
  }

  switch (failure.reach) {
    case REACH.NOT_RECEIVED:
      return "no connection was made, so it did not reach us";
    case REACH.ANSWERED:
      return "it reached us and what came back could not be read, so what it did is not known here";
    case REACH.UNKNOWN:
      return "the exchange did not finish, so what the call did is not known here";
  }
};

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
        [MERCHANT_KEY_HEADER]: merchantKeyHeaderValue(gateway.apiKey),
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(options.body ?? {}) } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    return failure(
      name,
      `${name} at ${url.href} could not be reached: ${String(cause)}`,
      reachOf(cause),
    );
  }

  let text: string;

  try {
    text = await response.text();
  } catch (cause) {
    // The gateway answered and the answer was not read to the end. Saying
    // "answered with something that is not JSON" here would be blaming it for
    // a connection that broke on our side of the exchange.
    return failure(
      name,
      `${name} at ${url.href} began answering ${response.status} and the answer could not be read to the end: ${String(cause)}`,
      REACH.UNKNOWN,
    );
  }

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    return failure(
      name,
      `${name} at ${url.href} answered ${response.status} with something that is not JSON: ${quote(text)}`,
      REACH.ANSWERED,
    );
  }

  const parsed = route.response.document.safeParse(body);

  if (parsed.success) {
    return { ok: true, document: parsed.data as DocumentOf<N> };
  }

  // A body that is not the route's document is asked whether it is the
  // envelope every route says no in, and if it is, the caller is handed what
  // the gateway said rather than our complaint about being unable to read it.
  // That is the difference between telling a merchant their order is over and
  // sending them to read our schemas.
  //
  // What keeps this from swallowing one of the surface's own documents is not
  // the order of these two reads. Some of those documents are refusals — an
  // order call that did not go through says so inside the shape its route
  // promises — and the envelope declines them on its own: its outer object is
  // strict, so a body carrying anything beside `error` is not one, and the
  // `ok` discriminator those answers lead with is exactly such a field. The
  // guarantee is held where it can be checked rather than here, by a case in
  // `api.test.ts` that puts an envelope to every route's document and demands
  // a refusal from each. Reversing these two reads is not what would break it,
  // which is why this paragraph does not claim the order is load-bearing.
  //
  // The status is not consulted, here or above. Which refusals of this surface
  // arrive under which code is the gateway's to decide and is written down
  // nowhere both sides read, so a rule keyed on it would be a guess; the shape
  // of the answer is the agreement, and it is the same at 402 as at 500.
  const refused = ErrorEnvelopeSchema.safeParse(body);

  if (refused.success) {
    const { code, message, retryable } = refused.data.error;

    return failure(
      name,
      `${name} at ${url.href} was refused ${response.status}: ${code} — ${message}`,
      REACH.ANSWERED,
      body,
      { code, message, retryable },
    );
  }

  return failure(
    name,
    `${name} at ${url.href} answered ${response.status} with something that is not the document it promises: ${quote(text)}`,
    REACH.ANSWERED,
    body,
  );
};
