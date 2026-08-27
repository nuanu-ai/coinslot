/**
 * Signing in, which for v0 is the merchant's API key and nothing else.
 *
 * There is no account here: the pilot's stage one is one merchant with one key
 * (`MERCHANT_API_KEY` on the gateway), and the key is exactly what the API
 * accepts. Anything cleverer — a password, a session store, a second factor —
 * would be authentication against a directory that does not exist.
 *
 * What that costs is written down rather than left to be found. The key is
 * kept in the session cookie, so a merchant's browser holds a working API key
 * for as long as the cookie lives; the cookie is HttpOnly so no script on the
 * page can read it, SameSite=Strict so another site cannot make the browser
 * press "stop all selling", and Secure wherever the cabinet is served over
 * https. It is not signed, because signing it would only prove the cabinet
 * issued a value that is itself the credential.
 */

import { bare, escaped } from "./html.js";

export const signInScreen = (base: string, problem?: string): string =>
  bare(
    base,
    "Sign in",
    `<div class="gate">
<form method="post" action="${escaped(base)}/sign-in">
  <h1>Coinslot</h1>
  <p>Sign in with the API key your gateway is configured with. It is the same key your own code sends.</p>
  <label for="key">Merchant key</label>
  <input id="key" name="key" type="password" autocomplete="off" autofocus required>
  <button class="primary" type="submit">Sign in</button>
  ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
</form>
</div>`,
  );
