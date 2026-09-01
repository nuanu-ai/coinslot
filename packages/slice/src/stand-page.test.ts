/**
 * The one claim on these pages that is about money.
 *
 * Everything else the console draws is a convenience, and a test that pinned
 * its wording would be pinning prose. This is different: the stand signs real
 * payments, the only thing here that names an environment is the prefix of the
 * key somebody typed, and the page has to keep three answers apart — real money,
 * test money, and not knowing. The sentence is the promise, so the sentence is
 * what these check.
 */

import { describe, expect, it } from "vitest";
import { type PageState, renderPage } from "./stand-page.js";

const connected = (keyEnvironment: PageState["keyEnvironment"]): string =>
  renderPage({
    tab: "agent",
    address: "http://localhost:8080",
    keyEnvironment,
    said: null,
    entries: [],
    standing: { order: "deliver", quote: "price", held: 0 },
    cards: [],
    selling: "open",
    cardDraft: "{}",
    publicItems: [],
    publicItemsRead: false,
    chosen: null,
    paramsDraft: "{}",
    exchange: null,
    moods: {
      order: "deliver",
      quote: "price",
      deliverAfterMs: 1_000,
      refusal: { code: "cannot_fulfill", message: "not this time" },
      price: { amount: "1.00", currency: "USD" },
    },
    goodsDraft: "",
    held: [],
    owed: [],
    receipts: [],
    receiptsRead: false,
  });

describe("the page a connected operator reads", () => {
  it("warns that a purchase spends real money, and only for a live key", () => {
    expect(connected("live")).toContain("real money");
    expect(connected("test")).not.toContain("real money");
    expect(connected(null)).not.toContain("real money");
  });

  it("says it cannot tell, rather than picking a side, for a key naming neither", () => {
    const page = connected(null);

    expect(page).toContain("cannot say whether money on this gateway is real");
    // "I do not know" has to stay distinguishable from "I know there is none":
    // a page that quietly borrowed the test wording would tell an operator
    // their payments are pretend on a gateway nobody has vouched for.
    expect(page).not.toContain("test funds");
  });
});
