import { PublishErrorSchema } from "@coinslot/contracts";
import { describe, expect, it } from "vitest";
import { checkCard } from "./check-card.js";

/**
 * The card the portal's quickstart publishes, which is the card a merchant
 * meets first. Copied here as an object rather than read out of the page: the
 * page's own examples are held to the schemas by the contracts package, and
 * what this file is about is what the checker says, not what the page says.
 */
const validCard = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Что покупатель получает, для какой задачи это годится и что в это не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: {
    email: { type: "string", required: true, title: "Куда прислать доступ" },
  },
  result: {
    access_url: { type: "string", title: "Ссылка для входа" },
  },
  fulfillment: "sync",
};

const pathsOf = (card: unknown): string[][] => checkCard(card).problems.map((p) => p.path);

describe("checking a card before it is published", () => {
  it("passes a card an agent could buy from", () => {
    // The promise: the check a merchant runs before publishing does not fail
    // the card the documentation told them to write.
    expect(checkCard(validCard).problems).toStrictEqual([]);
  });

  it("names the field that is missing, in the shape the publish call answers in", () => {
    // The promise: a finding a merchant reads is the same kind of object the
    // gateway would have sent back, so the two never have to be read
    // differently — one path, one code, one sentence for a person.
    const { problems } = checkCard({ ...validCard, title: undefined });

    expect(problems).toHaveLength(1);
    for (const problem of problems) {
      expect(PublishErrorSchema.safeParse(problem).success).toBe(true);
    }
    expect(problems[0]?.path).toStrictEqual(["title"]);
    expect(problems[0]?.message).toMatch(/string/);
  });

  it("reports every problem of one pass at once rather than the first", () => {
    // The promise the portal makes about the edit cycle: a merchant fixes
    // what is wrong and calls again, instead of discovering one field per
    // round trip.
    const paths = pathsOf({
      ...validCard,
      title: undefined,
      price: { amount: "5,00", currency: "USD" },
      fulfillment: "later",
    });

    expect(paths).toContainEqual(["title"]);
    expect(paths).toContainEqual(["price", "amount"]);
    expect(paths).toContainEqual(["fulfillment"]);
  });

  it("refuses a card that promises the agent nothing on delivery", () => {
    // An empty result satisfies the letter of "the card declares its result"
    // and tells the agent nothing about what it is paying for.
    expect(pathsOf({ ...validCard, result: {} })).toStrictEqual([["result"]]);
  });

  it("refuses the mode that has no shape on the wire yet", () => {
    // A card published as "confirm" would sell the merchant a mode nobody can
    // serve, and the first they heard of it would be a request they
    // mishandled.
    const paths = pathsOf({ ...validCard, fulfillment: "confirm" });

    expect(paths).toStrictEqual([["fulfillment"]]);
  });

  it("refuses a delivery deadline on a card that delivers inside the answer", () => {
    // A synchronous card advertising a delivery deadline advertises a wait
    // that never happens, and the agent reads that deadline before it pays.
    expect(pathsOf({ ...validCard, fulfill_deadline_seconds: 600 })).toStrictEqual([
      ["fulfill_deadline_seconds"],
    ]);
  });

  it("stops before the rules that compare fields when the shape itself is wrong", () => {
    // Pinned rather than assumed, because a merchant is entitled to know that
    // a clean second run is not implied by a short first one. The card below
    // has two problems — a field nobody declared, and a delivery deadline on
    // a synchronous card — and one pass sees only the first.
    const paths = pathsOf({ ...validCard, nonsense: 1, fulfill_deadline_seconds: 600 });

    expect(paths).toStrictEqual([[]]);
    expect(checkCard({ ...validCard, nonsense: 1 }).problems[0]?.message).toMatch(/nonsense/);
  });

  it("says so about a card as a whole when what it was handed is not a card", () => {
    // A merchant whose file held a list, a string or nothing at all gets a
    // finding about the card rather than a crash, and the empty path is what
    // says "this is about the card, not about a field of it".
    for (const value of [null, "a card", 42, [], undefined]) {
      const { problems } = checkCard(value);

      expect(problems).toHaveLength(1);
      expect(problems[0]?.path).toStrictEqual([]);
      expect(PublishErrorSchema.safeParse(problems[0]).success).toBe(true);
    }
  });
});
