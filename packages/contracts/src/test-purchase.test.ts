import { describe, expect, it } from "vitest";
import { schemas } from "./index.js";
import {
  TEST_PURCHASE_OUTCOMES,
  TEST_PURCHASE_STEPS,
  TestPurchaseSchema,
  TestPurchaseStepSchema,
} from "./test-purchase.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const step = {
  step: "price",
  ok: true,
  address: "https://test.coinslot.nuanu.ai/x402/itm_4d21bb/purchase",
  said: "payment required",
};

const walked = {
  outcome: "delivered",
  steps: [
    {
      step: "catalog",
      ok: true,
      address: "https://test.coinslot.nuanu.ai/x402/catalog",
      said: "the card is in the catalog an agent reads",
    },
    step,
    {
      step: "payment",
      ok: true,
      address: "https://test.coinslot.nuanu.ai/x402/itm_4d21bb/purchase",
      said: "the payment went through and the order came back delivered",
    },
    {
      step: "delivery",
      ok: true,
      address: "https://test.coinslot.nuanu.ai/x402/orders/ord_7c1e05/status",
      said: "the goods are the buyer's",
    },
  ],
  order_id: "ord_7c1e05",
  delivered: { access_code: "SESAME" },
};

describe("one step of a test purchase", () => {
  it("names the step, whether it got what it was for, where it went and what came back", () => {
    // All four are what a merchant reads off a failed walk: which step, that it
    // failed, the address a stranger's agent would have called, and the words.
    expect(TestPurchaseStepSchema.parse(step)).toStrictEqual(step);
  });

  for (const field of ["step", "ok", "address", "said"]) {
    it(`refuses a step without ${field} and names it`, () => {
      expectMissingFieldRejected(TestPurchaseStepSchema, step, field);
    });
  }

  it("refuses a step with no words in it", () => {
    // The rule the refusal envelope keeps, kept here for the same reason: a
    // step that failed and says nothing leaves the merchant a flag and no
    // reason, which is the one thing this whole document exists to avoid.
    expect(errorOf(TestPurchaseStepSchema, { ...step, said: "  " })).toContain("said");
  });

  it("refuses an address that is not one a buyer could have called", () => {
    // The point of carrying the address at all is that it is the public
    // storefront's — a path with no host in front of it would prove nothing
    // about which door the walk went through.
    expect(errorOf(TestPurchaseStepSchema, { ...step, address: "/x402/catalog" })).toContain(
      "address",
    );
  });

  it("takes the four steps of the walk and no others", () => {
    expect([...TEST_PURCHASE_STEPS]).toStrictEqual(["catalog", "price", "payment", "delivery"]);
    expect(TestPurchaseStepSchema.safeParse({ ...step, step: "refund" }).success).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(TestPurchaseStepSchema, { ...step, status: 402 })).toContain("status");
  });
});

describe("what a test purchase came to", () => {
  it("carries the walk, the order it made and the goods that came back", () => {
    expect(TestPurchaseSchema.parse(walked)).toStrictEqual(walked);
  });

  it("has one word for each of the three things a walk can come to", () => {
    // Three different next moves for the merchant: nothing, deliver the order
    // your worker took on, or read the steps and fix what stopped it.
    expect([...TEST_PURCHASE_OUTCOMES]).toStrictEqual(["delivered", "accepted", "stopped"]);
    expect(TestPurchaseSchema.safeParse({ ...walked, outcome: "in_progress" }).success).toBe(false);
  });

  it("says where a walk stopped and carries no order where none was opened", () => {
    // The whole promise of the shape: a walk that did not finish is a document
    // rather than a 500, and the last step it took is where it stopped.
    const stopped = {
      outcome: "stopped",
      steps: [
        {
          step: "catalog",
          ok: false,
          address: "https://test.coinslot.nuanu.ai/x402/catalog",
          said: "the card is not in the catalog an agent reads",
        },
        {
          step: "price",
          ok: false,
          address: "https://test.coinslot.nuanu.ai/x402/itm_4d21bb/purchase",
          said: "this product is not on sale at the moment",
        },
      ],
      order_id: null,
      delivered: null,
    };

    expect(TestPurchaseSchema.parse(stopped)).toStrictEqual(stopped);
  });

  for (const field of ["outcome", "steps", "order_id", "delivered"]) {
    it(`refuses a walk without ${field} and names it`, () => {
      expectMissingFieldRejected(TestPurchaseSchema, walked, field);
    });
  }

  it("refuses a walk that took no step at all", () => {
    // A document with an empty list says a purchase was walked and names
    // nothing that happened, which is a claim with no evidence under it.
    expect(errorOf(TestPurchaseSchema, { ...walked, steps: [] })).toContain("steps");
  });

  it("holds every step in the list to the same shape", () => {
    expect(
      TestPurchaseSchema.safeParse({ ...walked, steps: [{ step: "price", ok: true }] }).success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(TestPurchaseSchema, { ...walked, receipt_id: "rct_1" })).toContain("receipt_id");
  });

  it("says in the exported document that this walk only ever spends test money", () => {
    // The fifth gate on the one artifact a merchant will screenshot. Every
    // other document of this contract that reports on a purchase carries a
    // word for whether the money was real; this one carries none, because the
    // call that produces it is refused outright where the money is real — and
    // a reader of the document alone has to be told that rather than left to
    // infer it.
    const description = schemas.test_purchase.meta()?.description ?? "";

    expect(description).toContain("test money");
  });

  it("is published, so a reader outside TypeScript can see what comes back", () => {
    expect(schemas.test_purchase).toBe(TestPurchaseSchema);
  });
});
