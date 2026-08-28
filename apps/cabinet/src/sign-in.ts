/**
 * The pages a password is typed into or asked about: signing in, registering,
 * changing a password, asking for a new one when it is lost, choosing that new
 * one, and the page a confirmation link lands on.
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
 * The one exception is the hidden field on the page that a link lands on. What
 * it carries is the link's own token, which the person following the link
 * already holds and which the page has nothing else to identify them by.
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
  <p class="quiet"><a href="${escaped(base)}/password/forgot">Lost your password?</a></p>
  <p class="quiet">Selling here for the first time? <a href="${escaped(base)}/register">Register</a>, which takes the invitation you were given along with the address of this site.</p>
</form>
</div>`,
  );

/**
 * The form that makes a merchant, a key and an account at once.
 *
 * Three boxes, and it was four. Who signs in, what they sign in with, and the
 * invitation that stands in the door until registration is open to everybody.
 *
 * The fourth was the name a merchant's products are sold under, and it is gone
 * from here on purpose. On this form it asked for a public answer at the one
 * moment somebody knows least — no products, no catalogue seen, nothing yet to
 * name — and what a form like that collects is whatever gets past it, which is
 * then printed beside their products for buyers to read. It is asked for after
 * the account exists, where it has room to say why it matters and where it can
 * be changed. Until it is chosen, publishing a card is refused.
 *
 * The page says what the address is for and what it is not yet. A person who
 * registers has shown they hold an invitation, not that they hold the address
 * they typed — so the account works from the first minute and one thing waits
 * on confirming it, which is being sent a new password if this one is lost.
 * Saying so here rather than only in a decision is the difference between a
 * merchant knowing that and finding it out on the day it matters.
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
  <label for="invitation">Invitation</label>
  <input id="invitation" name="invitation" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  <p class="quiet">The code you were given along with the address of this site. Registering is not open to everybody yet, and this is what stands in the door for now.</p>
  <button class="primary" type="submit">Register</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet">Your account works straight away. We send one message to that address, when you ask us to, so that you can confirm it reaches you — and a confirmed address is what lets us send you a new password if you ever lose this one.</p>
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
  <p class="quiet">If you lose it, <a href="${escaped(base)}/password/forgot">ask us for a new one</a>. That works only once you have confirmed the address, so that a link replacing a password is never sent to an address nobody has answered from.</p>
  <p class="quiet"><a href="${escaped(base)}/cards">Back to your cards</a></p>
</form>
</div>`,
  );

/**
 * The form somebody fills in when they cannot get in at all.
 *
 * It takes an address and says nothing about it. Whether that address has an
 * account here, and whether it has been confirmed, are both answered with the
 * same page — because a form that answered them would be a way of asking who
 * sells here, put in front of anybody who finds the hostname.
 */
export const forgotScreen = (base: string, problem?: string): string =>
  bare(
    base,
    "Lost your password",
    `<div class="gate">
<form method="post" action="${escaped(base)}/password/forgot">
  <h1>Coinslot</h1>
  <p>Give us the address on your account and we will send you a link that lets you choose a new password.</p>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus required>
  <button class="primary" type="submit">Send me a link</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet">This works only for an address that has been confirmed — that is, one somebody has already opened a message at. If yours never was, the person who gave you the address of this site can set a new password for you.</p>
  <p class="quiet"><a href="${escaped(base)}/sign-in">Back to signing in</a></p>
</form>
</div>`,
  );

/**
 * What everybody sees after asking for a new password, whatever happened.
 *
 * One page for four different outcomes — no account, an account nobody has
 * confirmed, a message on its way, and a message the provider would not take —
 * and that is the whole point of it. The alternative is a page that tells any
 * visitor whether a given address sells here.
 *
 * It says what it says honestly: it does not claim a message has been sent. It
 * says what happens if there is an account and the address was confirmed, which
 * is the true statement that covers every case.
 */
export const linkSentScreen = (base: string): string =>
  bare(
    base,
    "Check your mail",
    `<div class="gate">
<form method="get" action="${escaped(base)}/sign-in">
  <h1>Coinslot</h1>
  <p>If that address has an account here and has been confirmed, a link is on its way to it. It works once and stops working after an hour.</p>
  <p class="quiet">We answer the same way whether or not the address has an account, so that this form cannot be used to find out who sells here. If nothing arrives, either there is no account at that address or nobody ever confirmed it.</p>
  <button type="submit">Back to signing in</button>
</form>
</div>`,
  );

/**
 * Choosing the new password, on the page the link lands on.
 *
 * The token travels in a hidden field rather than staying in the address, so
 * that the value is not in the browser's history, not in a referrer sent to
 * whatever the next page links to, and not in the log of anything in front of
 * this cabinet.
 */
export const newPasswordScreen = (
  base: string,
  token: string,
  minimum: number,
  problem?: string,
): string =>
  bare(
    base,
    "Choose a new password",
    `<div class="gate">
<form method="post" action="${escaped(base)}/password/new">
  <h1>Coinslot</h1>
  <p>Choose a new password. Every session you had ends with it, so you will sign in again with the new one.</p>
  <input type="hidden" name="token" value="${escaped(token)}">
  <label for="fresh">New password</label>
  <input id="fresh" name="fresh" type="password" autocomplete="new-password" minlength="${minimum}" autofocus required>
  <button class="primary" type="submit">Set it</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  <p class="quiet"><a href="${escaped(base)}/sign-in">Back to signing in</a></p>
</form>
</div>`,
  );

/**
 * Where a confirmation link lands.
 *
 * Both endings are the same page with a different sentence. The unhappy one
 * names the ordinary reason a link stops working, which is that it sat too
 * long, because that is what actually happens — and a person who knows that can
 * ask for another one from inside the cabinet.
 *
 * Following a working link a second time is not one of the unhappy endings. The
 * address is confirmed either way and the page says so, which is the true
 * answer: the link is worth an hour rather than one use, and a page that
 * refused the second click would be telling somebody their address is not
 * confirmed when it is.
 */
export const confirmedScreen = (base: string, worked: boolean): string =>
  bare(
    base,
    worked ? "Address confirmed" : "That link does not work",
    `<div class="gate">
<form method="get" action="${escaped(base)}/cards">
  <h1>Coinslot</h1>
  ${
    worked
      ? "<p>Your address is confirmed. If you ever lose your password, we can send you a link that replaces it.</p>"
      : '<p>That link does not work. A link stops working an hour after it is sent.</p><p class="quiet">Sign in and press the button beside your address to have another one sent.</p>'
  }
  <button type="submit">Go to your cards</button>
</form>
</div>`,
  );
