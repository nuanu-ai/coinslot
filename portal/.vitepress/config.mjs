import { defineConfig } from 'vitepress'

// The default theme, wearing our palette (see .vitepress/theme). Everything in
// themeConfig here is navigation and local search: the theme's own labels are
// already in the language the pages are written in, so none of them is
// restated.
export default defineConfig({
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
        items: [
          { text: 'The first test sale', link: '/quickstart' },
          { text: 'The product card', link: '/cards' },
          { text: 'Orders and fulfillment modes', link: '/orders' },
          { text: 'What can go wrong', link: '/failures' },
          { text: 'Questions from the engineer', link: '/faq#questions-from-the-engineer' }
        ]
      }
    ],
    search: { provider: 'local' }
  }
})
