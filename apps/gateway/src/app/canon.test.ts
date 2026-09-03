import { CatalogPageSchema, PublishResultSchema } from "@nuanu-ai/coinslot-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness } from "../testing/harness.js";

// ADR-0017 promises two halves. The schema keeps one at the door: a short
// spelling opens out into the canonical card at parse. This file keeps the
// other half, which no schema can: that the gateway stored what came through
// the door rather than what arrived at it, and that an agent is shown the
// same. If publish ever writes its raw input, or the catalog ever serves
// one, this goes red.

let open: Harness | null = null;
afterEach(async () => {
  await open?.stop();
  open = null;
});

const SHORT = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: "80.00 USD",
  result: { access_code: "string" },
};

const publishedShort = async (harnessed: Harness): Promise<string> => {
  const result = await harnessed.gateway.publishCard(harnessed.merchant.id, SHORT);
  expect(PublishResultSchema.safeParse(result).success).toBe(true);
  if (!result.ok) throw new Error(`publishing failed: ${JSON.stringify(result.error.problems)}`);
  return result.id;
};

describe("the canon behind the door", () => {
  it("stores the card the door opened out, not the spelling that arrived", async () => {
    open = await harness();
    const itemId = await publishedShort(open);

    const stored = await open.store.cardById(itemId);

    expect(stored?.card.price).toStrictEqual({ amount: "80.00", currency: "USD" });
    expect(stored?.card.result).toStrictEqual({ access_code: { type: "string" } });
    expect(stored?.card.fulfillment).toBe("sync");
  });

  it("shows an agent the canon, whatever spelling the merchant wrote", async () => {
    open = await harness();
    await publishedShort(open);

    const page = CatalogPageSchema.parse(await open.gateway.catalog());

    expect(page.items[0]?.price).toStrictEqual({ amount: "80.00", currency: "USD" });
    expect(JSON.stringify(page)).not.toContain("80.00 USD");
  });
});
