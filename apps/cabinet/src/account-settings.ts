/**
 * The half of the settings screen that is about the person rather than about
 * the shop: the address they sign in with, whether anybody has answered from
 * it, and the way to the page a password is changed on.
 *
 * The settings used to hold one thing, the name buyers read, and the address in
 * the corner of every page led straight to the password form. That put the two
 * halves of an account in two places and named neither: the page a merchant
 * reaches by pressing their own name was a form for the one thing about an
 * account somebody does rarely, and the page called Settings said nothing about
 * them at all. Both halves are here now, each under a heading that says which
 * it is, and the corner leads here.
 *
 * The password keeps its own page and its own handler. What that page does —
 * ask for the current password, refuse a short one, end every session that
 * person has — is a rule with somewhere to live already, and a second form here
 * would be a second place for it to be got wrong. This is the way in.
 *
 * Nothing here fetches anything or decides anything. It is a function from what
 * the cabinet already knows about the person signed in to a piece of a page,
 * which is what lets a test read the words a merchant would be looking at.
 */

import { escaped } from "./html.js";
import type { Viewer } from "./screens.js";

/**
 * What a confirmed address buys, said as the thing it buys rather than as a
 * state.
 *
 * "Confirmed" is a word about our records. What a merchant can act on is the
 * consequence: somebody has read mail at that address, so a password lost
 * tomorrow can be replaced without asking anybody for help.
 */
const CONFIRMED =
  "Somebody has answered from that address, so if you ever lose your password we can send you a" +
  " link that replaces it.";

/**
 * What an unconfirmed address costs, and who is left holding the account.
 *
 * The cost only shows up on the day the password is gone, which is a day this
 * page cannot be read — so it is said here while there is still time, and it is
 * said with the way out rather than as a bare refusal. A page that said only
 * "we cannot send you a link" would leave a merchant believing a lost password
 * ends the account.
 *
 * There are two ways out and this names both, in the order somebody would take
 * them. The first is the control at the top of every page, which is named here
 * by the words on it: a page reading "we cannot send you a link" a few lines
 * under a button reading "Send me the link" is a page that contradicts itself
 * to anybody who does not already know the two links are different things. The
 * second is the person who handed over the address of this site, who can set a
 * new password from a terminal — the answer for somebody whose password is
 * already gone, who cannot do the first.
 */
const NOT_CONFIRMED =
  "Nobody has answered from that address, so we cannot send you a link to replace a lost" +
  " password. Press Send me the link at the top of this page and answer the mail it sends, and" +
  " we can. Until somebody answers, the person who gave you the address of this site is the one" +
  " who can set a new password for you.";

/**
 * What this section cannot do, and what pressing its one control costs.
 *
 * The address is the first thing a person looks for a way to change on a page
 * headed by their own address, and there is no way to change it. Saying so is
 * one sentence; leaving it out sends somebody hunting through five screens for
 * a control nobody has written. "Yet" is doing work there — it is a gap rather
 * than a rule, and a sentence that read like a rule would be a claim we have
 * not made anywhere.
 *
 * The password page says the second sentence too, and it says it to somebody
 * who has already left the page they were working on. A merchant deciding
 * whether to do this now is the one who needs to know that everything they have
 * open closes.
 */
const WHAT_THE_CONTROLS_DO =
  "There is no way to change the address itself yet. Changing your password ends every session" +
  " you have, on this device and any other, so you sign in again with the new one.";

export const accountSettings = (viewer: Viewer): string => `
  <div class="lede">
    <div>
      <h2>The account you sign in with</h2>
      <p>${escaped(
        // The address is named here as well as in the corner. In the corner it
        // is a label saying whose screen this is; here it is the subject, and a
        // section about somebody's account that never names the account leaves
        // them reading the corner to work out whose settings these are.
        `You sign in as ${viewer.who}. ${viewer.confirmed ? CONFIRMED : NOT_CONFIRMED}`,
      )}</p>
      <p class="quiet">${escaped(WHAT_THE_CONTROLS_DO)}</p>
    </div>
  </div>
  <form class="issue" method="get" action="${escaped(viewer.base)}/password">
    <button type="submit">Change your password</button>
  </form>
`;
