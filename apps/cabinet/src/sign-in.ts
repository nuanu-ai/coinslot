/**
 * The two pages a password is typed into: signing in, and changing it.
 *
 * ADR-0009 replaced the old arrangement, in which the box asked for the
 * gateway's merchant key and the cookie then carried it. A person has an
 * account now; the key is the cabinet's own configuration and never reaches a
 * browser.
 *
 * Neither page ever puts back what was typed into it. A form that helpfully
 * refills the password box after a refusal puts the password into the HTML,
 * which is where a proxy, a cache and a browser's own history can all reach it —
 * and the address box is not refilled either, because a password typed into the
 * wrong box would be echoed by exactly that helpfulness.
 *
 * There is no link to a sign-up and no "forgot your password". Neither exists,
 * and offering one would be a door onto a corridor that was never built.
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
  <p class="quiet"><a href="${escaped(base)}/cards">Back to your cards</a></p>
</form>
</div>`,
  );
