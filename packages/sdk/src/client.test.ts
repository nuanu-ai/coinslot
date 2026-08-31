import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Card, Order } from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANSWER_NOT_UNDERSTOOD,
  CALL_DID_NOT_REACH_US,
  createClient,
  OUTCOME_UNKNOWN,
  WORKER_PROBLEM_KINDS,
  type WorkerProblem,
} from "./index.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";
import { REACH, type Reach, reachOf, type TransportFailure, whatIsKnown } from "./transport.js";

const API_KEY = "merchant-key-for-the-tests";

const card: Card = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Что покупатель получает, для какой задачи это годится и что в это не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
  result: { access_url: { type: "string", title: "Ссылка для входа" } },
  fulfillment: "sync",
};

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  test: false,
};

let gateway: FakeGateway | undefined;

const gatewayServing = async (routes: Parameters<typeof startFakeGateway>[0]["routes"]) => {
  gateway = await startFakeGateway({ apiKey: API_KEY, routes });
  return createClient({ apiKey: API_KEY, baseUrl: gateway.url });
};

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe("creating a client", () => {
  it("refuses to be built without a key rather than failing on the first call", () => {
    // The promise: a merchant whose environment variable is not set is told
    // that, at the line that is wrong, instead of receiving an authorisation
    // failure from a call they made much later.
    expect(() => createClient({ apiKey: undefined, baseUrl: "https://gateway.invalid" })).toThrow(
      /api key/i,
    );
    expect(() => createClient({ apiKey: "  ", baseUrl: "https://gateway.invalid" })).toThrow(
      /api key/i,
    );
  });

  it("is built without an address, and says so at the first call that needs one", async () => {
    // The quickstart builds a client from a key alone and calls that step
    // done, so building one has to work. Where it cannot work is the call, and
    // the documentation says as much: the first call is what finds out whether
    // this side can reach us. Nothing in the contract or in any decision names
    // where the gateway lives, so the call says that rather than reaching for
    // a hostname nobody chose.
    const coinslot = createClient({ apiKey: API_KEY });

    await expect(coinslot.catalog.publish(card)).rejects.toThrow(/baseUrl/);
    await expect(coinslot.orders.get("order-1")).rejects.toThrow(/baseUrl/);
    await expect(
      coinslot.orders.forId("order-1").deliver({ access_url: "https://a.example" }),
    ).rejects.toThrow(/baseUrl/);

    // Registering is not a call and does not need one; starting the loop is.
    coinslot.on("order", (arrived) => arrived.accepted());
    await expect(coinslot.start()).rejects.toThrow(/baseUrl/);
  });

  it("refuses an address that is not one", () => {
    expect(() => createClient({ apiKey: API_KEY, baseUrl: "gateway.invalid" })).toThrow(/address/i);
  });
});

describe("publishing a card", () => {
  it("hands back the catalog identifier", async () => {
    const coinslot = await gatewayServing({
      publish_card: () => ({ body: { ok: { id: "cat-1" } } }),
    });

    const published = await coinslot.catalog.publish(card);

    expect(published).toStrictEqual({ ok: { id: "cat-1" } });
    expect(gateway?.callsTo("publish_card")[0]?.body).toStrictEqual(card);
    expect(gateway?.callsTo("publish_card")[0]?.apiKey).toBe(API_KEY);
  });

  it("returns what is wrong with the card instead of throwing", async () => {
    // The portal's promise about the edit cycle: an invalid card does not
    // throw, it comes back as a list of findings the merchant can print.
    const errors = [{ path: ["price", "currency"], code: "unsupported", message: "not settled" }];
    const coinslot = await gatewayServing({
      publish_card: () => ({ status: 400, body: { errors } }),
    });

    const published = await coinslot.catalog.publish(card);

    expect("errors" in published && published.errors).toStrictEqual(errors);
  });

  it("throws when the answer is not an answer at all", async () => {
    // A card that was neither accepted nor faulted is a case a merchant
    // cannot branch on, so it arrives as an exception rather than as a third
    // shape nobody described.
    const coinslot = await gatewayServing({
      publish_card: () => ({ status: 502, text: "<html>gateway timeout</html>" }),
    });

    await expect(coinslot.catalog.publish(card)).rejects.toThrow(/publish_card/);
  });

  it("treats a well-formed answer that is not the document as no answer at all", async () => {
    // The dangerous shape is not the broken one: it is valid JSON, under a
    // 200, that is not what the route promises — a proxy's own body, a
    // gateway of another version, an error envelope somebody added. Read
    // without checking, it becomes a published card that was never published.
    const coinslot = await gatewayServing({
      publish_card: () => ({ status: 200, text: JSON.stringify({ accepted: true }) }),
    });

    await expect(coinslot.catalog.publish(card)).rejects.toThrow(/document it promises/);
  });
});

describe("reading orders back", () => {
  it("reads one order and the state it is in", async () => {
    const coinslot = await gatewayServing({
      get_order: () => ({ body: { ...order, status: "in_progress" } }),
    });

    const read = await coinslot.orders.get("order-1");

    expect(read.status).toBe("in_progress");
    expect(gateway?.callsTo("get_order")[0]?.params).toStrictEqual({ order_id: "order-1" });
  });

  it("encodes an identifier that carries a slash or a space", async () => {
    // The contract accepts "SKU 100/1" as an identifier, and pasted into an
    // address unencoded it becomes two segments and a different route.
    const coinslot = await gatewayServing({
      get_order: (call) => ({
        body: { ...order, id: call.params.order_id ?? "", status: "delivered" },
      }),
    });

    await coinslot.orders.get("SKU 100/1");

    expect(gateway?.callsTo("get_order")[0]?.params).toStrictEqual({ order_id: "SKU 100/1" });
  });

  it("asks for the open orders in the words the query string carries", async () => {
    // The merchant writes a boolean because that is what their language has;
    // the wire carries the two words the contract names. The translation is
    // the SDK's, and a merchant who wrote open=1 by hand would silently
    // receive every order and reconcile against the wrong list.
    const coinslot = await gatewayServing({ list_orders: () => ({ body: { orders: [] } }) });

    await coinslot.orders.list({ open: true });
    await coinslot.orders.list({ open: false });
    await coinslot.orders.list();

    expect(gateway?.callsTo("list_orders").map((call) => call.query)).toStrictEqual([
      { open: "true" },
      { open: "false" },
      {},
    ]);
  });
});

describe("closing an order the merchant took on", () => {
  it("delivers and hands back the word the gateway used", async () => {
    const coinslot = await gatewayServing({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    const result = await coinslot.orders.forId("order-1").deliver({
      access_url: "https://example.com/a",
    });

    expect(result).toStrictEqual({ ok: true, result: "delivered" });
    expect(gateway?.callsTo("deliver_order")[0]?.body).toStrictEqual({
      access_url: "https://example.com/a",
    });
  });

  it("says when a delivered field will be dropped, on this road as well", async () => {
    // The one silent loss the contract documents, and it was reported on one
    // of the two roads to the gateway. The worker warns about a handler's
    // answer; this call is the other road, and the one a merchant delivering
    // asynchronously takes — the portal's own loop over open orders ends in
    // it. A field lost here told nobody at all, and the merchant's handler had
    // no way to learn that what it sent is not what went out.
    const problems: WorkerProblem[] = [];
    const coinslot = await gatewayServing({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    coinslot.on("problem", (problem) => problems.push(problem));

    const result = await coinslot.orders
      .forId("order-1")
      .deliver(JSON.parse('{"access_url": "https://a.example", "__proto__": "gone"}'));

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.DELIVERY_FIELD_DROPPED);
    expect(problems[0]?.subject).toBe("order-1");
    expect(problems[0]?.fatal).toBe(false);
    // A warning and not a refusal: the rest of the delivery is good and the
    // call goes through, which is the same thing the worker does with it.
    expect(result).toStrictEqual({ ok: true, result: "delivered" });
  });

  it("says nothing about an ordinary delivery", async () => {
    // The negative control. A reporter that fired on every delivery would be
    // noise a merchant learns to ignore, and the one warning worth having
    // would go with it.
    const problems: WorkerProblem[] = [];
    const coinslot = await gatewayServing({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
    });

    coinslot.on("problem", (problem) => problems.push(problem));

    await coinslot.orders.forId("order-1").deliver({ access_url: "https://a.example" });
    await coinslot.orders.forId("order-1").refuse({ code: "out_of_stock", message: "none left" });

    expect(problems).toStrictEqual([]);
  });

  it("returns a refusal of the call rather than throwing it", async () => {
    // The portal promises that these errors are returned and carry whether a
    // repeat could help. A merchant who had to catch them would write a retry
    // loop around a case that no repeat changes.
    const error = {
      code: "refund_already_settled",
      message: "the debt was paid back",
      retryable: false,
    };
    const coinslot = await gatewayServing({
      deliver_order: () => ({ status: 409, body: { ok: false, error } }),
    });

    const result = await coinslot.orders.forId("order-1").deliver({
      access_url: "https://example.com/a",
    });

    expect(result).toStrictEqual({ ok: false, error });
  });

  it("turns a gateway that did not answer into a retryable error, not an exception", async () => {
    // Same promise, one layer down: a dropped connection is the case the
    // retryable flag exists for, and it must reach the merchant through the
    // same branch as everything else these calls answer with.
    const coinslot = await gatewayServing({
      refuse_order: () => ({ status: 502, text: "bad gateway" }),
    });

    const result = await coinslot.orders.forId("order-1").refuse({
      code: "out_of_stock",
      message: "Поставщик не подтвердил номер",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.retryable).toBe(true);
    expect(result.ok === false && result.error.message).toMatch(/refuse_order/);
  });

  it("does not read an order call's answer out of a document that is not one", async () => {
    // The same trap on the branch that returns rather than throws: a body
    // that parses and is not the answer would otherwise become a delivery
    // the merchant believes went through.
    const coinslot = await gatewayServing({
      deliver_order: () => ({ text: JSON.stringify({ ok: "yes", result: "delivered" }) }),
    });

    const result = await coinslot.orders.forId("order-1").deliver({
      access_url: "https://a.example",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.retryable).toBe(true);
    // The gateway did answer — this is a body we cannot read, not a call that
    // never arrived, and the two are different facts about the merchant's books.
    expect(result.ok === false && result.error.code).toBe(ANSWER_NOT_UNDERSTOOD);
  });

  it("keeps three different facts about a failed call apart", async () => {
    // They are three different things to know about one's own books. A call
    // that was refused a connection certainly delivered nothing. A call
    // answered in words we cannot read reached us and may well have done its
    // work. A call sent into silence is neither, and telling a merchant it did
    // not arrive would be inventing the one fact they came here for.
    const answering = await gatewayServing({
      deliver_order: () => ({ text: "<html>gateway timeout</html>" }),
    });
    const answered = await answering.orders.forId("order-1").deliver({
      access_url: "https://a.example",
    });

    expect(answered.ok === false && answered.error.code).toBe(ANSWER_NOT_UNDERSTOOD);
    expect(answered.ok === false && answered.error.message).toMatch(/reached us/);

    // An address that was listening a moment ago and is not any more: the
    // connection is refused, so nothing was handed over.
    const closed = await startFakeGateway({ apiKey: API_KEY, routes: {} });
    await closed.close();

    const gone = createClient({ apiKey: API_KEY, baseUrl: closed.url });
    const never = await gone.orders.forId("order-1").deliver({ access_url: "https://a.example" });

    expect(never.ok === false && never.error.code).toBe(CALL_DID_NOT_REACH_US);
    expect(never.ok === false && never.error.retryable).toBe(true);
    expect(never.ok === false && never.error.message).toMatch(/did not reach us/);
  });

  it("carries the third fact under its own code when nothing came back", async () => {
    // A request that was taken and then dropped mid-flight. Filed under the
    // code for a call that never arrived, this would tell a merchant their
    // delivery certainly did not happen — which is the one thing nobody on
    // this side knows.
    const takenAndDropped = createServer((_request, response) => {
      response.socket?.destroy();
    });

    await new Promise<void>((resolve) => takenAndDropped.listen(0, "127.0.0.1", resolve));

    const port = (takenAndDropped.address() as AddressInfo).port;
    const coinslot = createClient({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` });

    try {
      const result = await coinslot.orders.forId("order-1").deliver({
        access_url: "https://a.example",
      });

      expect(result.ok === false && result.error.code).toBe(OUTCOME_UNKNOWN);
      expect(result.ok === false && result.error.retryable).toBe(true);
      expect(result.ok === false && result.error.message).toMatch(/not known here/);
      expect(result.ok === false && result.error.message).not.toMatch(/did not reach us/);
    } finally {
      takenAndDropped.closeAllConnections();
      await new Promise<void>((resolve) => takenAndDropped.close(() => resolve()));
    }
  });

  it("does not blame the gateway for an answer that died halfway through", async () => {
    // The neighbour of the case above, and the one that is easiest to file
    // wrongly. Here the gateway did answer — a status came back, and part of a
    // body — and then the connection broke while the rest of it was being
    // read. The break is on this side of the exchange, so calling it "answered
    // with something that is not JSON" would be reporting a broken gateway on
    // the evidence of a broken wire, and a merchant chasing that spends their
    // afternoon reading someone else's logs. What is actually known is that
    // the call was delivered and its outcome is not: the same fact as a
    // request dropped in flight, said with the status it got as far as.
    const diedMidSentence = createServer((_request, response) => {
      // A length longer than what is written, so the answer is cut off rather
      // than merely short: the reader is waiting for bytes that never arrive.
      response.writeHead(200, { "content-type": "application/json", "content-length": "512" });
      response.write('{"order_id":"order-1","st', () => response.socket?.destroy());
    });

    await new Promise<void>((resolve) => diedMidSentence.listen(0, "127.0.0.1", resolve));

    const port = (diedMidSentence.address() as AddressInfo).port;
    const coinslot = createClient({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` });

    try {
      const result = await coinslot.orders.forId("order-1").deliver({
        access_url: "https://a.example",
      });

      // Not the unreadable-answer fact, which would blame the gateway.
      expect(result.ok === false && result.error.code).toBe(OUTCOME_UNKNOWN);
      expect(result.ok === false && result.error.code).not.toBe(ANSWER_NOT_UNDERSTOOD);
      expect(result.ok === false && result.error.retryable).toBe(true);
      // And not the never-arrived fact, which would claim it did nothing.
      expect(result.ok === false && result.error.message).not.toMatch(/did not reach us/);
      // What is left is the sentence for this case, carrying the status the
      // gateway got as far as saying — the detail that tells a person reading
      // the log which of the two broken-wire cases they are looking at.
      expect(result.ok === false && result.error.message).toMatch(
        /began answering 200 and the answer could not be read to the end/,
      );
      expect(result.ok === false && result.error.message).not.toMatch(/is not JSON/);
      // And the clause the whole message opens with must not contradict the
      // sentence it introduces. A status and part of a body did come back, so
      // "nothing came back" in front of "began answering 200" is the message
      // arguing with itself, and the half a merchant believes is the first
      // one — which sends them looking at the half of the network that was
      // working.
      expect(result.ok === false && result.error.message).not.toMatch(/nothing came back/);
    } finally {
      diedMidSentence.closeAllConnections();
      await new Promise<void>((resolve) => diedMidSentence.close(() => resolve()));
    }
  });

  it("promises a safe repeat only where the contract promises one", async () => {
    // Delivering is idempotent by the order's identifier and taking an order
    // on happens again on every redelivery, so both may be repeated. Refusing
    // is documented as neither, and a merchant who retried a refusal on our
    // say-so would be retrying the call that opens a refund debt.
    const coinslot = await gatewayServing({
      deliver_order: () => ({ text: "not an answer" }),
      refuse_order: () => ({ text: "not an answer" }),
      accept_order: () => ({ text: "not an answer" }),
    });

    const held = coinslot.orders.forId("order-1");
    const delivered = await held.deliver({ access_url: "https://a.example" });
    const refused = await held.refuse({ code: "out_of_stock", message: "no" });
    const accepted = await held.accept();

    expect(delivered.ok === false && delivered.error.message).toMatch(/may be made again/);
    expect(accepted.ok === false && accepted.error.message).toMatch(/may be made again/);
    expect(refused.ok === false && refused.error.message).not.toMatch(/may be made again/);
  });

  it("takes an order on, with and without an expected time", async () => {
    const coinslot = await gatewayServing({ accept_order: () => ({ body: { ok: true } }) });

    const held = coinslot.orders.forId("order-1");

    expect(await held.accept({ eta_seconds: 60 })).toStrictEqual({ ok: true });
    expect(await held.accept()).toStrictEqual({ ok: true });

    expect(gateway?.callsTo("accept_order").map((call) => call.body)).toStrictEqual([
      { eta_seconds: 60 },
      {},
    ]);
  });
});

describe("a refusal the gateway put into words", () => {
  /**
   * The refusal the real gateway answers `get_order` with when the order
   * closed before anybody named a price for it — the shape and the sentence
   * `apps/gateway/src/http/routes.ts` writes, and the one
   * `apps/gateway/src/http/server.test.ts` holds it to.
   *
   * It is scripted as text rather than as a document because it is not the
   * document this route promises, which is the whole situation: the gateway
   * had something to say and no way to say it in the shape the table names.
   */
  const closedBeforePriced = JSON.stringify({
    error: {
      code: "order_closed_before_it_was_priced",
      message:
        "this order ended as rejected before anybody named a price for it, so there is no sale to describe",
      status: "rejected",
    },
  });

  it("tells the merchant what the gateway said, not that we could not parse it", async () => {
    // The promise: a refusal reaches the caller in the server's own words. The
    // merchant reading this has to be able to act on it, and "answered 409
    // with something that is not the document it promises" sends them to read
    // our schemas about an order that is simply over.
    const coinslot = await gatewayServing({
      get_order: () => ({ status: 409, text: closedBeforePriced }),
    });

    const refused = await coinslot.orders.get("order-1").then(
      () => null,
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );

    expect(refused).toContain("order_closed_before_it_was_priced");
    expect(refused).toContain("no sale to describe");
    expect(refused).not.toContain("is not the document it promises");
  });

  it("hands an order call the gateway's own refusal instead of a word we invented", async () => {
    // The same answer reaching the other consumer. An order call does not
    // throw — the merchant is expected to branch on it — so the refusal has to
    // arrive as the failure it is, and the clause in front of it must not say
    // the answer could not be read when it was read perfectly well.
    const coinslot = await gatewayServing({
      deliver_order: () => ({
        status: 404,
        text: JSON.stringify({
          error: { code: "no_such_order", message: "there is no such order" },
        }),
      }),
    });

    const result = await coinslot.orders.forId("order-1").deliver({
      access_url: "https://a.example",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain("no_such_order");
    expect(result.ok === false && result.error.message).toContain("there is no such order");
    expect(result.ok === false && result.error.message).not.toMatch(/could not be read/);
  });

  it("still says what came back when the answer is not a refusal either", async () => {
    // The negative control, and it is the reason recognising a refusal cannot
    // be done by looking at the status alone. A body that is JSON and is
    // neither the document nor a refusal has to come back quoted, so that a
    // person can see what the gateway actually sent.
    const coinslot = await gatewayServing({
      get_order: () => ({ status: 409, text: JSON.stringify({ trouble: "no code, no words" }) }),
    });

    const refused = await coinslot.orders.get("order-1").then(
      () => null,
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );

    expect(refused).toContain("is not the document it promises");
    expect(refused).toContain("no code, no words");
  });

  it("does not read a half-written refusal as a refusal", async () => {
    // A refusal with a code and no words is not something a caller can act on,
    // and treating it as one would print an empty sentence where the reason
    // belongs. What is left in that case is the honest complaint with the body
    // quoted inside it.
    const coinslot = await gatewayServing({
      get_order: () => ({ status: 409, text: JSON.stringify({ error: { code: "no_message" } }) }),
    });

    const refused = await coinslot.orders.get("order-1").then(
      () => null,
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );

    expect(refused).toContain("is not the document it promises");
    expect(refused).toContain("no_message");
  });
});

describe("the door on every call", () => {
  it("presents the merchant's key on the calls that are behind it", async () => {
    // The fake gateway refuses a call behind the merchant's door that arrives
    // without the key, so this passing is the assertion.
    const coinslot = await gatewayServing({ list_orders: () => ({ body: { orders: [] } }) });

    await coinslot.orders.list();

    expect(gateway?.callsTo("list_orders")[0]?.apiKey).toBe(API_KEY);
  });
});

describe("what a failed call says about whether it arrived", () => {
  it("claims nothing was sent only when every address tried says so", () => {
    // A name that resolves to more than one address is tried at each of them,
    // and what comes back is one error holding the others. If one of those
    // attempts got as far as a connection, nothing was refused outright and
    // the honest answer is that we do not know — read the other way, a
    // merchant would be told their delivery certainly never arrived on the
    // strength of one address out of two.
    const failing = (...codes: string[]): unknown => ({
      cause: codes.length === 1 ? { code: codes[0] } : { errors: codes.map((code) => ({ code })) },
    });

    expect(reachOf(failing("ECONNREFUSED"))).toBe(REACH.NOT_RECEIVED);
    expect(reachOf(failing("ECONNREFUSED", "ENOTFOUND"))).toBe(REACH.NOT_RECEIVED);
    expect(reachOf(failing("ECONNREFUSED", "ECONNRESET"))).toBe(REACH.UNKNOWN);
    expect(reachOf(failing("ECONNRESET"))).toBe(REACH.UNKNOWN);
    expect(reachOf(failing())).toBe(REACH.UNKNOWN);
    expect(reachOf(new Error("something with no cause at all"))).toBe(REACH.UNKNOWN);
    expect(reachOf(undefined)).toBe(REACH.UNKNOWN);
  });
});

describe("what a failed call is told to the merchant as", () => {
  const failing = (reach: Reach): TransportFailure => ({
    route: "deliver_order",
    reason: "the reason, whatever it was",
    reach,
  });

  it("says a different thing for each of the three, and never the wrong one", () => {
    // The three sentences are what a merchant actually reads, and each of them
    // is a claim about their own books. Two of them saying the same thing, or
    // one of them wearing another's words, is the defect this exists to catch:
    // the wording is the whole of the difference between "your delivery did
    // not happen" and "we cannot tell you whether it did".
    const said = {
      [REACH.NOT_RECEIVED]: whatIsKnown(failing(REACH.NOT_RECEIVED)),
      [REACH.ANSWERED]: whatIsKnown(failing(REACH.ANSWERED)),
      [REACH.UNKNOWN]: whatIsKnown(failing(REACH.UNKNOWN)),
    };

    expect(new Set(Object.values(said)).size).toBe(3);

    // Only the first is allowed to say the call did not arrive.
    expect(said[REACH.NOT_RECEIVED]).toMatch(/did not reach us/);
    expect(said[REACH.ANSWERED]).not.toMatch(/did not reach us/);
    expect(said[REACH.UNKNOWN]).not.toMatch(/did not reach us/);

    // The other two have to say plainly that we cannot tell, and they have to
    // say which of the two silences it was.
    expect(said[REACH.ANSWERED]).toMatch(/reached us/);
    expect(said[REACH.ANSWERED]).toMatch(/not known here/);
    expect(said[REACH.UNKNOWN]).toMatch(/not known here/);

    // And the third one has to be true of every road into it, which is where
    // it was wrong. Three roads end at this reach and they know different
    // things. A request abandoned when the worker stopped or when the deadline
    // passed throws with no code at all, and may never have left this process.
    // A connection that broke in flight was certainly sent. And a gateway that
    // began answering and stopped mid-sentence certainly arrived — a status
    // and part of a body came back.
    //
    // So neither half of "it was sent and nothing came back" is safe to say:
    // the first is unknowable on the first road, the second is plainly false
    // on the third, and a merchant reading it rules out the half of the
    // network that was working. Nor may it claim not to know whether the call
    // arrived, because on the third road it did.
    expect(said[REACH.UNKNOWN]).not.toMatch(/it was sent/);
    expect(said[REACH.UNKNOWN]).not.toMatch(/nothing came back/);
    expect(said[REACH.UNKNOWN]).not.toMatch(/whether it arrived/);

    // What is left is the one thing all three roads share, and it is pinned
    // rather than left to the absences above: without it the clause could
    // shrink to "we cannot tell" and stop saying that the exchange was cut
    // short at all, which is the difference between a call that may have done
    // its work and one that was answered in words we could not read.
    expect(said[REACH.UNKNOWN]).toMatch(/did not finish/);
  });
});
