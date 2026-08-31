/**
 * The smoke command: the same buyer and the same mock merchant as the offline
 * gate, but against a gateway wired to the real x402 facilitator on the Base
 * Sepolia testnet, where a purchase moves real testnet USDC.
 *
 * It is not part of `pnpm test` and never runs from it. It touches the network
 * and, with `--confirm`, moves money — testnet money with no real value, but a
 * real transfer — so it is fenced behind explicit intent and a spending cap,
 * and its default is a dry run that stops before anything is signed.
 *
 * What is real here and what is not is worth stating plainly. The facilitator
 * is the real one: it verifies and settles against Base Sepolia through the CDP
 * endpoint using the credentials in the environment. The store and the queue
 * are still in memory — the smoke's subject is the money path, not persistence
 * — so nothing it writes outlives the process. The buyer's wallet and the
 * merchant's receiving address are throwaway testnet accounts; the buyer's key
 * is read from the environment, never printed, and never written down.
 *
 * The safeguards below each refuse the run outright rather than proceeding on a
 * guess. They are the same shape the pilot's payment spike used, because the
 * thing they guard against — signing a transfer nobody meant to send — is the
 * same.
 *
 *   COINSLOT_SMOKE=1 SMOKE_BUYER_KEY=0x… SMOKE_PAY_TO=0x… pnpm smoke
 *   COINSLOT_SMOKE=1 SMOKE_BUYER_KEY=0x… SMOKE_PAY_TO=0x… \
 *     CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… pnpm smoke --confirm
 *
 * The first is a dry run: it boots the gateway, publishes the card, reads the
 * real payment challenge and prints exactly what a payment would be, then stops
 * without signing. The second, with credentials and the flag, executes one real
 * testnet settlement.
 */

import { isTestnetChain } from "@coinslot/core";
import {
  type Facilitator,
  type GatewayConfig,
  PaymentEdge,
  X402Facilitator,
} from "@coinslot/gateway";
import type { Card } from "@nuanu-ai/coinslot-contracts";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { getDefaultAsset } from "@x402/evm";
import { makeBuyer } from "./buyer.js";
import { EUROPE_ESIM } from "./cards.js";
import { bootGateway, SLICE_MERCHANT_KEY, sliceEnv } from "./gateway-harness.js";
import { startMerchant } from "./merchant.js";

/** The CDP x402 facilitator, and the public one that needs no credentials. */
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PUBLIC_FACILITATOR_URL = "https://x402.org/facilitator";

/** Address tails that are burn holes rather than a merchant's wallet. */
const BURN_TAILS = ["dead", "beef", "0000"];

const say = (...parts: unknown[]): void => {
  console.log("[smoke]", ...parts);
};

/**
 * Refuses the run. Declared as a function rather than an arrow so its `never`
 * return narrows the flow after it — a value a gate has just refused as absent
 * is known to be present below.
 */
function die(why: string): never {
  console.error(`[smoke] REFUSED: ${why}`);
  process.exit(1);
}

/** Whether an address is a burn hole or not an address at all — never a payee. */
const isBurnAddress = (address: string): boolean => {
  const hex = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(hex)) {
    return true;
  }
  const body = hex.slice(2);
  return BURN_TAILS.some((tail) => body === "0".repeat(40 - tail.length) + tail);
};

/** The real facilitator, built from the loaded config exactly as production does. */
function realFacilitator(config: GatewayConfig): Facilitator {
  const edge = new PaymentEdge(config.payment, config.publicBaseUrl, config.payment.timeoutSeconds);
  const { cdpApiKeyId, cdpApiKeySecret } = config.payment;
  const client = new HTTPFacilitatorClient({
    url: config.payment.facilitatorUrl,
    ...(cdpApiKeyId === null || cdpApiKeySecret === null
      ? {}
      : {
          createAuthHeaders: async () => {
            const headers = {
              "CDP-Api-Key-Id": cdpApiKeyId,
              "CDP-Api-Key-Secret": cdpApiKeySecret,
            };
            return { verify: headers, settle: headers, supported: headers };
          },
        }),
  });
  return new X402Facilitator(client, edge);
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm") || process.env.SMOKE_CONFIRM === "1";
  const mode = confirm ? "LIVE (--confirm): one real testnet settlement" : "dry run (no payment)";

  // --- the gates: any one of them refuses the run ---------------------------

  if (process.env.COINSLOT_SMOKE !== "1") {
    die(
      "set COINSLOT_SMOKE=1 to run the smoke — it touches the network and, with --confirm, moves testnet money",
    );
  }

  const buyerKey = process.env.SMOKE_BUYER_KEY ?? process.env.BUYER_PRIVATE_KEY;
  if (buyerKey === undefined) {
    die(
      "set SMOKE_BUYER_KEY to a throwaway testnet wallet key — there is nothing to pay with otherwise",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(buyerKey)) {
    die("SMOKE_BUYER_KEY is not a private key (expected 0x followed by 64 hex characters)");
  }

  const payTo = process.env.SMOKE_PAY_TO;
  if (payTo === undefined) {
    die(
      "set SMOKE_PAY_TO to the merchant's testnet address — the money has nowhere to go otherwise",
    );
  }
  if (isBurnAddress(payTo)) {
    die(`SMOKE_PAY_TO ${payTo} is not a payable address (it is malformed or a known burn address)`);
  }

  const network = process.env.SMOKE_NETWORK ?? "eip155:84532";
  if (!isTestnetChain(network) && process.env.SMOKE_ALLOW_MAINNET !== "1") {
    die(
      `${network} is not a known testnet; real money needs an explicit SMOKE_ALLOW_MAINNET=1, which this command is not meant for`,
    );
  }

  const maxUsd = Number(process.env.SMOKE_MAX_USD ?? "0.05");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    die("SMOKE_MAX_USD must be a positive number of dollars");
  }

  const priceUsd = process.env.SMOKE_PRICE_USD ?? "0.01";
  if (!/^\d+(?:\.\d+)?$/.test(priceUsd) || Number(priceUsd) > maxUsd) {
    die(
      `SMOKE_PRICE_USD ${priceUsd} is either not an amount or above the SMOKE_MAX_USD cap of ${maxUsd}`,
    );
  }

  const cdpApiKeyId = process.env.CDP_API_KEY_ID;
  const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET;
  const haveCdp = cdpApiKeyId !== undefined && cdpApiKeySecret !== undefined;
  if (confirm && !haveCdp) {
    die(
      "--confirm needs CDP_API_KEY_ID and CDP_API_KEY_SECRET for the facilitator to verify and settle on Base Sepolia",
    );
  }

  const facilitatorUrl =
    process.env.SMOKE_FACILITATOR_URL ?? (haveCdp ? CDP_FACILITATOR_URL : PUBLIC_FACILITATOR_URL);

  // --- boot the real gateway and publish the card ---------------------------

  const env = sliceEnv({
    PAY_TO_ADDRESS: payTo,
    PAYMENT_NETWORK: network,
    FACILITATOR_URL: facilitatorUrl,
    ...(haveCdp ? { CDP_API_KEY_ID: cdpApiKeyId, CDP_API_KEY_SECRET: cdpApiKeySecret } : {}),
  });

  const booted = await bootGateway(realFacilitator, env);
  // The key the harness seeded into the gateway, named rather than read back
  // out of the environment: the variable that carries it is the gateway's
  // own, and reading a name this file does not control is how the merchant
  // ends up presenting an empty key and being turned away at the door.
  const merchant = startMerchant(booted.baseUrl, SLICE_MERCHANT_KEY);
  await merchant.start();
  const buyer = makeBuyer({ baseUrl: booted.baseUrl, privateKey: buyerKey, maxUsd });

  // A cheap asynchronous eSIM: the money moves at the purchase in one
  // settlement, so a single paid call is the whole of what the smoke has to do.
  // Same merchant_item_id as the catalog eSIM, so the mock merchant's own
  // handler answers it; only the price is the testnet one.
  const smokeCard: Card = { ...EUROPE_ESIM, price: { amount: priceUsd, currency: "USD" } };

  try {
    const published = await merchant.client.catalog.publish(smokeCard);
    if (!("ok" in published)) {
      die(`the gateway refused the smoke card: ${JSON.stringify(published.errors)}`);
    }

    const catalog = await buyer.catalog();
    const listing = catalog.find((card) => card.title === smokeCard.title);
    if (listing === undefined) {
      die("the smoke card did not appear in the catalog it was just published to");
      return;
    }

    // Read the real challenge without paying: it names the amount, the asset and
    // the address a payment would go to.
    const challenge = await buyer.challenge(listing.id);
    const requirement = challenge.accepts[0];
    if (requirement === undefined) {
      die("the payment challenge carried no payment options");
      return;
    }

    const asset = getDefaultAsset(network as `${string}:${string}`);
    const decimals =
      asset.asset.toLowerCase() === requirement.asset.toLowerCase() ? asset.decimals : null;
    const amountUsd = decimals === null ? null : Number(requirement.amount) / 10 ** decimals;

    say(`mode: ${mode}`);
    say(
      `gateway: ${booted.baseUrl} (in-process; in-memory store and queue; REAL x402 facilitator)`,
    );
    say(`facilitator: ${facilitatorUrl} (CDP credentials ${haveCdp ? "present" : "absent"})`);
    say(`buyer wallet: ${buyer.address} (public address; the key is never printed)`);
    say(`product: ${listing.title} — catalog id ${listing.id}`);
    say(
      `challenge: pay ${requirement.amount} ${requirement.asset} ` +
        `(= ${amountUsd === null ? "?" : `$${amountUsd}`} ${asset.symbol}) ` +
        `to ${requirement.payTo} on ${requirement.network}, valid for ${requirement.maxTimeoutSeconds}s`,
    );
    say(`spending cap: $${maxUsd} per payment (enforced by the buyer's own x402 client)`);

    if (amountUsd !== null && amountUsd > maxUsd) {
      die(`the challenge asks $${amountUsd}, above the SMOKE_MAX_USD cap of $${maxUsd}`);
    }

    if (!confirm) {
      say("DRY RUN: every safeguard passed and NOTHING was signed. No money moved.");
      say(
        "To execute one real Base Sepolia USDC transfer, re-run the same command with --confirm.",
      );
      return;
    }

    // Refuse rather than trust the buyer's client cap alone. If the challenge's
    // asset is not the one this network's default table knows, the dollar amount
    // could not be read above, and paying then would be paying an amount this
    // command could not check.
    if (amountUsd === null) {
      die(
        `could not read the challenge amount in dollars (asset ${requirement.asset} is not ${asset.symbol} on ${network}), so it cannot be checked against the cap`,
      );
    }

    // --- the one real paid call (only under --confirm) ----------------------
    say("--confirm: signing and settling one real testnet payment now.");
    const bought = await buyer.buy(listing.id, { email: "smoke@example.com" });
    say(`HTTP ${bought.status}`);
    say(`resource answered: ${JSON.stringify(bought.body)}`);
    if (bought.settlement === null) {
      die("the purchase returned no settlement receipt — the money path did not complete");
    }
    say(`settlement: ${JSON.stringify(bought.settlement)}`);
    if (bought.settlement.success !== true) {
      die(`the settlement did not succeed: ${JSON.stringify(bought.settlement)}`);
    }
    say("done: one real testnet settlement went through.");
  } finally {
    await merchant.stop();
    await booted.stop();
  }
}

main().catch((error: unknown) => {
  // The message only, never the whole error object: a payment client's error can
  // carry request details in tow, and the buyer's key is not something to risk
  // printing even by accident.
  console.error(
    `[smoke] the smoke command failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
