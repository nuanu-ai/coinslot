/**
 * Building a page out of strings, and the escaping that makes that safe.
 *
 * There is no template engine here because ADR-0005 §4 asks for no build step
 * and three lists do not need one. What that trades away is the engine's
 * automatic escaping, so the escaping is the first thing in this file and
 * everything that reaches a page goes through it. A merchant's own card title
 * is not hostile input in any interesting sense, but it is text somebody else
 * wrote, and a title containing a `<` would otherwise silently break the page
 * it appears on.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS, type SurfaceMode } from "@coinslot/core";

/** Text on its way into a page, with the five characters that are not text. */
export const escaped = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Which of the screens with navigation on them is being looked at. */
export type Tab = "cards" | "orders" | "receipts" | "keys" | "settings";

export interface Chrome {
  /** Which of the three things this stack is, so every page names it. */
  readonly mode: SurfaceMode;
  /** Where the cabinet is mounted, "" when it is at the root of its origin. */
  readonly base: string;
  /**
   * The address of the person signed in.
   *
   * On every page, in the corner, because a merchant with two people has to be
   * able to tell whose screen this is before pressing the control that stops
   * all their selling.
   *
   * It links to the settings, where the account it names is looked after. It
   * used to link to the password form, which is the one thing about an account
   * somebody does rarely — pressing your own name means "show me my account",
   * and the answer to that is a page with the address on it and the password
   * form one press further on.
   */
  readonly who: string;
  /**
   * Whether anybody has shown they can read mail sent to that address.
   *
   * Unconfirmed, every page says so beside the address and offers the one
   * control that changes it. It is on every page rather than on a settings
   * screen because what it costs its owner only shows up on the day they have
   * lost their password — which is a day they cannot read a settings screen.
   */
  readonly confirmed: boolean;
  readonly tab: Tab;
  readonly title: string;
  /**
   * The merchant's own selling word, for the light in the corner.
   *
   * Absent on a screen that is not about selling, which is the keys. The word
   * comes from the card list, and fetching one on a page that draws no cards
   * would be a call to the gateway whose only purpose is a coloured dot — on
   * the one screen a merchant is most likely to be reading because something
   * about their keys has gone wrong.
   */
  readonly selling?: { readonly text: string; readonly tone: string };
  /**
   * Whether this merchant has still chosen no name for buyers to read.
   *
   * True draws the line at the top of the page saying nothing of theirs can go
   * on sale, with the page that fixes it. Absent where the screen did not ask
   * the gateway — the keys, for the reason given above the selling word, and
   * the settings itself, which is the answer rather than a place to be told
   * about the question.
   */
  readonly unnamed?: boolean;
  readonly body: string;
}

const TABS: readonly [Tab, string][] = [
  ["cards", "Cards"],
  ["orders", "Orders"],
  ["receipts", "Receipts"],
  ["keys", "API Keys"],
  ["settings", "Settings"],
];

/** Every page names its mode and warns only where there is something to warn about. */
const surface = (mode: SurfaceMode): string => {
  const words = SURFACE_WORDS[mode];
  return words === null
    ? `<div ${SURFACE_MARKER_ATTRIBUTE}="${escaped(mode)}"></div>`
    : `<div class="surface" ${SURFACE_MARKER_ATTRIBUTE}="${escaped(mode)}"><p class="surface-words">${escaped(words)}</p></div>`;
};

/**
 * The way out of the cabinet, into the documentation.
 *
 * It is the other half of the way out of the documentation, which is a link in
 * the bar of the portal reading "← Coinslot"
 * (portal/.vitepress/theme/index.mjs). The two are one solution and are meant
 * to read as one: the same class name, the same shape — an arrow and the name
 * the destination wears in its own corner — the same muted colour until it is
 * hovered, and the same place, at the edge of the bar beside the navigation
 * rather than inside it. Only the arrow differs, because one side is going
 * back and this one is going out.
 *
 * Not a sixth tab, and that is the whole of why it sits in the right-hand
 * group. The tabs are the five places inside the cabinet, and every one of them
 * hangs off the mount point; a tab that took a merchant off this application
 * altogether would be the row lying about what it is. So it rides with the
 * things in the bar that are not navigation — the selling light, the address,
 * the control that signs a merchant out.
 *
 * The word is "Docs" and not "Documentation" because the page it lands on says
 * "Docs" in its own corner (portal/.vitepress/config.mjs). Whoever presses it
 * arrives at the word they pressed.
 *
 * The address is absolute and carries no base path: ADR-0005 §1 puts the
 * documentation at /docs beside the cabinet at /cabinet on one origin, not
 * under it, so /docs/ is the address on every deployment and the trailing
 * slash is the form Caddy redirects to. Run on its own the cabinet has no
 * /docs and this 404s, exactly as /styles/fonts.css does above, and for the
 * same reason: the shared origin is Caddy's to assemble.
 *
 * The portal's half needs `target="_self"` to escape VitePress's router. There
 * is no router here, so a plain anchor is the whole of it.
 */
const WAY_OUT = '<a class="way-out" href="/docs/" title="The Coinslot documentation">Docs →</a>';

/**
 * One whole page.
 *
 * Beside the address in the corner, until it is confirmed, is the plain fact
 * that nobody has confirmed it and the one control that changes that. It is
 * three words and a button rather than a paragraph because it is on every page;
 * the paragraph is on the pages the address is actually typed into. Once the
 * address is confirmed both go, because a banner that never leaves is a banner
 * nobody reads.
 *
 * The stylesheet is linked rather than inlined so that a merchant moving
 * between the four screens fetches it once, and so that the one visual
 * language ADR-0005 §6 asks for is one file rather than four copies.
 *
 * The faces are linked separately, from the shared origin, because they are
 * woff2 files the landing already serves and their addresses are relative to
 * that directory. Behind Caddy this resolves and the pages are set in IBM Plex;
 * run on its own the cabinet has no /styles, the link 404s and the fallback
 * stack in the tokens carries the page — which is what a fallback stack is for,
 * and why every family here names a full one.
 */
export const page = (chrome: Chrome): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(chrome.title)} — Coinslot</title>
<link rel="stylesheet" href="/styles/fonts.css">
<link rel="stylesheet" href="${escaped(chrome.base)}/coinslot.css">
</head>
<body>
<div class="page">
${surface(chrome.mode)}
  <div class="top">
    <div class="brand">
      <span class="wordmark">coinslot</span>
      <nav class="tabs">${TABS.map(([tab, label]) =>
        tab === chrome.tab
          ? `<span class="here">${label}</span>`
          : `<a href="${escaped(chrome.base)}/${tab}">${label}</a>`,
      ).join("")}</nav>
    </div>
    <div class="whoami">
      ${WAY_OUT}
      ${chrome.selling === undefined ? "" : state(chrome.selling)}
      <a class="who" href="${escaped(chrome.base)}/settings">${escaped(chrome.who)}</a>
      ${
        chrome.confirmed
          ? ""
          : `<span class="tag plain">address not confirmed</span>
      <form class="inline" method="post" action="${escaped(chrome.base)}/confirm">
        <button type="submit">Send me the link</button>
      </form>`
      }
      <form class="inline" method="post" action="${escaped(chrome.base)}/sign-out">
        <button type="submit">Sign out</button>
      </form>
    </div>
  </div>
${chrome.unnamed === true ? unnamedNote(chrome.base) : ""}${chrome.body}
</div>
</body>
</html>
`;

/**
 * The line at the top of every working screen while no name is set.
 *
 * It says the consequence rather than the setting, because the consequence is
 * the part a merchant can feel: a card their code publishes is refused, and
 * without this line the refusal arrives in their own logs with nothing in the
 * cabinet to explain it. The refusal they would read there ends by naming the
 * route that lifts it, which is the right sentence for whoever is holding an
 * API response and the wrong one for somebody looking at a page — so this says
 * the same thing and points at the page that does it instead.
 *
 * It goes once the name is chosen. A line that never leaves is a line nobody
 * reads, and this one is about a state one form post ends.
 */
const unnamedNote = (base: string): string => `  <div class="callout">
    <div class="what">Your products cannot go on sale until you choose the name buyers see beside them.</div>
    <div class="why">A card published while this is unset is refused, because it would be offered for sale with no seller on it. <a href="${escaped(base)}/settings">Choose the name in your settings</a>.</div>
  </div>
`;

/** A page with no navigation, for a merchant who is not signed in yet. */
export const bare = (
  base: string,
  title: string,
  body: string,
  mode: SurfaceMode,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(title)} — Coinslot</title>
<link rel="stylesheet" href="/styles/fonts.css">
<link rel="stylesheet" href="${escaped(base)}/coinslot.css">
</head>
<body>
${surface(mode)}
${body}
</body>
</html>
`;

/** A state with its dot, the way every one of the three screens draws one. */
export const state = (word: { readonly text: string; readonly tone: string }): string =>
  `<span class="state ${word.tone}"><span class="dot"></span>${escaped(word.text)}</span>`;

/** A table with a row for every entry, or one line saying there are none. */
export const table = (
  columns: readonly string[],
  rows: readonly string[],
  nothing: string,
): string =>
  rows.length === 0
    ? `<div class="scroller"><p class="empty">${escaped(nothing)}</p></div>`
    : `<div class="scroller"><table>
<thead><tr>${columns.map((column) => `<th>${escaped(column)}</th>`).join("")}</tr></thead>
<tbody>${rows.join("")}</tbody>
</table></div>`;
