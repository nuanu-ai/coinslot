/**
 * The two screens a merchant keeps their keys on: the list, and the one page a
 * new key's secret is ever shown on.
 *
 * A key is what a merchant's own code opens the door with. ADR-0010 made each
 * one a row so that it can be revoked on its own — without touching any other
 * key, and without touching anybody's session in this cabinet — and ADR-0014 §5
 * brings that from a command somebody runs at a terminal to a screen.
 *
 * Two things about the list are decisions rather than layout. The revoked keys
 * are on it, because "which key did I turn off, and when" is a question
 * somebody has on exactly this screen and a list of only the working ones
 * answers it with silence. And the key this cabinet's own calls are made with —
 * which the list itself names, as `this_call` — has no control beside it. That
 * is the one click the gateway refuses (ADR-0014 §5), and the refusal is worth
 * reading precisely: it is about the key in front of it and not about whichever
 * key some cabinet happens to hold, which the gateway has no way of knowing. So
 * this screen keeps a merchant from closing the door of the cabinet they are
 * standing in, and it cannot keep them from closing the door of another one
 * they are signed into elsewhere.
 *
 * Neither screen fetches anything or decides anything. Each is a function from
 * what the gateway answered to a page, which is what lets a test read the page
 * a merchant would be looking at.
 */

import type { MerchantKey, MerchantKeyList } from "@nuanu-ai/coinslot-contracts";
import { escaped, page } from "./html.js";
import type { Viewer } from "./screens.js";
import { moment } from "./words.js";

const keyRow = (base: string, entry: MerchantKey, thisCall: string): string => {
  const revoked = entry.disabled_at !== null;
  return `<tr class="${revoked ? "off" : ""}">
<td><div class="title">${escaped(entry.label)}</div><div class="under mono">${escaped(entry.id)}</div></td>
<td class="quiet">${escaped(moment(entry.created_at))}</td>
<td class="quiet">${revoked ? escaped(`Revoked ${moment(entry.disabled_at ?? "")}`) : "Works"}</td>
<td class="control">${keyControl(base, entry, thisCall)}</td>
</tr>`;
};

/**
 * What a merchant can do to one key from this list, which is sometimes nothing.
 *
 * The key this cabinet signed in with says so in words rather than showing a
 * control that would be refused. A key that is already revoked shows nothing at
 * all: there is no undo — a revoked key never works again — and a control that
 * looked like one would be a promise the gateway does not make.
 */
const keyControl = (base: string, entry: MerchantKey, thisCall: string): string => {
  if (entry.disabled_at !== null) {
    return "";
  }
  if (entry.id === thisCall) {
    return '<span class="quiet">This is the key this cabinet is using</span>';
  }
  // Named "Revoke" rather than "Disable", because it does not come back and the
  // word people already use for a credential that does not come back is this
  // one. The page says so in words above the table as well; a control with no
  // confirmation behind it should not be the only place that is said.
  return `<form class="inline" method="post" action="${escaped(base)}/keys/${encodeURIComponent(entry.id)}/disable">
<button type="submit">Revoke</button></form>`;
};

export const keysScreen = (viewer: Viewer, keys: MerchantKeyList, problem?: string): string => {
  const { base } = viewer;
  const working = keys.keys.filter((entry) => entry.disabled_at === null).length;

  const body = `
  <div class="lede">
    <div>
      <h1>Keys</h1>
      <p>${escaped(
        `${working} of the ${keys.keys.length} ${keys.keys.length === 1 ? "key" : "keys"} below` +
          `${working === 1 ? " works" : " work"}. A key is what your code opens the door with.` +
          " Revoking one stops that key from that moment and does not stop anything else: your" +
          " other keys go on working, and nobody is signed out of this cabinet. It is not undone" +
          " — a revoked key never opens the door again, and what replaces it is a new one.",
      )}</p>
    </div>
  </div>
${
  keys.keys.length === 0
    ? '<div class="scroller"><p class="empty">There are no keys here at all, which cannot happen while you are reading this page — the cabinet reached the gateway with one.</p></div>'
    : `<div class="scroller"><table>
<thead><tr><th>Name</th><th>Made</th><th>State</th><th></th></tr></thead>
<tbody>${keys.keys.map((entry) => keyRow(base, entry, keys.this_call)).join("")}</tbody>
</table></div>
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(
    "This is what the gateway answered with, and its answer does not say whether it is all of" +
      " them. Nothing pages this list yet and nothing here counts your keys for you — the number" +
      " above counts the rows below and nothing more.",
  )}</span></div>`
}
  <div class="lede">
    <div>
      <h2>A new key</h2>
      <p>The name is for you: it is how you tell one key from another on this page when you come to revoke one. The key itself is shown once, on the page that makes it, and nothing keeps a readable copy of it.</p>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/keys">
    <div>
      <label for="label">What this key is for</label>
      <input id="label" name="label" type="text" autocomplete="off" required>
    </div>
    <button class="primary" type="submit">Issue a key</button>
    ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  </form>
`;

  return page({
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "keys",
    title: "Keys",
    body,
  });
};

/**
 * The one page a key's secret appears on, ever.
 *
 * It is answered straight from the post rather than after a redirect, which is
 * the one place in this cabinet that happens. A redirect cannot carry the
 * secret: putting it in the address would write it into the browser's history
 * and into every log between here and there, and keeping it anywhere to hand to
 * the next request would be storing the thing we have just promised not to
 * store. So the page says out loud what that costs — reloading it asks the
 * browser to send the form again, and that issues another key.
 */
export const newKeyScreen = (viewer: Viewer, label: string, secret: string): string => {
  const { base } = viewer;
  const body = `
  <div class="lede">
    <div>
      <h1>Your new key</h1>
      <p>${escaped(`This is the key for "${label}". It is shown here and nowhere else, now and never again — nothing on our side keeps a readable copy of it, so a key you do not copy is a key you have to replace.`)}</p>
    </div>
  </div>
  <div class="scroller"><p class="secret">${escaped(secret)}</p></div>
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(
    "Put it where your code reads its key from before you leave this page. Reloading this page" +
      " asks your browser to send the form again, which issues another key rather than showing" +
      " you this one.",
  )}</span></div>
  <p class="quiet"><a href="${escaped(base)}/keys">Back to your keys</a></p>
`;

  return page({
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "keys",
    title: "Your new key",
    body,
  });
};
