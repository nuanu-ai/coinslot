/**
 * The contract run against a catalog that is not the portal's.
 *
 * Every other test in this package works from the same example the
 * documentation works from, which is exactly the way a set of schemas can look
 * complete and still not fit anything real. The products below are the pilot
 * merchant's, as recorded in `docs/research/11-freeland-api-facts.md`: a
 * rented phone number sold synchronously, an eSIM plan whose profile arrives
 * later, and a VPN subscription at a fixed price.
 *
 * What comes from that record and what does not is worth separating, because
 * this file's whole argument is that it is not working from invented material.
 *
 * From the record: the three products and their modes, the number's price of
 * $8.75 (supplier cost plus a markup) and its documented limits, the VPN's $5
 * a month and its single subscription link, the eSIM delivery fields (ICCID,
 * the LPA string, the iOS link) and the supplier running out of profiles.
 *
 * Constructed, because the record does not carry them, and this list is the
 * whole of it: the eSIM plan's price of $18.90, its identifier, its title and
 * its description, and its delivery deadline of 900 seconds; the phone
 * number's `phone_number` result field, whose exact shape the same note lists
 * among its own gaps; and every identifier, timestamp and title on this page.
 * They are built to be plausible and none of them is a quotation.
 *
 * The test walks one purchase end to end — the card, the price question, the
 * order, the handler's answer, the receipt, and the event that follows when a
 * delivery does not happen — because a vocabulary that only works one document
 * at a time is not a contract.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CardSchema, deliveryCheckFor, purchaseCheckFor } from "./card.js";
import { OrderEventSchema } from "./events.js";
import { HandlerAnswerSchema } from "./handler.js";
import { OrderSchema } from "./order.js";

import { QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";
import { ReceiptSchema } from "./receipt.js";

/**
 * Whether the schema accepts the value — and, when it does not, why.
 *
 * A boolean alone would report "expected false to be true" from the one test
 * that runs a whole catalog through, leaving the reader to find the field
 * themselves.
 */
const verdictOf = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  return result.success ? "accepted" : `refused: ${z.prettifyError(result.error)}`;
};

describe("a rented phone number, sold synchronously", () => {
  // The merchant's price is their supplier's cost plus a markup, so it is
  // asked for at the moment of purchase. Their "no SIM available" is a
  // refusal before any money moves, which is what the synchronous mode is for.
  const card = {
    merchant_item_id: "virtual-number-monthly",
    title: "Виртуальный номер на месяц",
    description:
      "Номер в выбранной стране на 30 дней. Только входящие SMS; совместимость с одноразовыми кодами зависит от отправителя.",
    price: { amount: "8.75", currency: "USD" },
    params: {
      country: { type: "string", required: true, title: "Страна номера, ISO 3166-1 alpha-2" },
      period: { type: "string", required: true, title: "MONTHLY, 90, 180 или YEAR" },
    },
    result: {
      phone_number: { type: "string", title: "Номер в формате E.164" },
    },
    fulfillment: "sync",
    price_check: "handler",
  };

  it("is a card an agent can buy from", () => {
    expect(verdictOf(CardSchema, card)).toBe("accepted");
  });

  it("checks a purchase against what the card declared", () => {
    // Through the card rather than the raw compiler: the card is the only
    // place that knows which of its two declarations is which.
    const check = purchaseCheckFor(CardSchema.parse(card));

    expect(verdictOf(check, { country: "GB", period: "MONTHLY" })).toBe("accepted");
    expect(verdictOf(check, { country: "GB" })).not.toBe("accepted");
    expect(verdictOf(check, { country: "GB", period: "MONTHLY", service: "telegram" })).not.toBe(
      "accepted",
    );
  });

  it("holds the delivery to the result the card advertised", () => {
    const check = deliveryCheckFor(CardSchema.parse(card));

    expect(verdictOf(check, { phone_number: "+447700900123" })).toBe("accepted");
    expect(verdictOf(check, {})).not.toBe("accepted");
  });

  it("asks for a price and gets one back", () => {
    const question = {
      merchant_item_id: card.merchant_item_id,
      params: { country: "GB", period: "MONTHLY" },
      price_id: "prc_5d10ab",
      purpose: "purchase",
      expires_at: "2026-08-26T12:05:00Z",
    };
    const answer = {
      available: true,
      price: { amount: "8.75", currency: "USD" },
      as_of: "2026-08-26T12:00:00Z",
    };

    expect(verdictOf(QuoteRequestSchema, question)).toBe("accepted");
    expect(verdictOf(QuoteResponseSchema, answer)).toBe("accepted");
  });

  it("reaches the handler as an order and comes back as a delivery", () => {
    const order = {
      id: "ord_1c42fa",
      merchant_item_id: card.merchant_item_id,
      params: { country: "GB", period: "MONTHLY" },
      price: {
        amount: "8.75",
        currency: "USD",
        at: "2026-08-26T12:00:04Z",
        as_of: "2026-08-26T12:00:00Z",
      },
      price_id: "prc_5d10ab",
      test: false,
    };

    expect(verdictOf(OrderSchema, order)).toBe("accepted");
    expect(verdictOf(HandlerAnswerSchema, { delivered: { phone_number: "+447700900123" } })).toBe(
      "accepted",
    );

    // Their supplier answering "no SIM" is a refusal, and in this mode the
    // buyer spends nothing.
    expect(
      verdictOf(HandlerAnswerSchema, {
        refused: { code: "out_of_stock", message: "Свободных номеров в этой стране нет" },
      }),
    ).toBe("accepted");
  });
});

describe("an eSIM plan, whose profile arrives later", () => {
  // The purchase names a plan and nothing else, so the card takes no
  // parameters at all — the case the portal's own example never exercises.
  const card = {
    merchant_item_id: "esim-europe-10gb-30d",
    title: "eSIM: Европа, 10 ГБ на 30 дней",
    description: "Профиль eSIM с покрытием в странах Европы. Активация после установки профиля.",
    price: { amount: "18.90", currency: "USD" },
    result: {
      iccid: { type: "string", title: "ICCID профиля" },
      qr_data: { type: "string", title: "Строка LPA для QR-кода" },
      ios_tap_link: { type: "string", title: "Ссылка установки для iOS" },
    },
    fulfillment: "async",
    price_check: "handler",
    fulfill_deadline_seconds: 900,
  };

  it("is a card with no purchase parameters and a delivery deadline of its own", () => {
    expect(verdictOf(CardSchema, card)).toBe("accepted");
  });

  it("takes the order on first and delivers afterwards", () => {
    const order = {
      id: "ord_88b3c1",
      merchant_item_id: card.merchant_item_id,
      params: {},
      price: {
        amount: "18.90",
        currency: "USD",
        at: "2026-08-26T12:10:00Z",
        as_of: "2026-08-26T12:09:58Z",
      },
      price_id: "prc_77aa04",
      test: false,
    };

    expect(verdictOf(OrderSchema, order)).toBe("accepted");
    expect(verdictOf(HandlerAnswerSchema, { accepted: { eta_seconds: 120 } })).toBe("accepted");
  });

  it("leaves a receipt from the moment the money moves, before the profile exists", () => {
    const receipt = {
      id: "rcp_2f60ce",
      order_id: "ord_88b3c1",
      item_id: "itm_4d21bb",
      price: {
        amount: "18.90",
        currency: "USD",
        at: "2026-08-26T12:10:00Z",
        as_of: "2026-08-26T12:09:58Z",
      },
      price_id: "prc_77aa04",
      paid_at: "2026-08-26T12:10:01Z",
      outcome: "in_progress",
      test: false,
    };

    expect(verdictOf(ReceiptSchema, receipt)).toBe("accepted");
  });

  it("turns into a refund owed when the supplier has no SIM left", () => {
    // Their API answers a purchase it cannot fulfil with a plain refusal, and
    // here the money has already moved — so the merchant hears both the
    // refusal they sent and the debt it created.
    expect(
      verdictOf(HandlerAnswerSchema, {
        refused: { code: "out_of_stock", message: "У поставщика не осталось профилей этого плана" },
      }),
    ).toBe("accepted");

    expect(
      verdictOf(OrderEventSchema, {
        type: "order.refund_due",
        order_id: "ord_88b3c1",
        at: "2026-08-26T12:11:30Z",
        price: { amount: "18.90", currency: "USD" },
        reason: "refused",
      }),
    ).toBe("accepted");
  });
});

describe("a VPN subscription at a price that does not move", () => {
  // A fixed price and nothing to ask about: no price check, no deadlines, and
  // the order that follows carries no price_id because no question was asked.
  const card = {
    merchant_item_id: "vpn-monthly",
    title: "VPN на месяц",
    description: "Подписка на 30 дней. Выдаётся ссылка подписки, одна на все устройства.",
    price: { amount: "5", currency: "USDT" },
    result: {
      subscription_url: { type: "string", title: "Ссылка подписки" },
    },
    fulfillment: "sync",
  };

  it("is a complete card without a price check", () => {
    expect(verdictOf(CardSchema, card)).toBe("accepted");
  });

  it("produces an order with no price question behind it", () => {
    const order = {
      id: "ord_9ae107",
      merchant_item_id: card.merchant_item_id,
      params: {},
      price: {
        amount: "5",
        currency: "USDT",
        at: "2026-08-26T12:30:00Z",
        // Sold from the card, so the price is as fresh as the card is: this is
        // the moment it was last published.
        as_of: "2026-08-20T09:00:00Z",
      },
      test: false,
    };

    expect(verdictOf(OrderSchema, order)).toBe("accepted");
  });

  it("closes with a receipt that says the delivery happened", () => {
    const receipt = {
      id: "rcp_0b7712",
      order_id: "ord_9ae107",
      item_id: "itm_6c0f39",
      price: {
        amount: "5",
        currency: "USDT",
        at: "2026-08-26T12:30:00Z",
        as_of: "2026-08-20T09:00:00Z",
      },
      paid_at: "2026-08-26T12:30:02Z",
      outcome: "delivered",
      test: false,
    };

    expect(verdictOf(ReceiptSchema, receipt)).toBe("accepted");
  });
});
