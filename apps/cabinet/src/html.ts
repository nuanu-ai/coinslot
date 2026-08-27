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

/** Text on its way into a page, with the five characters that are not text. */
export const escaped = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Which of the three screens is being looked at. */
export type Tab = "cards" | "orders" | "receipts";

export interface Chrome {
  /** Where the cabinet is mounted, "" when it is at the root of its origin. */
  readonly base: string;
  /**
   * The address of the person signed in.
   *
   * On every page, in the corner, because a merchant with two people has to be
   * able to tell whose screen this is before pressing the control that stops
   * all their selling.
   */
  readonly who: string;
  readonly tab: Tab;
  readonly title: string;
  /** The merchant's own selling word, for the light in the corner. */
  readonly selling: { readonly text: string; readonly tone: string };
  readonly body: string;
}

const TABS: readonly [Tab, string][] = [
  ["cards", "Cards"],
  ["orders", "Orders"],
  ["receipts", "Receipts"],
];

/**
 * One whole page.
 *
 * The stylesheet is linked rather than inlined so that a merchant moving
 * between the three screens fetches it once, and so that the one visual
 * language ADR-0005 §6 asks for is one file rather than three copies.
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
      <span class="state ${chrome.selling.tone}"><span class="dot"></span>${escaped(chrome.selling.text)}</span>
      <a class="who" href="${escaped(chrome.base)}/password">${escaped(chrome.who)}</a>
      <form class="inline" method="post" action="${escaped(chrome.base)}/sign-out">
        <button type="submit">Sign out</button>
      </form>
    </div>
  </div>
${chrome.body}
</div>
</body>
</html>
`;

/** A page with no navigation, for a merchant who is not signed in yet. */
export const bare = (base: string, title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(title)} — Coinslot</title>
<link rel="stylesheet" href="/styles/fonts.css">
<link rel="stylesheet" href="${escaped(base)}/coinslot.css">
</head>
<body>
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
