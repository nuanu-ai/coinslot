/**
 * The worked examples the console offers to publish.
 *
 * Three of them are files rather than copies: the portal prints the same JSON
 * on its own pages and `packages/contracts/src/landing-fixtures.test.ts` holds
 * the landing's code block to the shortest of them. Read from disk here, a
 * template that stops publishing is a documented example that stopped working,
 * which is the whole reason to have the button.
 *
 * The two after them are the pilot's own products, and the last is the shape
 * the public x402 catalogue is actually full of. That one is drawn from a
 * reading of it rather than from imagination — see the note above it — because
 * an invented example that no real catalogue would carry teaches the wrong
 * thing about what this system is for.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CardInput } from "@nuanu-ai/coinslot";
import { CATALOG } from "./cards.js";

export interface Template {
  /** What the form posts back, and what names this example in the log. */
  readonly key: string;
  readonly label: string;
  /** One line saying what this example is for, shown on hovering the button. */
  readonly about: string;
  /** The card, as JSON somebody can edit before publishing it. */
  read(): Promise<string>;
}

const portalExample = (file: string): (() => Promise<string>) => {
  const at = fileURLToPath(new URL(`../../../portal/examples/card/${file}`, import.meta.url));
  return async () => {
    let text: string;
    try {
      text = await readFile(at, "utf8");
    } catch {
      throw new Error(
        `The portal's example ${file} could not be read. This template publishes the file the portal itself prints, so it only works inside the repository.`,
      );
    }
    // Parsed and printed again rather than passed through, so that a file with
    // its own indentation lands in the box the way every other template does.
    return JSON.stringify(JSON.parse(text), null, 2);
  };
};

const written =
  (card: CardInput): (() => Promise<string>) =>
  async () =>
    JSON.stringify(card, null, 2);

/**
 * The pilot's asynchronous product, with a deadline it can be watched against.
 *
 * The card as published names none, so the gateway holds it to the system
 * default — a day — and nothing on a console anybody is sitting at will ever
 * reach it. Ten seconds is short enough to watch run out.
 */
const esimWithADeadline = (): CardInput => {
  const card = structuredClone(CATALOG[1]) as Record<string, unknown>;
  card.fulfill_deadline_seconds = 10;
  return card as CardInput;
};

/*
 * Three cards in the shape the public catalogue is actually made of.
 *
 * Read on 2026-09-01: one page of 100 records out of 14,787, and what is on it
 * is chain and market lookups — an ERC20 balance, an ENS name resolved, a block
 * height, a transaction by its hash, NFT metadata, a token price. Every one
 * synchronous, answering with JSON, at a median of 0.003 USDC, a floor of 0.001
 * and a ceiling across that page of 5.00. Beside them the pilot's own two
 * products, at three and eight dollars with one delivered later, are unlike
 * anything on that shelf — which is worth being able to see rather than be told.
 *
 * They name no merchant and copy nobody's wording. What is taken is the shape,
 * the price and the kind of thing, and each one is here because it exercises
 * something this console does differently: a card with no purchase parameters
 * at all, a card with one required parameter, and a card whose answer has
 * several fields in it.
 */
const BLOCK_HEIGHT: CardInput = {
  merchant_item_id: "chain-tip",
  title: "The height of the latest block",
  description:
    "The current tip of the chain, answered in the purchase itself. Nothing is asked of the buyer: the question has no parameters.",
  price: "0.001 USD",
  result: {
    height: { type: "integer", title: "The block number at the tip" },
    as_of: { type: "string", title: "When the tip was read (ISO 8601)" },
  },
  fulfillment: "sync",
};

const TOKEN_BALANCE: CardInput = {
  merchant_item_id: "token-balance",
  title: "The balance of one token in one wallet",
  description:
    "How much of a token an address holds, answered in the purchase itself. The buyer names the wallet and the token contract.",
  price: "0.003 USD",
  params: {
    wallet: { type: "string", required: true, title: "The address to look at" },
    token: { type: "string", required: true, title: "The token contract" },
  },
  result: {
    balance: { type: "string", title: "The balance in the token's smallest unit" },
    decimals: { type: "integer", title: "How many decimal places the token has" },
  },
  fulfillment: "sync",
};

const TRANSACTION: CardInput = {
  merchant_item_id: "transaction-by-hash",
  title: "One transaction, whole, by its hash",
  description:
    "Everything a transaction carries, answered in the purchase itself: who sent it, where to, what it moved and what it cost.",
  price: "0.008 USD",
  params: {
    hash: { type: "string", required: true, title: "The transaction hash" },
  },
  result: {
    from: { type: "string", title: "The sender" },
    to: { type: "string", title: "The recipient" },
    value: { type: "string", title: "What it moved, in the chain's smallest unit" },
    block_number: { type: "integer", title: "The block it landed in" },
    status: { type: "string", title: "Whether it succeeded" },
  },
  fulfillment: "sync",
};

export const TEMPLATES: readonly Template[] = [
  {
    key: "portal_short",
    label: "Access, short form",
    about:
      "The card the front page prints, read from the file the front page renders from — the shortest spelling a card has.",
    read: portalExample("access-monthly-short.json"),
  },
  {
    key: "chain_tip",
    label: "Block height, 0.001",
    about:
      "A card that asks the buyer for nothing at all. The cheapest kind the catalogue carries.",
    read: written(BLOCK_HEIGHT),
  },
  {
    key: "token_balance",
    label: "Token balance, 0.003",
    about: "Two required parameters, and the median price of the public catalogue.",
    read: written(TOKEN_BALANCE),
  },
  {
    key: "transaction",
    label: "Transaction, 0.008",
    about: "An answer with five fields in it, so a delivery has a shape worth getting wrong.",
    read: written(TRANSACTION),
  },
  {
    key: "rented_number",
    label: "Rented number, 3.00",
    about: "The pilot's synchronous product, priced by the handler at the moment of purchase.",
    read: written(CATALOG[0] as CardInput),
  },
  {
    key: "esim",
    label: "eSIM, delivered later",
    about: "The pilot's asynchronous product, with a ten-second deadline you can watch run out.",
    read: () => written(esimWithADeadline())(),
  },
];

export const templateNamed = (key: string): Template | undefined =>
  TEMPLATES.find((one) => one.key === key);
