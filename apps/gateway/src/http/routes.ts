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

/**
 * The merchant whose key opened this call.
 *
 * Every handler that asks is on a route the contract puts behind the merchant's
 * key, and the mounting loop resolves that key before any handler runs and
 * answers 401 where it resolves to nobody. So null cannot arrive here — it
 * would mean the route table and this file disagree about which calls are the
 * merchant's, and the safe thing then is to stop rather than to act for a
 * merchant this line had to invent.
 */
function merchantOf({ merchantId }: RouteCall): string {
  if (merchantId === null) {
    throw new Error(
      "this call was served as one of the merchant's and reached its handler with no merchant behind it",
    );
  }
  return merchantId;
}

export function handlersFor(gateway: Gateway): Partial<Record<RouteName, MountedRoute>> {
  const { config } = gateway.runtime;
  const edge = new PaymentEdge(config.payment, config.publicBaseUrl, config.payment.timeoutSeconds);

  return {
    publish_card: {
      // The card is checked by the flow rather than by the mounting loop, so
      // everything wrong with it comes back in the contract's own list of
      // findings — which is the whole point of that branch existing.
      checksItsOwnBody: true,
      serve: async (call) => {
        const published = await gateway.publishCard(merchantOf(call), call.body);
        return { status: "ok" in published ? OK : UNPROCESSABLE, document: published };
      },
    },

    list_catalog: { serve: async () => ({ status: OK, document: await gateway.catalog() }) },

    list_merchant_cards: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.merchantCards(merchantOf(call)),
      }),
    },

    pause_card: { serve: (call) => cardPaused(gateway, call, true) },

    resume_card: { serve: (call) => cardPaused(gateway, call, false) },

    pause_selling: { serve: (call) => sellingSet(gateway, call, "paused") },

    resume_selling: { serve: (call) => sellingSet(gateway, call, "open") },

    list_receipts: {
      serve: async (call) => ({ status: OK, document: await gateway.receipts(merchantOf(call)) }),
    },

    get_order: {
      serve: async (call) => {
        const { params, response } = call;
        // The merchant's own read of one order, and another merchant's order is
        // not found — the same answer an identifier naming nothing gets, so a
        // stranger learns nothing by guessing.
        const record = await gateway.merchantOrder(merchantOf(call), params.order_id ?? "");
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
      serve: async (call) => {
        // Only "true" narrows the list. Anything else asks for everything, which
        // is what the contract says and what a merchant reconciling their books
        // has to be able to rely on — everything of theirs, that is: the
        // merchant is in the query and nobody else's order is read at all.
        const asked = (call.query as OrderListQuery | undefined)?.open;
        const records = await gateway.orders(merchantOf(call), asked === "true" ? true : undefined);
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
      serve: async (call) => {
        const asked = call.body as WorkerPollRequest;
        return {
          status: OK,
          // A worker draws its own merchant's stream. It is not a filter over
          // what came back: the stream is named by the merchant the key
          // resolved to, so a stranger's envelope is never drawn and so never
          // held out of reach of the worker it was meant for.
          document: await gateway.poll(
            merchantOf(call),
            asked.max ?? gateway.runtime.config.worker.pollMaxEnvelopes,
            asked.wait_seconds === undefined
              ? gateway.runtime.config.worker.pollWaitMs
              : asked.wait_seconds * 1_000,
          ),
        };
      },
    },

    answer_order: {
      serve: async (call) =>
        answeredOrder(
          call.response,
          await gateway.answerOrder(
            merchantOf(call),
            call.params.order_id ?? "",
            call.body as never,
          ),
        ),
    },

    deliver_order: {
      serve: async (call) =>
        answeredOrder(
          call.response,
          await gateway.deliverOrder(
            merchantOf(call),
            call.params.order_id ?? "",
            call.body as never,
          ),
        ),
    },

    refuse_order: {
      serve: async (call) =>
        answeredOrder(
          call.response,
          await gateway.refuseOrder(
            merchantOf(call),
            call.params.order_id ?? "",
            call.body as never,
          ),
        ),
    },

    accept_order: {
      serve: async (call) =>
        answeredOrder(
          call.response,
          await gateway.acceptOrder(
            merchantOf(call),
            call.params.order_id ?? "",
            call.body as never,
          ),
        ),
    },

    answer_quote: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.answerQuote(
          merchantOf(call),
          call.params.price_id ?? "",
          call.body as never,
        ),
      }),
    },

    purchase_item: { serve: (call) => purchase(gateway, edge, call) },
  };
}

/**
 * All selling stopped or started again, answered with the whole catalog —
 * because every card's word changed, and which cards actually came back is then
 * a fact rather than something the caller has to infer.
 *
 * A merchant who has left is refused. Leaving closed their open orders and left
 * refunds owed; putting the word back to "open" would return them to the
 * catalog with none of that unwound.
 */
async function sellingSet(
  gateway: Gateway,
  call: RouteCall,
  selling: "open" | "paused",
): Promise<RouteAnswer> {
  // One merchant's switch and nobody else's: stopping all selling takes this
  // merchant's cards out of the public catalog and leaves every other
  // merchant's exactly where they were.
  const changed = await gateway.setSelling(merchantOf(call), selling);
  if (!changed.ok) {
    return written(call.response, CONFLICT, refusal("merchant_departed", changed.why));
  }
  return { status: OK, document: changed.cards };
}

/**
 * One card taken off sale or put back, answered with where it now stands.
 *
 * Pausing a card that is already paused answers the same way as pausing one
 * that was selling, and that is deliberate: the call says what the merchant
 * wants to be true rather than asking for a change, so a retry after a dropped
 * connection is safe and needs no note kept of what was already pressed.
 */
async function cardPaused(
  gateway: Gateway,
  call: RouteCall,
  paused: boolean,
): Promise<RouteAnswer> {
  const card = await gateway.setCardPaused(merchantOf(call), call.params.item_id ?? "", paused);
  if (card === null) {
    // A card of another merchant's is refused in the words a card that is not
    // there gets. Pausing is not a way of finding out what somebody else sells.
    return written(call.response, NOT_FOUND, refusal("no_such_item", "there is no such product"));
  }
  return { status: OK, document: card };
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

  if (request.method === "GET") {
    const offered = await gateway.paidResource(itemId);
    if (offered === null) {
      return written(response, NOT_FOUND, refusal("no_such_item", "there is no such product"));
    }
    if (offered.selling !== "open") {
      // A card that is off sale answers no challenge, and the reason is not
      // tidiness. A challenge carries the declaration a discovery catalog is
      // built from, and a catalog lists what answers 402 and drops what stops:
      // kept up here, a paused card would stay listed while every purchase
      // behind the listing came back refused. The word an agent gets is the
      // same word the order machine would have given it a moment later.
      return written(
        response,
        CONFLICT,
        refusal("not_selling", "this product is not on sale at the moment"),
      );
    }
    response.setHeader(
      PAYMENT_REQUIRED_HEADER,
      edge.challengeFor(
        { amount: offered.card.card.price.amount, currency: offered.card.card.price.currency },
        null,
        { itemId: offered.card.id, card: offered.card.card, serviceName: offered.serviceName },
        "GET",
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
      // The product this order is for, read from the order rather than from the
      // address the call came in on. They are the same address in the ordinary
      // case, and where they are not — a payment naming an order for another
      // product — what a challenge has to describe is the product being paid
      // for. The resource an agent is invited to pay for and the resource a
      // catalog lists are the same string, so it cannot come from the request.
      const offered = await gateway.paidResource(attempt.order.itemId);
      if (offered === null) {
        throw new Error(
          `the order ${attempt.order.order.id} is for ${attempt.order.itemId}, which is not in the catalog`,
        );
      }
      response.setHeader(
        PAYMENT_REQUIRED_HEADER,
        edge.challengeFor(
          price,
          attempt.order.order.id,
          { itemId: offered.card.id, card: offered.card.card, serviceName: offered.serviceName },
          "POST",
          why,
        ),
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
