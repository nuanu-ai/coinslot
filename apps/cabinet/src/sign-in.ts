/**
 * The three pages a password is typed into: signing in, registering, and
 * changing a password.
 *
 * ADR-0009 replaced the old arrangement, in which the box asked for the
 * gateway's merchant key and the cookie then carried it. A person has an
 * account now, and the key never reaches a browser at all — it is on the row of
 * whoever is signed in (ADR-0014 §2).
 *
 * No page here ever puts back what was typed into it. A form that helpfully
 * refills the password box after a refusal puts the password into the HTML,
 * which is where a proxy, a cache and a browser's own history can all reach it —
 * and the address box is not refilled either, because a password typed into the
 * wrong box would be echoed by exactly that helpfulness. That costs the person
 * who mistyped one field their other three, and it is the trade this file keeps
 * making: a form is cheap to fill in twice, and a password in a cache is not
 * cheap at all.
 *
 * There is a link to registration now and there is still no "forgot your
 * password". The first used to be a door onto a corridor that was never built;
 * ADR-0014 built the corridor. The second is unchanged and is answered by the
 * command that sets a new password, because nothing here sends mail.
 */

import { bare, escaped } from "./html.js";

export const signInScreen = (base: string, problem?: string): string =>
  bare(
    base,
    "Sign in",
    `<div class="gate">
<form method="post" action="${escaped(base)}/sign-in">
  <h1>Coinslot</h1>
  <p>Sign in with the address and password your account was made with.</p>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button class="primary" type="submit">Sign in</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet">Selling here for the first time? <a href="${escaped(base)}/register">Register</a>, which takes the invitation you were given along with the address of this site.</p>
</form>
</div>`,
  );

/**
 * The form that makes a merchant, a key and an account at once.
 *
 * Four boxes, because that is what the act needs: who signs in, what they sign
 * in with, the name the merchant is shown under in the catalogue every buyer
 * reads, and the invitation that stands in the door until an address can be
 * confirmed (ADR-0014 §3).
 *
 * The page says what the address is and is not. Nothing is sent to it — not a
 * confirmation, not a reset — so a person who registers has shown they hold an
 * invitation and not that they hold the address they typed (ADR-0014 §4).
 * Saying so here rather than only in a decision is the difference between a
 * merchant knowing that and finding it out when they lose the password.
 */
export const registerScreen = (base: string, minimum: number, problem?: string): string =>
  bare(
    base,
    "Register",
    `<div class="gate">
<form method="post" action="${escaped(base)}/register">
  <h1>Coinslot</h1>
  <p>Registering makes your merchant, its first key and your account together. You are signed in at the end of it.</p>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="${minimum}" required>
  <label for="name">The name your products are sold under</label>
  <input id="name" name="name" type="text" autocomplete="organization" maxlength="32" required>
  <p class="quiet">Buyers read this name beside your products. At most 32 characters, all of them ordinary keyboard characters, with no space at either end — that is the rule of the catalogue that lists you, not ours.</p>
  <label for="invitation">Invitation</label>
  <input id="invitation" name="invitation" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  <p class="quiet">The code you were given along with the address of this site. Registering is not open to everybody yet, and this is what stands in the door until an address can be confirmed.</p>
  <button class="primary" type="submit">Register</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet">Your address is a name you sign in with. It is not confirmed by anybody and nothing is ever sent to it, so keep the password somewhere safe: losing it is answered by asking us, not by a link in your mail.</p>
  <p class="quiet">Already have an account? <a href="${escaped(base)}/sign-in">Sign in</a>.</p>
</form>
</div>`,
  );

/**
 * Changing a password, for somebody who is already signed in.
 *
 * The current one is asked for even though the session already proves who this
 * is. Without it an unattended tab is a way to take the account outright rather
 * than merely to use it while it is open — and the person who walks away from a
 * screen is the case this whole page is for.
 */
export const passwordScreen = (
  base: string,
  who: string,
  minimum: number,
  problem?: string,
): string =>
  bare(
    base,
    "Your password",
    `<div class="gate">
<form method="post" action="${escaped(base)}/password">
  <h1>Coinslot</h1>
  <p>A new password for ${escaped(who)}. It ends every session you have, on this device and any other, so you will sign in again with the new one.</p>
  <label for="current">Current password</label>
  <input id="current" name="current" type="password" autocomplete="current-password" autofocus required>
  <label for="fresh">New password</label>
  <input id="fresh" name="fresh" type="password" autocomplete="new-password" minlength="${minimum}" required>
  <button class="primary" type="submit">Change it</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet">That address is not confirmed by anybody and nothing is ever sent to it — it is the name you sign in with. If the new password is lost, ask us for another one; there is no link we can mail you.</p>
  <p class="quiet"><a href="${escaped(base)}/cards">Back to your cards</a></p>
</form>
</div>`,
  );
