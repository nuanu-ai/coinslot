/**
 * One list, three readers, each asked in its own words.
 *
 * The gateway's derivation, the ordinary smoke command and the bootstrap
 * spending gate each decide something about a chain, and they used to decide
 * it from two copies of one set. Two copies that move independently is the
 * exact disagreement this change removed, and this is what holds them
 * together afterwards: if a chain is ever classified differently by any of the
 * three, the one who would otherwise notice is a person spending real money on
 * a run that thought it was on a testnet.
 *
 * Every assertion below goes through a command's own decision function rather
 * than through the set they share. Asking the set would prove that the set is
 * the set.
 */

import { isTestnetChain, LIVE_CHAINS, TESTNET_CHAINS } from "@coinslot/core";
import { loadConfig } from "@coinslot/gateway";
import { describe, expect, it } from "vitest";
import {
  type CatalogCard,
  type Challenge,
  gateOneProduct,
  type Settings,
} from "./bootstrap-command.js";
import { whyNotThisNetwork } from "./smoke.js";

const DATABASE_URL = "postgres://coinslot@localhost:5432/coinslot";

/**
 * The three fixtures a bootstrap gate needs before it reaches the chain, built
 * here rather than borrowed from `bootstrap-command.test.ts`: importing another
 * suite would run it a second time inside this file.
 */
const A_BUYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const A_MERCHANT = "0x784D1234567890123456789012345678901234Ac";

const aCard = (): CatalogCard => ({ id: "itm_1", title: "A room for the night", params: {} });

const aChallengeOn = (network: string): Challenge => ({
  resourceUrl: "https://coinslot.example/v0/items/itm_1/purchase",
  payTo: A_MERCHANT,
  network,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  decimals: 6,
  symbol: "USDC",
});

const SETTINGS: Settings = {
  baseUrl: "http://localhost",
  buyerKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  maxUsd: "0.05",
  totalUsd: "0.50",
  waitMs: 0,
  allowMainnet: false,
  confirm: false,
  named: [],
  answers: {},
};

/** What the bootstrap gate says about one chain, with no consent given. */
const bootstrapRefusal = (network: string): string | null =>
  gateOneProduct(aCard(), aChallengeOn(network), {
    buyer: A_BUYER,
    settings: { ...SETTINGS, allowMainnet: false },
    spent: 0n,
  });

describe("the shared list", () => {
  it("lets every written testnet through all three readers", () => {
    for (const chain of TESTNET_CHAINS) {
      expect(loadConfig({ DATABASE_URL, PAYMENT_NETWORK: chain }).environment).toBe("test");
      expect(whyNotThisNetwork(chain, false)).toBeNull();
      expect(bootstrapRefusal(chain)).toBeNull();
    }
  });

  it("makes all three say out loud that a live chain is a live chain", () => {
    for (const chain of LIVE_CHAINS) {
      expect(
        loadConfig({
          DATABASE_URL,
          PAYMENT_NETWORK: chain,
          FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
          CDP_API_KEY_ID: "key-id",
          CDP_API_KEY_SECRET: "secret",
        }).environment,
      ).toBe("live");
      expect(whyNotThisNetwork(chain, false)).toMatch(/SMOKE_ALLOW_MAINNET/);
      expect(bootstrapRefusal(chain)).toMatch(/SMOKE_ALLOW_MAINNET/);
    }
  });

  it("leaves an unwritten chain outside all three", () => {
    // Refused as unwritten, and not merely refused. A derivation that sorted an
    // unknown chain into a side would still be stopped here by the facilitator
    // rule, so a bare "it throws" would go on passing while the gateway had
    // started calling `eip155:1` live — which is the reading that writes
    // `test: false` onto a receipt paid for with play money.
    expect(() => loadConfig({ DATABASE_URL, PAYMENT_NETWORK: "eip155:1" })).toThrowError(
      /neither written list/,
    );
    expect(whyNotThisNetwork("eip155:1", false)).toMatch(/SMOKE_ALLOW_MAINNET/);
    expect(bootstrapRefusal("eip155:1")).toMatch(/SMOKE_ALLOW_MAINNET/);
    // And the helper agrees with all three, which is the only thing asking it
    // proves.
    expect(isTestnetChain("eip155:1")).toBe(false);
  });

  it("lets consent through, because the gate is a gate and not a wall", () => {
    for (const chain of LIVE_CHAINS) {
      expect(whyNotThisNetwork(chain, true)).toBeNull();
    }
  });
});
