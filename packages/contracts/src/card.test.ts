import { describe, expect, it } from "vitest";
import { CardSchema, FulfillmentSchema, PriceCheckSchema } from "./card.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const syncCard = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Доступ на 30 дней с момента выдачи, продление не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
  result: { access_url: { type: "string", title: "Ссылка для входа" } },
  fulfillment: "sync",
};

describe("fulfillment mode", () => {
  it("is one of the three modes the agent is told about before paying", () => {
    for (const mode of ["sync", "async", "confirm"]) {
      expect(FulfillmentSchema.safeParse(mode).success, mode).toBe(true);
    }
    for (const mode of ["synchronous", "SYNC", "manual", ""]) {
      expect(FulfillmentSchema.safeParse(mode).success, JSON.stringify(mode)).toBe(false);
    }
  });
});

describe("price check", () => {
  // The promise: a card says how its price is asked for, and the two
  // transports are the two the model has — the handler on the order channel,
  // or an address of the merchant's own.
  it("accepts the handler on the order channel", () => {
    expect(PriceCheckSchema.parse("handler")).toBe("handler");
  });

  it("accepts an address for the merchants who run a pricing service", () => {
    expect(PriceCheckSchema.parse({ url: "https://api.example.com/quote" })).toStrictEqual({
      url: "https://api.example.com/quote",
    });
  });

  it("refuses a price hook that is not over https", () => {
    // The question and the answer carry a merchant's prices. Over plain http
    // they are readable and rewritable by anyone on the path, and the merchant
    // would have no way to tell that the price we sold at was not theirs.
    expect(PriceCheckSchema.safeParse({ url: "http://api.example.com/quote" }).success).toBe(false);
    expect(PriceCheckSchema.safeParse({ url: "/quote" }).success).toBe(false);
    expect(PriceCheckSchema.safeParse({ url: "api.example.com/quote" }).success).toBe(false);
  });

  it("refuses an address that names nowhere", () => {
    // A card that declares the second transport and gives no address is a card
    // whose price we would never manage to ask about, and the merchant would
    // find out from the sales that quietly stopped rather than from publishing.
    expect(errorOf(PriceCheckSchema, {})).toContain("url");
    expect(errorOf(PriceCheckSchema, { address: "https://api.example.com/quote" })).toContain(
      "url",
    );
  });

  it("refuses a transport it does not have", () => {
    const message = errorOf(PriceCheckSchema, "webhook");
    expect(message).toContain("handler");
    expect(message).toContain("url");
  });
});

describe("card", () => {
  it("accepts a synchronous card with everything a purchase needs", () => {
    expect(CardSchema.parse(syncCard)).toStrictEqual(syncCard);
  });

  it("accepts an asynchronous card that checks its price and names its deadline", () => {
    const card = {
      ...syncCard,
      fulfillment: "async",
      price_check: "handler",
      fulfill_deadline_seconds: 86_400,
    };
    expect(CardSchema.parse(card)).toStrictEqual(card);
  });

  it("accepts a card with confirmation and both of the merchant's deadlines", () => {
    const card = {
      ...syncCard,
      fulfillment: "confirm",
      confirm_deadline_seconds: 3_600,
      fulfill_deadline_seconds: 86_400,
    };
    expect(CardSchema.parse(card)).toStrictEqual(card);
  });

  it("accepts a card that takes no purchase parameters", () => {
    const { params, ...withoutParams } = syncCard;
    expect(params).toBeDefined();
    expect(CardSchema.safeParse(withoutParams).success).toBe(true);
    expect(CardSchema.safeParse({ ...withoutParams, params: {} }).success).toBe(true);
  });

  for (const field of [
    "merchant_item_id",
    "title",
    "description",
    "price",
    "result",
    "fulfillment",
  ]) {
    it(`refuses a card without ${field} and names it`, () => {
      expectMissingFieldRejected(CardSchema, syncCard, field);
    });
  }

  it("refuses a card that fills in the catalog id", () => {
    // The catalog id is ours and we hand it back from the publish call. A
    // merchant who sends one is either guessing at our numbering or replaying
    // a card we returned, and both are worth saying out loud.
    expect(errorOf(CardSchema, { ...syncCard, id: "itm_9f2c4a" })).toContain("id");
  });

  it("refuses a card whose title or description is blank", () => {
    // The agent picks a card out of a catalog by these two fields. A blank
    // title is a card nobody can tell from its neighbours.
    expect(CardSchema.safeParse({ ...syncCard, title: "   " }).success).toBe(false);
    expect(CardSchema.safeParse({ ...syncCard, description: "" }).success).toBe(false);
  });

  it("refuses a card that promises nothing on delivery", () => {
    // `result` is what the agent reads before paying to decide what it is
    // buying. An empty declaration passes the letter of "result is required"
    // and tells the agent nothing at all.
    expect(errorOf(CardSchema, { ...syncCard, result: {} })).toContain("result");
  });
});

describe("the merchant's two deadlines", () => {
  // The promise: both deadlines are shown to the agent before it pays, so a
  // card may only carry the ones its mode actually uses. A synchronous card
  // showing a delivery deadline would be advertising a wait that never
  // happens; the wait for a synchronous answer is our own system-wide budget
  // and is not a card field at all.

  it("refuses a confirmation deadline on a card that has no confirmation step", () => {
    for (const fulfillment of ["sync", "async"]) {
      const message = errorOf(CardSchema, {
        ...syncCard,
        fulfillment,
        confirm_deadline_seconds: 3_600,
      });
      expect(message, fulfillment).toContain("confirm_deadline_seconds");
    }
  });

  it("refuses a delivery deadline on a synchronous card", () => {
    const message = errorOf(CardSchema, { ...syncCard, fulfill_deadline_seconds: 86_400 });
    expect(message).toContain("fulfill_deadline_seconds");
  });

  it("has no field for the synchronous response budget", () => {
    expect(errorOf(CardSchema, { ...syncCard, sync_deadline_seconds: 10 })).toContain(
      "sync_deadline_seconds",
    );
  });

  it("refuses a deadline that is not a whole number of seconds in the future", () => {
    for (const seconds of [0, -1, 1.5, "3600", null]) {
      const card = { ...syncCard, fulfillment: "async", fulfill_deadline_seconds: seconds };
      expect(CardSchema.safeParse(card).success, JSON.stringify(seconds)).toBe(false);
    }
  });

  it("accepts a card that names neither deadline", () => {
    // The default values are among the numbers named before the pilot, so a
    // card is allowed to leave both out and take ours.
    expect(CardSchema.safeParse({ ...syncCard, fulfillment: "async" }).success).toBe(true);
    expect(CardSchema.safeParse({ ...syncCard, fulfillment: "confirm" }).success).toBe(true);
  });
});
