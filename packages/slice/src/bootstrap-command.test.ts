/**
 * The bootstrap purchase, tested without the network and without a wallet.
 *
 * The live path is `pnpm smoke:bootstrap` and nothing here goes near it: a
 * purchase moves real money on a real chain, and a suite that could make one
 * would take `pnpm test` off the free, deterministic, offline footing
 * `vitest.config.ts` puts it on. What is testable here is everything that
 * decides whether a payment happens and what it meant afterwards, and that is
 * the part where a mistake costs somebody money or tells them a lie about it.
 *
 * Four promises are worth more than the rest:
 *
 * The caps hold. A run cannot spend more than it was told to, and the
 * arithmetic is in the token's own units, so a budget is not eaten by the
 * rounding of a float.
 *
 * A payment that cannot list is not made. Paying yourself is refused by the
 * facilitator anyway, and a gateway nothing can crawl cannot be listed however
 * the payment goes — so neither is attempted, and the reason is said out loud.
 *
 * A refusal is read out of the header where it actually lives. In version two
 * the body of a 402 is empty and the verdict is in `PAYMENT-REQUIRED.error`, and
 * a client that does not read it reports a silence as though it were a result.
 *
 * And a settle that a catalog will never see is not reported as a settle. A
 * gateway with no chain behind it answers a purchase exactly as a real one does,
 * receipt and all, and the only thing that gives it away is that the transaction
 * it names is not a transaction.
 *
 * The last block opens a socket, to this process, and stubs the payment.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomicOf,
  type CatalogCard,
  type Challenge,
  couldEverBeListed,
  DISCOVERY_PAGE_SIZE,
  dollarsOf,
  isSelfSend,
  type Outside,
  overTheNetwork,
  type PurchaseOutcome,
  type Reach,
  readSettings,
  runBootstrap,
  type Settings,
  unanswerable,
  whatBecameOfThePayment,
  withinCaps,
} from "./bootstrap-command.js";

/** A public, valueless test key — the first well-known local-devnet account. */
const A_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** The address that key signs as, which the buyer prints and never the key. */
const ITS_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** A merchant's payout address, spelled with the capitals that are its checksum. */
const A_MERCHANT = "0x784D1234567890123456789012345678901234Ac";
const BASE_SEPOLIA = "eip155:84532";
const USDC_ON_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** A hash of the shape a chain produces: 0x and sixty-four hex characters. */
const A_TRANSACTION = `0x${"1e".repeat(32)}`;

const env = (extra: Record<string, string | undefined> = {}) => ({
  COINSLOT_SMOKE: "1",
  GATEWAY_URL: "https://coinslot.example",
  SMOKE_BUYER_KEY: A_KEY,
  ...extra,
});

const aChallenge = (over: Partial<Challenge> = {}): Challenge => ({
  resourceUrl: "https://coinslot.example/v0/items/itm_1/purchase",
  payTo: A_MERCHANT,
  network: BASE_SEPOLIA,
  asset: USDC_ON_BASE_SEPOLIA,
  amount: "10000",
  decimals: 6,
  symbol: "USDC",
  ...over,
});

const aCard = (id: string, params: CatalogCard["params"] = {}): CatalogCard => ({
  id,
  title: "A room for the night",
  params,
});

const settled = (over: Record<string, unknown> = {}): PurchaseOutcome => ({
  kind: "answered",
  status: 200,
  body: { status: "delivered", delivered: { access_code: "abc" } },
  settlement: { success: true, transaction: A_TRANSACTION, ...over },
  facilitatorSaid: { heard: "nothing" },
});

/** A run: what the way out answered, and everything the command said. */
function aRun(options: {
  readonly catalog?: readonly CatalogCard[] | Error;
  readonly challenges?: (itemId: string) => Challenge;
  readonly purchases?: (itemId: string) => PurchaseOutcome;
  /** The catalog as discovery shows it, one entry per walk. */
  readonly walks?: readonly (readonly string[])[];
  readonly buyer?: string;
}) {
  const bought: string[] = [];
  const said: string[] = [];
  const slept: number[] = [];
  let walk = 0;
  let clock = 0;

  const reach: Reach = {
    buyerAddress: options.buyer ?? ITS_ADDRESS,
    catalog: async () => {
      const held = options.catalog ?? [aCard("itm_1")];
      if (held instanceof Error) throw held;
      return held;
    },
    challenge: async (itemId) => options.challenges?.(itemId) ?? aChallenge(),
    purchase: async (itemId) => {
      bought.push(itemId);
      return options.purchases?.(itemId) ?? settled();
    },
    discoveryPage: async (offset) => {
      const shown = options.walks?.[Math.min(walk, (options.walks?.length ?? 1) - 1)] ?? [];
      return offset === 0
        ? { total: shown.length, resources: shown }
        : { total: shown.length, resources: [] };
    },
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
      walk += 1;
    },
    now: () => clock,
  };

  const outside: Outside = () => reach;
  const run = (argv: string[], extra: Record<string, string | undefined> = {}) =>
    runBootstrap(argv, env(extra), outside, (line) => said.push(line));

  return { run, bought, slept, text: () => said.join("\n") };
}

describe("the caps", () => {
  it("lets a purchase priced at exactly the ceiling through", () => {
    // A cap of five cents that refuses a five-cent product is a cap of four, and
    // the person who set it would never find out which one they had.
    expect(
      withinCaps({ price: 50_000n, spent: 0n, max: 50_000n, total: 500_000n, decimals: 6 }).ok,
    ).toBe(true);
  });

  it("refuses a purchase above the ceiling on one purchase, and says what both were", () => {
    const refused = withinCaps({
      price: 60_000n,
      spent: 0n,
      max: 50_000n,
      total: 500_000n,
      decimals: 6,
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.why).toContain("$0.06");
    expect(refused.ok === false && refused.why).toContain("$0.05");
    expect(refused.ok === false && refused.why).toContain("SMOKE_MAX_USD");
  });

  it("refuses the purchase that would take the run past its own ceiling", () => {
    // Each of these is inside the per-purchase cap. What they are not inside is
    // the run, and a command that only ever checked one payment at a time would
    // spend a budget one affordable purchase at a time.
    const room = { price: 40_000n, max: 50_000n, total: 100_000n, decimals: 6 };

    expect(withinCaps({ ...room, spent: 0n }).ok).toBe(true);
    expect(withinCaps({ ...room, spent: 40_000n }).ok).toBe(true);
    expect(withinCaps({ ...room, spent: 80_000n }).ok).toBe(false);
    expect(
      withinCaps({ ...room, spent: 80_000n }).ok === false &&
        withinCaps({ ...room, spent: 80_000n }),
    ).toMatchObject({ why: expect.stringContaining("SMOKE_TOTAL_USD") });
  });

  it("counts in the token's own units rather than in dollars as a number", () => {
    // Three ten-cent purchases against thirty cents. Read as floats,
    // 0.1 + 0.1 + 0.1 is 0.30000000000000004 and the third is refused — a budget
    // eaten by the arithmetic rather than by anything anybody bought.
    const room = { price: 100_000n, max: 100_000n, total: 300_000n, decimals: 6 };

    expect(withinCaps({ ...room, spent: 0n }).ok).toBe(true);
    expect(withinCaps({ ...room, spent: 100_000n }).ok).toBe(true);
    expect(withinCaps({ ...room, spent: 200_000n }).ok).toBe(true);
    expect(withinCaps({ ...room, spent: 300_000n }).ok).toBe(false);
  });

  it("reads a cap in dollars into the token's units, and refuses one finer than the token", () => {
    expect(atomicOf("0.05", 6)).toBe(50_000n);
    expect(atomicOf("1", 6)).toBe(1_000_000n);
    // Six places is what USDC carries; a seventh cannot be charged, and rounding
    // it would be spending a cap nobody set.
    expect(atomicOf("0.0000001", 6)).toBeNull();
    expect(atomicOf("-1", 6)).toBeNull();
    expect(atomicOf("lots", 6)).toBeNull();
  });

  it("writes an amount back out as the dollars it was", () => {
    expect(dollarsOf(50_000n, 6)).toBe("0.05");
    expect(dollarsOf(1_000_000n, 6)).toBe("1");
    expect(dollarsOf(0n, 6)).toBe("0");
    expect(dollarsOf(1n, 6)).toBe("0.000001");
  });
});

describe("what a paid call came to", () => {
  it("reads a settlement with a chain transaction on it as a settle", () => {
    const payment = whatBecameOfThePayment(settled(), BASE_SEPOLIA);

    expect(payment.paid).toBe("settled");
    expect(payment.paid === "settled" && payment.transaction).toBe(A_TRANSACTION);
  });

  it("does not read a settlement against nothing as a settle", () => {
    // The sandbox answers a purchase exactly as a real gateway does — same
    // status, same document, a receipt and all — and its facilitator hands back
    // a counter rather than a hash. Reported as a settle, this would send
    // somebody off to wait half an hour for a listing that was never coming.
    const payment = whatBecameOfThePayment(settled({ transaction: "0xtx1" }), BASE_SEPOLIA);

    expect(payment.paid).toBe("pretend");
    expect(payment.paid === "pretend" && payment.why).toContain("settles against nothing");
  });

  it("does not judge the shape of a transaction on a chain it has never seen", () => {
    // The hash of an EVM chain has one shape and this checks it, because that is
    // the only thing that tells a real settle from a pretend one. On a chain
    // whose hashes it does not know there is no rule to apply, and inventing one
    // would report a working deployment as a sandbox — which is a claim that no
    // money moved, made about somebody's wallet, on nothing.
    const somewhereElse = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

    expect(
      whatBecameOfThePayment(settled({ transaction: "5VfydnLu4r…" }), somewhereElse),
    ).toMatchObject({ paid: "settled" });
    // An empty transaction is not a transaction on any chain.
    expect(whatBecameOfThePayment(settled({ transaction: "  " }), somewhereElse).paid).toBe(
      "pretend",
    );
  });

  it("reads the facilitator's own verdict out of the header when the purchase is refused", () => {
    // The body of a 402 is always {} in version two. A command that read the
    // status alone would report "the gateway answered 402" and nothing more,
    // which is what the spike did for an afternoon.
    const payment = whatBecameOfThePayment(
      {
        kind: "answered",
        status: 402,
        body: {},
        settlement: null,
        facilitatorSaid: { heard: "verdict", error: "self_send_not_allowed" },
      },
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("refused");
    expect(payment.paid === "refused" && payment.why).toContain("self_send_not_allowed");
  });

  it("says a refusal never got as far as the facilitator when no header came back with it", () => {
    const payment = whatBecameOfThePayment(
      {
        kind: "answered",
        status: 500,
        body: {},
        settlement: null,
        facilitatorSaid: { heard: "nothing" },
      },
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("refused");
    expect(payment.paid === "refused" && payment.why).toContain(
      "never got as far as the facilitator",
    );
  });

  it("does not read a header with no reason in it as the facilitator having said nothing", () => {
    // The same header carries "here is the price" and "your payment was
    // rejected, and here is why", and only the reason tells them apart. Folded
    // together, a gateway that answered with a price is reported as a gateway
    // that never reached its facilitator — a claim about somebody else's system
    // made on no evidence.
    const payment = whatBecameOfThePayment(
      {
        kind: "answered",
        status: 402,
        body: {},
        settlement: null,
        facilitatorSaid: { heard: "no reason" },
      },
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("refused");
    expect(payment.paid === "refused" && payment.why).toContain("carried no reason");
    expect(payment.paid === "refused" && payment.why).not.toContain("never got as far");
  });

  it("reads a settlement that failed as a refusal, in its own words", () => {
    const payment = whatBecameOfThePayment(
      settled({ success: false, errorMessage: "contract call failed: execution reverted" }),
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("refused");
    expect(payment.paid === "refused" && payment.why).toContain("execution reverted");
  });

  it("reads the client's own refusal as a refusal rather than as a silence", () => {
    // The payment wrapper throws for what it refuses itself — a spend control, a
    // network it has no scheme for — and returns a quiet 402 for the server's
    // refusal. Two doors, one meaning.
    const payment = whatBecameOfThePayment(
      { kind: "client_refused", why: "no payment requirements matched the spend controls" },
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("refused");
    expect(payment.paid === "refused" && payment.why).toContain("spend controls");
  });

  it("will not call a call that never landed a refusal", () => {
    // The fifth gate. An agent told its purchase did not happen goes and buys
    // the same thing elsewhere without looking at its wallet, and here nobody
    // knows whether the money moved.
    const payment = whatBecameOfThePayment(
      { kind: "unreachable", why: "socket hang up" },
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("unresolved");
    expect(payment.paid === "unresolved" && payment.why).toContain("not known here");
  });

  it("will not call payment_unresolved a settle or a refusal", () => {
    const payment = whatBecameOfThePayment(
      {
        kind: "answered",
        status: 200,
        body: { status: "payment_unresolved" },
        settlement: null,
        facilitatorSaid: { heard: "nothing" },
      },
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("unresolved");
  });

  it("reads an accepted purchase with no receipt as a settle with no transaction to name", () => {
    // A card whose goods come later moves the money as the order is opened, so
    // the settlement was signed onto an exchange that is already over and no
    // receipt rides back on this one. The settle happened; there is nothing here
    // that ever carried its hash, and saying so is not the same as having none.
    const payment = whatBecameOfThePayment(
      {
        kind: "answered",
        status: 200,
        body: { status: "in_progress", order_id: "ord_1" },
        settlement: null,
        facilitatorSaid: { heard: "nothing" },
      },
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("settled");
    expect(payment.paid === "settled" && payment.transaction).toBeNull();
    expect(payment.paid === "settled" && payment.note).toContain("no transaction here to name");
  });

  it("reads an order that closed with nothing charged as a refusal", () => {
    for (const word of ["rejected", "declined", "expired", "cancelled", "delivered_unpaid"]) {
      const payment = whatBecameOfThePayment(
        {
          kind: "answered",
          status: 200,
          body: { status: word },
          settlement: null,
          facilitatorSaid: { heard: "nothing" },
        },
        BASE_SEPOLIA,
      );
      expect(payment.paid, word).toBe("refused");
    }
  });

  it("says nothing is known when an accepted purchase carries no status it can read", () => {
    const payment = whatBecameOfThePayment(
      {
        kind: "answered",
        status: 200,
        body: "<html>ok</html>",
        settlement: null,
        facilitatorSaid: { heard: "nothing" },
      },
      BASE_SEPOLIA,
    );

    expect(payment.paid).toBe("unresolved");
  });
});

describe("the gates in front of a payment", () => {
  it("refuses a resource no catalog could ever fetch", () => {
    // The one thing a local sandbox says about itself on the wire. A gateway
    // with no chain behind it warns in its own log and nowhere else, and the
    // address it pins into every challenge is what is left.
    const refused = couldEverBeListed(
      aChallenge({ resourceUrl: "http://localhost:8080/v0/items/itm_1/purchase" }),
    );

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.why).toContain("not an https address");
  });

  it("lets a public https resource through", () => {
    expect(couldEverBeListed(aChallenge()).ok).toBe(true);
  });

  it("sees a self-send however the two addresses are spelled", () => {
    // EIP-55 capitals are a checksum, not an identity: the facilitator refuses
    // payer == payee whichever way either was typed.
    expect(isSelfSend(ITS_ADDRESS, ITS_ADDRESS.toLowerCase())).toBe(true);
    expect(isSelfSend(` ${ITS_ADDRESS.toUpperCase()} `, ITS_ADDRESS)).toBe(true);
    expect(isSelfSend(A_MERCHANT, ITS_ADDRESS)).toBe(false);
  });

  it("names the parameters a card asks for that the run cannot answer", () => {
    const card = aCard("itm_1", { email: { required: true }, area_code: { required: false } });

    expect(unanswerable(card, {})).toStrictEqual(["email"]);
    expect(unanswerable(card, { email: "buyer@example.com" })).toStrictEqual([]);
  });
});

describe("reading the settings", () => {
  it("refuses a key on the command line rather than using it", () => {
    // ps shows one process's arguments to every user on the machine, so a key
    // typed there is a key handed out. It is refused after the fact, but at
    // least it is not also spent.
    const read = readSettings([A_KEY], env());

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why.join(" ")).toContain("looks like a private key");
  });

  it("refuses a run with no key at all", () => {
    const read = readSettings([], env({ SMOKE_BUYER_KEY: undefined }));

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why.join(" ")).toContain("SMOKE_BUYER_KEY");
    expect(read.ok === false && read.why.join(" ")).toContain("self_send_not_allowed");
  });

  it("refuses a key that is not one, without saying anything about the value", () => {
    const read = readSettings([], env({ SMOKE_BUYER_KEY: "hunter2" }));

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why.join(" ")).not.toContain("hunter2");
  });

  it("refuses a run ceiling below the ceiling on one purchase", () => {
    // Two numbers that contradict each other, and guessing which one was meant
    // is guessing with somebody's money.
    const read = readSettings([], env({ SMOKE_MAX_USD: "1", SMOKE_TOTAL_USD: "0.50" }));

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.why.join(" ")).toContain("below the ceiling on one purchase");
  });

  it("fills in the caps and the wait when nothing says otherwise", () => {
    const read = readSettings([], env());

    expect(read.ok && read.settings.maxUsd).toBe("0.05");
    expect(read.ok && read.settings.totalUsd).toBe("0.50");
    expect(read.ok && read.settings.waitMs).toBe(30 * 60_000);
    expect(read.ok && read.settings.confirm).toBe(false);
  });

  it("takes the answers a card asks for as JSON, and refuses anything else", () => {
    const good = readSettings([], env({ SMOKE_PARAMS: '{"email":"buyer@example.com"}' }));
    expect(good.ok && good.settings.answers).toStrictEqual({ email: "buyer@example.com" });

    expect(readSettings([], env({ SMOKE_PARAMS: "[1,2]" })).ok).toBe(false);
    expect(readSettings([], env({ SMOKE_PARAMS: "{oops" })).ok).toBe(false);
  });

  it("will not run at all without COINSLOT_SMOKE", () => {
    expect(readSettings([], env({ COINSLOT_SMOKE: undefined })).ok).toBe(false);
  });

  it("refuses a gateway address carrying a query or a fragment", () => {
    // A path is joined onto this, so either one lands in the middle of every
    // purchase address — and of the address a listing would be keyed on.
    expect(readSettings([], env({ GATEWAY_URL: "https://coinslot.example/?utm=1" })).ok).toBe(
      false,
    );
    expect(readSettings([], env({ GATEWAY_URL: "https://coinslot.example/#top" })).ok).toBe(false);
  });
});

describe("a whole run", () => {
  it("buys nothing without --confirm, and does not report that as a pass", () => {
    // Zero is reserved for a run where every product it attempted is readable in
    // the catalog. A dry run attempted none.
    const run = aRun({});

    return run.run([]).then((code) => {
      expect(code).toBe(2);
      expect(run.bought).toStrictEqual([]);
      expect(run.text()).toContain("NOTHING was signed");
    });
  });

  it("buys every card in the catalog and reports the one it found in discovery", async () => {
    const resource = "https://coinslot.example/v0/items/itm_1/purchase";
    const run = aRun({
      catalog: [aCard("itm_1")],
      walks: [[resource]],
    });

    expect(await run.run(["--confirm"])).toBe(0);
    expect(run.bought).toStrictEqual(["itm_1"]);
    expect(run.text()).toContain("LISTED");
    expect(run.text()).toContain("spent this run: $0.01");
  });

  it("buys only the product it was named", async () => {
    const run = aRun({ catalog: [aCard("itm_1"), aCard("itm_2")], walks: [[]] });

    await run.run(["itm_2", "--confirm"], { SMOKE_WAIT_MINUTES: "0" });

    expect(run.bought).toStrictEqual(["itm_2"]);
  });

  it("reports a settle the catalog does not show as neither a pass nor a failure of the product", async () => {
    // The verdict that is the whole instrument: the money moved and the listing
    // is not there. Whether that is the catalog being slow or a chain nobody
    // indexes is exactly what is not known, and the report has to say so.
    const run = aRun({ walks: [[]], catalog: [aCard("itm_1")] });

    expect(await run.run(["--confirm"], { SMOKE_WAIT_MINUTES: "0" })).toBe(1);
    expect(run.text()).toContain("SETTLED, NOT YET LISTED");
    expect(run.text()).toContain(A_TRANSACTION);
    expect(run.text()).toContain("proves nothing about the listing");
    expect(run.text()).not.toContain("itm_1: LISTED");
  });

  it("keeps walking until the resource turns up, and says how long it took", async () => {
    const resource = "https://coinslot.example/v0/items/itm_1/purchase";
    const run = aRun({ walks: [[], [], [resource]], catalog: [aCard("itm_1")] });

    expect(await run.run(["--confirm"])).toBe(0);
    // Two waits of two minutes each before the third walk found it.
    expect(run.slept).toStrictEqual([120_000, 120_000]);
    expect(run.text()).toContain("after 4m00s");
  });

  it("does not pay a merchant who is the buyer, and says why", async () => {
    const run = aRun({ challenges: () => aChallenge({ payTo: ITS_ADDRESS }) });

    expect(await run.run(["--confirm"])).toBe(1);
    expect(run.bought).toStrictEqual([]);
    expect(run.text()).toContain("self_send_not_allowed");
    expect(run.text()).toContain("NOT ATTEMPTED");
  });

  it("does not pay a gateway nothing could crawl, and does not call that a refusal", async () => {
    const run = aRun({
      challenges: () =>
        aChallenge({ resourceUrl: "http://localhost:8080/v0/items/itm_1/purchase" }),
    });

    expect(await run.run(["--confirm"])).toBe(1);
    expect(run.bought).toStrictEqual([]);
    expect(run.text()).toContain("NOT ATTEMPTED");
    expect(run.text()).not.toContain("REFUSED");
  });

  it("does not pay for a product priced above the cap", async () => {
    const run = aRun({ challenges: () => aChallenge({ amount: "5000000" }) });

    expect(await run.run(["--confirm"])).toBe(1);
    expect(run.bought).toStrictEqual([]);
    expect(run.text()).toContain("SMOKE_MAX_USD");
  });

  it("stops buying when the run's own ceiling is reached, having bought what fitted", async () => {
    // Four two-cent products against a five-cent run. Two fit, the third does
    // not, and the fourth is not attempted either — a cap that let the cheap one
    // after a refusal through would be a cap on the order of the catalog.
    const run = aRun({
      catalog: [aCard("itm_1"), aCard("itm_2"), aCard("itm_3"), aCard("itm_4")],
      challenges: () => aChallenge({ amount: "20000" }),
      walks: [[]],
    });

    expect(await run.run(["--confirm"], { SMOKE_TOTAL_USD: "0.05", SMOKE_WAIT_MINUTES: "0" })).toBe(
      1,
    );
    expect(run.bought).toStrictEqual(["itm_1", "itm_2"]);
    expect(run.text()).toContain("SMOKE_TOTAL_USD");
    expect(run.text()).toContain("spent this run: $0.04");
  });

  it("refuses a chain where the money is real unless somebody said so out loud", async () => {
    const run = aRun({ challenges: () => aChallenge({ network: "eip155:8453" }) });

    expect(await run.run(["--confirm"])).toBe(1);
    expect(run.bought).toStrictEqual([]);
    expect(run.text()).toContain("SMOKE_ALLOW_MAINNET=1");
  });

  it("buys on a real chain when somebody did", async () => {
    const run = aRun({
      challenges: () => aChallenge({ network: "eip155:8453" }),
      walks: [[]],
    });

    await run.run(["--confirm"], { SMOKE_ALLOW_MAINNET: "1", SMOKE_WAIT_MINUTES: "0" });

    expect(run.bought).toStrictEqual(["itm_1"]);
  });

  it("does not pay an amount it could not read in dollars", async () => {
    // Without decimals there is no dollar amount, so there is nothing to hold
    // against a cap — and a payment whose size nobody checked is the one thing
    // the caps exist to stop.
    const run = aRun({ challenges: () => aChallenge({ decimals: null, symbol: null }) });

    expect(await run.run(["--confirm"])).toBe(1);
    expect(run.bought).toStrictEqual([]);
    expect(run.text()).toContain("no dollar amount");
  });

  it("does not walk the catalog for a purchase that was refused", async () => {
    const run = aRun({
      purchases: () => ({
        kind: "answered",
        status: 402,
        body: {},
        settlement: null,
        facilitatorSaid: {
          heard: "verdict",
          error: "invalid_exact_evm_payload_authorization_value",
        },
      }),
    });

    expect(await run.run(["--confirm"])).toBe(1);
    expect(run.slept).toStrictEqual([]);
    expect(run.text()).toContain("PURCHASE REFUSED");
    expect(run.text()).toContain("invalid_exact_evm_payload_authorization_value");
    expect(run.text()).toContain("spent this run: $0");
  });

  it("counts nothing spent when a settle was against nothing", async () => {
    const run = aRun({ purchases: () => settled({ transaction: "0xtx1" }) });

    expect(await run.run(["--confirm"])).toBe(1);
    expect(run.slept).toStrictEqual([]);
    expect(run.text()).toContain("spent this run: $0");
    expect(run.text()).not.toContain("SETTLED, NOT YET LISTED");
  });

  it("stops the run at the first settle it cannot read rather than buying the rest", async () => {
    // Which facilitator is behind a gateway belongs to the deployment, so the
    // next product would come back the same. It is also what keeps the caps
    // sound: a settle nobody can read is one nobody can count, and a run that
    // went on counting nothing could spend past its own ceiling with the
    // arithmetic none the wiser.
    const run = aRun({
      catalog: [aCard("itm_1"), aCard("itm_2"), aCard("itm_3")],
      purchases: () => settled({ transaction: "0xtx1" }),
    });

    expect(await run.run(["--confirm"])).toBe(1);
    expect(run.bought).toStrictEqual(["itm_1"]);
    expect(run.text()).toContain("the rest of the run was called off");
  });

  it("counts what the settlement says was settled rather than what was quoted", async () => {
    const run = aRun({ purchases: () => settled({ amount: "4000" }), walks: [[]] });

    await run.run(["--confirm"], { SMOKE_WAIT_MINUTES: "0" });

    expect(run.text()).toContain("spent this run: $0.004");
  });

  it("says nothing was bought rather than nothing was wrong when the catalog is empty", async () => {
    const run = aRun({ catalog: [] });

    expect(await run.run(["--confirm"])).toBe(2);
    expect(run.text()).toContain("nothing to bootstrap");
  });

  it("says what it could not read when the catalog will not come back", async () => {
    const run = aRun({ catalog: new Error("connect ECONNREFUSED") });

    expect(await run.run(["--confirm"])).toBe(2);
    expect(run.text()).toContain("ECONNREFUSED");
    expect(run.text()).toContain("Nothing was bought.");
  });

  it("never prints the key", async () => {
    const run = aRun({ walks: [[]] });

    await run.run(["--confirm"], { SMOKE_WAIT_MINUTES: "0" });

    expect(run.text()).not.toContain(A_KEY);
    expect(run.text()).toContain(ITS_ADDRESS);
  });
});

describe("reading a gateway and the discovery catalog, over a real socket", () => {
  /**
   * Everything above fakes the way out, which leaves the part that talks to a
   * server untested: what it accepts, and what it says when the answer is not
   * what it asked for. This serves the answers over a real socket instead — the
   * server is this process, on a port the operating system picks.
   *
   * The payment exchange is exercised here too, and that is not a live call.
   * Signing is arithmetic over a key and needs no chain, and the server below
   * plays the gateway and, through the header it answers with, its facilitator.
   * What the exchange never reaches is a facilitator or a chain of anybody
   * else's — that is `pnpm smoke:bootstrap`, and it costs money.
   */
  let server: Server | null = null;
  let asked: string[] = [];

  const serving = async (
    answer: (
      path: string,
      signed: boolean,
    ) => {
      readonly status?: number;
      readonly body: string;
      readonly headers?: Readonly<Record<string, string | undefined>>;
    },
  ): Promise<string> => {
    asked = [];
    server = createServer((request, response) => {
      asked.push(request.url ?? "");
      const signed = request.headers["payment-signature"] !== undefined;
      const said = answer(request.url ?? "", signed);
      response.setHeader("content-type", "application/json");
      for (const [name, value] of Object.entries(said.headers ?? {})) {
        if (value !== undefined) {
          response.setHeader(name, value);
        }
      }
      response.writeHead(said.status ?? 200);
      response.end(said.body);
    });
    await new Promise<void>((ready) => server?.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  };

  /** A challenge in the shape the protocol carries one, for the fake gateway. */
  const challengeHeader = (over: { readonly error?: string } = {}): string =>
    encodePaymentRequiredHeader({
      x402Version: 2,
      ...(over.error === undefined ? {} : { error: over.error }),
      resource: {
        url: "https://coinslot.example/v0/items/itm_1/purchase",
        description: "A room for the night",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: BASE_SEPOLIA,
          asset: USDC_ON_BASE_SEPOLIA,
          amount: "10000",
          payTo: A_MERCHANT,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
      ],
    });

  afterEach(async () => {
    await new Promise<void>((closed) => {
      if (server === null) return closed();
      server.close(() => closed());
    });
    server = null;
  });

  const settingsFor = (baseUrl: string): Settings => ({
    baseUrl,
    buyerKey: A_KEY,
    maxUsd: "0.05",
    totalUsd: "0.50",
    waitMs: 0,
    allowMainnet: false,
    confirm: false,
    named: [],
    answers: {},
  });

  it("takes the products out of a catalog it can read, from a gateway newer than this copy", async () => {
    // Held to the whole published document, a good catalog from a deployment
    // ahead of this checkout would be refused over fields this copy has never
    // heard of, and the run would report that it bought nothing.
    const base = await serving(() => ({
      body: JSON.stringify({
        items: [
          { id: "itm_1", title: "A room", params: { email: { required: true } }, badges: ["new"] },
          { id: "itm_2", title: "Another" },
        ],
        next_page: "cursor-42",
      }),
    }));

    const cards = await overTheNetwork(settingsFor(base)).catalog();

    expect(cards.map((card) => card.id)).toStrictEqual(["itm_1", "itm_2"]);
    expect(cards[0]?.params).toStrictEqual({ email: { required: true } });
  });

  it("says what it could not read when something else answers for the gateway", async () => {
    const base = await serving(() => ({ body: JSON.stringify({ error: "unauthorized" }) }));

    await expect(overTheNetwork(settingsFor(base)).catalog()).rejects.toThrow("not a catalog");
  });

  it("names the status when the gateway refuses the catalog", async () => {
    const base = await serving(() => ({ status: 503, body: "{}" }));

    await expect(overTheNetwork(settingsFor(base)).catalog()).rejects.toThrow("503");
  });

  it("says there is no challenge when the address answers without one", async () => {
    const base = await serving(() => ({ status: 404, body: JSON.stringify({ error: {} }) }));

    await expect(overTheNetwork(settingsFor(base)).challenge("itm_1")).rejects.toThrow(
      "no PAYMENT-REQUIRED header",
    );
  });

  it("reads a challenge off the wire, decimals and all", async () => {
    const base = await serving(() => ({
      status: 402,
      body: "{}",
      headers: { "PAYMENT-REQUIRED": challengeHeader() },
    }));

    const challenge = await overTheNetwork(settingsFor(base)).challenge("itm_1");

    // The address is the one the challenge pins, never the one this was called
    // at: behind a terminator those are two different strings, and it is the
    // pinned one a listing is keyed on.
    expect(challenge.resourceUrl).toBe("https://coinslot.example/v0/items/itm_1/purchase");
    expect(challenge.payTo).toBe(A_MERCHANT);
    expect(challenge).toMatchObject({ amount: "10000", decimals: 6, symbol: "USDC" });
  });

  it("takes the facilitator's verdict out of the header on the leg that was signed", async () => {
    // The exchange for real: the first call comes back a challenge, the client
    // signs it, and the second is refused. In version two both answers are a 402
    // with an empty body and the same header name, and the reason is a field
    // inside it — so a command reading the status alone reports a silence and a
    // command reading the wrong leg reports the price as a verdict.
    const base = await serving((_path, signed) => ({
      status: 402,
      body: "{}",
      headers: {
        "PAYMENT-REQUIRED": signed
          ? challengeHeader({ error: "self_send_not_allowed" })
          : challengeHeader(),
      },
    }));

    const outcome = await overTheNetwork(settingsFor(base)).purchase("itm_1", {});

    expect(outcome).toMatchObject({
      kind: "answered",
      status: 402,
      facilitatorSaid: { heard: "verdict", error: "self_send_not_allowed" },
    });
    expect(whatBecameOfThePayment(outcome, BASE_SEPOLIA)).toStrictEqual({
      paid: "refused",
      why: "the gateway answered 402: self_send_not_allowed",
    });
  });

  it("does not turn a repeated challenge into a verdict about the payment", async () => {
    const base = await serving(() => ({
      status: 402,
      body: "{}",
      headers: { "PAYMENT-REQUIRED": challengeHeader() },
    }));

    const outcome = await overTheNetwork(settingsFor(base)).purchase("itm_1", {});

    expect(outcome).toMatchObject({ facilitatorSaid: { heard: "no reason" } });
  });

  it("reads a settlement receipt off a purchase that went through", async () => {
    const base = await serving((_path, signed) =>
      signed
        ? {
            status: 200,
            body: JSON.stringify({ status: "delivered", delivered: { access_code: "abc" } }),
            headers: {
              "PAYMENT-RESPONSE": encodePaymentResponseHeader({
                success: true,
                transaction: A_TRANSACTION,
                network: BASE_SEPOLIA,
              }),
            },
          }
        : { status: 402, body: "{}", headers: { "PAYMENT-REQUIRED": challengeHeader() } },
    );

    const outcome = await overTheNetwork(settingsFor(base)).purchase("itm_1", {});

    expect(whatBecameOfThePayment(outcome, BASE_SEPOLIA)).toMatchObject({
      paid: "settled",
      transaction: A_TRANSACTION,
    });
  });

  it("does not read a client that refused to sign as a call that may have moved money", async () => {
    // The client's own cap kills a payment before anything is signed, and it
    // does so by throwing. Called unreachable, that would be reported as a
    // payment that might have gone through — the exact claim beyond the evidence
    // this whole command is built to avoid, made in the opposite direction.
    const base = await serving(() => ({
      status: 402,
      body: "{}",
      headers: { "PAYMENT-REQUIRED": challengeHeader() },
    }));

    const outcome = await overTheNetwork({ ...settingsFor(base), maxUsd: "0.001" }).purchase(
      "itm_1",
      {},
    );

    expect(outcome.kind).toBe("client_refused");
    expect(whatBecameOfThePayment(outcome, BASE_SEPOLIA).paid).toBe("refused");
  });

  it("reads one page of the discovery catalog at the offset it asked for", async () => {
    const base = await serving((path) => ({
      body: JSON.stringify({
        items: path.includes("offset=0")
          ? [{ resource: "https://a.example/x" }, { notaresource: 1 }]
          : [{ resource: "https://b.example/y" }],
        pagination: { limit: DISCOVERY_PAGE_SIZE, offset: 0, total: 2 },
      }),
    }));

    const reach = overTheNetwork(settingsFor("https://coinslot.example"), { discovery: base });

    // Entries with no address are dropped rather than crashing the walk: the
    // catalog is somebody else's document and it grows fields we do not know.
    expect(await reach.discoveryPage(0, DISCOVERY_PAGE_SIZE)).toStrictEqual({
      total: 2,
      resources: ["https://a.example/x"],
    });
    expect((await reach.discoveryPage(1000, DISCOVERY_PAGE_SIZE)).resources).toStrictEqual([
      "https://b.example/y",
    ]);
    expect(asked).toStrictEqual([
      `/?offset=0&limit=${DISCOVERY_PAGE_SIZE}`,
      `/?offset=1000&limit=${DISCOVERY_PAGE_SIZE}`,
    ]);
  });

  it("says so rather than reporting an empty catalog when discovery refuses", async () => {
    // An empty walk and a walk that never happened are the difference between
    // "not listed" and "not known", and only one of them is an answer.
    const base = await serving(() => ({ status: 429, body: "{}" }));

    const reach = overTheNetwork(settingsFor("https://coinslot.example"), { discovery: base });

    await expect(reach.discoveryPage(0, DISCOVERY_PAGE_SIZE)).rejects.toThrow("429");
  });
});
