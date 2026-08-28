/**
 * The block a merchant sets their payout address in, read the way they read it.
 *
 * Two promises are held here and neither is about markup. The first is that an
 * address which money could never reach is refused before anything is written,
 * and that an address a wallet handed out with capitals in it is not. The
 * second is that a saved address can be checked: the whole of it is on the
 * page, and what a merchant selects and copies off the page is the address
 * itself rather than a prettier arrangement of its characters.
 *
 * The routes that save one are driven over HTTP in `server.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { payoutWalletBlock, whatIsWrongWithTheWallet } from "./payout-wallet.js";
import type { Viewer } from "./screens.js";
import { readable } from "./testing/html.js";

/**
 * An address of the right shape, and one nobody is going to mistake for a real
 * one: the digits run 0 to 9 and then the letters a to f, twice over. It is a
 * fixture rather than an address anybody could be paid at.
 */
const SHAPED = "0x0123456789abcdef0123456789abcdef01234567";

const looking = (payout?: Viewer["payout"]): Viewer => ({
  base: "",
  who: "dmitry@example.com",
  confirmed: true,
  ...(payout === undefined ? {} : { payout }),
});

/** The page as a merchant's clipboard sees it: the tags gone, nothing added. */
const asCopied = (html: string): string => html.replaceAll(/<[^>]*>/g, "");

describe("the rule an address is held to", () => {
  it("takes an address of the right shape, in either case", () => {
    // A wallet hands out an address with some of its letters capitalised, and
    // those capitals are a check the address carries on itself. Refusing them
    // would refuse most of the addresses merchants are actually given.
    expect(whatIsWrongWithTheWallet(SHAPED)).toBeNull();
    expect(whatIsWrongWithTheWallet("0x0123456789ABCDEF0123456789abcdef01234567")).toBeNull();
  });

  it("refuses what money could never reach, and says nothing was saved", () => {
    const wrong = [
      "",
      "0x",
      // One character short and one character long: the two mistakes a hand
      // that retyped an address actually makes.
      SHAPED.slice(0, -1),
      `${SHAPED}0`,
      // No 0x at the front, which is how an address arrives out of some tools.
      SHAPED.slice(2),
      // A character that is not hexadecimal at all, in the middle where an eye
      // skates over it.
      `${SHAPED.slice(0, 20)}z${SHAPED.slice(21)}`,
      // A whole address with something else stuck to it.
      `${SHAPED} and then some`,
      "my wallet",
    ];

    for (const address of wrong) {
      const said = whatIsWrongWithTheWallet(address);
      expect(said, address).not.toBeNull();
      expect(said, address).toMatch(/not saved/i);
    }
  });
});

describe("the block on the settings screen", () => {
  it("shows a saved address whole, so a merchant can check it against their wallet", () => {
    const block = payoutWalletBlock(looking({ wallet: SHAPED }));

    // Every character of it, in order, and no ellipsis standing in for the
    // middle: the shortening everybody reaches for is the one presentation
    // under which a wrong address and the right one look identical.
    expect(asCopied(block)).toContain(SHAPED);
    expect(block).not.toContain("…");
  });

  it("leaves no space inside the address, so copying it off the page pastes an address", () => {
    // The groups of four are the stylesheet's gaps and not the text's. Were
    // they real spaces, a merchant who selected the address and pasted it into
    // a wallet would be pasting something no wallet accepts — and would have
    // read the right address on the way to doing it.
    const copied = asCopied(payoutWalletBlock(looking({ wallet: SHAPED })));
    const shown = copied.slice(copied.indexOf("0x"), copied.indexOf("0x") + SHAPED.length);

    expect(shown).toBe(SHAPED);
  });

  it("asks for the address and for nothing else", () => {
    // The address is enough to be paid with. A private key or a recovery phrase
    // would be enough to spend with, and a second box on this block is how a
    // merchant would come to believe we ask for one.
    const block = payoutWalletBlock(looking({ wallet: null }));

    expect(block.match(/<input/g)).toHaveLength(1);
    expect(block).toContain('name="payout_wallet"');
    expect(readable(block).toLowerCase()).not.toMatch(/enter your (private key|recovery phrase)/);
  });

  it("says what a missing address does and does not stop", () => {
    // The consequence is not the same everywhere, and a screen that claimed it
    // was would be telling a merchant on a preview that something is blocked
    // which is not. Both halves are on the page: refused where the payments are
    // real, and refused nowhere on a preview that settles nothing.
    const text = readable(payoutWalletBlock(looking({ wallet: null })));

    expect(text).toMatch(/refused wherever the payments are real/i);
    expect(text).toMatch(/nothing settles/i);
  });

  it("shows what was wrong with an address just refused", () => {
    const block = payoutWalletBlock(looking({ wallet: SHAPED, problem: "that was not saved" }));

    expect(readable(block)).toContain("that was not saved");
  });

  it("draws nothing on a screen that did not ask the gateway for the address", () => {
    // A page that did not ask must not say anything either way. Drawn from
    // nothing, this block would tell a merchant they have set no address at the
    // moment they are least able to check.
    expect(payoutWalletBlock(looking())).toBe("");
  });
});
