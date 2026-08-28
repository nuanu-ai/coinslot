/**
 * The address money can be sent to on an EVM chain, and the one thing that can
 * be checked about one before it is used.
 *
 * An address is twenty bytes and nothing about those bytes is redundant, so a
 * character lost or mistyped in one produces another perfectly valid address —
 * belonging to nobody, or to somebody else, and a payment to it is gone. EIP-55
 * is the only guard anybody has against that: the capital letters in the
 * spelling a wallet shows are not decoration, they are a checksum over the
 * address itself, and a character that is wrong stops the capitals agreeing
 * with the digits. Checked here, a mistyped address is a sentence a merchant
 * reads while they still have the right one in front of them; not checked, it
 * is a stranger's wallet filling up with somebody's sales.
 *
 * Two spellings are accepted and no others. All lower case is the spelling that
 * carries no checksum at all, and it is what a block explorer prints and what
 * half the tooling in this world hands somebody, so refusing it would refuse
 * addresses that are perfectly good. The other is the exact output of the
 * checksum, which is what a wallet puts on the clipboard. Anything between the
 * two is a string that has been through something: a case-mangling copy, a
 * document that shouted it, or a keystroke in the wrong place. The refusal says
 * so and says what to do instead, because "invalid address" leaves a person
 * staring at forty characters that look fine.
 *
 * Of the two, the wallet's is the canon: the door takes both spellings and
 * everything behind it holds one (ADR-0017), and `checksummedAddressOf` below
 * is what writes it. The reason is about the person rather than about the
 * storage, and it is written where that function is.
 *
 * The hash is written out below rather than taken from a package, and that is a
 * decision rather than an oversight. This package's runtime dependency tree is
 * `zod` and nothing else, and it is the whole of what a merchant installs with
 * the SDK — ADR-0003 §8 makes every addition to it a decision of its own, and
 * that decision is not this file's to take. What is written out is therefore
 * kept as small as the job allows: twenty-four rounds of a fixed permutation
 * over one block, with no configuration and no second use, and it is pinned by
 * the vectors the standard publishes, so an implementation that is wrong
 * anywhere fails against somebody else's arithmetic rather than agreeing with
 * itself. The cost is named too: this is hand-written cryptographic code in a
 * published package, and the trigger to replace it with an audited library is
 * the first other thing in this package that needs a hash.
 */

import { z } from "zod";

/** How many characters an address carries after its prefix. */
const ADDRESS_LENGTH = 40;

/**
 * What an address looks like before anything is checked about its letters.
 *
 * It is a pattern rather than a set of refinements for the reason written in
 * `primitives.ts`: a rule expressed as a refinement is dropped from the JSON
 * Schema export without a word, and this half of the rule is the half a
 * generated client in another language can keep.
 */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * How wide a block of Keccak-256 is, in bytes: the state less twice the
 * capacity the 256-bit digest asks for.
 *
 * Forty characters fit inside one, which is why nothing here loops over blocks.
 */
const BLOCK_BYTES = 136;

/** The constant mixed into the state at the end of each of the twenty-four rounds. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

/** How far each lane is rotated as it is carried to its new place. */
const ROTATIONS: readonly number[] = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];

/** Where each lane goes, following the same path the rotations are read along. */
const DESTINATIONS: readonly number[] = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

/** Sixty-four bits, since the arithmetic below is done in unbounded integers. */
const LANE = (1n << 64n) - 1n;

/**
 * One lane of the state, by its index.
 *
 * Every index this file computes is inside the twenty-five lanes by
 * construction — they come from the fixed tables above and from loops bounded
 * by five. The fallback is what the compiler's index check asks for and is
 * never reached.
 */
const laneAt = (state: readonly bigint[], index: number): bigint => state[index] ?? 0n;

/** One lane rotated left, the way the permutation rotates. */
const rotated = (lane: bigint, by: number): bigint =>
  ((lane << BigInt(by)) | (lane >> BigInt(64 - by))) & LANE;

/**
 * The Keccak permutation, applied to the state in place.
 *
 * The four steps are the standard's own and are named after it: the column
 * parities, the rotate-and-move, the row mixing, and the round constant.
 */
function permute(state: bigint[]): void {
  for (const constant of ROUND_CONSTANTS) {
    const parity: bigint[] = [];
    for (let column = 0; column < 5; column++) {
      parity[column] =
        laneAt(state, column) ^
        laneAt(state, column + 5) ^
        laneAt(state, column + 10) ^
        laneAt(state, column + 15) ^
        laneAt(state, column + 20);
    }
    for (let column = 0; column < 5; column++) {
      const change =
        laneAt(parity, (column + 4) % 5) ^ rotated(laneAt(parity, (column + 1) % 5), 1);
      for (let row = 0; row < 25; row += 5) {
        state[column + row] = laneAt(state, column + row) ^ change;
      }
    }

    let carried = laneAt(state, 1);
    for (let step = 0; step < 24; step++) {
      const destination = DESTINATIONS[step] ?? 0;
      const held = laneAt(state, destination);
      state[destination] = rotated(carried, ROTATIONS[step] ?? 0);
      carried = held;
    }

    for (let row = 0; row < 25; row += 5) {
      const held = state.slice(row, row + 5);
      for (let column = 0; column < 5; column++) {
        state[row + column] =
          laneAt(held, column) ^
          (~laneAt(held, (column + 1) % 5) & LANE & laneAt(held, (column + 2) % 5));
      }
    }

    state[0] = laneAt(state, 0) ^ constant;
  }
}

/**
 * The first forty hexadecimal digits of the Keccak-256 digest of an address
 * written in lower case — one digit for each character of the address, which is
 * exactly what the checksum reads.
 *
 * The input is always forty ASCII characters, so it is absorbed as one padded
 * block and squeezed once. A general implementation would carry a loop over
 * blocks and a branch neither of which anything here would ever take.
 */
function checksumDigits(body: string): string {
  const block = new Uint8Array(BLOCK_BYTES);
  for (let index = 0; index < ADDRESS_LENGTH; index++) {
    block[index] = body.charCodeAt(index);
  }
  // The padding the original Keccak appends: a marker where the message ends,
  // and the top bit of the last byte of the block.
  block[ADDRESS_LENGTH] = 0x01;
  block[BLOCK_BYTES - 1] = 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let lane = 0; lane < BLOCK_BYTES / 8; lane++) {
    let value = 0n;
    for (let byte = 7; byte >= 0; byte--) {
      value = (value << 8n) | BigInt(block[lane * 8 + byte] ?? 0);
    }
    state[lane] = value;
  }
  permute(state);

  let digits = "";
  for (let lane = 0; digits.length < ADDRESS_LENGTH; lane++) {
    let value = laneAt(state, lane);
    for (let byte = 0; byte < 8; byte++) {
      digits += (value & 0xffn).toString(16).padStart(2, "0");
      value >>= 8n;
    }
  }
  return digits.slice(0, ADDRESS_LENGTH);
}

/**
 * One address body written the way a wallet writes it: every character whose
 * digest digit is eight or more capitalised, and the rest left alone.
 */
function checksummedBody(body: string): string {
  const digits = checksumDigits(body);
  let written = "";
  for (let index = 0; index < ADDRESS_LENGTH; index++) {
    const character = body[index] ?? "";
    // A digit has no capital form, so nothing has to ask whether this is a
    // letter: capitalising "7" gives "7" back.
    written += Number.parseInt(digits[index] ?? "0", 16) >= 8 ? character.toUpperCase() : character;
  }
  return written;
}

/**
 * Whether the letters of this address say what the address says.
 *
 * A value whose shape is wrong is left alone rather than answered here: the
 * pattern above has already complained about it, and two complaints about one
 * string would send a merchant looking for a checksum in something that is not
 * an address at all.
 */
function carriesItsOwnChecksum(value: string): boolean {
  if (!ADDRESS_SHAPE.test(value)) {
    return true;
  }
  const body = value.slice(2);
  const lowered = body.toLowerCase();
  return body === lowered || body === checksummedBody(lowered);
}

/**
 * One address written the way the wallet it came out of displays it: the
 * canonical form, and the one anything behind the door keeps.
 *
 * The door takes two spellings and everything behind it holds one (ADR-0017),
 * and this is the one, because it is the one a person recognises. A merchant
 * pastes forty characters out of their wallet and then reads them back on a
 * settings screen; handed the same address in lower case they cannot tell it
 * from a different address without comparing character by character, and the
 * one field in this system where that matters is the field money is sent to.
 * Lower case would be the easier canon to compute and the harder one to check
 * by eye, and the eye is the only thing checking.
 *
 * It refuses what the schema refuses rather than quietly repairing it. Given a
 * mixed-case address whose letters disagree with its digits, capitalising it
 * afresh would produce a perfectly well-formed address that nobody typed —
 * which is the exact failure the checksum exists to catch, arrived at by the
 * thing meant to enforce it.
 *
 * Given an address that is already in this form it answers with the same
 * string, so writing one down twice writes the same thing twice.
 */
export function checksummedAddressOf(address: string): string {
  if (!ADDRESS_SHAPE.test(address) || !carriesItsOwnChecksum(address)) {
    throw new Error(
      `${JSON.stringify(address)} is not an address this can write out: it is either not an address at all, or its capital letters disagree with the rest of it`,
    );
  }
  return `0x${checksummedBody(address.slice(2).toLowerCase())}`;
}

/**
 * An address on an EVM chain, in one of the two spellings anybody writes one
 * in.
 *
 * It carries no chain of its own. The same twenty bytes are an address on every
 * EVM network, and which network a payment is made on is settled by the payment
 * requirements rather than by the address inside them; a schema that claimed
 * otherwise would be claiming knowledge this package does not have.
 */
export const EvmAddressSchema = z
  .string()
  .regex(
    ADDRESS_SHAPE,
    "an address on an EVM chain is 0x and then forty hexadecimal characters, with nothing else on it",
  )
  .refine(
    carriesItsOwnChecksum,
    "the capital letters in an address are a checksum over the address itself, and these do not" +
      " match the rest of it — so a character in it is wrong, or something has changed its case" +
      " along the way; paste it again exactly as your wallet shows it, or write it all in lower" +
      " case",
  )
  .meta({
    description:
      "An address on an EVM chain: 0x and forty hexadecimal characters. Two spellings are accepted and no others — all in lower case, which carries no checksum, and the exact mixed-case spelling a wallet shows, which is the EIP-55 checksum of the address. Anything between the two is refused, because the capitals are a checksum and letters that disagree with the digits mean a character is wrong; an address that is wrong is another perfectly valid address belonging to somebody else. That checksum is not part of this document: JSON Schema cannot express it, so a client generated from here checks the shape and this gateway checks the rest. What is stored and what comes back is always the mixed-case spelling a wallet shows, whichever of the two was sent — it is the form a person can recognise at a glance, which on the one field money is sent to is the whole of the checking anybody does.",
  });

export type EvmAddress = z.infer<typeof EvmAddressSchema>;
