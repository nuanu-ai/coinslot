/**
 * The two screens the name buyers read is chosen on: the one a merchant meets
 * straight after registering, and the settings page it is changed on afterwards.
 *
 * It used to be a box on the registration form, between a password and an
 * invitation code, and moving it is the whole point of this file. There it was
 * a public answer — printed beside the products every buyer sees — demanded at
 * the one moment a merchant knows least: no products yet, no catalogue seen,
 * nothing anywhere saying what the name is for. What a form like that collects
 * is whatever was closest to hand, and whatever was closest to hand is then
 * what strangers read. Here there is room to say what the name does before
 * asking for it, room for an example, and room to promise it can be changed.
 *
 * Skipping is allowed on the first of the two screens, because a name demanded
 * before somebody can answer it is a name nobody means. What is not allowed is
 * skipping it silently: until a name is set, publishing a card is refused, and
 * every screen a merchant works on says so with a way to fix it.
 *
 * Neither screen fetches anything or decides anything, which is what lets a
 * test read the page a merchant would be looking at.
 */

import { ServiceNameSchema } from "@coinslot/contracts";
import { bare, escaped, page } from "./html.js";
import type { Viewer } from "./screens.js";

/**
 * What a name has to be, said in words a person can act on.
 *
 * The rule itself is the contract's `ServiceNameSchema` and is applied by
 * asking it rather than by writing it out again in code: it is the discovery
 * catalogue's own rule, because that catalogue is where this name goes, and a
 * second copy of it here would be the copy that goes stale. What is written out
 * is only the sentence, because the schema's messages are one per broken rule
 * and somebody filling in a form is better served by the whole rule once.
 *
 * It is on both screens before anybody types, rather than only after a refusal,
 * so that the common case is a name that fits.
 */
export const NAME_RULE =
  "The name your products are sold under is at most 32 characters, all of them ordinary" +
  " keyboard characters, with no space at either end. That is the rule of the catalogue that" +
  " will list you under it, not ours.";

/**
 * What somebody is told whose name the catalogue would not carry.
 *
 * The rule is already printed beside the box, so this does not repeat it: a
 * refusal that answers with the same paragraph a second time reads as the page
 * failing to notice anything happened. What the person cannot see for
 * themselves is that nothing was written, which is the half this carries.
 *
 * The name is checked here as well as at the gateway so that this is what comes
 * back rather than the gateway's own refusal, which is written for whoever is
 * reading an API response and names a route rather than a page.
 */
export const NAME_REFUSED =
  "That is not a name the catalogue will carry, so it was not saved. The rule it has to keep" +
  " to is printed on this page.";

/** What somebody who pressed the button with an empty box is told, first time. */
export const NAME_NEEDED =
  "A name is needed here. If you have not settled on one yet, leave this for now with the link" +
  " below and come back to it in your settings.";

/**
 * What somebody is told who tries to empty the name they already have.
 *
 * The route refuses it, and that is a rule rather than a gap in the screen. A
 * card on sale with nobody named beside it reaches a buyer inside a request to
 * pay somebody the request does not name, which is the thing this whole field
 * exists to stop. Coming off sale is a different act with a different control,
 * and it is the one that does what somebody emptying this box actually wants:
 * it leaves the cards where they are, so a merchant can put them back.
 */
export const NAME_CANNOT_BE_TAKEN_AWAY =
  "This name cannot be emptied. A product on sale with nobody named beside it reaches a buyer" +
  " inside a request to pay somebody the request does not name, so there is no way here to go" +
  " back to having none. To come off sale, stop your selling from the cards screen: your cards" +
  " stay where they are and one press puts them back.";

/** What is wrong with a name somebody typed, in a sentence, or null. */
export const whatIsWrongWithTheName = (name: string): string | null =>
  ServiceNameSchema.safeParse(name).success ? null : NAME_REFUSED;

/**
 * What the name is for, and what one looks like.
 *
 * The example is the shape of the mistake rather than a decorated version of
 * the rule: the name people already know, not a description of the goods. A
 * merchant who writes their catalogue into this box ends up listed under their
 * own stock list, and nothing further down the line corrects it.
 */
const WHAT_IT_IS_FOR = `<p>Buyers see this name beside your products, and it is the name on the payment they are asked to approve. Somebody who has never heard of you reads it and decides from it whether to go through with the purchase.</p>
  <p class="quiet">Write the name people already know you by rather than a description of what you sell: a shop selling VPN plans, eSIMs and virtual numbers is listed under its own name, not under &#8220;VPN plans and eSIMs&#8221;.</p>`;

/**
 * The screen a merchant lands on the moment their account exists.
 *
 * Drawn with no navigation, like the registration it follows, because it is the
 * last step of registering rather than a page inside the cabinet. The way out
 * is a link and not a hidden field: whoever skips goes to their cards, which is
 * where the same fact is waiting for them with the page that fixes it.
 */
export const chooseNameScreen = (base: string, problem?: string): string =>
  bare(
    base,
    "The name your products are sold under",
    `<div class="gate">
<form method="post" action="${escaped(base)}/choose-name">
  <h1>Coinslot</h1>
  <p>Your account is made and you are signed in. One thing is left, and it is the only one buyers ever see.</p>
  ${WHAT_IT_IS_FOR}
  <label for="seller_name">The name your products are sold under</label>
  <input id="seller_name" name="seller_name" type="text" autocomplete="organization" maxlength="32" autofocus required>
  <p class="quiet">${escaped(NAME_RULE)}</p>
  <button class="primary" type="submit">Use this name</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet">You can change it whenever you like. Until it is set, nothing you publish goes on sale, and every screen in the cabinet says so.</p>
  <p class="quiet">Not decided yet? <a href="${escaped(base)}/cards">Leave it for now</a> — it is set under <a href="${escaped(base)}/settings">Settings</a> whenever you are ready.</p>
</form>
</div>`,
  );

/**
 * The cabinet's settings, which today hold one thing.
 *
 * One thing and a page of its own rather than a control tucked onto the cards
 * screen: the name is not about a card, it is about the merchant, and the next
 * thing of that kind has somewhere to go. The box is filled from what the
 * gateway answered rather than from what was last typed, so that a merchant
 * refused for a name outside the rule is still looking at what they are
 * actually listed under.
 */
export const settingsScreen = (viewer: Viewer, problem?: string): string => {
  const { base } = viewer;
  const name = viewer.sellerName ?? null;

  const body = `
  <div class="lede">
    <div>
      <h1>Settings</h1>
      <p>${escaped(
        name === null
          ? "You have not chosen the name your products are sold under. Until you do, publishing a card is refused."
          : `Your products are sold under ${name}.`,
      )}</p>
    </div>
  </div>
  <div class="lede">
    <div>
      <h2>The name your products are sold under</h2>
      ${WHAT_IT_IS_FOR}
      <p class="quiet">${escaped(NAME_RULE)}</p>
      <p class="quiet">${escaped(NAME_CANNOT_BE_TAKEN_AWAY)}</p>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/settings">
    <div>
      <label for="seller_name">The name buyers read</label>
      <input id="seller_name" name="seller_name" type="text" autocomplete="organization" maxlength="32" value="${escaped(name ?? "")}" required>
    </div>
    <button class="primary" type="submit">Save it</button>
    ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  </form>
`;

  return page({
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "settings",
    title: "Settings",
    body,
  });
};
