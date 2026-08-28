import { describe, expect, it } from "vitest";
import { checksummedAddressOf, EvmAddressSchema } from "./evm-address.js";
import { errorOf } from "./testing/expect-schema.js";

/**
 * The addresses EIP-55 publishes as its own test vectors, in the spelling the
 * standard prints them in.
 *
 * They are the external oracle this file rests on. Every one of them was
 * produced by somebody else's implementation of the same hash, so an
 * implementation of ours that agrees with all eight is the standard's and not
 * merely self-consistent — which is the one thing a checksum written from
 * scratch has to be made to prove.
 *
 * The last four are worth reading twice, because they look like exceptions and
 * are not. Two of them come out of the checksum with every letter capital and
 * two with every letter small; that is what the standard's own output is for
 * those addresses, and both are accepted here as checksummed rather than as
 * spellings anybody chose.
 */
const CHECKSUMMED = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  "0x52908400098527886E0F7030069857D2E4169EE7",
  "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
  "0xde709f2102306220921060314715629080e2fb77",
  "0x27b1fdb04752bbc536007a920d24acb045561c26",
];

/** The same address with one letter's case flipped: one keystroke off. */
const oneLetterFlipped = (address: string): string => {
  const body = address.slice(2);
  for (const [index, character] of [...body].entries()) {
    const flipped =
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
    if (flipped !== character) {
      return `0x${body.slice(0, index)}${flipped}${body.slice(index + 1)}`;
    }
  }
  throw new Error(`${address} carries no letter to flip`);
};

const accepts = (value: string): boolean => EvmAddressSchema.safeParse(value).success;

describe("an address on an EVM chain", () => {
  // The promise: the address a merchant's sales are paid to is the address
  // their wallet showed them. Everything below is a way that stops being true —
  // a character lost in a paste, a case-mangling copy, a truncation nobody saw.

  it("takes every address the standard publishes, in the spelling it publishes", () => {
    for (const address of CHECKSUMMED) {
      expect(accepts(address), address).toBe(true);
    }
  });

  it("takes the same addresses written all in lower case", () => {
    // Lower case is the spelling that carries no checksum at all, and it is a
    // real one: it is what a block explorer prints, what our own storage holds,
    // and what a merchant reads back from us. Refusing it would mean an address
    // we handed out ourselves could not be sent back.
    for (const address of CHECKSUMMED) {
      expect(accepts(address.toLowerCase()), address).toBe(true);
    }
  });

  it("refuses an address whose letters claim a checksum they do not carry", () => {
    // The whole reason the checksum is checked here rather than taken on
    // trust. A wallet hands its owner the capitalised spelling; one character
    // wrong in it and the capitals stop agreeing with the rest, which is the
    // only warning anybody gets before the money goes to a stranger.
    for (const address of CHECKSUMMED) {
      const mistyped = oneLetterFlipped(address);
      expect(accepts(mistyped), mistyped).toBe(false);
    }
  });

  it("refuses a character swapped for another inside a checksummed address", () => {
    // The case above changes only the case of a letter; this one changes the
    // address itself, which is the mistake that actually costs money. The
    // capitals no longer describe these digits, so it is caught.
    expect(accepts("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAee")).toBe(false);
    expect(accepts("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d358")).toBe(false);
  });

  it("says the address looks mistyped, rather than talking about hexadecimal", () => {
    // The reader is a merchant holding a wallet address, not somebody debugging
    // a regular expression. What they need to be told is that this is not the
    // address they think it is and what to do about it.
    const complaint = errorOf(EvmAddressSchema, oneLetterFlipped(CHECKSUMMED[0] ?? ""));

    expect(complaint).toMatch(/wrong|mistyp/i);
    expect(complaint).toContain("lower case");
  });

  it("refuses a shape that is not an address at all", () => {
    expect(accepts("")).toBe(false);
    expect(accepts("0x")).toBe(false);
    // One character short and one character long: a paste that lost a
    // character is the mistake this catches, and it is invisible by eye.
    expect(accepts("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe")).toBe(false);
    expect(accepts("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedd")).toBe(false);
    // The prefix is part of the address rather than decoration on it.
    expect(accepts("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(false);
    expect(accepts("0X5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(false);
    // Not hexadecimal: "g" and "z" are the two letters a hand reaching for
    // "f" and "a" lands on.
    expect(accepts("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeg")).toBe(false);
    expect(accepts("0xzaaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(false);
  });

  it("refuses an address with whitespace anywhere on it", () => {
    // A copied address arrives with a space or a newline stuck to it more often
    // than it arrives wrong. It is refused rather than trimmed: what a merchant
    // is paid at must be the string they can see, and something quietly cut off
    // the end is the shape of the truncation this whole schema exists to catch.
    const address = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

    expect(accepts(` ${address}`)).toBe(false);
    expect(accepts(`${address} `)).toBe(false);
    expect(accepts(`${address}\n`)).toBe(false);
    expect(accepts("0x5aaeb6053f3e94c9 b9a09f33669435e7ef1beaed")).toBe(false);
  });

  it("complains about the shape alone when the shape is wrong", () => {
    // Two complaints about one string would have a merchant looking for a
    // checksum in something that is not an address. Whichever is the real
    // problem is the one that gets said.
    const complaint = errorOf(EvmAddressSchema, "0xnot-an-address");

    expect(complaint).toContain("forty");
    expect(complaint).not.toMatch(/wrong|mistyp/i);
  });

  it("refuses anything that is not a string", () => {
    expect(EvmAddressSchema.safeParse(null).success).toBe(false);
    expect(EvmAddressSchema.safeParse(undefined).success).toBe(false);
    expect(EvmAddressSchema.safeParse(0x5aaeb605).success).toBe(false);
  });
});

describe("an address written the way a wallet shows it", () => {
  // The promise: a merchant pastes forty characters out of their wallet, and
  // every screen that shows them back shows the same forty characters. This is
  // the function that makes that true, and the reason it is the canon rather
  // than lower case: nobody compares two spellings of one address by eye and
  // gets it right, and the eye is the only thing checking.

  it("writes out the spelling the standard publishes, from either spelling", () => {
    for (const address of CHECKSUMMED) {
      expect(checksummedAddressOf(address.toLowerCase()), address).toBe(address);
      // And given that spelling already, it answers with the same string, so
      // writing an address down twice writes the same thing twice.
      expect(checksummedAddressOf(address), address).toBe(address);
    }
  });

  it("puts capitals in an address that has letters to capitalise", () => {
    // The negative control for the loop above: two of the standard's vectors
    // come out all lower case, so a function that returned its input unchanged
    // would pass on those and on every all-digit address. This one has to
    // actually change.
    const lowered = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

    expect(checksummedAddressOf(lowered)).not.toBe(lowered);
    expect(checksummedAddressOf(lowered)).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  });

  it("leaves an address with no letters in it exactly as it is", () => {
    // Nothing to capitalise, so the canonical form and what was typed are one
    // string. Worth pinning because it is what the seeded addresses in the
    // gateway's tests look like.
    const digits = "0x0000000000000000000000000000000000000001";

    expect(checksummedAddressOf(digits)).toBe(digits);
  });

  it("agrees with the schema about which addresses there are", () => {
    // The two must never disagree: an address this writes out is one the
    // schema takes, and one the schema takes is one this can write out.
    for (const address of CHECKSUMMED) {
      expect(EvmAddressSchema.safeParse(checksummedAddressOf(address)).success, address).toBe(true);
    }
  });

  it("refuses to repair an address whose letters disagree with it", () => {
    // The failure this exists to not have. Capitalising a mistyped address
    // afresh produces a perfectly well-formed address that nobody typed —
    // which is the checksum defeated by the thing meant to enforce it.
    const mistyped = oneLetterFlipped(CHECKSUMMED[0] ?? "");

    expect(() => checksummedAddressOf(mistyped)).toThrow();
    expect(() => checksummedAddressOf("0x1234")).toThrow();
    expect(() => checksummedAddressOf("")).toThrow();
  });
});
