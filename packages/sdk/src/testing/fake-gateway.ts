/**
 * A gateway made of the route table, for the tests to talk to.
 *
 * It exists so that the SDK is exercised over a real socket against the real
 * addresses, with the real documents going each way, and without a network.
 * Everything it knows about the surface it reads out of `@coinslot/contracts`
 * at startup: which routes may be served (`mountableRoutes`), at which
 * addresses, under which method, behind which door, and which schema each
 * body and each answer is held to. Nothing about the surface is written down
 * here a second time, so a route that moves in the table moves here too, and a
 * test cannot pass against an address that no longer exists.
 *
 * It is strict in both directions on purpose. A request whose body the
 * contract refuses is answered with a complaint rather than with the answer
 * the test wanted, so an SDK that sends a document nobody would accept fails
 * loudly here instead of on a merchant's first order. And an answer a test
 * scripts is held to the route's own document before it is sent, so a test
 * cannot prove the SDK reads something the gateway could never say. Where a
 * test needs to send something malformed on purpose — a body that is not JSON,
 * an error page from a proxy — it says so by scripting `text` instead of
 * `body`, and that text goes out untouched.
 *
 * One thing it is not: a queue. Redelivery, visibility timeouts and the order
 * of a stream are the gateway's behaviour, and a test that needs them scripts
 * them by answering differently on the second call. That keeps the double
 * honest — it models the wire, not the machine behind it.
 *
 * This file is not part of the published surface: `index.ts` does not
 * re-export it, and its name keeps it out of the test glob. It depends on
 * `node:http` and on the contracts package, so it drags nothing into a
 * merchant's tree either.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mountableRoutes, type RouteDefinition, type RouteName } from "@coinslot/contracts";

/** One request that reached the gateway, after it was matched and read. */
export interface GatewayCall {
  readonly route: RouteName;
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** The key the caller presented, without the scheme word in front of it. */
  readonly apiKey: string | undefined;
}

/**
 * What a test wants sent back.
 *
 * `body` is a document and is held to the route's own schema before it goes
 * out. `text` is bytes and is not held to anything, which is what a test uses
 * to play a broken gateway, a proxy's error page or a truncated answer.
 */
export interface GatewayAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
}

/** How a test answers one route, given the call and how many came before it. */
export type Responder = (
  call: GatewayCall,
  index: number,
) => GatewayAnswer | Promise<GatewayAnswer>;

export interface FakeGatewayOptions {
  /** The key the gateway accepts on the routes that are behind the merchant's door. */
  readonly apiKey: string;
  readonly routes: Partial<Record<RouteName, Responder>>;
}

export interface FakeGateway {
  /** The address to hand `createClient`. */
  readonly url: string;
  /** Every call that was matched to a route, in the order they arrived. */
  readonly calls: readonly GatewayCall[];
  callsTo(route: RouteName): GatewayCall[];
  close(): Promise<void>;
}

interface Segment {
  readonly literal?: string;
  readonly param?: string;
}

interface Mounted {
  readonly name: RouteName;
  readonly route: RouteDefinition;
  readonly segments: readonly Segment[];
}

const segmentsOf = (path: string): Segment[] =>
  path
    .split("/")
    .filter((part) => part !== "")
    .map((part) => (part.startsWith(":") ? { param: part.slice(1) } : { literal: part }));

const mounted: Mounted[] = mountableRoutes().map(([name, route]) => ({
  name,
  route,
  segments: segmentsOf(route.path),
}));

const matchPath = (
  segments: readonly Segment[],
  parts: readonly string[],
): Record<string, string> | null => {
  if (segments.length !== parts.length) return null;

  const params: Record<string, string> = {};

  for (const [index, segment] of segments.entries()) {
    const part = parts[index] ?? "";

    if (segment.param !== undefined) {
      params[segment.param] = decodeURIComponent(part);
      continue;
    }
    if (segment.literal !== part) return null;
  }

  return params;
};

const answersOn = (route: RouteDefinition, method: string): boolean =>
  route.method === method || (route.also_answers_on ?? []).some((other) => other === method);

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const send = (response: ServerResponse, status: number, text: string): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
};

/**
 * Refuses a call, having first read whatever it was carrying.
 *
 * The reading is not decoration. A response ended while the request's body is
 * still arriving leaves that body in the socket, and the next call on the same
 * connection reads it as its own — which is a state no test would ever guess
 * at from the assertion that failed.
 */
const complain = async (
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  message: string,
): Promise<void> => {
  await readBody(request);
  send(response, status, JSON.stringify({ fake_gateway_refused: message }));
};

/**
 * The findings of a schema as one line, for the complaints this double sends
 * back. They are read by a person debugging a test, never by the SDK.
 */
const findingsOf = (issues: readonly { path: readonly PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => `${issue.path.map(String).join(".") || "(whole document)"}: ${issue.message}`)
    .join("; ");

export const startFakeGateway = async (options: FakeGatewayOptions): Promise<FakeGateway> => {
  const calls: GatewayCall[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    const parts = url.pathname.split("/").filter((part) => part !== "");
    const method = request.method ?? "GET";

    const hit = mounted
      .map((candidate) => ({ candidate, params: matchPath(candidate.segments, parts) }))
      .find((found) => found.params !== null);

    if (hit === undefined || hit.params === null) {
      await complain(
        request,
        response,
        404,
        `no mountable route answers ${method} ${url.pathname}`,
      );
      return;
    }

    const { candidate, params } = hit;

    if (!answersOn(candidate.route, method)) {
      await complain(
        request,
        response,
        405,
        `${candidate.name} answers on ${candidate.route.method}, not ${method}`,
      );
      return;
    }

    const authorization = request.headers.authorization;
    const apiKey =
      authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : undefined;

    if (candidate.route.auth === "merchant_key" && apiKey !== options.apiKey) {
      await complain(request, response, 401, `${candidate.name} is behind the merchant's key`);
      return;
    }

    const raw = await readBody(request);
    let body: unknown;

    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        await complain(request, response, 400, "the body was not JSON");
        return;
      }
    }

    const query = Object.fromEntries(url.searchParams);

    if (candidate.route.query !== undefined) {
      const checked = candidate.route.query.safeParse(query);
      if (!checked.success) {
        await complain(
          request,
          response,
          400,
          `the query string is not what ${candidate.name} takes: ${findingsOf(checked.error.issues)}`,
        );
        return;
      }
    }

    if (candidate.route.request !== undefined && method === candidate.route.method) {
      const checked = candidate.route.request.safeParse(body);
      if (!checked.success) {
        await complain(
          request,
          response,
          422,
          `the body is not what ${candidate.name} takes: ${findingsOf(checked.error.issues)}`,
        );
        return;
      }
    }

    const call: GatewayCall = { route: candidate.name, method, params, query, body, apiKey };
    const index = calls.filter((earlier) => earlier.route === candidate.name).length;
    calls.push(call);

    const responder = options.routes[candidate.name];

    if (responder === undefined) {
      await complain(request, response, 501, `the test did not script ${candidate.name}`);
      return;
    }

    // A caller that goes away — a worker stopping abandons its parked poll —
    // ends the exchange here too. A real gateway notices the connection has
    // gone and drops the work it was holding; a double that kept the request
    // open would leave the server unable to answer anything else on that
    // connection, which is a state no gateway would be in and which no test
    // should have to reason about.
    const clientLeft = Symbol("the caller went away");
    const gone = new Promise<typeof clientLeft>((resolve) => {
      response.on("close", () => resolve(clientLeft));
    });

    const answer = await Promise.race([responder(call, index), gone]);

    if (answer === clientLeft) {
      response.destroy();
      return;
    }

    const status = answer.status ?? 200;

    if (answer.text !== undefined) {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(answer.text);
      return;
    }

    if (status >= 200 && status < 300) {
      const checked = candidate.route.response.document.safeParse(answer.body);
      if (!checked.success) {
        await complain(
          request,
          response,
          500,
          `the test scripted an answer ${candidate.name} could never send: ${findingsOf(checked.error.issues)}`,
        );
        return;
      }
    }

    send(response, status, JSON.stringify(answer.body));
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((cause: unknown) => {
      void complain(request, response, 500, `the double itself failed: ${String(cause)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    callsTo: (route: RouteName) => calls.filter((call) => call.route === route),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};
