import { describe, expect, it } from "vitest";
import { isSandboxFacilitator, loadConfig, SANDBOX_FACILITATOR } from "./config.js";

const database = "postgres://coinslot:secret@localhost:5432/coinslot";

/** The two variables that have no sensible default and must always be given. */
const required = { DATABASE_URL: database, MERCHANT_API_KEY: "a-merchant-key-long-enough" };

describe("loadConfig", () => {
  it("reads the environment and fills in the sandbox defaults", () => {
    const config = loadConfig(required);

    expect(config.databaseUrl).toBe(database);
    expect(config.merchantApiKey).toBe("a-merchant-key-long-enough");
    expect(config.port).toBe(3000);

    expect(loadConfig({ ...required, PORT: "8080" }).port).toBe(8080);
  });

  it("carries every deadline the order machine asks for, and none of them is invented in code", () => {
    // The promise: an engineer changing how long the gateway waits for anything
    // changes an environment variable, and never a number buried in a source
    // file. The machine takes its policy from here, so a number missing from
    // this object is a number somebody would have had to guess further down.
    const { deadlines, redelivery } = loadConfig(required);

    expect(deadlines).toStrictEqual({
      quoteResponseMs: 5_000,
      quoteTtlMs: 30_000,
      settleResponseMs: 2_000,
      syncResponseMs: 8_000,
      syncBudgetMs: 10_000,
      paymentAfterConfirmationMs: 300_000,
      defaultConfirmationResponseMs: 3_600_000,
      defaultAsyncFulfillmentMs: 86_400_000,
      handlerAnswerMs: 3_000,
    });
    const config = loadConfig(required);
    expect(config.reminderAttempts).toBe(3);
    expect(config.reminderRetryDelayMs).toBe(5_000);
    expect(config.settleInFlightRetryMs).toBe(1_000);
    expect(config.claimRetentionMs).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(config.paymentWordsKept).toBe(20);

    expect(redelivery).toStrictEqual({
      baseDelayMs: 500,
      factor: 2,
      maxDelayMs: 30_000,
      maxAttempts: 5,
    });
  });

  it("takes every deadline from the environment when it is given one", () => {
    const config = loadConfig({
      ...required,
      QUOTE_RESPONSE_MS: "1000",
      QUOTE_TTL_MS: "2000",
      SETTLE_RESPONSE_MS: "3000",
      SYNC_RESPONSE_MS: "4000",
      SYNC_BUDGET_MS: "9000",
      PAYMENT_AFTER_CONFIRMATION_MS: "5000",
      DEFAULT_CONFIRMATION_RESPONSE_MS: "6000",
      DEFAULT_ASYNC_FULFILLMENT_MS: "7000",
      HANDLER_ANSWER_MS: "1500",
      REDELIVERY_BASE_DELAY_MS: "10",
      REDELIVERY_FACTOR: "3",
      REDELIVERY_MAX_DELAY_MS: "100",
      REDELIVERY_MAX_ATTEMPTS: "9",
    });

    expect(config.deadlines.quoteResponseMs).toBe(1000);
    expect(config.deadlines.quoteTtlMs).toBe(2000);
    expect(config.deadlines.settleResponseMs).toBe(3000);
    expect(config.deadlines.syncResponseMs).toBe(4000);
    expect(config.deadlines.syncBudgetMs).toBe(9000);
    expect(config.deadlines.paymentAfterConfirmationMs).toBe(5000);
    expect(config.deadlines.defaultConfirmationResponseMs).toBe(6000);
    expect(config.deadlines.defaultAsyncFulfillmentMs).toBe(7000);
    expect(config.deadlines.handlerAnswerMs).toBe(1500);
    expect(config.redelivery).toStrictEqual({
      baseDelayMs: 10,
      factor: 3,
      maxDelayMs: 100,
      maxAttempts: 9,
    });
  });

  it("carries the worker window and the payment settings", () => {
    const config = loadConfig(required);

    expect(config.worker).toStrictEqual({ pollWaitMs: 25_000, pollMaxEnvelopes: 32 });
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
    expect(config.payment).toStrictEqual({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      timeoutSeconds: 300,
      payTo: null,
      cdpApiKeyId: null,
      cdpApiKeySecret: null,
    });

    const live = loadConfig({
      ...required,
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      PAYMENT_NETWORK: "eip155:8453",
      PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001",
      CDP_API_KEY_ID: "key-id",
      CDP_API_KEY_SECRET: "key-secret",
    });

    expect(live.payment).toStrictEqual({
      facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
      network: "eip155:8453",
      timeoutSeconds: 300,
      payTo: "0x0000000000000000000000000000000000000001",
      cdpApiKeyId: "key-id",
      cdpApiKeySecret: "key-secret",
    });
  });

  it("takes one address that means the sandbox, and tells it from a real one", () => {
    // The promise: a local stack completes a purchase with no chain behind it,
    // and a deployment that names a real facilitator cannot also be pretending.
    // One field holds one value, so the two cannot be held at once — there is
    // no flag beside the address to be left set from yesterday (ADR-0008).
    expect(isSandboxFacilitator(loadConfig(required).payment.facilitatorUrl)).toBe(false);

    const sandbox = loadConfig({ ...required, FACILITATOR_URL: SANDBOX_FACILITATOR });
    expect(sandbox.payment.facilitatorUrl).toBe(SANDBOX_FACILITATOR);
    expect(isSandboxFacilitator(sandbox.payment.facilitatorUrl)).toBe(true);

    // A near miss is a refusal at startup rather than a real address that
    // quietly does not exist.
    expect(() => loadConfig({ ...required, FACILITATOR_URL: "sandbox:scripted-ish" })).toThrowError(
      /FACILITATOR_URL/,
    );
  });

  it("refuses the sandbox beside a real facilitator's credentials", () => {
    // The mistake this catches is a production environment file copied onto a
    // sandbox. Those credentials exist only to talk to a real facilitator, so
    // beside an address that settles against nothing they are somebody's
    // leftovers rather than a choice (ADR-0008).
    const sandbox = { ...required, FACILITATOR_URL: SANDBOX_FACILITATOR };

    expect(() => loadConfig({ ...sandbox, CDP_API_KEY_ID: "key-id" })).toThrowError(/CDP_API_KEY/);
    expect(() => loadConfig({ ...sandbox, CDP_API_KEY_SECRET: "secret" })).toThrowError(
      /CDP_API_KEY/,
    );

    // An address to be paid at is not the same signal and is not refused: the
    // challenge cannot be built without one, so a sandbox that rejected it
    // could not sell anything at all. Nothing ever arrives there.
    expect(() =>
      loadConfig({ ...sandbox, PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" }),
    ).not.toThrow();
  });

  it("does not let it start, names every problem at once and tells absent from wrong", () => {
    // The promise to the engineer: the whole list of what is missing arrives in
    // one go rather than one variable per restart, and "not set" sounds
    // different from "set wrong".
    const bothBroken = () => loadConfig({ PORT: "not a number" });
    expect(bothBroken).toThrowError(/DATABASE_URL: the variable is not set/);
    expect(bothBroken).toThrowError(/MERCHANT_API_KEY: the variable is not set/);
    expect(bothBroken).toThrowError(/PORT: must be a whole number/);

    expect(() =>
      loadConfig({ ...required, DATABASE_URL: "mysql://localhost/coinslot" }),
    ).toThrowError(/DATABASE_URL: must be an address of the form postgres/);
    expect(() => loadConfig({ ...required, PORT: "70000" })).toThrowError(
      /PORT: must be within the range/,
    );
  });

  it("refuses an address the money could not reach", () => {
    // It goes straight into the challenge that invites an agent to pay it, so a
    // truncated paste would invite them to pay nobody.
    expect(() => loadConfig({ ...required, PAY_TO_ADDRESS: "0xdeadbee" })).toThrowError(
      /PAY_TO_ADDRESS is "0xdeadbee", which is not an address on eip155:84532/,
    );
    expect(() =>
      loadConfig({ ...required, PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" }),
    ).not.toThrow();
  });

  it("refuses a chain that is not written the way the protocol writes one", () => {
    // A network name from version one of the protocol looks harmless and is a
    // different string from the one the asset table is keyed by, so a challenge
    // built from it would name an asset that is not there.
    expect(() => loadConfig({ ...required, PAYMENT_NETWORK: "base-sepolia" })).toThrowError(
      /PAYMENT_NETWORK: must be a CAIP-2 chain such as eip155:84532/,
    );
  });

  it("refuses a merchant key too short to be worth comparing", () => {
    expect(() => loadConfig({ ...required, MERCHANT_API_KEY: "short" })).toThrowError(
      /MERCHANT_API_KEY: must be at least 16 characters/,
    );
  });

  it("refuses a deadline that is not a whole number of milliseconds above zero", () => {
    expect(() => loadConfig({ ...required, QUOTE_RESPONSE_MS: "0" })).toThrowError(
      /QUOTE_RESPONSE_MS: must be a whole number of milliseconds above zero/,
    );
    expect(() => loadConfig({ ...required, SETTLE_RESPONSE_MS: "1.5" })).toThrowError(
      /SETTLE_RESPONSE_MS: must be a whole number of milliseconds above zero/,
    );
    expect(() => loadConfig({ ...required, REDELIVERY_MAX_ATTEMPTS: "-1" })).toThrowError(
      /REDELIVERY_MAX_ATTEMPTS: must be a whole number above zero/,
    );
    expect(() => loadConfig({ ...required, REDELIVERY_FACTOR: "0.5" })).toThrowError(
      /REDELIVERY_FACTOR: must be at least 1/,
    );
  });

  it("refuses a synchronous budget the two waits inside it do not fit into", () => {
    // The composition of `docs/research/16-order-state-machine.md`: the agent's
    // worst case in the synchronous mode is the merchant's answer plus the
    // charge, and the portal promises the agent one ceiling. A configuration
    // whose parts do not fit inside that ceiling breaks the promise on the
    // first slow sale rather than at startup, so it is refused here.
    expect(() =>
      loadConfig({ ...required, SYNC_RESPONSE_MS: "9000", SETTLE_RESPONSE_MS: "2000" }),
    ).toThrowError(
      /the synchronous budget is 10000ms and the answer \(9000ms\) and the charge \(2000ms\) inside it come to 11000ms/,
    );

    // Exactly filling it is allowed: the sum is the worst case, not a target.
    expect(() =>
      loadConfig({ ...required, SYNC_RESPONSE_MS: "8000", SETTLE_RESPONSE_MS: "2000" }),
    ).not.toThrow();
  });

  it("refuses a price wait that leaves the merchant no time to deliver", () => {
    // The synchronous deadline runs from the purchase itself, so the wait for
    // the price is spent out of it. A price wait as long as the whole answer
    // leaves nothing behind it, and every synchronous sale of a card with a
    // price check would run out of time however fast the merchant answered.
    expect(() =>
      loadConfig({ ...required, QUOTE_RESPONSE_MS: "8000", SYNC_RESPONSE_MS: "8000" }),
    ).toThrowError(
      /the wait for the merchant's price is 8000ms out of the 8000ms synchronous answer, which leaves nothing to deliver in/,
    );
  });

  it("names both arithmetic problems at once when both are wrong", () => {
    const broken = () =>
      loadConfig({
        ...required,
        QUOTE_RESPONSE_MS: "9000",
        SYNC_RESPONSE_MS: "9000",
        SETTLE_RESPONSE_MS: "5000",
        SYNC_BUDGET_MS: "10000",
      });

    expect(broken).toThrowError(/the synchronous budget is 10000ms/);
    expect(broken).toThrowError(/the wait for the merchant's price is 9000ms/);
  });
});
