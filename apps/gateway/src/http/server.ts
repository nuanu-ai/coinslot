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
 * never mounted at all, because the list this loop walks is the one the contract
 * calls mountable — leaving it out of the loop is what stops the agent's status
 * route, the only route under the merchant's prefix that is not the merchant's,
 * from being served to the whole world by accident.
 *
 * What the table deliberately does not carry, this file supplies: the header the
 * merchant's key arrives in, and the status code each answer comes back under.
 * Those are the gateway's, and a number invented in the contract would have been
 * a decision nobody took.
 */

import {
  type AuthMode,
  mountableRoutes,
  type RouteDefinition,
  type RouteName,
} from "@coinslot/contracts";
import express, { type Express, type Request, type Response } from "express";
import type { ZodType } from "zod";
import type { Gateway } from "../app/gateway.js";
import { bearerIn, keyMatches } from "./auth.js";
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
  if (!allowedThrough(route.auth, request, gateway)) {
    // Which key would have worked is not said, and neither is whether one was
    // sent at all: both are answers to somebody who is guessing.
    response.status(401).json(refusal("not_authorised", "this call is behind the merchant's key"));
    return;
  }

  let body: unknown = carriesBody ? request.body : undefined;
  if (carriesBody && route.request !== undefined && handler.checksItsOwnBody !== true) {
    const held = hold(route.request, request.body);
    if (!held.ok) {
      response.status(400).json({ error: { code: "malformed_body", problems: held.problems } });
      return;
    }
    body = held.value;
  }

  let query: unknown;
  if (route.query !== undefined) {
    const held = hold(route.query, request.query);
    if (!held.ok) {
      response.status(400).json({ error: { code: "malformed_query", problems: held.problems } });
      return;
    }
    query = held.value;
  }

  const answered = await handler.serve({
    params: request.params as Record<string, string>,
    body,
    query,
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
  if ("document" in route.response) {
    route.response.document.parse(answered.document);
  }

  response.status(answered.status).json(answered.document);
}

function allowedThrough(auth: AuthMode, request: Request, gateway: Gateway): boolean {
  if (auth !== "merchant_key") {
    return true;
  }
  const presented = bearerIn(request.header("authorization") ?? undefined);
  return presented !== null && keyMatches(presented, gateway.runtime.config.merchantApiKey);
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
 * The gateway's own refusal document.
 *
 * It is the gateway's and not the contract's, and that is worth knowing: the
 * route table publishes what each call answers with when it works, and says
 * nothing about the shapes of "you are not allowed", "there is no such route"
 * or "something here is broken". Those are invented here, so nothing in the
 * SDK should be written against them beyond the status code.
 */
export function refusal(
  code: string,
  message: string,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
