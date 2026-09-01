import { ProblemSchema } from "@nuanu-ai/coinslot-contracts";
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
      expect(ProblemSchema.safeParse(problem).success).toBe(true);
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

  // Three cases stood here that walked one card rule each through the checker
  // — an empty result, the mode with no shape on the wire, a delivery deadline
  // on a synchronous card. `checkCard` is `CardSchema` and nothing beside it,
  // so each of them was the schema's own test written a second time, and
  // `card.test.ts` in the contracts package is where the rule lives. Removing
  // each rule in turn from the schema was tried: every one of them fails a test
  // over there, which is what says these were spare rather than load-bearing.
  // What this file is for is the answer's shape — a finding in the shape the
  // publish call answers in, and the report saying what a short list does and
  // does not imply — and that is what is left.

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
      expect(ProblemSchema.safeParse(problems[0]).success).toBe(true);
    }
  });
});
