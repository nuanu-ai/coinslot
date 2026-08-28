/**
 * What each call in the table actually does.
 *
 * The table says where a call lives and what shape goes each way; this says
 * which flow answers it. Nothing here decides anything about an order either —
 * every handler is a translation between one HTTP request and one call on the
 * gateway, and the status codes are the only judgement it makes, because the
 * contract deliberately carries none.
 *
 * Every refusal here is written straight to the response rather than returned
 * as a document, and so is the payment challenge, whose whole content is a
 * header. Everything a call answers with when it works goes back as a document
 * and is held to the route's own schema on the way out. The purchase is not an
 * exception to that any more: what it answers a paid call with is the state of
 * the order it made, in the document the agent's own door answers with.
 */

import type {
  IssueKeyRequest,
  OrderListQuery,
  OrderWithStatus,
  PurchaseRequest,
  RegistrationRequest,
  RouteName,
  SellerNameRequest,
  WorkerPollRequest,
} from "@coinslot/contracts";
import { outcomeFor } from "@coinslot/core";
import type { Gateway, PurchaseAttempt } from "../app/gateway.js";
import { agentOrderStatusOf, orderDocumentOf } from "../app/runner.js";
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
const FORBIDDEN = 403;
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

/**
 * The key this call was made with, on a route behind the merchant's key.
 *
 * Null cannot arrive here for the reason it cannot arrive above — the door
 * resolves a key and a merchant together or refuses — and the three routes that
 * ask are the three about keys, where a wrong answer is the merchant locking
 * themselves out rather than a page failing to draw.
 */
function callersKey({ keyId }: RouteCall): string {
  if (keyId === null) {
    throw new Error(
      "this call was served as one of the merchant's and reached its handler with no key behind it",
    );
  }
  return keyId;
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

    register_merchant: {
      serve: async (call) => {
        const asked = call.body as RegistrationRequest;
        const made = await gateway.registerMerchant(asked.invitation);
        if (made === null) {
          // One answer for a wrong code and for a gateway that takes no
          // registrations. Two answers would make this form a way of asking
          // which deployment is open, which is what the code in the door exists
          // to stop being findable (ADR-0014 §3). The words say what is needed
          // to get in and nothing about whether anything would.
          return written(
            call.response,
            FORBIDDEN,
            refusal(
              "not_invited",
              "registering here needs an invitation this gateway accepts, and this is not one",
            ),
          );
        }
        return { status: OK, document: made };
      },
    },

    get_seller_name: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.sellerName(merchantOf(call)),
      }),
    },

    set_seller_name: {
      // A name outside the catalog's rule never reaches this handler: the
      // mounting loop holds the body to the contract's own shape and answers
      // 400 with the schema's words, which name the rule and the number. That
      // is the same rule the flow below applies before it writes, and the two
      // are one schema rather than two copies of a number.
      serve: async (call) => ({
        status: OK,
        document: await gateway.setSellerName(
          merchantOf(call),
          (call.body as SellerNameRequest).seller_name,
        ),
      }),
    },

    list_keys: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.merchantKeys(merchantOf(call), callersKey(call)),
      }),
    },

    issue_key: {
      serve: async (call) => ({
        status: OK,
        document: await gateway.issueMerchantKey(
          merchantOf(call),
          (call.body as IssueKeyRequest).label,
        ),
      }),
    },

    disable_key: {
      serve: async (call) => {
        const disabled = await gateway.disableMerchantKey(
          merchantOf(call),
          call.params.key_id ?? "",
          callersKey(call),
        );

        if (disabled === "locked_out") {
          // A refusal that protects the caller from themselves rather than from
          // anybody else. A merchant whose cabinet holds this key and disabled
          // it would meet "the gateway will not take this key" on every page
          // afterwards, with no terminal to undo it from (ADR-0014 §5). It
          // reaches only the key on this call; the flow above says what that
          // leaves open.
          return written(
            call.response,
            CONFLICT,
            refusal(
              "key_opened_this_call",
              "this is the key this call was made with, and disabling it would leave the caller with nothing to reach the gateway",
            ),
          );
        }
        if (disabled === null) {
          // A key of another merchant's is refused in the words a key that is
          // not there gets. Disabling is not a way of counting somebody else's
          // keys.
          return written(call.response, NOT_FOUND, refusal("no_such_key", "there is no such key"));
        }
        return { status: OK, document: disabled };
      },
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
          return written(
            response,
            CONFLICT,
            refusal(
              open ? "order_not_priced_yet" : "order_closed_before_it_was_priced",
              open
                ? "this order is still waiting for its price, and until it has one there is no sale to describe"
                : `this order ended as ${status} before anybody named a price for it, so there is no sale to describe`,
              { status },
            ),
          );
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

    get_order_status: { serve: (call) => orderStatus(gateway, call) },
  };
}

/**
 * What became of one purchase, for the agent that made it.
 *
 * The one route here that is the agent's rather than the merchant's. Knowing
 * the order's identifier is what stands in for a key (ADR-0011), so nothing
 * about a merchant enters into it: the read is across the whole gateway,
 * because the caller has no merchant to be scoped to and the order belongs to
 * whichever merchant sold it.
 *
 * The answer is built by `agentOrderStatusOf`, which is also what the purchase
 * answers with — one document for one question, so an agent that bought and an
 * agent that came back later are told the same thing in the same shape.
 *
 * An identifier that names no order is answered in the words the merchant's
 * own read of a stranger's order gets — there is no such order, and nothing
 * about whether the string was ever one.
 */
async function orderStatus(
  gateway: Gateway,
  { params, response }: RouteCall,
): Promise<RouteAnswer> {
  const record = await gateway.orderById(params.order_id ?? "");
  if (record === null) {
    return written(response, NOT_FOUND, refusal("no_such_order", "there is no such order"));
  }

  return { status: OK, document: agentOrderStatusOf(record) };
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
      // built from; kept up here, a paused card would go on inviting an agent
      // to pay for something every purchase of which comes back refused. The
      // word an agent gets is the same word the order machine would have given
      // it a moment later.
      //
      // What a catalog does with a resource that stops answering is its own
      // business and we have not measured it: the CDP documentation says such a
      // resource is eventually removed, and `docs/research/04-spike-bazaar-listing.md`
      // records that as read rather than as timed.
      return written(
        response,
        CONFLICT,
        refusal("not_selling", "this product is not on sale at the moment"),
      );
    }
    response.setHeader(
      PAYMENT_REQUIRED_HEADER,
      edge.challengeFor(
        { amount: offered.stored.card.price.amount, currency: offered.stored.card.price.currency },
        null,
        { itemId: offered.stored.id, card: offered.stored.card, serviceName: offered.serviceName },
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
      // The findings are what the agent fixes, and the sentence is what tells
      // it that they are findings about its own parameters rather than about
      // the product or the payment. A refusal that carried the list alone left
      // whoever printed it an empty space where the reason belongs.
      return written(
        response,
        UNPROCESSABLE,
        refusal(
          "params_do_not_fit",
          "these purchase parameters are not what this product's card asks for, and the problems say which of them and why",
          { problems: attempt.problems },
        ),
      );

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
      return written(
        response,
        CONFLICT,
        refusal("payment_not_verified", attempt.why, { retryable: attempt.retryable }),
      );

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
      // The product this order is for, read from the order and not from the
      // address the call came in on.
      //
      // Every call that reaches this line today opened its own order a moment
      // ago, against the product in the address, so the two agree — nobody has
      // been able to construct one where they do not. The reading is off the
      // order anyway, and the reason is what happens when they ever differ:
      // an order's identifier travels, in a challenge and in a receipt, so a
      // payment may name an order that was not made here, and the shape above
      // has a branch for a payment naming an order. The resource an agent is invited to pay for and
      // the resource a catalog lists are one string, and it belongs to the
      // order rather than to whoever typed the URL.
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
          {
            itemId: offered.stored.id,
            card: offered.stored.card,
            serviceName: offered.serviceName,
          },
          "POST",
          why,
        ),
      );
      return written(response, PAYMENT_REQUIRED, {});
    }

    // Both of the remaining steps answer with where the order stands, in the
    // one document the agent's own door answers with. The status code is what
    // separates them, and the contract deliberately carries none of it: 200
    // where the purchase is going through or has ended in the goods, 409 where
    // it has not.
    case "under_way":
      // A synchronous purchase promises the agent the goods themselves inside
      // one ceiling. Coming back from that ceiling with no goods is not a
      // success, however the order is getting on internally — and the one way
      // to arrive there is the case that most needs saying: a charge that was
      // sent and never reported back. Answered 200, an agent would read "your
      // purchase is being worked on" for an order nothing is working on, while
      // holding nothing and not knowing whether it was charged.
      //
      // Where the money moved at the purchase and the goods come later, the
      // same document under a 200 is the honest answer: the order exists, it
      // is paid for, and the door that hands the goods over is the one named
      // in the address the agent already holds.
      return {
        status: attempt.order.order.mode.settle === "after_fulfillment" ? CONFLICT : OK,
        document: agentOrderStatusOf(attempt.order),
      };

    case "settled": {
      const settlement = attempt.order.settlement;
      if (settlement !== null) {
        // The payment layer's own receipt, which an agent's x402 client reads
        // off the answer to its purchase. It travels in a header and is the
        // agent's proof that money moved; our own receipt is the merchant's
        // record and is read through the merchant's door.
        response.setHeader(
          PAYMENT_RESPONSE_HEADER,
          edge.receiptHeader({
            success: true,
            transaction: settlement.transaction,
            network: gateway.runtime.config.payment.network as `${string}:${string}`,
          }),
        );
      }

      return {
        status: outcomeFor(attempt.order.order) === "delivered" ? OK : CONFLICT,
        document: agentOrderStatusOf(attempt.order),
      };
    }
  }
}

function written(response: RouteCall["response"], status: number, document: unknown): RouteAnswer {
  response.status(status).json(document);
  return { written: true };
}
