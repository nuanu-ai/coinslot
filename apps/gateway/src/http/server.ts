/**
 * The HTTP surface, mounted from the table rather than written out.
 *
 * `packages/contracts/src/api.ts` is the agreement: which calls exist, at which
 * addresses, behind which door, with which document going each way. This file
 * reads that table and serves it. Nothing below writes an address, a method or
 * a schema of its own, and that is the whole point — a surface transcribed by
 * hand is how one side ends up posting to `/v0/order/:id/deliver` while the
 * other serves `/v0/orders/:id/deliver`.
 *
 * Two consequences are deliberate and both are loud. A route in the table with
 * nothing to serve it stops the gateway from starting, so a call cannot be
 * agreed and quietly unimplemented. And a route whose door nobody has chosen is
 * never mounted: the list this loop walks is the one the contract calls
 * mountable, and the loop refuses such a route again on its own account, so a
 * door nobody chose cannot be opened by editing a list.
 *
 * Which door a call is behind is read off `auth` and off nothing else — never
 * off the address. That is the one rule this file has to keep, and the reason
 * is one route: the agent's order status sits under `/v0/orders`, where every
 * other route is the merchant's. A key check attached to that prefix would shut
 * the only caller that route is for out of it, and nothing about the table
 * would look wrong. So there is no path-scoped middleware here at all, and the
 * function that resolves the door names every mode the contract has — adding
 * one stops the build until somebody says which door it is, rather than
 * defaulting it to open.
 *
 * What the table deliberately does not carry, this file supplies: the header the
 * merchant's key arrives in, and the status code each answer comes back under.
 * Those are the gateway's, and a number invented in the contract would have been
 * a decision nobody took.
 */

import {
  type AuthMode,
  type ErrorCode,
  type ErrorEnvelope,
  MERCHANT_KEY_HEADER,
  mountableRoutes,
  type RouteDefinition,
  type RouteName,
} from "@coinslot/contracts";
import express, { type Express, type Request, type Response } from "express";
import type { ZodType } from "zod";
import type { Gateway } from "../app/gateway.js";
import { bearerIn } from "./auth.js";
import { handlersFor } from "./routes.js";

/** What a handler answers with: a document and its status, or its own writing. */
export type RouteAnswer =
  | { readonly status: number; readonly document: unknown }
  /** The handler wrote the response itself. Only the payment exchange does. */
  | { readonly written: true };

export interface RouteCall {
  readonly params: Readonly<Record<string, string>>;
  /** The body, already held to the schema the table names for this route. */
  readonly body: unknown;
  readonly query: unknown;
  /**
   * Whose key opened this call, where the route is behind one.
   *
   * It is resolved before any handler runs, and a route behind the merchant's
   * key whose key resolves to nobody never reaches a handler at all — so on
   * those routes this is a merchant that exists. Null is what an open route
   * carries: the catalog and the purchase take no key, because an agent has
   * none.
   */
  readonly merchantId: string | null;
  /**
   * Which key opened this call, resolved in the same lookup as the merchant.
   *
   * One route needs it and the reason is a rule rather than a convenience: a
   * merchant cannot disable the key their own call was made with (ADR-0014 §5),
   * and this is the only place that knows which key that was. Read again in a
   * handler it would be a second hash of the same header and a second chance for
   * the two answers to disagree.
   *
   * Null on an open route, exactly as the merchant is, and for the same reason.
   */
  readonly keyId: string | null;
  readonly request: Request;
  readonly response: Response;
}

export type RouteHandler = (call: RouteCall) => Promise<RouteAnswer>;

/** One call of the table, and how it is served. */
export interface MountedRoute {
  readonly serve: RouteHandler;
  /**
   * The body reaches this handler unchecked, because the contract gave this
   * call somewhere in its own answer to say what is wrong with what arrived.
   *
   * Publishing a card is the one. Its answer is either an identifier or a list
   * of findings, and that list is how a merchant learns everything wrong with
   * their card at once. Checked generically, the card would come back under
   * the gateway's own refusal shape instead, and the branch the contract
   * designed for it would never be reached by anybody.
   */
  readonly checksItsOwnBody?: boolean;
}

/** The most a request body may be. A card with a large schema is still small. */
const BODY_LIMIT = "256kb";

/**
 * The whole surface, on an express app.
 *
 * `routes` is a parameter with the real table as its default so that the guard
 * below can be shown to work. Nothing but a test ever passes anything else, and
 * what a deployment mounts is the contract's own list.
 */
export function buildApp(
  gateway: Gateway,
  routes: readonly [RouteName, RouteDefinition][] = mountableRoutes(),
): Express {
  const app = express();
  const handlers = handlersFor(gateway);

  // Behind a terminator the address an agent called is not the one this process
  // sees. The challenge names the address from configuration rather than from
  // the request, so this is only about the client's own address in logs.
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true });
  });

  for (const [name, route] of routes) {
    // The contract's own list already leaves these out, and that is one filter
    // away from not doing so. Refusing them here as well puts the guard at the
    // place the mistake would land, so a route whose door nobody has chosen
    // cannot be served by handing it over by name.
    if (route.auth === "undecided") {
      throw new Error(
        `the contract leaves ${name}'s door undecided, so this gateway will not serve it at ${route.method} ${route.path}`,
      );
    }
    const handler = handlers[name];
    if (handler === undefined) {
      throw new Error(
        `the contract's route table names ${name} at ${route.method} ${route.path} and this gateway has nothing to serve it with`,
      );
    }
    mount(app, name, route, handler, gateway);
  }

  app.use((_request, response) => {
    response.status(404).json(refusal("no_such_route", "there is no call at this address"));
  });

  // Everything refused before a route runs arrives here, and here is the only
  // place it is still possible to say what was refused. Without an answer of
  // our own it comes back as express's own HTML page — from a surface whose
  // every other refusal is a document, to a client that reads only documents.
  //
  // The rule is the status. Whatever raised the throw, a 4xx is that thing
  // saying the caller was wrong, and this gateway does not take the blame for a
  // call it was right to turn away: a 5xx is the one answer an agent is
  // entitled to retry, and the retry brings the same bad request back for as
  // long as it keeps trying. A throw carrying no such claim is ours, and gets
  // the log line and the 500.
  //
  // Within that, the named refusals are refinements, each keyed on the word the
  // parser puts on its own throw. They exist because the answer is the only
  // thing the caller can act on, and one refusal wearing another's words sends
  // somebody else's agent to repair what was never broken. A document that is
  // good JSON and merely too long, told it could not be read, is re-encoded and
  // sent again unchanged forever, so the size case says so and names the limit
  // — "too large" without a number leaves the caller bisecting against a live
  // gateway. The encoding and charset refusals both happen before the body
  // becomes text at all, so nothing whatever about the JSON inside is known and
  // neither answer pretends otherwise; each names the header it refused and the
  // one value that always works, rather than the set that would work, which
  // belongs to a dependency and would rot in this file unwatched.
  //
  // One refusal arrives with no word on it: a body under an encoding the parser
  // does inflate whose bytes then turn out not to be that encoding — a dropped
  // upload, or a client that set the header and forgot to compress. Two things
  // are known there and no more, that the caller asked for a decompression and
  // that the parser blamed the caller. That is enough to answer honestly and
  // not enough to say whether the bytes or the header is the wrong one, so the
  // answer offers both and picks neither.
  //
  // Order carries the rest. Every named refusal is answered above the unnamed
  // ones, which is what keeps a body that inflates cleanly and holds bad JSON —
  // the same header, a different failure — on the malformed-JSON answer. The
  // generic sits under all of them and says only that the call was refused
  // before we began and that there is no name for why here. The next refusal
  // raised by a layer we do not control lands there, and a floor that guessed
  // would be wrong about it in some new way.
  app.use(
    (thrown: unknown, request: Request, response: Response, next: (error?: unknown) => void) => {
      if (response.headersSent) {
        next(thrown);
        return;
      }

      if (blamesTheCaller(thrown)) {
        const named = refusalType(thrown);

        if (named === "entity.parse.failed") {
          response
            .status(400)
            .json(refusal("malformed_body", "this call's body could not be read as JSON"));
          return;
        }
        if (named === "entity.too.large") {
          response
            .status(413)
            .json(
              refusal(
                "body_too_large",
                `this call's body is over the ${BODY_LIMIT} a call may carry`,
              ),
            );
          return;
        }
        if (named === "charset.unsupported") {
          response
            .status(415)
            .json(
              refusal(
                "charset_unsupported",
                "this call's body was not read because the charset its content-type names is not one this gateway decodes, so send it as utf-8",
              ),
            );
          return;
        }
        if (named === "encoding.unsupported") {
          response
            .status(415)
            .json(
              refusal(
                "encoding_unsupported",
                "this call's body was not read because its content-encoding is not one this gateway decompresses, so send the body uncompressed",
              ),
            );
          return;
        }
        if (declaresCompression(request)) {
          response
            .status(400)
            .json(
              refusal(
                "body_undecodable",
                "this call's body could not be decompressed as the content-encoding it declares, so either those bytes or that header is wrong",
              ),
            );
          return;
        }

        response
          .status(400)
          .json(
            refusal(
              "call_refused",
              "this call was refused before the gateway began handling it, for a reason this gateway has no name for",
            ),
          );
        return;
      }

      console.error("[gateway] a request failed before it reached a route", thrown);
      response
        .status(500)
        .json(refusal("gateway_failed", "this call did not complete and nothing was decided"));
    },
  );

  return app;
}

function mount(
  app: Express,
  name: RouteName,
  route: RouteDefinition,
  handler: MountedRoute,
  gateway: Gateway,
): void {
  const methods = [route.method, ...(route.also_answers_on ?? [])];

  for (const method of methods) {
    // Only the route's own method carries a body. The others exist because
    // something outside our design asks for them — a validator listing a paid
    // resource with GET — and they answer without one.
    const carriesBody = method === route.method;
    const serve = async (request: Request, response: Response): Promise<void> => {
      try {
        await answer(request, response, route, handler, gateway, carriesBody);
      } catch (thrown) {
        // A defect. The agent or the merchant is told that something here is
        // broken, and nothing about what: an error text is a claim like any
        // other, and one assembled out of an exception makes claims about our
        // internals to somebody who cannot act on them.
        console.error(`[gateway] ${name} failed`, thrown);
        if (!response.headersSent) {
          response
            .status(500)
            .json(refusal("gateway_failed", "this call did not complete and nothing was decided"));
        }
      }
    };

    if (method === "GET") {
      app.get(route.path, serve);
    } else {
      app.post(route.path, serve);
    }
  }
}

async function answer(
  request: Request,
  response: Response,
  route: RouteDefinition,
  handler: MountedRoute,
  gateway: Gateway,
  carriesBody: boolean,
): Promise<void> {
  const caller = await callerBehind(route.auth, request, gateway);
  if (caller === REFUSED) {
    // Which key would have worked is not said, whether one was sent at all is
    // not said, and a key that was issued and then revoked is refused in
    // exactly these words — all three are answers to somebody who is guessing.
    response.status(401).json(refusal("not_authorised", "this call is behind the merchant's key"));
    return;
  }

  let body: unknown = carriesBody ? request.body : undefined;
  if (carriesBody && route.request !== undefined && handler.checksItsOwnBody !== true) {
    const held = hold(route.request, request.body);
    if (!held.ok) {
      response
        .status(400)
        .json(
          refusal(
            "malformed_body",
            "this call's body is not the document this call takes, and the problems say which fields and why",
            { problems: held.problems },
          ),
        );
      return;
    }
    body = held.value;
  }

  let query: unknown;
  if (route.query !== undefined) {
    const held = hold(route.query, request.query);
    if (!held.ok) {
      response
        .status(400)
        .json(
          refusal(
            "malformed_query",
            "this call's query string is not the one this call takes, and the problems say which fields and why",
            { problems: held.problems },
          ),
        );
      return;
    }
    query = held.value;
  }

  const answered = await handler.serve({
    params: request.params as Record<string, string>,
    body,
    query,
    merchantId: caller?.merchantId ?? null,
    keyId: caller?.keyId ?? null,
    request,
    response,
  });

  if ("written" in answered) {
    return;
  }

  // The document goes out held to the same schema the SDK will hold it to. A
  // response that does not match the contract is a lie the other side would
  // reject anyway, and failing on our side is how it gets found here rather
  // than in somebody's integration.
  //
  // A handler that writes its own response — the payment exchange, and every
  // refusal — passes above and is not held to this. That is what `written`
  // means and it is the whole of the exception: a challenge is a header and an
  // empty body, and a refusal is the contract's envelope rather than the
  // route's document.
  route.response.document.parse(answered.document);

  response.status(answered.status).json(answered.document);
}

/** The door said no. A value rather than null, which is what an open route has. */
const REFUSED = Symbol("the key on this call opens nothing");

/** Who made a call that came through a door: the merchant, and which key. */
interface Caller {
  readonly merchantId: string;
  readonly keyId: string;
}

/**
 * Who is behind this call: a merchant and the key they presented, nobody at all
 * on a route that takes no key, or the refusal.
 *
 * Every door the contract has is named below, and the last branch is why: a
 * mode added to the contract and not answered here stops the build, naming the
 * omission. Written as "is it the merchant's key, and otherwise nobody", the
 * same addition would have quietly made the new route open, and the one route
 * that already takes no key is the agent's own — under the merchant's prefix,
 * where nobody would look for it.
 *
 * There is no comparison here and there is nothing to compare against — the key
 * presented is hashed and the digest looked up, and a key nobody was issued and
 * a key that has been disabled come back the same way. That sameness is the
 * point: a door that answered them differently would confirm which guesses had
 * once been real keys, which is exactly what revoking one has to stop.
 *
 * What it costs is a database round trip on every call behind this door, where
 * the single key it replaced cost nothing. It is one probe of a unique index
 * and it does not grow with the number of merchants or of keys, so the trigger
 * for caching it is a measurement rather than a feeling — and a cache would
 * have to answer for how long a revoked key goes on working, which is the one
 * thing revoking a key is for.
 */
async function callerBehind(
  auth: AuthMode,
  request: Request,
  gateway: Gateway,
): Promise<Caller | null | typeof REFUSED> {
  switch (auth) {
    case "merchant_key": {
      const presented = bearerIn(request.header(MERCHANT_KEY_HEADER) ?? undefined);
      if (presented === null) {
        return REFUSED;
      }
      const key = await gateway.keyBehind(presented);
      return key === null ? REFUSED : { merchantId: key.merchantId, keyId: key.id };
    }

    // Neither of these carries a key, and they are two different reasons for
    // that rather than one. On an open route the payment stands in for
    // authorisation, or there is nothing to authorise — the catalog. On the
    // agent's own route the order's identifier does, so whatever arrives in the
    // key's header is not read at all: a stranger's key neither opens this door
    // nor closes it.
    case "none":
    case "order_id":
      return null;

    case "undecided":
      throw new Error("a route whose door nobody has chosen reached the door");

    default: {
      const unanswered: never = auth;
      throw new Error(`this gateway builds no door for ${String(unanswered)}`);
    }
  }
}

/**
 * Whether a thrown value is a refusal of the caller rather than a failure of
 * ours.
 *
 * Everything that turns a request away before our handlers do — the body
 * parser, the router decoding a path — marks the refusal the same way, with an
 * HTTP status, and on a throw that says nothing else the status is the only
 * part that says whose fault it was. A 4xx is that layer declining what it was
 * sent; anything else is this process, and this process does not get to answer
 * its own defects with somebody else's name on them.
 */
function blamesTheCaller(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null || !("status" in thrown)) {
    return false;
  }
  const { status } = thrown as { status: unknown };
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * The word a refusal puts on itself, when it puts one there at all.
 *
 * The body parser names most of what it turns away; the layers around it name
 * almost nothing. A refusal with no word is not a lesser refusal, only one this
 * gateway has no refinement for, and it is answered as such rather than being
 * sorted into whichever named case it happens to resemble.
 */
function refusalType(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null || !("type" in thrown)) {
    return null;
  }
  const { type } = thrown as { type: unknown };
  return typeof type === "string" ? type : null;
}

/**
 * Whether the caller asked for the body to be decompressed on the way in.
 *
 * An absent header and an empty one both mean identity, which is what the
 * parser itself makes of them; reading either as a compression would put a
 * refusal that has nothing to do with encoding under an answer about encoding.
 */
function declaresCompression(request: Request): boolean {
  const declared = request.headers["content-encoding"];
  if (typeof declared !== "string") {
    return false;
  }
  const named = declared.toLowerCase().trim();
  return named !== "" && named !== "identity";
}

type Held = { ok: true; value: unknown } | { ok: false; problems: readonly unknown[] };

function hold(schema: ZodType, value: unknown): Held {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      path: issue.path.map((step) => String(step)),
      code: issue.code,
      message: issue.message,
    })),
  };
}

/**
 * How this gateway says no, and the only way it does.
 *
 * The shape is the contract's — `ErrorEnvelopeSchema` — and so is the code:
 * the first parameter takes one of `ERROR_CODES` and nothing else, which is
 * what makes that published list true rather than a description somebody keeps
 * in step by hand. A refusal this gateway wants to send under a name the
 * contract has not got stops the build until the name is added there, where a
 * consumer switching over the codes will see it.
 *
 * The words stay ours. The table publishes what each call answers with when it
 * works and names no sentences, so "you are not allowed", "there is no such
 * route" and "something here is broken" are this gateway's to write, and the
 * contract fixes only that every refusal arrives in one shape with a code and
 * a sentence — so a caller can always find out that it was refused and always
 * have something to print.
 *
 * `detail` is for the refusals that know more about themselves than the two
 * required fields: where an order ended, whether the payment layer might
 * vouch for a second attempt, which fields of a document did not fit. It goes
 * inside the envelope beside the code and the sentence rather than beside the
 * envelope, because a reader that does not recognise it must still be able to
 * read the two that are always there — and because a body carrying anything at
 * the top level but `error` is not a refusal at all.
 *
 * It is spread first, so the code and the sentence win. Spread last it would
 * be a way of replacing them: a detail that happened to carry a `message` —
 * a field named after the thing it describes, arriving from a payment layer or
 * a validator — would silently become the refusal's own sentence, and the one
 * the caller was meant to read would be gone with nothing to say it ever
 * existed. The type does not catch it, because `unknown` fits a string.
 *
 * Every refusal this gateway sends goes through here. Three of them used to be
 * written out as object literals with findings and no sentence at all, which
 * left the caller a code to search our source for and an empty space where the
 * reason belongs.
 */
export function refusal(
  code: ErrorCode,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): ErrorEnvelope {
  return { error: { ...detail, code, message } };
}
