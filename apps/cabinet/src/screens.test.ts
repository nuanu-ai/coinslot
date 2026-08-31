/**
 * The two sentences that cannot be reached through the real gateway yet.
 *
 * Stage one marks every order as a test, so a list mixing test money with real
 * money is a shape the HTTP tests cannot produce — and it is the shape that
 * arrives the day stage two lands, on the screen a merchant reads for money
 * they have been sent. A branch that has never run is a branch nobody has
 * checked, and this is the one whose failure mode is a merchant counting test
 * purchases as takings.
 *
 * The screens are pure functions of the documents the gateway answered with,
 * which is what lets this be done honestly: the documents below are built by
 * the contract's own schemas, so a shape this file accepts is a shape the wire
 * can carry. Nothing is stubbed — there is nothing here to stub.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@coinslot/core";
import type { OrderList, ReceiptList } from "@nuanu-ai/coinslot-contracts";
import {
  MerchantCardListSchema,
  OrderListSchema,
  ReceiptListSchema,
} from "@nuanu-ai/coinslot-contracts";
import { describe, expect, it } from "vitest";
import { page } from "./html.js";
import { ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
import { signInScreen } from "./sign-in.js";
import { readable } from "./testing/html.js";

/** A page is drawn for somebody now, and every screen says who (ADR-0009). */
const SEEN_BY: Viewer = { base: "", mode: "sandbox", who: "dmitry@example.com", confirmed: true };

describe("what a page says about the stack it belongs to", () => {
  it("says nothing settles here on the laptop", () => {
    // Production break: the sandbox sign-in page could omit the statement that
    // no payment settles here, misleading a person who reads it as a receipt.
    const html = signInScreen("", "sandbox");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="sandbox"`);
    expect(readable(html)).toContain(SURFACE_WORDS.sandbox);
  });

  it("says payments settle with test funds on the test site", () => {
    // Production break: the test-site page could omit its test-funds warning.
    const html = signInScreen("", "test");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="test"`);
    expect(readable(html)).toContain(SURFACE_WORDS.test);
  });

  it("says nothing at all on the live one, and still names itself", () => {
    // The marker names the mode rather than merely existing. An absence cannot
    // tell a correct live page from a layout that forgot to render — on the
    // one site where the money is real.
    const html = signInScreen("", "live");

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="live"`);
    expect(readable(html)).not.toContain(SURFACE_WORDS.test);
    expect(readable(html)).not.toContain(SURFACE_WORDS.sandbox);
    // Not merely wordless: no banner element either. The styled one carries
    // padding and a rule, so an empty one is a band across a live page.
    expect(html).not.toContain('class="surface"');
  });

  it("carries the same marker on a signed-in page", () => {
    // Production break: authenticated pages could silently lose the stack label.
    const html = page({
      base: "",
      who: "dmitry@example.com",
      confirmed: true,
      tab: "cards",
      title: "Cards",
      mode: "test",
      body: "<p>x</p>",
    });

    expect(html).toContain(`${SURFACE_MARKER_ATTRIBUTE}="test"`);
    expect(readable(html)).toContain(SURFACE_WORDS.test);
  });
});

const cards = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    {
      id: "itm_1",
      as_of: "2026-08-26T09:00:00Z",
      card: {
        merchant_item_id: "room-101",
        title: "A room for the night",
        description: "One night in room 101",
        price: { amount: "80.00", currency: "USD" },
        result: { access_code: { type: "string" } },
        fulfillment: "sync",
      },
      selling: "open",
      paused: false,
    },
  ],
});

const order = (id: string, test: boolean) => ({
  id,
  merchant_item_id: "room-101",
  params: {},
  price: {
    amount: "80.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  test,
  status: "delivered",
});

const receipt = (id: string, test: boolean) => ({
  id,
  order_id: `ord_${id}`,
  item_id: "itm_1",
  price: {
    amount: "80.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  paid_at: "2026-08-26T10:20:03Z",
  outcome: "delivered",
  test,
});

describe("a list where some of the money was real and some was not", () => {
  it("counts the test purchases rather than calling the whole page a test", () => {
    const orders: OrderList = OrderListSchema.parse({
      orders: [order("ord_1", true), order("ord_2", false), order("ord_3", false)],
    });

    const text = readable(ordersScreen(SEEN_BY, cards, orders, false));

    expect(text).toContain("1 order here is a test purchase");
    expect(text).not.toContain("Every order here is a test purchase");
  });

  it("marks the test rows and leaves the real ones alone", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", true), receipt("rcp_2", false)],
    });

    const html = receiptsScreen(SEEN_BY, cards, receipts);
    const rows = html.slice(html.indexOf("<tbody>")).split("<tr");

    expect(readable(html)).toContain("1 receipt here is a test purchase");
    // One row carries the mark and the other does not: a page that marked both
    // or neither would be useless on exactly the day this matters.
    //
    // The mark is found by its word rather than by the class it is drawn with.
    // That class is a small pill, and the page carries a second one now — the
    // note beside the address saying nobody has confirmed it — so the class
    // stopped being the name of one thing on this page. It is still spelled
    // differently enough that the old assertion would pass; what changed is
    // that it would be passing by accident.
    expect(rows.filter((row) => row.includes(">test<"))).toHaveLength(1);
  });

  it("says nothing about test money when none of it was a test", () => {
    const receipts: ReceiptList = ReceiptListSchema.parse({
      receipts: [receipt("rcp_1", false)],
    });
    const orders: OrderList = OrderListSchema.parse({ orders: [order("ord_1", false)] });

    const onReceipts = readable(receiptsScreen(SEEN_BY, cards, receipts));
    const onOrders = readable(ordersScreen(SEEN_BY, cards, orders, false));

    expect(onReceipts).not.toContain("test purchase");
    expect(onOrders).not.toContain("test purchase");
    expect(receiptsScreen(SEEN_BY, cards, receipts)).not.toContain(">test<");
  });
});
