/**
 * The merchant half of the stand, on the SDK a merchant actually uses.
 *
 * It keeps only the answer the handler is set to give, the orders it has taken
 * on for a later delivery, and the ones it is holding while it waits for a
 * person. The feed records what crossed this boundary; it neither replaces the
 * gateway's journal nor teaches the merchant key to any observer.
 *
 * Everything a merchant's code can do here goes through the SDK, and that is
 * the point of the file rather than a convenience: an outside engineer reading
 * it must not learn to assemble by hand what the package already carries. So
 * the orders on screen are `client.orders.list`, the calls that close them are
 * the ones on the rows it returns, and the only calls in this console made with
 * raw HTTP are the ones the SDK deliberately does not have.
 */

import {
  type CardInput,
  type CoinslotClient,
  createClient,
  type Delivery,
  type HandlerAnswer,
  type LiveOrder,
  type LiveOrderWithStatus,
  type Money,
  type OrderCallResponse,
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
  /**
   * Why the subscription ended, where it has.
   *
   * A fatal problem stops the loop. A console that went on saying "connected"
   * after one would be claiming a subscription it no longer has.
   */
  stopped(): string | null;
  connect(baseUrl: string, apiKey: string): Promise<void>;
  disconnect(): Promise<void>;
  publish(card: CardInput): Promise<PublishResult>;
  learn(merchantItemId: string, result: ParamSpec): void;
  /**
   * This merchant's orders, and with `open` only those still owed something.
   *
   * Through `client.orders.list`, which is what the SDK offers for exactly
   * this: the rows come back carrying the calls that close them, and the open
   * ones are what a process reads after a restart. What this process happens to
   * be holding in memory is not that list and does not survive a reconnection.
   */
  orders(open?: boolean): Promise<readonly LiveOrderWithStatus[]>;
  /** Orders the handler is holding open until a person answers. */
  readonly held: ReadonlyMap<string, HeldOrder>;
  /** Answers one held order. False when it is no longer being held. */
  answerHeld(orderId: string, answer: HeldAnswer): boolean;
  /** Delivers an order taken on earlier, named by its own identifier. */
  deliverOwed(orderId: string, merchantItemId: string): Promise<void>;
  /** Refuses an order taken on earlier, named by its own identifier. */
  refuseOwed(orderId: string): Promise<void>;
}

/**
 * How long the silent moods stay silent, and why it is this long.
 *
 * The deadline this mood has to outlast is the order's own: a synchronous
 * purchase is answered within `SYNC_RESPONSE_MS`, eight seconds counted from
 * the payment. `HANDLER_ANSWER_MS` is a different number and it is the one that
 * is easy to mistake for this: three seconds is how long the gateway waits for
 * one delivery attempt before calling that attempt unanswered and sending the
 * order round again, so an answer arriving in the fifth second is late for the
 * attempt and still well inside the order's deadline — the goods go out and the
 * purchase settles. Waiting anything short of eight seconds therefore delivers
 * and calls it a timeout, which is the one thing this mood must not do.
 *
 * The worker dispatches handlers serially, so every second spent here blocks
 * every other order and quote. This is the shortest wait that is honestly past
 * the deadline, and no longer.
 */
const SILENCE_PAST_DEADLINES_MS = 9_500;

/**
 * How long the handler will hold an order open for a person.
 *
 * Short, and the reason is worth knowing before anybody designs around this.
 * Three clocks run at once: the gateway waits about three seconds for one
 * delivery attempt (`HANDLER_ANSWER_MS`) before calling it unanswered and
 * sending the order round again, the goods themselves are due within eight
 * seconds of the payment (`SYNC_RESPONSE_MS`), and the agent is promised an
 * answer within ten (`SYNC_BUDGET_MS`). Holding an order for a person therefore
 * runs past what the order can survive almost at once — the gateway stops
 * waiting and the order expires while this side is still holding it. That is
 * worth watching once, which is why holding exists at all; it is not worth
 * waiting two minutes for, and a held order blocks the worker's serial dispatch
 * the whole time.
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
  let stoppedBecause: string | null = null;

  const connectedClient = (): CoinslotClient => {
    if (client === undefined) {
      throw new Error("Connect the stand merchant before asking it for anything.");
    }
    return client;
  };

  /**
   * The calls that close one order, named by its identifier.
   *
   * `orders.forId` reaches no gateway — the SDK offers it for the process that
   * kept an identifier and nothing else, which is exactly what a console
   * pressing a button on a row has. The order object a handler was given works
   * too, and stops existing the moment this process reconnects.
   */
  const calls = (orderId: string) => connectedClient().orders.forId(orderId);

  /**
   * What this handler hands over for one product.
   *
   * The goods are made from the card's own `result` declaration, which this
   * console learns when it reads the merchant's cards. A card published
   * somewhere else after that — from the cabinet, from another process — is one
   * it has never read, and the fields it would fill are none. That case says so
   * rather than delivering an empty object into a refusal nobody can explain:
   * it is a gap in this console, not in the SDK, and it is one press of "Read
   * again" on the catalogue away.
   */
  const deliveryFor = (merchantItemId: string): Delivery => {
    if (moods.delivery !== null) return moods.delivery;
    const declared = results.get(merchantItemId);
    if (declared === undefined) {
      feed.write(
        "stand",
        `This console has not read the card ${merchantItemId} declares, so it has nothing to deliver for it. Read the catalogue again, or paste the goods yourself.`,
      );
    }
    return filledFrom(declared);
  };

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

  /**
   * How a delivery or a refusal answered, in the fields the log reads.
   *
   * A call the gateway would not take is named under `error` as well as carried
   * whole, for the reason the worker's problems are: the log colours a line off
   * that field, and without it the one refused delivery sits in the stream
   * looking like every other line. The finding leads where the refusal carries
   * any — the code is the word a merchant's own program branches on, and the
   * finding is the thing their handler has to change.
   */
  const answerRead = (result: OrderCallResponse): Record<string, unknown> => {
    if (result.ok) return { result };
    const first = result.error.problems?.[0];
    const said =
      first === undefined || first.path.length === 0
        ? (first?.message ?? result.error.message)
        : `${first.path.join(".")}: ${first.message}`;
    return { error: `${result.error.code} — ${said}`, result };
  };

  /**
   * Hands over the goods for an order taken on earlier, and says how it went.
   *
   * No try/catch, and that is deliberate. The SDK's transport says in its own
   * header that nothing there throws: a call that did not get through comes
   * back as an answer saying so. A catch around it would teach a reader of this
   * file — which is meant to read like a merchant's own code — to write a
   * handler for an exception that never arrives, and no branch on the answer
   * that always does.
   */
  const handOver = async (orderId: string, merchantItemId: string): Promise<void> => {
    const delivery = deliveryFor(merchantItemId);
    feed.sent("merchant", "The handler delivered the goods it had promised.", {
      order_id: orderId,
      merchant_item_id: merchantItemId,
      delivery,
    });
    const result = await calls(orderId).deliver(delivery);
    feed.got(
      "merchant",
      result.ok ? "The gateway took that delivery." : "The gateway would not take that delivery.",
      { order_id: orderId, ...answerRead(result) },
    );
  };

  const deliverLater = (order: LiveOrder): void => {
    const session = deliverySession;
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      if (session.cancelling || taken.get(order.id) !== order) {
        return;
      }
      const inFlight = handOver(order.id, order.merchant_item_id);
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
      feed.write("stand", "Waiting for a delivery already in flight before stopping the SDK.", {
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
    feed.write("merchant", "An order is being held at the console, waiting for you to answer it.", {
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
        writeOrderAnswer("The handler delivered the goods.", order, { delivery });
        return answer;
      }
      case "accept_then_deliver": {
        taken.set(order.id, order);
        const answer = order.accepted({ eta_seconds: Math.ceil(moods.deliverAfterMs / 1_000) });
        writeOrderAnswer("The handler accepted the order and promised the goods later.", order, {
          answer,
        });
        deliverLater(order);
        return answer;
      }
      case "accept_and_say_nothing": {
        taken.set(order.id, order);
        const answer = order.accepted();
        writeOrderAnswer("The handler accepted the order and will never deliver it.", order, {
          answer,
        });
        return answer;
      }
      case "refuse": {
        const answer = order.refused(moods.refusal);
        writeOrderAnswer("The handler refused the order.", order, { refusal: moods.refusal });
        return answer;
      }
      case "say_nothing": {
        await wait(SILENCE_PAST_DEADLINES_MS);
        const delivery = deliveryFor(order.merchant_item_id);
        const answer = order.delivered(delivery);
        writeOrderAnswer(
          "The handler delivered, long past the deadline the card promised.",
          order,
          { delivery },
        );
        return answer;
      }
      case "answer_wrong_shape": {
        const delivery = { a_field_this_card_never_declared: "wrong-shape" };
        const answer = order.delivered(delivery);
        writeOrderAnswer("The handler delivered a shape the card never declared.", order, {
          delivery,
        });
        return answer;
      }
    }
  };

  const register = (fresh: CoinslotClient): void => {
    fresh.on("order", async (order) => {
      feed.got("merchant", "The SDK handed the handler an order.", {
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
        writeOrderAnswer("Nobody at the console answered, so the handler refused.", order, {
          refusal: NOBODY_ANSWERED,
        });
        return answer;
      }
      return decide(order, HELD_MEANS[answered]);
    });

    fresh.on("quote", async (question) => {
      feed.got("merchant", "The SDK handed the handler a price question.", {
        merchant_item_id: question.merchant_item_id,
        price_id: question.price_id,
      });
      if (moods.quote === "unavailable") {
        const answer = question.unavailable();
        feed.sent("merchant", "The handler said this product has no price right now.", {
          price_id: question.price_id,
          answer,
        });
        return answer;
      }
      if (moods.quote === "say_nothing") {
        await wait(SILENCE_PAST_DEADLINES_MS);
      }
      const answer = question.available(moods.price);
      feed.sent("merchant", "The handler answered the price question.", {
        price_id: question.price_id,
        answer,
      });
      return answer;
    });

    fresh.on("event", (event) => {
      taken.delete(event.order_id);
      feed.got("gateway", "The gateway sent an event about an order.", event);
    });

    // Eleven kinds arrive here and exactly one of them is the gateway refusing
    // what this handler sent. A poll that never got through, a handler that
    // threw, an answer this SDK would not send, a dialect mismatch that stops
    // the loop — a console calling all of them "the gateway refused" is wrong
    // about ten. The SDK already writes one sentence a person can act on, so
    // that sentence is the line; the kind travels beside it as the fact it is,
    // and a fatal one ends the subscription on screen rather than leaving the
    // top of the page claiming a loop that has stopped.
    fresh.on("problem", (problem) => {
      if (problem.fatal && stoppedBecause === null) {
        stoppedBecause = problem.message;
      }
      feed.got("gateway", problem.message, {
        error: problem.kind,
        fatal: problem.fatal,
        ...(problem.subject === undefined ? {} : { subject: problem.subject }),
        ...(problem.cause === undefined ? {} : { cause: String(problem.cause) }),
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
    held,
    connected: () => address,
    stopped: () => stoppedBecause,
    answerHeld(orderId, answer) {
      const resolve = answering.get(orderId);
      if (resolve === undefined) return false;
      feed.write("stand", "You answered a held order.", { order_id: orderId, answer });
      resolve(answer);
      return true;
    },
    async orders(open) {
      // Both halves, like every other call this file makes. The console cannot
      // watch an SDK call from the outside the way it watches its own fetches,
      // so a call the SDK makes says for itself that it went and what came
      // back — a line arriving with nothing in front of it is what makes a log
      // read as though it were out of order.
      feed.sent(
        "merchant",
        open === true
          ? "Asking the SDK for the orders still owed something."
          : "Asking the SDK for this merchant's orders.",
        { open: open === true },
      );
      const listed = await connectedClient().orders.list(
        open === true ? { open: true } : undefined,
      );
      feed.got(
        "merchant",
        `The gateway answered with ${listed.length} order${listed.length === 1 ? "" : "s"}.`,
        {
          open: open === true,
          orders: listed.length,
        },
      );
      return listed;
    },
    async deliverOwed(orderId, merchantItemId) {
      await handOver(orderId, merchantItemId);
    },
    async refuseOwed(orderId) {
      feed.sent("merchant", "The handler refused an order it had already accepted.", {
        order_id: orderId,
        refusal: moods.refusal,
      });
      const result = await calls(orderId).refuse(moods.refusal);
      feed.got(
        "merchant",
        result.ok ? "The gateway took that refusal." : "The gateway would not take that refusal.",
        { order_id: orderId, ...answerRead(result) },
      );
    },
    async connect(baseUrl, apiKey) {
      await this.disconnect();
      deliverySession = makeDeliverySession();
      stoppedBecause = null;
      const fresh = createClient({ baseUrl, apiKey });
      register(fresh);
      await fresh.start();
      client = fresh;
      address = baseUrl;
      feed.write(
        "stand",
        "Started the merchant SDK. It is polling this gateway for work from now on.",
        { base_url: baseUrl },
      );
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
        feed.write("stand", "Stopped the merchant SDK. It is no longer polling and holds nothing.");
      }
    },
    async publish(card) {
      if (client === undefined) {
        throw new Error("Connect the stand merchant before publishing a card.");
      }
      const result = await client.catalog.publish(card);
      feed.sent("merchant", "Published a card through the SDK.", {
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
