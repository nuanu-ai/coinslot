/**
 * The block on the settings screen where a merchant says which address their
 * money arrives at.
 *
 * Payments here are not held by anybody in the middle: a buyer's agent pays the
 * merchant's own address, and nothing of the merchant's ever sits with us. That
 * is the whole reason this field exists, and it is also why it is one field.
 * The address is enough to be paid with; a private key or a recovery phrase
 * would be enough to spend with, and there is nowhere in this cabinet to type
 * either. The screen says so out loud, because somebody who has been asked for
 * a recovery phrase once by a page that looked like this one has no other way
 * to tell the two apart.
 *
 * Two things on this screen are decisions rather than layout.
 *
 * The first is that a missing address gets no banner. The name a merchant is
 * listed under gets one on every screen, because a card published without a
 * name is refused everywhere, always. This one is not: where nothing settles,
 * publishing without an address is not refused, and a line saying "your
 * products cannot go on sale" would then be a page telling a merchant something
 * that is not happening. So the consequence is written once, here, in the form
 * that says which case is which.
 *
 * The second is how a saved address is shown back. It is shown whole, never
 * with the middle left out. Forty characters is more than anybody reads, and
 * the shortening everybody reaches for — the first few, dots, the last few — is
 * the one presentation under which a wrong address and the right one look
 * identical. So the whole of it is on the page, grouped in fours the way a
 * long number is, with no space actually in the text: a merchant reads it
 * against their wallet group by group, and a merchant who selects it gets the
 * address back rather than a spaced-out copy of it that pastes wrong.
 *
 * What is shown is whatever the gateway answered with, untouched. That is not
 * indifference about the spelling — it is where the spelling is decided. The
 * capitals in an address are a checksum over the address itself, the gateway
 * keeps every address in the mixed-case spelling a wallet displays, and it
 * answers in that spelling whichever of the two accepted spellings it was
 * given. So a merchant who pasted their address in lower case reads it back the
 * way their own wallet shows it, and this page never has to ask anybody to take
 * on trust that two spellings are one address.
 */

import { EvmAddressSchema } from "@nuanu-ai/coinslot-contracts";

import { escaped } from "./html.js";
import type { Viewer } from "./screens.js";

/**
 * What an address has to look like, and the two things this page cannot tell
 * anybody about it.
 *
 * The rule itself is the contract's and is applied by asking the schema rather
 * than by writing the pattern out again here; what is written out is the
 * sentence, because a schema's message is one per broken rule and somebody
 * filling in a box is better served by the whole rule once.
 *
 * The second half is the part it would be easy to leave off. Nothing in the
 * cabinet looks an address up anywhere — there is no chain call on this path
 * and no balance read — so a box that turned green would be promising something
 * nobody checked. Said plainly, a merchant knows the check they still have to
 * do themselves is the only one there is.
 */
export const WALLET_RULE =
  "An address is 0x followed by forty characters, each of them a digit or a letter from a to f." +
  " Paste it exactly as your wallet shows it, capitals and all, or write it all in lower case:" +
  " those capitals are a check the address carries on itself, so a spelling that is neither of" +
  " those two is refused rather than guessed at. It comes back written the way your wallet" +
  " writes it. Past that check nothing here looks the address up anywhere, so this page cannot" +
  " tell you that the address exists, that it is yours, or that anything has ever been paid to" +
  " it — copy it from your wallet rather than typing it out.";

/** What somebody who pressed the button with an empty box is told. */
export const WALLET_NEEDED =
  "An address is needed here. Copy it out of the wallet you want to be paid in rather than" +
  " typing it, and paste the whole of it.";

/**
 * The half of a refusal this file writes, and the half a merchant cannot see.
 *
 * They can see the box still holding what they typed. Whether it went anywhere
 * is the thing they cannot, and on this one field that is the difference
 * between money arriving where they meant it and money arriving somewhere else.
 */
const NOTHING_WAS_SAVED = "It was not saved.";

/**
 * What is wrong with an address somebody typed, in a sentence, or null.
 *
 * The sentence is the rule's own, asked of the schema rather than written out
 * here a second time. Two rules can fail and they fail differently: forty
 * characters that are not an address at all, and forty of the right shape whose
 * capitals disagree with the rest — which means a character in it is wrong, and
 * is the failure this box exists to catch at all. One sentence covering both
 * would have to say "that is not an address", which is untrue of the second and
 * leaves a merchant re-reading a spelling that looks perfectly fine.
 */
export const whatIsWrongWithTheWallet = (address: string): string | null => {
  const read = EvmAddressSchema.safeParse(address);
  if (read.success) {
    return null;
  }
  const said = read.error.issues[0]?.message;
  return said === undefined
    ? NOTHING_WAS_SAVED
    : `${said.slice(0, 1).toUpperCase()}${said.slice(1)}. ${NOTHING_WAS_SAVED}`;
};

/**
 * What the merchant's payout address is on the screen drawing it.
 *
 * The refusal travels with the address rather than beside it because one block
 * draws both, and a screen holding one without the other cannot draw that
 * block at all.
 */
export interface PayoutWallet {
  /** What the gateway answered: the address, or null where none is set. */
  readonly wallet: string | null;
  /** What was wrong with the address just typed, where one was refused. */
  readonly problem?: string;
}

/**
 * One address, whole, in groups of four.
 *
 * The groups are spans with nothing between them, so the gaps are the
 * stylesheet's and not the text's. That is the difference between a merchant
 * who copies this and pastes an address and a merchant who copies this and
 * pastes something no wallet will accept.
 */
const inFours = (address: string): string => {
  const lead = address.slice(0, 2);
  const rest = address.slice(2);
  const groups = rest.match(/.{1,4}/g) ?? [];
  return `<span class="lead">${escaped(lead)}</span>${groups
    .map((group) => `<span class="quad">${escaped(group)}</span>`)
    .join("")}`;
};

/** The address as it stands, with what to do with it before trusting it. */
const savedAddress = (address: string): string => `
  <div class="saved">
    <div class="label">Saved here</div>
    <div class="address">${inFours(address)}</div>
    <p class="under">This is the spelling your own wallet shows, so read it against your wallet group by group. Two addresses that differ only in the middle look the same when the middle is left out, so the whole of it is here.</p>
  </div>`;

/**
 * The block itself.
 *
 * It draws nothing at all where the screen did not ask the gateway for the
 * address, which is every screen but the settings. That is the same rule the
 * line about an unset name follows: a page that did not ask must not say
 * anything either way, and a block drawn from an address nobody fetched would
 * be a page telling a merchant they have set none when they may have.
 *
 * The box beside a saved address starts empty rather than filled with it. An
 * input reads as a draft, and the thing a merchant came here to do — check what
 * is actually stored — is not something a box you can type over can show them.
 * So the stored address is text, the box is for a different one, and the label
 * on it says which of the two acts this is.
 */
export const payoutWalletBlock = (viewer: Viewer): string => {
  const { base, payout } = viewer;
  if (payout === undefined) {
    return "";
  }
  const { wallet, problem } = payout;

  return `
  <div class="lede">
    <div>
      <h2>Where your money arrives</h2>
      <p>Buyers pay you directly. The money goes from the buyer's wallet to this address, and Coinslot never holds it: there is no balance here, nothing to withdraw, and no point on the way where the money sits with us.</p>
      <p>The address is the only thing we ask for, and it is the only thing we can use. There is nowhere on this site to type a private key or a recovery phrase — the words your wallet told you to write down — and nobody here will ever ask you for one.</p>
      <p class="quiet">A product published without this address is refused wherever the payments are real. On a preview, where nothing settles and no money moves, nothing is refused: an empty box there stops nothing, and a sale that goes through there has paid nobody.</p>
    </div>
  </div>${wallet === null ? "" : savedAddress(wallet)}
  <div class="lede">
    <div>
      <p class="quiet">${escaped(WALLET_RULE)}</p>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/settings/payout-wallet">
    <div>
      <label for="payout_wallet">${wallet === null ? "The address your money arrives at" : "Change it to a different address"}</label>
      <input id="payout_wallet" name="payout_wallet" type="text" autocomplete="off" spellcheck="false" maxlength="42" size="42" required>
    </div>
    <button class="primary" type="submit">${wallet === null ? "Save it" : "Change the address"}</button>
    ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  </form>
`;
};
