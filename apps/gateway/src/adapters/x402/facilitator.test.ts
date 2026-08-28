import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import {
  FacilitatorTimeoutError,
  type PaymentPayload,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
  type SupportedResponse,
  VerifyError,
  type VerifyResponse,
} from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { PaymentEdge } from "../../http/x402.js";
import type { Charge } from "../../ports/facilitator.js";
import { X402Facilitator } from "./facilitator.js";

/** The address the merchant behind these charges is paid at. */
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
  payTo: PAY_TO,
});

/** A payment made against exactly what this gateway would have asked for. */
const honest = (overrides: Partial<PaymentRequirements> = {}): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      ...edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
      ...overrides,
    },
    payload: { signature: "0xsigned" },
  });

/**
 * A payment made against a different order of ours, correct in every other
 * respect: same price, same asset, same chain, same address.
 */
const forOrder = (orderId: string): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, orderId, PAY_TO),
    payload: { signature: "0xsigned" },
  });

/**
 * A payment naming no offer at all. The decoder is a base64 JSON parse with no
 * schema behind it, so a header shaped like this really does arrive; the cast
 * is what it takes to write down a value the type forbids and the wire allows.
 */
const namesNoOffer = (): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    payload: { signature: "0xsigned" },
  } as unknown as PaymentPayload);

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

    // All five of these refusals carry the same coarse reason, because the
    // machine has three of them and none is a better fit. The message is the
    // only place that says which offer was wrong, so it is what the test reads.
    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "the payment was made out to a different address from the one asked for",
    });
    expect(client.asked).toStrictEqual([]);
  });

  it("checks the payment against the merchant's address rather than the gateway's own", async () => {
    // The address in the requirements comes from the charge, which reads it off
    // the order's own merchant, and never from this gateway's configuration.
    // Read from the configuration, every sale on a deployment with several
    // merchants would be checked against one address and only one of them would
    // ever be paid — and it would be the operator.
    const theirs = "0x27b1fdb04752bbc536007a920d24acb045561c26";
    const paidToThem = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", theirs),
      payload: { signature: "0xsigned" },
    });
    const client = new Answering();

    const answered = await new X402Facilitator(client, edge).verify({
      orderId: "ord_1",
      amount: "80.00",
      currency: "USD",
      payment: paidToThem,
      payTo: theirs,
    });

    expect(answered).toStrictEqual({ verified: true, payer: "0xpayer" });
    expect(client.asked[0]?.requirements.payTo).toBe(theirs);
    // And the same payment on a charge naming a different merchant's address is
    // refused, which is what makes the assertion above about this merchant
    // rather than about any address at all.
    expect(
      await new X402Facilitator(new Answering(), edge).verify(charge(paidToThem)),
    ).toMatchObject({
      verified: false,
      message: "the payment was made out to a different address from the one asked for",
    });
  });

  it("refuses a payment made in another asset or on another chain", async () => {
    // The price matches to the digit and the money still goes somewhere else:
    // the same number of a token nobody agreed on, or the right token on a
    // chain we do not settle on.
    const wrongAsset = new Answering();
    const wrongChain = new Answering();
    const message =
      "the payment was made in a different asset or on a different chain from the one asked for";

    expect(
      await new X402Facilitator(wrongAsset, edge).verify(
        charge(honest({ asset: "0x00000000000000000000000000000000000000aa" })),
      ),
    ).toStrictEqual({ verified: false, reason: "price_stale", message });

    expect(
      await new X402Facilitator(wrongChain, edge).verify(charge(honest({ network: "eip155:1" }))),
    ).toStrictEqual({ verified: false, reason: "price_stale", message });

    expect(wrongAsset.asked).toStrictEqual([]);
    expect(wrongChain.asked).toStrictEqual([]);
  });

  it("refuses a payment signed for one order and presented on another", async () => {
    // Two orders of ours at the same price make one offer indistinguishable
    // from the other everywhere except in the order it names. What stops one
    // signed authorisation from buying both is the claim taken on the payment
    // before any of this runs, not this branch; what this branch stops is a
    // payment for somebody else's order being carried to the facilitator as
    // though it were for this one.
    const client = new Answering();
    const answered = await new X402Facilitator(client, edge).verify(charge(forOrder("ord_2")));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "the payment was made against a different order from the one it was presented for",
    });
    expect(client.asked).toStrictEqual([]);
  });

  it("refuses a payment that names no offer to check against", async () => {
    const client = new Answering();
    const answered = await new X402Facilitator(client, edge).verify(charge(namesNoOffer()));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "the payment names no offer, so there is nothing to check it against",
    });
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

  it("tells a payment it could not read from a sale it cannot ask about", async () => {
    // Two different facts, and everything about what happens next turns on
    // which one it is. A payment that will not decode is the payer's to fix and
    // is refused for good. A charge this gateway cannot even put a question
    // about — a merchant with nowhere to be paid, a currency it cannot charge
    // in — is ours, and the payment presented for it may be perfectly good. Told
    // it "could not be read as a payment at all", an agent goes looking through
    // a payment with nothing wrong with it.
    const client = new Answering();

    const answered = await new X402Facilitator(client, edge).verify({
      ...charge(honest()),
      payTo: null,
    });

    expect(answered.verified).toBe("unknown");
    expect(answered).toMatchObject({
      message: expect.stringContaining("nowhere to send the money"),
    });
    // And nothing reached the facilitator, because there was no question to put
    // to it: what is missing is on our side of the call.
    expect(client.asked).toHaveLength(0);
  });

  it("says what is actually wrong when a charge cannot be built at all", async () => {
    // The same seam on the executing side. Whoever reads this out of a log is
    // looking at an order whose money never moved, and "the payment cannot be
    // read" would send them to the payment rather than to the merchant's
    // settings.
    const facilitator = new X402Facilitator(new Answering(), edge);

    await expect(facilitator.settle({ ...charge(honest()), payTo: null })).rejects.toThrow(
      /nowhere to send the money/,
    );
    // And a payment that really cannot be read still says so.
    await expect(facilitator.settle(charge("not base64"))).rejects.toThrow(/cannot be read/);
  });

  it("reads a verdict the facilitator sent with a refusing status as a verdict", async () => {
    // A facilitator may answer "this payment is invalid, and here is why" with
    // a 4xx rather than a 200, and the client turns that into a throw. Reported
    // as "nobody knows", a refusal the facilitator was perfectly clear about
    // becomes a purchase that hangs waiting for an answer that already came —
    // and the agent is never told the thing it could act on.
    const answered = await new X402Facilitator(
      new Answering({
        verify: new VerifyError(400, {
          isValid: false,
          invalidReason: "invalid_exact_evm_payload_authorization_value",
          invalidMessage: "the authorised amount is not the amount asked for",
        } as VerifyResponse),
      }),
      edge,
    ).verify(charge(honest()));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "the authorised amount is not the amount asked for",
    });
  });

  it("keeps a verdict carried by a broken facilitator as no verdict at all", async () => {
    // The same shape arriving with a 500 is not the same news. A facilitator
    // answering out of its own failure has not judged the payment, and telling
    // an agent its payment is bad on that evidence costs it a sale it could
    // have made by asking again a moment later.
    const answered = await new X402Facilitator(
      new Answering({
        verify: new VerifyError(500, {
          isValid: false,
          invalidReason: "internal_error",
        } as VerifyResponse),
      }),
      edge,
    ).verify(charge(honest()));

    expect(answered).toMatchObject({ verified: "unknown" });
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

  it("reads a charge the facilitator refused outright as a charge that did not happen", async () => {
    // A 4xx carrying the facilitator's own settlement verdict is the request
    // turned away before any money moved — the spike met one of these,
    // `self_send_not_allowed`, where the facilitator will not send a payer's
    // money to the payer. Held as "unknown" it would park the order waiting for
    // an answer that has already arrived, and somebody would reconcile a charge
    // that was never attempted.
    const answered = await new X402Facilitator(
      new Answering({
        settle: new SettleError(400, {
          success: false,
          transaction: "",
          network: "eip155:84532",
          errorReason: "self_send_not_allowed",
        } as SettleResponse),
      }),
      edge,
    ).settle(charge(honest()));

    expect(answered).toStrictEqual({ settled: false, reason: "self_send_not_allowed" });
  });

  it("keeps a charge a broken facilitator could not report on as unknown", async () => {
    // This is the branch above with the one difference that decides money. A
    // facilitator failing inside itself may have moved the money before it
    // fell over, so the same body under a 500 is not a verdict, and a gateway
    // that read it as one would tell a buyer his purchase did not happen while
    // his money was on its way.
    const answered = await new X402Facilitator(
      new Answering({
        settle: new SettleError(503, {
          success: false,
          transaction: "",
          network: "eip155:84532",
          errorReason: "unexpected_settle_error",
        } as SettleResponse),
      }),
      edge,
    ).settle(charge(honest()));

    expect(answered).toMatchObject({ settled: "unknown" });
  });

  it("keeps a charge that ran out of time as unknown, however the clock reports it", async () => {
    // The protocol says this outright: a client-side timeout on settle is
    // indeterminate, because the facilitator may have completed the settlement
    // after the client stopped waiting. It is the one case the branch above
    // must never swallow, so it is pinned with the library's own timeout rather
    // than a plain error.
    const answered = await new X402Facilitator(
      new Answering({ settle: new FacilitatorTimeoutError("settle", 30_000) }),
      edge,
    ).settle(charge(honest()));

    expect(answered).toMatchObject({ settled: "unknown" });
  });
});
