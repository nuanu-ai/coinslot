import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { PaymentEdge } from "../../http/x402.js";
import type { Charge } from "../../ports/facilitator.js";
import { X402Facilitator } from "./facilitator.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

const edge = new PaymentEdge(
  {
    facilitatorUrl: "https://x402.org/facilitator",
    network: "eip155:84532",
    timeoutSeconds: 300,
    payTo: PAY_TO,
    cdpApiKeyId: null,
    cdpApiKeySecret: null,
  },
  "https://coinslot.example",
  300,
);

/** A facilitator that answers what a test tells it to, and records what it was asked. */
class Answering implements FacilitatorClient {
  readonly asked: { payload: PaymentPayload; requirements: PaymentRequirements }[] = [];

  constructor(
    private readonly verdicts: {
      verify?: VerifyResponse | Error;
      settle?: SettleResponse | Error;
    } = {},
  ) {}

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.asked.push({ payload, requirements });
    const answer = this.verdicts.verify ?? { isValid: true, payer: "0xpayer" };
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.asked.push({ payload, requirements });
    const answer =
      this.verdicts.settle ??
      ({ success: true, transaction: "0xtx", network: "eip155:84532" } as SettleResponse);
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [], extensions: [], signers: {} };
  }
}

const charge = (payment: string): Charge => ({
  orderId: "ord_1",
  amount: "80.00",
  currency: "USD",
  payment,
});

/** A payment made against exactly what this gateway would have asked for. */
const honest = (overrides: Partial<PaymentRequirements> = {}): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      ...edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1"),
      ...overrides,
    },
    payload: { signature: "0xsigned" },
  });

describe("verifying a payment", () => {
  it("checks it against the price this gateway issued, not the one the payment names", async () => {
    // The requirements handed to the facilitator are rebuilt from our own
    // order. A payment made against a price the agent chose is checked against
    // ours and never reaches the facilitator at all.
    const client = new Answering();
    const facilitator = new X402Facilitator(client, edge);

    const answered = await facilitator.verify(charge(honest({ amount: "1" })));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "this order is priced at 80000000 and the payment was made for 1",
    });
    expect(client.asked).toStrictEqual([]);
  });

  it("refuses a payment made out to somebody else", async () => {
    const client = new Answering();
    const answered = await new X402Facilitator(client, edge).verify(
      charge(honest({ payTo: "0x00000000000000000000000000000000000000ff" })),
    );

    expect(answered).toMatchObject({ verified: false, reason: "price_stale" });
    expect(client.asked).toStrictEqual([]);
  });

  it("passes an honest payment through and reports who paid", async () => {
    const client = new Answering();
    const answered = await new X402Facilitator(client, edge).verify(charge(honest()));

    expect(answered).toStrictEqual({ verified: true, payer: "0xpayer" });
    expect(client.asked[0]?.requirements.amount).toBe("80000000");
  });

  it("keeps what the facilitator actually said, and picks the nearest of the machine's three reasons", async () => {
    // The facilitator's set of reasons is open and grows; the machine's is
    // three. The record is a little coarser than what happened and never wrong
    // about whether the payment was refused.
    const cases: [string, string][] = [
      ["invalid_exact_evm_payload_signature", "signature"],
      ["invalid_payload: contract call failed / execution reverted", "insufficient_funds"],
      ["invalid_exact_evm_payload_authorization_value", "price_stale"],
      ["something nobody has seen before", "signature"],
    ];

    for (const [said, expected] of cases) {
      const answered = await new X402Facilitator(
        new Answering({ verify: { isValid: false, invalidReason: said } }),
        edge,
      ).verify(charge(honest()));

      expect(answered).toStrictEqual({ verified: false, reason: expected, message: said });
    }
  });

  it("says nobody knows when the facilitator could not be asked", async () => {
    const answered = await new X402Facilitator(
      new Answering({ verify: new Error("the facilitator timed out") }),
      edge,
    ).verify(charge(honest()));

    expect(answered).toStrictEqual({ verified: "unknown", message: "the facilitator timed out" });
  });

  it("refuses something that is not a payment at all", async () => {
    const answered = await new X402Facilitator(new Answering(), edge).verify(charge("not base64"));
    expect(answered).toMatchObject({ verified: false, reason: "signature" });
  });
});

describe("executing a charge", () => {
  it("hands back the transaction the payment layer named", async () => {
    const answered = await new X402Facilitator(new Answering(), edge).settle(charge(honest()));
    expect(answered).toStrictEqual({ settled: true, transaction: "0xtx" });
  });

  it("says the charge failed when the payment layer says so", async () => {
    const answered = await new X402Facilitator(
      new Answering({
        settle: {
          success: false,
          transaction: "",
          network: "eip155:84532",
          errorReason: "insufficient_funds",
        } as SettleResponse,
      }),
      edge,
    ).settle(charge(honest()));

    expect(answered).toStrictEqual({ settled: false, reason: "insufficient_funds" });
  });

  it("says nobody knows when the charge went out and nothing came back", async () => {
    // The protocol's own account: a timeout on settle is an indeterminate
    // outcome, because the facilitator may have completed it. Reporting that as
    // a failure is how a buyer gets told his purchase did not happen while his
    // money is on its way.
    const answered = await new X402Facilitator(
      new Answering({ settle: new Error("the facilitator timed out") }),
      edge,
    ).settle(charge(honest()));

    expect(answered).toStrictEqual({ settled: "unknown", reason: "the facilitator timed out" });
  });
});
