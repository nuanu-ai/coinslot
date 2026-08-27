import { defineConfig } from 'vitepress'

// The default theme, wearing our palette (see .vitepress/theme). Everything in
// themeConfig here is navigation and local search: the theme's own labels are
// already in the language the pages are written in, so none of them is
// restated.
export default defineConfig({
  lang: 'en',
  title: 'Coinslot',
  description:
    'Seller documentation: connecting, cards, money and what can go wrong.',
  cleanUrls: true,
  srcExclude: ['WRITING.md'],
  themeConfig: {
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
