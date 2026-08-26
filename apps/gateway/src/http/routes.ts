/**
 * What each call in the table actually does.
 *
 * The table says where a call lives and what shape goes each way; this says
 * which flow answers it. Nothing here decides anything about an order either —
 * every handler is a translation between one HTTP request and one call on the
 * gateway, and the status codes are the only judgement it makes, because the
 * contract deliberately carries none.
 *
 * The purchase is the one handler that writes its own response, and it is the
 * only one that has to: its answer is a payment exchange before it is a
 * document, and the challenge travels in a header.
 */

import type {
  OrderListQuery,
  OrderWithStatus,
  PurchaseRequest,
  RouteName,
  WorkerPollRequest,
} from "@coinslot/contracts";
import { outcomeFor } from "@coinslot/core";
import type { Gateway, PurchaseAttempt } from "../app/gateway.js";
import { orderDocumentOf } from "../app/runner.js";
import type { MountedRoute, RouteAnswer, RouteCall } from "./server.js";
import { refusal } from "./server.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PaymentEdge,
  presentedPayment,
} from "./x402.js";

/**
 * The status codes.
 *
 * They are here rather than scattered through the handlers so that a reader can
 * see the whole judgement at once. Two of them are worth arguing. A merchant's
 * call that the machine could not honour comes back as 409 rather than 200:
 * the document already says `ok: false`, but a client that only reads statuses
 * would otherwise record a refusal as a success. And a purchase whose order
 * ended in anything but delivery is also 409 — the call was understood, and
 * what it ran into is the state of the world.
 */
const OK = 200;
const PAYMENT_REQUIRED = 402;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNPROCESSABLE = 422;

export function handlersFor(gateway: Gateway): Partial<Record<RouteName, MountedRoute>> {
  const { config } = gateway.runtime;
  const edge = new PaymentEdge(config.payment, config.publicBaseUrl, config.payment.timeoutSeconds);

  return {
    publish_card: {
      // The card is checked by the flow rather than by the mounting loop, so
      // everything wrong with it comes back in the contract's own list of
      // findings — which is the whole point of that branch existing.
      checksItsOwnBody: true,
      serve: async ({ body }) => {
        const published = await gateway.publishCard(body);
        return { status: "ok" in published ? OK : UNPROCESSABLE, document: published };
      },
    },

    list_catalog: { serve: async () => ({ status: OK, document: await gateway.catalog() }) },

    get_order: {
      serve: async ({ params, response }) => {
        const record = await gateway.orderById(params.order_id ?? "");
        if (record === null) {
          return written(response, NOT_FOUND, refusal("no_such_order", "there is no such order"));
        }
        if (record.order.price === null) {
          // An order still waiting for its price has no sale price, and the shape
          // this call answers in requires one. Standing the card's number in for
          // it would be a claim about a sale that has not been priced.
          return written(
            response,
            CONFLICT,
            refusal("order_not_priced_yet", "this order is still waiting for its price"),
          );
        }
        const document: OrderWithStatus = {
          ...orderDocumentOf(record),
          status: outcomeFor(record.order),
        };
        return { status: OK, document };
      },
    },

    list_orders: {
      serve: async ({ query }) => {
        // Only "true" narrows the list. Anything else asks for everything, which
        // is what the contract says and what a merchant reconciling their books
        // has to be able to rely on.
        const asked = (query as OrderListQuery | undefined)?.open;
        const records = await gateway.orders(asked === "true" ? true : undefined);
        return {
          status: OK,
          document: {
            orders: records
              .filter((record) => record.order.price !== null)
              .map((record) => ({ ...orderDocumentOf(record), status: outcomeFor(record.order) })),
          },
        };
      },
    },

    poll_worker: {
      serve: async ({ body }) => {
        const asked = body as WorkerPollRequest;
        return {
          status: OK,
          document: await gateway.poll(
            asked.max ?? gateway.runtime.config.worker.pollMaxEnvelopes,
            asked.wait_seconds === undefined
              ? gateway.runtime.config.worker.pollWaitMs
              : asked.wait_seconds * 1_000,
          ),
        };
      },
    },

    answer_order: {
      serve: async ({ params, body, response }) =>
        answeredOrder(response, await gateway.answerOrder(params.order_id ?? "", body as never)),
    },

    deliver_order: {
      serve: async ({ params, body, response }) =>
        answeredOrder(response, await gateway.deliverOrder(params.order_id ?? "", body as never)),
    },

    refuse_order: {
      serve: async ({ params, body, response }) =>
        answeredOrder(response, await gateway.refuseOrder(params.order_id ?? "", body as never)),
    },

    accept_order: {
      serve: async ({ params, body, response }) => {
        const taken = await gateway.acceptOrder(params.order_id ?? "", body as never);
        if (taken === null) {
          return written(response, NOT_FOUND, refusal("no_such_order", "there is no such order"));
        }
        return { status: taken.ok ? OK : CONFLICT, document: taken };
      },
    },

    answer_quote: {
      serve: async ({ params, body }) => ({
        status: OK,
        document: await gateway.answerQuote(params.price_id ?? "", body as never),
      }),
    },

    purchase_item: { serve: (call) => purchase(gateway, edge, call) },
  };
}

/** A merchant's call, answered with the document the machine produced. */
function answeredOrder(
  response: RouteCall["response"],
  answered: { readonly ok: boolean } | null,
): RouteAnswer {
  if (answered === null) {
    return written(response, NOT_FOUND, refusal("no_such_order", "there is no such order"));
  }
  return { status: answered.ok ? OK : CONFLICT, document: answered };
}

/**
 * Buying one product.
 *
 * A GET produces the challenge and never a purchase: it carries no body, so it
 * has no parameters and there is nothing to open an order with. That is the
 * whole reason the address answers on GET at all — the validators and crawlers
 * that list a paid resource ask for it that way, and a paywall bound to one
 * method makes the resource invisible to them.
 *
 * A POST is the purchase. Without a payment it opens an order, has it priced,
 * and answers with what that order costs. With one it looks up the order the
 * payment names and drives it. A payment naming an order we are not holding is
 * answered with a fresh challenge rather than an error: the agent then pays
 * against a price this gateway actually issued, which is the only kind it can
 * check.
 */
async function purchase(
  gateway: Gateway,
  edge: PaymentEdge,
  { params, body, request, response }: RouteCall,
): Promise<RouteAnswer> {
  const itemId = params.item_id ?? "";
  const path = request.originalUrl.split("?")[0] ?? request.path;

  if (request.method === "GET") {
    const stored = await gateway.runtime.store.cardById(itemId);
    if (stored === null) {
      return written(response, NOT_FOUND, refusal("no_such_item", "there is no such product"));
    }
    response.setHeader(
      PAYMENT_REQUIRED_HEADER,
      edge.challengeFor(
        { amount: stored.card.price.amount, currency: stored.card.price.currency },
        null,
        path,
        stored.card.description,
        "this resource is paid for; the price here is the published one and a purchase is priced when it is made",
      ),
    );
    return written(response, PAYMENT_REQUIRED, {});
  }

  const presented = presentedPayment(request.headers);

  if (presented !== null && presented.orderId !== null) {
    const named = await gateway.orderById(presented.orderId);
    if (named !== null) {
      return answerPurchase(
        gateway,
        edge,
        response,
        path,
        await gateway.payPurchase(presented.orderId, presented.raw),
      );
    }
  }

  const asked = (body as PurchaseRequest | undefined)?.params ?? {};
  const attempt = await gateway.beginPurchase(itemId, asked);
  return answerPurchase(
    gateway,
    edge,
    response,
    path,
    attempt,
    presented === null
      ? undefined
      : "the payment did not name an order this gateway is holding, so here is a fresh price",
  );
}

async function answerPurchase(
  gateway: Gateway,
  edge: PaymentEdge,
  response: RouteCall["response"],
  path: string,
  attempt: PurchaseAttempt,
  why?: string,
): Promise<RouteAnswer> {
  switch (attempt.step) {
    case "no_such_item":
      return written(response, NOT_FOUND, refusal("no_such_item", "there is no such product"));

    case "params_rejected":
      return written(response, UNPROCESSABLE, {
        error: { code: "params_do_not_fit", problems: attempt.problems },
      });

    case "not_selling":
      return written(response, CONFLICT, refusal("not_selling", attempt.message));

    case "pay": {
      const price = attempt.order.order.price;
      if (price === null) {
        throw new Error(`the order ${attempt.order.order.id} was offered for sale with no price`);
      }
      response.setHeader(
        PAYMENT_REQUIRED_HEADER,
        edge.challengeFor(price, attempt.order.order.id, path, "one purchase", why),
      );
      return written(response, PAYMENT_REQUIRED, {});
    }

    case "under_way":
      // The money moved at the purchase and the goods come later. The receipt
      // is written when the order reaches an ending, so at this moment there is
      // none — and the answer says so rather than leaving the field out, which
      // a reader cannot tell from an oversight.
      return written(response, OK, {
        order: orderDocumentOf(attempt.order),
        receipt: await gateway.runtime.store.receiptForOrder(attempt.order.order.id),
      });

    case "settled": {
      const outcome = outcomeFor(attempt.order.order);
      const settlement = attempt.order.settlement;
      if (settlement !== null) {
        // The payment layer's own receipt, which an agent's x402 client reads
        // off the answer to its purchase.
        response.setHeader(
          PAYMENT_RESPONSE_HEADER,
          edge.receiptHeader({
            success: true,
            transaction: settlement.transaction,
            network: gateway.runtime.config.payment.network as `${string}:${string}`,
          }),
        );
      }

      if (outcome === "delivered") {
        return written(response, OK, {
          delivered: attempt.delivery,
          order: orderDocumentOf(attempt.order),
          receipt: await gateway.runtime.store.receiptForOrder(attempt.order.order.id),
        });
      }

      return written(response, CONFLICT, {
        order_id: attempt.order.order.id,
        status: outcome,
      });
    }
  }
}

function written(response: RouteCall["response"], status: number, document: unknown): RouteAnswer {
  response.status(status).json(document);
  return { written: true };
}
