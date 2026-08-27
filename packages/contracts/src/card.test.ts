import { describe, expect, it } from "vitest";
import {
  CardSchema,
  deliveryCheckFor,
  FulfillmentSchema,
  MerchantCardSchema,
  PriceCheckSchema,
  PublicCardSchema,
  publicCardOf,
  purchaseCheckFor,
} from "./card.js";
import { toJsonSchemas } from "./index.js";
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

  it("reads the scheme the way a URL scheme is read, without regard to case", () => {
    // A scheme is case-insensitive, and for a while the two checks behind this
    // field disagreed about that: one accepted `HTTPS://` and the other
    // refused it, complaining that an address was not https about an address
    // that was.
    expect(PriceCheckSchema.safeParse({ url: "HTTPS://api.example.com/quote" }).success).toBe(true);
    expect(PriceCheckSchema.safeParse({ url: "HtTpS://api.example.com/quote" }).success).toBe(true);
    expect(PriceCheckSchema.safeParse({ url: "HTTP://api.example.com/quote" }).success).toBe(false);
  });

  it("refuses a price hook that is not over https", () => {
    // The question and the answer carry a merchant's prices. Over plain http
    // they are readable and rewritable by anyone on the path, and the merchant
    // would have no way to tell that the price we sold at was not theirs.
    expect(PriceCheckSchema.safeParse({ url: "http://api.example.com/quote" }).success).toBe(false);
    expect(PriceCheckSchema.safeParse({ url: "/quote" }).success).toBe(false);
    expect(PriceCheckSchema.safeParse({ url: "api.example.com/quote" }).success).toBe(false);
  });

  it("refuses something that begins like an address and is not one", () => {
    // The scheme rule and the address rule are two checks, and this is the
    // case that tells them apart: right scheme, no address behind it. A card
    // carrying one of these would publish, and the price question would fail
    // at the first purchase instead of at the publish call.
    for (const url of ["https://", "https://a b", "https://["]) {
      expect(PriceCheckSchema.safeParse({ url }).success, url).toBe(false);
    }
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

  it("refuses to publish in the mode whose request the wire cannot carry", () => {
    // The promise this keeps: a merchant never publishes a card that cannot be
    // sold. In the confirmation mode a request arrives before any money moves
    // and must be answered without delivering — but nothing on the wire marks
    // it, so a handler could not tell it from a paid order. Naming that in a
    // comment somewhere is not enough: the merchant, and the engineer
    // generating a client from the exported document, learn about it here or
    // they learn about it from a request they mishandle.
    const message = errorOf(CardSchema, { ...syncCard, fulfillment: "confirm" });

    expect(message).toContain("confirm");
    expect(message).toContain("pilot");
  });

  it("complains about the mode and not about the deadlines that go with it", () => {
    // The rules about which card carries which deadline are unchanged and
    // still correct for the confirmation mode; they are simply unreachable
    // while the gate is down. If this card drew a deadline complaint too, the
    // gate would be hiding a second problem behind it — and lifting the gate
    // later would uncover it.
    const message = errorOf(CardSchema, {
      ...syncCard,
      fulfillment: "confirm",
      confirm_deadline_seconds: 3_600,
      fulfill_deadline_seconds: 86_400,
    });

    expect(message).not.toContain("confirm_deadline_seconds");
    expect(message).not.toContain("fulfill_deadline_seconds");
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

  it("refuses a card whose whole result might be absent", () => {
    // The same nothing, spelled differently: a declaration of one field that
    // the merchant has marked as possibly missing promises exactly as much as
    // an empty one, and satisfies "at least one field" while doing it. At
    // least one field of a result has to be a field that arrives.
    expect(
      errorOf(CardSchema, { ...syncCard, result: { maybe: { type: "string", required: false } } }),
    ).toContain("result");

    // One that arrives alongside one that might not is a real promise.
    expect(
      CardSchema.safeParse({
        ...syncCard,
        result: {
          access_url: { type: "string" },
          ios_tap_link: { type: "string", required: false },
        },
      }).success,
    ).toBe(true);
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
  });
});

describe("the checks a card compiles to", () => {
  // The promise: the card is the only place that knows which of its two
  // declarations is which, so asking it for a check cannot get the direction
  // backwards. A caller who compiled the result as a purchase would silently
  // reopen the hole where a delivery promises nothing.
  //
  // The card below is the one that tells the two apart: a field with no
  // `required` flag, which a purchase may omit and a delivery may not.
  const card = CardSchema.parse({
    ...syncCard,
    params: { email: { type: "string", required: true }, note: { type: "string" } },
    result: { access_url: { type: "string" }, expires_at: { type: "string" } },
  });

  it("lets a purchase leave out a parameter that was never marked required", () => {
    const check = purchaseCheckFor(card);

    expect(check.safeParse({ email: "buyer@example.com" }).success).toBe(true);
    expect(check.safeParse({ email: "buyer@example.com", note: "for a friend" }).success).toBe(
      true,
    );
    expect(check.safeParse({ note: "for a friend" }).success).toBe(false);
  });

  it("holds a delivery to every field the same card declared", () => {
    const check = deliveryCheckFor(card);

    expect(
      check.safeParse({ access_url: "https://example.com/a", expires_at: "2026-09-25T10:00:00Z" })
        .success,
    ).toBe(true);
    expect(check.safeParse({ access_url: "https://example.com/a" }).success).toBe(false);
  });

  it("compiles nothing for a card that asks for no parameters", () => {
    const withoutParams = CardSchema.parse({ ...syncCard, params: undefined });
    const check = purchaseCheckFor(withoutParams);

    expect(check.safeParse({}).success).toBe(true);
    expect(check.safeParse({ email: "buyer@example.com" }).success).toBe(false);
  });
});

describe("what the exported document says about the mode", () => {
  // An engineer generating a client from the JSON Schema never reads the
  // TypeScript. If the gate lived only in a refinement, their generated card
  // would offer a mode that fails on the first publish, and the reason would
  // be nowhere in the document they were working from.

  it("keeps all three modes in the enumeration", () => {
    // The value is not removed: the mode exists in the model, the machine
    // knows it, and taking it out of the vocabulary would be a different and
    // larger claim than "not yet".
    expect(toJsonSchemas().fulfillment.enum).toStrictEqual(["sync", "async", "confirm"]);
  });

  it("says in the fulfillment document that one of them cannot be published", () => {
    const description = toJsonSchemas().fulfillment.description ?? "";

    expect(description).toContain("confirm");
    expect(description).toContain("pilot");
  });

  it("says the same in the card document", () => {
    const description = toJsonSchemas().card.description ?? "";

    expect(description).toContain("confirm");
    expect(description).toContain("pilot");
  });
});

describe("the card an agent reads", () => {
  // The promise: an agent choosing between products sees everything it needs
  // to choose and to buy, and nothing about how the merchant runs their shop.
  // Every field here is a claim we make to somebody spending money on it, so
  // the projection names what it copies rather than removing what it must not.

  const published = CardSchema.parse({ ...syncCard, price_check: "handler" });
  const issued = { id: "itm_4d21bb", as_of: "2026-08-26T09:00:00Z" };
  const publicCard = publicCardOf(published, issued);

  it("is a document an agent can buy from", () => {
    expect(PublicCardSchema.safeParse(publicCard).success).toBe(true);
  });

  it("carries these fields and no others", () => {
    // Written out rather than checked field by field, because the failure this
    // guards against is a field appearing: a card gains something the merchant
    // considers internal, the projection copies it because it copies broadly,
    // and it reaches every agent before anybody notices.
    expect(Object.keys(publicCard).sort()).toStrictEqual([
      "as_of",
      "description",
      "fulfillment",
      "id",
      "params",
      "price",
      "price_checked_at_purchase",
      "result",
      "title",
    ]);
  });

  it("hands the agent our catalog identifier and not the merchant's own key", () => {
    // Our identifier is what a purchase, a receipt and a status all use. The
    // merchant's key is theirs, it is unique only inside their own catalog,
    // and an agent given both would use the wrong one some of the time.
    expect(publicCard.id).toBe("itm_4d21bb");
    expect(Object.keys(publicCard)).not.toContain("merchant_item_id");
    expect(
      PublicCardSchema.safeParse({ ...publicCard, merchant_item_id: "access-monthly" }).success,
    ).toBe(false);
  });

  it("says the price will be asked again without saying where", () => {
    // The address of a merchant's pricing service is infrastructure of theirs
    // that no agent calls and that publishing would expose to everyone. That
    // the price is asked again is the part an agent acts on: the catalog price
    // is what it compares, and the sale can go through at another.
    expect(publicCard.price_checked_at_purchase).toBe(true);
    expect(Object.keys(publicCard)).not.toContain("price_check");
    expect(PublicCardSchema.safeParse({ ...publicCard, price_check: "handler" }).success).toBe(
      false,
    );
    expect(
      PublicCardSchema.safeParse({
        ...publicCard,
        price_check: { url: "https://pricing.internal/quote" },
      }).success,
    ).toBe(false);
  });

  it("says the price is firm when the card has no price check at all", () => {
    const fixed = publicCardOf(CardSchema.parse(syncCard), issued);

    expect(fixed.price_checked_at_purchase).toBe(false);
  });

  it("refuses a card whose flag about the price is missing rather than reading silence", () => {
    // Both readings are expensive. Read as false, an agent budgets against a
    // price that is about to move; read as true, it distrusts a price that
    // never moves and walks away from a sale.
    expectMissingFieldRejected(PublicCardSchema, publicCard, "price_checked_at_purchase");
    expect(
      PublicCardSchema.safeParse({ ...publicCard, price_checked_at_purchase: "yes" }).success,
    ).toBe(false);
  });

  for (const field of [
    "id",
    "title",
    "description",
    "price",
    "as_of",
    "result",
    "fulfillment",
    "price_checked_at_purchase",
  ]) {
    it(`refuses a public card without ${field} and names it`, () => {
      expectMissingFieldRejected(PublicCardSchema, publicCard, field);
    });
  }

  it("accepts a product that needs no input from the agent", () => {
    const noInput = publicCardOf(CardSchema.parse({ ...syncCard, params: undefined }), issued);

    expect(Object.keys(noInput)).not.toContain("params");
    expect(PublicCardSchema.safeParse(noInput).success).toBe(true);
  });

  it("carries the moment the price it shows was published", () => {
    // A price with no moment behind it cannot be judged stale, and this is the
    // catalog's only freshness claim: the same `as_of` an order carries when
    // it is sold from the card price rather than from a live answer.
    expect(publicCard.as_of).toBe("2026-08-26T09:00:00Z");
    expect(PublicCardSchema.safeParse({ ...publicCard, as_of: "2026-08-26" }).success).toBe(false);
  });

  it("holds the declared result to the same rule the published card is held to", () => {
    // The agent reads this before paying, so it has to promise the same thing
    // the card promised: at least one field, and at least one that arrives.
    expect(PublicCardSchema.safeParse({ ...publicCard, result: {} }).success).toBe(false);
    expect(
      PublicCardSchema.safeParse({
        ...publicCard,
        result: { access_url: { type: "string", required: false } },
      }).success,
    ).toBe(false);
  });

  it("advertises a delivery deadline on the mode that has one", () => {
    const async = publicCardOf(
      CardSchema.parse({ ...syncCard, fulfillment: "async", fulfill_deadline_seconds: 900 }),
      issued,
    );

    expect(async.fulfillment === "async" && async.fulfill_deadline_seconds).toBe(900);
    expect(PublicCardSchema.safeParse(async).success).toBe(true);
  });

  it("cannot advertise a wait that the mode never has", () => {
    // A synchronous card delivers inside our own response budget, one number
    // for every product; a delivery deadline on it would be a promise about a
    // wait that does not happen. The published card is already held to this,
    // and holding the projection to it too is what keeps a bug in whoever
    // builds the projection from reaching an agent as a false claim.
    expect(
      PublicCardSchema.safeParse({ ...publicCard, fulfill_deadline_seconds: 900 }).success,
    ).toBe(false);
    expect(
      PublicCardSchema.safeParse({ ...publicCard, confirm_deadline_seconds: 60 }).success,
    ).toBe(false);

    const async = publicCardOf(
      CardSchema.parse({ ...syncCard, fulfillment: "async", fulfill_deadline_seconds: 900 }),
      issued,
    );
    expect(PublicCardSchema.safeParse({ ...async, confirm_deadline_seconds: 60 }).success).toBe(
      false,
    );
  });

  it("says the deadline rule as structure, so it survives into the exported document", () => {
    // The reason the shape is a union over the mode rather than one object
    // with a rule attached: JSON Schema cannot hold "this field only when that
    // one has this value", and zod drops such a rule without a word. As
    // branches it crosses whole, and a generated client refuses what we refuse.
    const document = toJsonSchemas().public_card;
    const branches = document.anyOf ?? document.oneOf ?? [];
    type Branch = { properties?: Record<string, { const?: unknown } | undefined> };
    const modeOf = (branch: unknown) => (branch as Branch).properties?.fulfillment?.const;
    const propertiesOf = (mode: string) =>
      Object.keys((branches.find((branch) => modeOf(branch) === mode) as Branch)?.properties ?? {});

    expect(branches).toHaveLength(3);
    expect(propertiesOf("sync")).not.toContain("fulfill_deadline_seconds");
    expect(propertiesOf("sync")).not.toContain("confirm_deadline_seconds");
    expect(propertiesOf("async")).toContain("fulfill_deadline_seconds");
    expect(propertiesOf("async")).not.toContain("confirm_deadline_seconds");
    expect(propertiesOf("confirm")).toContain("confirm_deadline_seconds");
  });

  it("carries its own caveats into the exported document, where the reader has nothing else", () => {
    // Everything below is argued in the file's prose, and the reader this
    // matters most to has the document and no TypeScript — and is about to
    // spend money on what the card claims. `as_of` is the sharp one: the same
    // name means "the moment a live answer was true" elsewhere in this
    // contract, and here it means only when the number shown was published.
    const description = toJsonSchemas().public_card.description ?? "";

    expect(description).toContain("when the price shown here was published");
    expect(description).toContain("says nothing about how fresh that check will be");
    expect(description).toContain("not that they answer");
    expect(description).toContain("who is selling");
  });

  it("projects every card of the pilot merchant's catalog into something an agent can read", () => {
    // The cross-check that keeps the two shapes in step. A card the merchant
    // may publish and whose projection this schema refuses is a product that
    // cannot be shown for sale, and the first anyone would hear of it is an
    // empty catalog.
    const catalog = [
      syncCard,
      { ...syncCard, price_check: "handler" },
      { ...syncCard, params: undefined },
      { ...syncCard, fulfillment: "async" },
      { ...syncCard, fulfillment: "async", fulfill_deadline_seconds: 900 },
      { ...syncCard, price_check: { url: "https://api.example.com/quote" } },
    ];

    for (const card of catalog) {
      const projected = publicCardOf(CardSchema.parse(card), issued);
      const verdict = PublicCardSchema.safeParse(projected);

      expect(
        verdict.success ? "" : JSON.stringify(verdict.error?.issues),
        JSON.stringify(card),
      ).toBe("");
    }
  });
});

describe("a card as its own merchant reads it", () => {
  // The promise: a merchant can see what they published and the word each card
  // is selling under, without reading the public catalog and working out which
  // entries are theirs. The catalog is unscoped and carries our identifier in
  // place of the merchant's key; this document carries the card itself.
  const merchantCard = {
    id: "itm_4d21bb",
    as_of: "2026-08-26T09:00:00Z",
    card: syncCard,
    selling: "open",
    paused: false,
  };

  it("carries the card exactly as the merchant published it", () => {
    // Not a third projection of a card. A merchant looking at their own
    // catalog is looking at what they wrote, and a shape that copied some
    // fields across would be one more thing to keep in step with the published
    // card — the drift `publicCardOf` already exists to prevent once.
    const parsed = MerchantCardSchema.parse(merchantCard);

    expect(parsed.card).toStrictEqual(CardSchema.parse(syncCard));
    expect(parsed.id).toBe("itm_4d21bb");
  });

  it("refuses a card its own merchant could not have published", () => {
    // The card inside is held to the rules publishing holds it to. A document
    // that admitted a card the publish route refuses would describe a catalog
    // entry that cannot exist.
    const impossible = { ...merchantCard, card: { ...syncCard, fulfillment: "confirm" } };

    expect(errorOf(MerchantCardSchema, impossible)).toContain("confirm");
  });

  for (const field of ["id", "as_of", "card", "selling", "paused"]) {
    it(`refuses a merchant's card without ${field} and names it`, () => {
      expectMissingFieldRejected(MerchantCardSchema, merchantCard, field);
    });
  }

  it("says both what this card sells under and whether the pause is its own", () => {
    // The two differ exactly when the whole catalog is paused: every card then
    // reads paused, and only the ones paused in their own right stay paused
    // when the merchant starts selling again. A merchant given one fact would
    // press resume on a card and watch nothing happen.
    const stoppedAll = MerchantCardSchema.parse({
      ...merchantCard,
      selling: "paused",
      paused: false,
    });

    expect(stoppedAll.selling).toBe("paused");
    expect(stoppedAll.paused).toBe(false);
  });

  it("refuses a selling word the order machine would not recognise", () => {
    expect(errorOf(MerchantCardSchema, { ...merchantCard, selling: "off" })).toContain("selling");
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(MerchantCardSchema, { ...merchantCard, revenue: "1000.00" })).toContain(
      "revenue",
    );
  });

  it("tells the reader of the document alone what the two selling fields mean", () => {
    // The trap is invisible from the shape: two fields that agree most of the
    // time and disagree exactly when the difference matters.
    const description = toJsonSchemas().merchant_card.description ?? "";

    expect(description).toContain("paused");
    expect(description).toContain("resume");
  });
});
