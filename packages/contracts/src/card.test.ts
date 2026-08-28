import { describe, expect, it } from "vitest";
import {
  bazaarDeclarationOf,
  CardSchema,
  deliveryCheckFor,
  FulfillmentSchema,
  MerchantCardSchema,
  PriceCheckSchema,
  PublicCardSchema,
  publicCardOf,
  purchaseCheckFor,
  ServiceNameSchema,
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
    // And it is filed against the field, which is the half the sentence itself
    // does not say: the word "fulfillment" appears nowhere in the message, so
    // this can only come from the path the finding carries. A merchant's editor
    // puts a finding next to the line it is about, and one with an empty path
    // is a complaint about the card as a whole.
    expect(message).toContain("fulfillment");
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
    // The defaults live in the gateway's configuration, where the portal
    // publishes them as that deployment's settings, so a card is allowed to
    // leave both out and take ours.
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

describe("the tags a merchant puts on a card", () => {
  // The promise: what a merchant writes here is what a discovery channel
  // shows, or the card is refused. The channel this pilot lists in drops a tag
  // it cannot render and keeps the first five, silently, and a merchant whose
  // tag disappeared would have no way of learning that it had.
  it("takes the words a merchant chose", () => {
    const parsed = CardSchema.parse({ ...syncCard, tags: ["access", "subscription"] });

    expect(parsed.tags).toStrictEqual(["access", "subscription"]);
  });

  it("is absent on a card that names none", () => {
    expect(CardSchema.parse(syncCard).tags).toBeUndefined();
  });

  it("refuses a sixth tag rather than dropping it", () => {
    const six = ["a", "b", "c", "d", "e", "f"];

    expect(errorOf(CardSchema, { ...syncCard, tags: six })).toContain("tags");
    expect(CardSchema.safeParse({ ...syncCard, tags: six.slice(0, 5) }).success).toBe(true);
  });

  it("refuses a tag longer than the channel carries rather than cutting it short", () => {
    expect(CardSchema.safeParse({ ...syncCard, tags: ["x".repeat(32)] }).success).toBe(true);
    expect(errorOf(CardSchema, { ...syncCard, tags: ["x".repeat(33)] })).toContain("32");
  });

  it("refuses a tag the channel cannot render, rather than letting it vanish", () => {
    // The measured behaviour: a tag outside printable ASCII is dropped by the
    // facilitator without a word. A merchant writing in their own alphabet
    // has to find that out here, at the publish, and not from an empty listing.
    const cyrillic = errorOf(CardSchema, { ...syncCard, tags: ["доступ"] });

    expect(cyrillic).toContain("tags");
    expect(cyrillic).toMatch(/ASCII/i);
  });

  it("refuses an empty tag and a blank one", () => {
    expect(CardSchema.safeParse({ ...syncCard, tags: [""] }).success).toBe(false);
    expect(CardSchema.safeParse({ ...syncCard, tags: ["  "] }).success).toBe(false);
  });
});

describe("the name a seller is listed under", () => {
  // The promise: the same rule as the tags, on the field that names the seller
  // rather than the product. A truncated name in a public catalog is somebody
  // else's business trading under a word they did not choose.
  it("takes a name the channel carries whole", () => {
    expect(ServiceNameSchema.parse("Freeland")).toBe("Freeland");
    expect(ServiceNameSchema.parse("x".repeat(32))).toBe("x".repeat(32));
  });

  it("refuses a name longer than the channel carries", () => {
    expect(errorOf(ServiceNameSchema, "x".repeat(33))).toContain("32");
  });

  it("refuses a name the channel cannot render", () => {
    expect(errorOf(ServiceNameSchema, "Кафе")).toMatch(/ASCII/i);
  });

  it("refuses an empty name and a blank one", () => {
    expect(ServiceNameSchema.safeParse("").success).toBe(false);
    expect(ServiceNameSchema.safeParse("   ").success).toBe(false);
  });
});

describe("a card as a discovery channel reads it", () => {
  // The promise: an agent that has never seen our catalog finds this product
  // in a channel it already walks, and what it reads there is the same product
  // it can then buy. Everything below is drawn from the card; the two things
  // that are not — the address the resource answers at and the name of the
  // seller — are passed in, because a card cannot know either.
  const declared = (card: unknown, at: Parameters<typeof bazaarDeclarationOf>[1]) =>
    bazaarDeclarationOf(CardSchema.parse(card), at);

  const at = {
    url: "https://coinslot.example/v0/items/itm_4d21bb/purchase",
    serviceName: "The pilot merchant",
  };

  it("names the resource at the address it was given, not one it worked out", () => {
    expect(declared(syncCard, at).resource.url).toBe(at.url);
  });

  it("carries the merchant's description and the seller's name", () => {
    const { resource } = declared({ ...syncCard, tags: ["access"] }, at);

    expect(resource.description).toBe(syncCard.description);
    expect(resource.mimeType).toBe("application/json");
    expect(resource.serviceName).toBe("The pilot merchant");
    expect(resource.tags).toStrictEqual(["access"]);
  });

  it("leaves out a seller's name and a card's tags where there are none", () => {
    // Absent rather than empty. An empty string and an empty list are values a
    // channel renders; the absence of the field is the only way to say that
    // nobody named one.
    const { resource } = declared(syncCard, { url: at.url, serviceName: null });

    expect("serviceName" in resource).toBe(false);
    expect("tags" in resource).toBe(false);
  });

  it("describes the purchase body an agent would actually send", () => {
    const { input, inputSchema } = declared(syncCard, at);

    // The shape of a purchase on this gateway: the parameters under `params`.
    expect(input).toStrictEqual({ params: { email: "string" } });
    expect(inputSchema.type).toBe("object");
    const properties = inputSchema.properties as Record<string, Record<string, unknown>>;
    const params = properties.params ?? {};
    expect(params.required).toStrictEqual(["email"]);
    expect((params.properties as Record<string, unknown>).email).toStrictEqual({ type: "string" });
  });

  it("publishes an example the gateway's own check would accept", () => {
    // The one claim this example makes: send a body of this shape and it gets
    // past the door. An example our own validator refuses is an invitation to
    // a refusal, published to strangers.
    for (const card of [
      syncCard,
      { ...syncCard, params: undefined },
      {
        ...syncCard,
        params: {
          email: { type: "string", required: true },
          seats: { type: "integer" },
          trial: { type: "boolean", required: true },
          weight: { type: "number" },
        },
      },
    ]) {
      const parsed = CardSchema.parse(card);
      const { input } = bazaarDeclarationOf(parsed, at);
      const verdict = purchaseCheckFor(parsed).safeParse(
        (input as { params: Record<string, unknown> }).params,
      );

      expect(verdict.success ? "" : JSON.stringify(verdict.error?.issues)).toBe("");
    }
  });

  it("publishes a delivery example the card's own promise would accept", () => {
    const parsed = CardSchema.parse({
      ...syncCard,
      result: {
        access_url: { type: "string" },
        seats: { type: "integer" },
        active: { type: "boolean" },
        credit: { type: "number", required: false },
      },
    });
    const { output } = bazaarDeclarationOf(parsed, at);

    expect(output.example).toStrictEqual({
      access_url: "string",
      seats: 0,
      active: false,
      credit: 0,
    });
    // The claim this example makes to a stranger: a delivery of this shape is
    // one the merchant could actually send. A string that is empty is not —
    // the delivery check refuses it — so the example would advertise goods
    // this system would turn away.
    expect(deliveryCheckFor(parsed).safeParse(output.example).success).toBe(true);
    expect(deliveryCheckFor(parsed).safeParse({ ...output.example, access_url: "" }).success).toBe(
      false,
    );
  });

  it("gives the same declaration for the same card twice", () => {
    // The resource identity is what a listing is keyed on. Two challenges for
    // one product that disagreed about it would be two listings, or one that
    // flickers.
    expect(declared(syncCard, at)).toStrictEqual(declared(syncCard, at));
  });
});

describe("the tags a card may carry, against the listing's own rules", () => {
  // Each of these is a value our schema used to take and the catalog then made
  // something else of — a duplicate folded away, an empty list dropped so that
  // it says exactly what no tags at all says, padding kept so that one word has
  // two spellings. Nothing here runs the catalog's
  // own code: this package depends on zod and nothing else, deliberately. What
  // runs it is `apps/gateway/src/http/x402.test.ts`, which puts the longest
  // name and the most tags these schemas allow through the catalog's own
  // sanitiser and checks that it hands all of them back. These say what our side refuses; that one
  // says their side keeps what our side sends.
  const tagged = (tags: unknown) => CardSchema.safeParse({ ...syncCard, tags });

  it("refuses two tags the listing would fold into one", () => {
    expect(errorOf(CardSchema, { ...syncCard, tags: ["Access", "access"] })).toContain("case");
    expect(tagged(["access", "subscription"]).success).toBe(true);
  });

  it("refuses an empty list rather than sending one", () => {
    expect(tagged([]).success).toBe(false);
    expect(tagged(undefined).success).toBe(true);
  });

  it("refuses a tag padded with spaces, which the listing keeps as written", () => {
    expect(tagged([" access"]).success).toBe(false);
    expect(tagged(["access "]).success).toBe(false);
    expect(tagged(["one two"]).success).toBe(true);
  });

  it("says the rules it cannot check in a document, for the reader who has only that", () => {
    const document = toJsonSchemas().tags;

    expect(document.maxItems).toBe(5);
    expect(document.minItems).toBe(1);
    expect(document.uniqueItems).toBe(true);
    expect(document.description).toContain("case");
  });
});

describe("the description a listing carries", () => {
  // The promise: what a merchant writes here is what a discovery catalog
  // shows, whole. It is the one field of prose that goes out, no sanitiser
  // anywhere touches it, and the catalog's own documentation puts a ceiling on
  // it — so the ceiling is here, where a merchant meets it while they are still
  // writing, rather than there, where nobody would be told.
  const withDescription = (description: string) =>
    CardSchema.safeParse({ ...syncCard, description });

  it("takes a description up to the length the catalog documents", () => {
    expect(withDescription("d".repeat(500)).success).toBe(true);
  });

  it("refuses one longer than that rather than letting it be cut", () => {
    expect(errorOf(CardSchema, { ...syncCard, description: "d".repeat(501) })).toContain("500");
  });

  it("still refuses an empty description and a blank one", () => {
    expect(withDescription("").success).toBe(false);
    expect(withDescription("   ").success).toBe(false);
  });

  it("says the ceiling in the document, for the reader who has only that", () => {
    expect(toJsonSchemas().card.properties?.description).toMatchObject({ maxLength: 500 });
  });
});
