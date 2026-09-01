/**
 * The merchant half of the stand, on the SDK a merchant actually uses.
 *
 * It keeps only the answer the handler is set to give, the orders it has taken
 * on for a later delivery, and the ones it is holding while it waits for a
 * person. The feed records what crossed this boundary; it neither replaces the
 * gateway's journal nor teaches the merchant key to any observer.
 *
 * What the screen reads back is `held` and `taken`: the orders waiting for a
 * person and the orders accepted with goods still owed. Everything else this
 * half does lands in the feed, which is the console's one shared thread.
 */

import {
  type CardInput,
  type CoinslotClient,
  createClient,
  type Delivery,
  type HandlerAnswer,
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
  | "answer_wrong_shape"
  | "ask_me";

/** The moods that decide on their own, which is every one but `ask_me`. */
export type DecidedMood = Exclude<OrderMood, "ask_me">;

export type QuoteMood = "price" | "unavailable" | "say_nothing";

/** What a person can answer with while the handler holds an order open. */
export type HeldAnswer = "deliver" | "accept" | "refuse" | "say_nothing";

export interface Moods {
  order: OrderMood;
  quote: QuoteMood;
  deliverAfterMs: number;
  refusal: Refusal;
  price: Money;
  delivery: Delivery | null;
}

/** An order the handler is holding while it waits for somebody to answer. */
export interface HeldOrder {
  readonly id: string;
  readonly merchantItemId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly since: number;
}

export interface StandMerchant {
  readonly moods: Moods;
  connected(): string | null;
  connect(baseUrl: string, apiKey: string): Promise<void>;
  disconnect(): Promise<void>;
  publish(card: CardInput): Promise<PublishResult>;
  learn(merchantItemId: string, result: ParamSpec): void;
  /** Orders accepted and not yet delivered. */
  readonly taken: ReadonlyMap<string, LiveOrder>;
  /** Orders the handler is holding open until a person answers. */
  readonly held: ReadonlyMap<string, HeldOrder>;
  /** Answers one held order. False when it is no longer being held. */
  answerHeld(orderId: string, answer: HeldAnswer): boolean;
  /** Delivers an order taken on earlier, now. False when it is no longer owed. */
  deliverOwed(orderId: string): Promise<boolean>;
  /** Refuses an order taken on earlier. False when it is no longer owed. */
  refuseOwed(orderId: string): Promise<boolean>;
}

// The worker dispatches handlers serially, so waiting longer blocks every other
// order and quote without making the timeout scenario more truthful.
const SILENCE_PAST_DEADLINES_MS = 5_100;

/**
 * How long the handler will hold an order open for a person.
 *
 * Short, and the reason is worth knowing before anybody designs around this:
 * the gateway gives a handler about three seconds to answer
 * (`HANDLER_ANSWER_MS`), and a synchronous purchase is answered inside eight
 * (`SYNC_RESPONSE_MS`). Holding an order for a person therefore runs past what
 * the order can survive almost at once — the gateway stops waiting and the
 * order expires while this side is still holding it. That is worth watching
 * once, which is why holding exists at all; it is not worth waiting two minutes
 * for, and a held order blocks the worker's serial dispatch the whole time.
 *
 * The ceiling refuses rather than falling silent, because a refusal names
 * itself in the order's own record and a silence looks like a crash.
 */
const ASK_CEILING_MS = 30_000;

/** What the ceiling refuses with, so the record says why rather than what. */
const NOBODY_ANSWERED: Refusal = {
  code: "nobody_answered",
  message:
    "The stand held this order at the console and nobody answered it. The gateway had stopped waiting long before.",
};

/** Nobody answered in time, which is neither of the four answers a person gives. */
const RAN_OUT = "ran_out" as const;

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

const HELD_MEANS: Readonly<Record<HeldAnswer, DecidedMood>> = {
  deliver: "deliver",
  accept: "accept_then_deliver",
  refuse: "refuse",
  say_nothing: "say_nothing",
};

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
  const held = new Map<string, HeldOrder>();
  const answering = new Map<string, (answer: HeldAnswer | typeof RAN_OUT) => void>();
  const results = new Map<string, ParamSpec>();
  let deliverySession = makeDeliverySession();
  let client: CoinslotClient | undefined;
  let address: string | null = null;

  const deliveryFor = (merchantItemId: string): Delivery =>
    moods.delivery ?? filledFrom(results.get(merchantItemId));

  /** Every answer the handler gives is something this side put on the wire. */
  const writeOrderAnswer = (
    title: string,
    order: LiveOrder,
    detail: Record<string, unknown>,
  ): void => {
    feed.sent("merchant", title, {
      order_id: order.id,
      merchant_item_id: order.merchant_item_id,
      ...detail,
    });
  };

  /** Hands over the goods for an order taken on earlier, and says how it went. */
  const handOver = async (order: LiveOrder): Promise<void> => {
    try {
      const delivery = deliveryFor(order.merchant_item_id);
      feed.sent("merchant", "Delivering an accepted order.", {
        order_id: order.id,
        merchant_item_id: order.merchant_item_id,
        delivery,
      });
      const result = await order.deliver(delivery);
      feed.got("merchant", "The accepted-order delivery answered.", {
        order_id: order.id,
        result,
      });
    } catch (error: unknown) {
      feed.sent("merchant", "The later delivery could not be completed.", {
        order_id: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const deliverLater = (order: LiveOrder): void => {
    const session = deliverySession;
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      if (session.cancelling || taken.get(order.id) !== order) {
        return;
      }
      const inFlight = handOver(order);
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

  /** Holds one order open until a person answers, the ceiling runs out, or the stand disconnects. */
  const askAbout = async (order: LiveOrder): Promise<HeldAnswer | typeof RAN_OUT> => {
    held.set(order.id, {
      id: order.id,
      merchantItemId: order.merchant_item_id,
      params: order.params,
      since: Date.now(),
    });
    feed.write("merchant", "An order is waiting for you.", {
      order_id: order.id,
      merchant_item_id: order.merchant_item_id,
      params: order.params,
    });

    const answer = await new Promise<HeldAnswer | typeof RAN_OUT>((resolve) => {
      const ceiling = setTimeout(() => {
        answering.delete(order.id);
        resolve(RAN_OUT);
      }, ASK_CEILING_MS);
      answering.set(order.id, (chosen) => {
        clearTimeout(ceiling);
        answering.delete(order.id);
        resolve(chosen);
      });
    });

    held.delete(order.id);
    return answer;
  };

  /** Every handler answer but the one that asks a person first. */
  const decide = async (order: LiveOrder, mood: DecidedMood): Promise<HandlerAnswer> => {
    switch (mood) {
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
  };

  const register = (fresh: CoinslotClient): void => {
    fresh.on("order", async (order) => {
      feed.got("merchant", "An order arrived.", {
        order_id: order.id,
        merchant_item_id: order.merchant_item_id,
        params: order.params,
      });
      if (moods.order !== "ask_me") {
        return decide(order, moods.order);
      }
      const answered = await askAbout(order);
      if (answered === RAN_OUT) {
        const answer = order.refused(NOBODY_ANSWERED);
        writeOrderAnswer("Refusing an order nobody answered.", order, {
          refusal: NOBODY_ANSWERED,
        });
        return answer;
      }
      return decide(order, HELD_MEANS[answered]);
    });

    fresh.on("quote", async (question) => {
      feed.got("merchant", "A price question arrived.", {
        merchant_item_id: question.merchant_item_id,
        price_id: question.price_id,
      });
      if (moods.quote === "unavailable") {
        const answer = question.unavailable();
        feed.sent("merchant", "Saying a price is unavailable.", {
          price_id: question.price_id,
          answer,
        });
        return answer;
      }
      if (moods.quote === "say_nothing") {
        await wait(SILENCE_PAST_DEADLINES_MS);
      }
      const answer = question.available(moods.price);
      feed.sent("merchant", "Answering a price question.", {
        price_id: question.price_id,
        answer,
      });
      return answer;
    });

    fresh.on("event", (event) => {
      taken.delete(event.order_id);
      feed.got("gateway", "An order event arrived.", event);
    });

    fresh.on("problem", (problem) => {
      // Named under `error` as well as carried whole: a worker problem is the
      // gateway refusing what this handler sent, and the log reads a refusal
      // off that field. Without it the one line that says the delivery was
      // rejected would sit in the stream looking like every other line.
      feed.got("gateway", `The gateway refused what the handler sent: ${problem.kind}.`, {
        error: problem.kind,
        problem,
      });
    });
  };

  /** Lets every held order go, so a disconnect never leaves the worker blocked. */
  const releaseHeld = (): void => {
    for (const [orderId, resolve] of [...answering]) {
      answering.delete(orderId);
      resolve(RAN_OUT);
    }
    held.clear();
  };

  return {
    moods,
    taken,
    held,
    connected: () => address,
    answerHeld(orderId, answer) {
      const resolve = answering.get(orderId);
      if (resolve === undefined) return false;
      feed.write("stand", "You answered a held order.", { order_id: orderId, answer });
      resolve(answer);
      return true;
    },
    async deliverOwed(orderId) {
      const order = taken.get(orderId);
      if (order === undefined) return false;
      await handOver(order);
      return true;
    },
    async refuseOwed(orderId) {
      const order = taken.get(orderId);
      if (order === undefined) return false;
      try {
        const result = await order.refuse(moods.refusal);
        feed.sent("merchant", "Refusing an order taken on earlier.", {
          order_id: orderId,
          refusal: moods.refusal,
          result,
        });
      } catch (error: unknown) {
        feed.sent("merchant", "That refusal could not be completed.", {
          order_id: orderId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    },
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
      releaseHeld();
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
      feed.sent("merchant", "Published a card.", {
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
