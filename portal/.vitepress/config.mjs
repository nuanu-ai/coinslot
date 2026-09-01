import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// The default theme, wearing our palette (see .vitepress/theme). Everything in
// themeConfig here is navigation and local search: the theme's own labels are
// already in the language the pages are written in, so none of them is
// restated.
//
// withMermaid turns ```mermaid fences into diagrams. It is a wrapper around
// this config and not a markdown plugin beside it, because the diagrams are
// drawn in the reader's browser: the wrapper registers the component, and
// mermaid itself is loaded on the pages that have one. A page with no fence
// pays nothing for it. The fulfillment modes are the only diagrams so far, on
// /orders.
export default withMermaid(defineConfig({
  lang: 'en',
  title: 'Coinslot',
  description:
    'Selling to AI agents with Coinslot: connecting, cards, money and what can go wrong.',
  cleanUrls: true,
  srcExclude: ['WRITING.md'],
  themeConfig: {
    // The corner of the bar reads "← Coinslot  Docs": the first is the way out
    // to the site, added in .vitepress/theme, and this is what the reader is
    // in. Left as the site's own name it said "Coinslot" twice in a row, once
    // as a link home and once as the title of the page it never leaves.
    siteTitle: 'Docs',
    sidebar: [
      {
        text: 'For the owner',
        items: [
          { text: 'Connecting to Coinslot', link: '/' },
          { text: 'Money', link: '/money' },
          { text: 'Common questions', link: '/faq' }
        ]
      },
      {
        text: 'For the engineer',
        // The addresses and the keys come first because they are wanted before
        // the first call rather than after it, and because an engineer who is
        // already integrated comes back for them and will not reread a guide
        // to find one.
        items: [
          { text: 'Where to call, and with which key', link: '/where-to-call' },
          { text: 'The first test sale', link: '/quickstart' },
          { text: 'The product card', link: '/cards' },
          { text: 'Orders and fulfillment modes', link: '/orders' },
          { text: 'What can go wrong', link: '/failures' },
          { text: 'Questions from the engineer', link: '/faq#questions-from-the-engineer' }
        ]
      }
    ],
    search: { provider: 'local' }
  },

  /**
   * Two things, in one hook because VitePress takes one.
   *
   * The first is the preload filtering already written below. The second is the
   * surface marker, on every generated file including the nested ones: a hook
   * that walked a directory could miss one, and the page it missed would be the
   * page a reader lands on. `scripts/check-portal-render.mjs` is what catches
   * that if it happens anyway.
   *
   * The words are written out here rather than imported because this project is
   * outside the workspace and has its own lockfile;
   * `packages/core/src/deployment/surface-markers.test.ts` reads this file and
   * holds these strings against the module the cabinet renders from.
   */
  // Mermaid is registered once for the whole site, so every page's preload list
  // gets its chunks — including the pages with no diagram on them. Measured on
  // the page about connecting, that was 1.54 MB of diagram kinds we never draw
  // (gantt, c4, gitGraph, cytoscape, katex) fetched before the merchant had
  // read a line. Vite's own `build.modulePreload` does not reach these: VitePress
  // writes the links itself, from the page's chunk graph.
  //
  // So they are taken back out of the pages that do not draw anything. A page
  // that does keeps every link it had; `class="mermaid"` is the marker, written
  // by the plugin's component into the rendered HTML. Dropping a preload cannot
  // break a page — the chunk stays on disk and loads on demand — which is why
  // the rule is an allowlist of what to keep rather than a list of mermaid's
  // chunks to remove: a chunk this does not recognise costs a page one lazy
  // fetch, where an unrecognised diagram kind would cost every page the
  // megabyte again.
  transformHtml(code) {
    // Above the application root, not before </body>. Appended at the end it
    // lands after the whole VitePress page and renders as an unstyled
    // paragraph a reader reaches only by scrolling past everything — which
    // would satisfy the release probe while telling nobody that payments here
    // settle with test funds. A marker somebody has to look for is a marker
    // that is not doing its job.
    if (!code.includes('<div id="app"')) {
      throw new Error(
        'the portal build no longer writes <div id="app">, so the surface marker has nowhere ' +
          'to go; find the new application root before shipping a site that says nothing about ' +
          'which stack it is',
      )
    }
    const marked = code.replace('<div id="app"', `${SURFACE_MARKER}<div id="app"`)

    // A page with a diagram keeps every preload it was built with, and still
    // gets the marker.
    if (marked.includes('class="mermaid"')) return marked

    return marked.replace(
      /[ \t]*<link rel="modulepreload" href="([^"]+)">\n?/g,
      (link, href) => (KEPT_CHUNK.test(href) ? link : ''),
    )
  }
}))

/** The framework, the theme, and the page's own module. Everything else a page
 * with no diagram preloads is mermaid's. */
const KEPT_CHUNK = /\/(framework|theme)\.[^/]+\.js$|\.md\.[^/]+\.js$/

/** What every built page says about the stack serving it (deploy/Caddyfile). */
const SURFACE_MARKER = [
  // The attribute on the outer element and the band on the paragraph, so a
  // live page carries a marker and no empty box (apps/cabinet/src/html.ts says
  // why). Style .surface-words in theme/coinslot.css, never this div.
  '<div data-coinslot-surface="<!--{{env `COINSLOT_SURFACE_MODE`}}-->">',
  '<!--{{if eq (env "COINSLOT_SURFACE_MODE") "test"}}-->',
  '<p class="surface-words">Test environment. Payments settle on Base Sepolia with test funds, and every order and receipt here is marked as a test. The live site is coinslot.nuanu.ai.</p>',
  '<!--{{else if eq (env "COINSLOT_SURFACE_MODE") "sandbox"}}-->',
  '<p class="surface-words">Sandbox. No chain stands behind this stack: every payment it accepts is pretend, nothing arrives at the address in a challenge, and no receipt it writes points at a transfer.</p>',
  '<!--{{end}}-->',
  '</div>',
].join('')
