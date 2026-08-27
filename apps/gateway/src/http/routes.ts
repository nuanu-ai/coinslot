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
  paymentFingerprint,
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
          // The shape this call answers in carries a sale price and this order
          // has none: standing the card's number in for it would be a claim
          // about a sale that was never priced. Which of the two silences it is
          // matters to the merchant, so both are said, along with where the
          // order ended — one closed before it was priced is not waiting for
          // anything, and saying it was would be a positive false statement
          // about a purchase that is over.
          const status = outcomeFor(record.order);
          const open = status === "in_progress";
          return written(response, CONFLICT, {
            error: {
              code: open ? "order_not_priced_yet" : "order_closed_before_it_was_priced",
              message: open
                ? "this order is still waiting for its price, and until it has one there is no sale to describe"
                : `this order ended as ${status} before anybody named a price for it, so there is no sale to describe`,
              status,
            },
          });
        }
        const document: OrderWithStatus = {
          ...orderDocumentOf(record),
          status: outcomeFor(record.order),
        };
        return { status: OK, document };
      },
    },

    // Worth knowing before this list is reconciled against: it cannot show an
    // order that was closed before anybody named a price for it — a product the
    // merchant said was gone, or a price check he never answered on a card whose
    // money moves at the purchase. The document every row is written in carries
    // a sale price and those orders have none. They are readable one at a time
    // by identifier, where the refusal says what became of them.
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
      serve: async ({ params, body, response }) =>
        answeredOrder(response, await gateway.acceptOrder(params.order_id ?? "", body as never)),
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
        await gateway.payPurchase(
          presented.orderId,
          presented.raw,
          paymentFingerprint(presented.payload, edge.token()),
        ),
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

    case "payment_already_spent":
      // The same signed payment was presented for a different order. It is not
      // a refusal of the payment — it may be perfectly good — it is a refusal to
      // spend one authorisation on two purchases. Whether the agent is sent to
      // collect that other order depends on whether there is anything there to
      // collect; a claim held by an order that is over is a dead end, and
      // saying otherwise would send the agent looking for nothing.
      return written(
        response,
        CONFLICT,
        refusal(
          "payment_already_spent",
          attempt.collectable
            ? `this payment was already presented for order ${attempt.heldBy}, which is still open; one payment buys one order`
            : `this payment was already presented for order ${attempt.heldBy}, which is over; one payment buys one order, so this one needs a fresh payment`,
        ),
      );

    case "not_this_purchase":
      // This order already belongs to another payment — the payment layer named
      // its payer, and it is not the one this call presented. An order's
      // identifier travels, in a challenge, on the merchant's stream, in a
      // receipt, and holding one is not the same as being the agent whose
      // purchase it is. The wording claims nothing about how far along the order
      // is, only that it is not this caller's to pay.
      return written(
        response,
        CONFLICT,
        refusal("not_this_purchase", "this order already belongs to another payment"),
      );

    case "payment_not_verified":
      // The payment layer did not vouch for this payment, so nothing was
      // touched: the order is exactly where it was and ends on its own
      // deadline. The agent is told what the layer said and, where trying again
      // could reach it, that it may.
      return written(response, CONFLICT, {
        error: { code: "payment_not_verified", message: attempt.why, retryable: attempt.retryable },
      });

    case "payment_not_taken":
      // The machine would not take a payment on this order and said why. The
      // one way here today is an order whose charge never reported back: a
      // second one would be the buyer's money spent on a guess about the first,
      // and only the payment layer can end that.
      return written(response, CONFLICT, refusal("payment_not_taken", attempt.why));

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

    case "under_way": {
      if (attempt.order.order.mode.settle === "after_fulfillment") {
        // A synchronous purchase promises the agent the goods themselves inside
        // one ceiling. Coming back from that ceiling with no goods is not a
        // success, however the order is getting on internally — and the one way
        // to arrive here is the case that most needs saying: a charge that was
        // sent and never reported back. Answered 200, an agent would read "your
        // purchase is being worked on" for an order nothing is working on,
        // while holding nothing and not knowing whether it was charged.
        return written(response, CONFLICT, {
          order_id: attempt.order.order.id,
          status: outcomeFor(attempt.order.order),
        });
      }

      // The money moved at the purchase and the goods come later. The receipt
      // is written when the order reaches an ending, so at this moment there is
      // none — and the answer says so rather than leaving the field out, which
      // a reader cannot tell from an oversight.
      return written(response, OK, {
        order: orderDocumentOf(attempt.order),
        receipt: await gateway.runtime.store.receiptForOrder(attempt.order.order.id),
      });
    }

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
