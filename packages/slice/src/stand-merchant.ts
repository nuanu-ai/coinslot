/**
 * The merchant half of the stand, on the SDK a merchant actually uses.
 *
 * It keeps only switchboard choices and orders still held for a later delivery.
 * The feed records what crossed this boundary; it neither replaces the gateway's
 * journal nor teaches the merchant key to any observer.
 */

import {
  type CardInput,
  type CoinslotClient,
  createClient,
  type Delivery,
  type LiveOrder,
  type Money,
  type PublishResult,
  type Refusal,
} from "@nuanu-ai/coinslot";
import type { ParamSpec } from "@nuanu-ai/coinslot-contracts";
import { filledFrom } from "./stand-goods.js";
import type { Feed } from "./stand-log.js";

export type OrderMood =
  | "deliver"
  | "accept_then_deliver"
  | "accept_and_say_nothing"
  | "refuse"
  | "say_nothing"
  | "answer_wrong_shape";

export type QuoteMood = "price" | "unavailable" | "say_nothing";

export interface Moods {
  order: OrderMood;
  quote: QuoteMood;
  deliverAfterMs: number;
  refusal: Refusal;
  price: Money;
  delivery: Delivery | null;
}

export interface StandMerchant {
  readonly moods: Moods;
  connected(): string | null;
  connect(baseUrl: string, apiKey: string): Promise<void>;
  disconnect(): Promise<void>;
  publish(card: CardInput): Promise<PublishResult>;
  learn(merchantItemId: string, result: ParamSpec): void;
  readonly taken: ReadonlyMap<string, LiveOrder>;
}

// The worker dispatches handlers serially, so waiting longer blocks every other
// order and quote without making the timeout scenario more truthful.
const SILENCE_PAST_DEADLINES_MS = 5_100;

const defaultMoods = (): Moods => ({
  order: "deliver",
  quote: "price",
  deliverAfterMs: 1_000,
  refusal: { code: "cannot_fulfill", message: "The stand was told not to fulfill this order." },
  price: { amount: "1.00", currency: "USD" },
  delivery: null,
});

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface DeliverySession {
  cancelling: boolean;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  readonly inFlight: Set<Promise<void>>;
}

const makeDeliverySession = (): DeliverySession => ({
  cancelling: false,
  timers: new Set(),
  inFlight: new Set(),
});

/** Makes a merchant whose handler decisions are changed directly by the stand page. */
export const makeStandMerchant = (feed: Feed): StandMerchant => {
  const moods = defaultMoods();
  const taken = new Map<string, LiveOrder>();
  const results = new Map<string, ParamSpec>();
  let deliverySession = makeDeliverySession();
  let client: CoinslotClient | undefined;
  let address: string | null = null;

  const deliveryFor = (merchantItemId: string): Delivery =>
    moods.delivery ?? filledFrom(results.get(merchantItemId));

  const writeOrderAnswer = (
    title: string,
    order: LiveOrder,
    detail: Record<string, unknown>,
  ): void => {
    feed.write("merchant", title, {
      order_id: order.id,
      merchant_item_id: order.merchant_item_id,
      ...detail,
    });
  };

  const deliverLater = (order: LiveOrder): void => {
    const session = deliverySession;
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      if (session.cancelling || taken.get(order.id) !== order) {
        return;
      }
      const inFlight = (async () => {
        try {
          const delivery = deliveryFor(order.merchant_item_id);
          feed.write("merchant", "Delivering an accepted order.", {
            order_id: order.id,
            merchant_item_id: order.merchant_item_id,
            delivery,
          });
          const result = await order.deliver(delivery);
          feed.write("merchant", "The accepted-order delivery answered.", {
            order_id: order.id,
            result,
          });
        } catch (error: unknown) {
          feed.write("merchant", "The later delivery could not be completed.", {
            order_id: order.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      session.inFlight.add(inFlight);
      void inFlight.then(() => session.inFlight.delete(inFlight));
    }, moods.deliverAfterMs);
    session.timers.add(timer);
  };

  const stopDeliveries = async (): Promise<void> => {
    const session = deliverySession;
    session.cancelling = true;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    if (session.inFlight.size > 0) {
      feed.write("stand", "Waiting for in-flight delivery work before disconnect.", {
        deliveries: session.inFlight.size,
      });
    }
    await Promise.all([...session.inFlight]);
  };

  const register = (fresh: CoinslotClient): void => {
    fresh.on("order", async (order) => {
      feed.write("merchant", "An order arrived.", {
        order_id: order.id,
        merchant_item_id: order.merchant_item_id,
      });
      switch (moods.order) {
        case "deliver": {
          const delivery = deliveryFor(order.merchant_item_id);
          const answer = order.delivered(delivery);
          writeOrderAnswer("Delivering an order.", order, { delivery });
          return answer;
        }
        case "accept_then_deliver": {
          taken.set(order.id, order);
          const answer = order.accepted({ eta_seconds: Math.ceil(moods.deliverAfterMs / 1_000) });
          writeOrderAnswer("Accepting an order for later delivery.", order, { answer });
          deliverLater(order);
          return answer;
        }
        case "accept_and_say_nothing": {
          taken.set(order.id, order);
          const answer = order.accepted();
          writeOrderAnswer("Accepting an order without a later delivery.", order, { answer });
          return answer;
        }
        case "refuse": {
          const answer = order.refused(moods.refusal);
          writeOrderAnswer("Refusing an order.", order, { refusal: moods.refusal });
          return answer;
        }
        case "say_nothing": {
          await wait(SILENCE_PAST_DEADLINES_MS);
          const delivery = deliveryFor(order.merchant_item_id);
          const answer = order.delivered(delivery);
          writeOrderAnswer("Delivering an order after its deadline.", order, { delivery });
          return answer;
        }
        case "answer_wrong_shape": {
          const delivery = { a_field_this_card_never_declared: "wrong-shape" };
          const answer = order.delivered(delivery);
          writeOrderAnswer("Delivering a shape the card never declared.", order, { delivery });
          return answer;
        }
      }
    });

    fresh.on("quote", async (question) => {
      feed.write("merchant", "A price question arrived.", {
        merchant_item_id: question.merchant_item_id,
        price_id: question.price_id,
      });
      if (moods.quote === "unavailable") {
        const answer = question.unavailable();
        feed.write("merchant", "Saying a price is unavailable.", {
          price_id: question.price_id,
          answer,
        });
        return answer;
      }
      if (moods.quote === "say_nothing") {
        await wait(SILENCE_PAST_DEADLINES_MS);
      }
      const answer = question.available(moods.price);
      feed.write("merchant", "Answering a price question.", {
        price_id: question.price_id,
        answer,
      });
      return answer;
    });

    fresh.on("event", (event) => {
      taken.delete(event.order_id);
      feed.write("gateway", "An order event arrived.", event);
    });

    fresh.on("problem", (problem) => {
      feed.write("gateway", problem.kind, problem);
    });
  };

  return {
    moods,
    taken,
    connected: () => address,
    async connect(baseUrl, apiKey) {
      await this.disconnect();
      deliverySession = makeDeliverySession();
      const fresh = createClient({ baseUrl, apiKey });
      register(fresh);
      await fresh.start();
      client = fresh;
      address = baseUrl;
      feed.write("stand", "Connected the merchant.", { base_url: baseUrl });
    },
    async disconnect() {
      const stopping = client;
      client = undefined;
      address = null;
      taken.clear();
      results.clear();
      await stopDeliveries();
      if (stopping !== undefined) {
        await stopping.stop();
        feed.write("stand", "Disconnected the merchant.");
      }
    },
    async publish(card) {
      if (client === undefined) {
        throw new Error("Connect the stand merchant before publishing a card.");
      }
      const result = await client.catalog.publish(card);
      feed.write("merchant", "Published a card.", {
        merchant_item_id: card.merchant_item_id,
        result,
      });
      return result;
    },
    learn(merchantItemId, result) {
      results.set(merchantItemId, result);
    },
  };
};
