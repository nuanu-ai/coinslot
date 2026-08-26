import { defineConfig } from 'vitepress'

// Тема — дефолтная, без визуальной кастомизации. В themeConfig только
// навигация и русские подписи стандартных элементов темы.
export default defineConfig({
  lang: 'ru-RU',
  title: 'Coinslot',
  description: 'Документация мерчанта: подключение, карточки, деньги, отказы.',
  cleanUrls: true,
  themeConfig: {
    sidebar: [
      {
        text: 'Владельцу бизнеса',
        items: [
          { text: 'Подключение к Coinslot', link: '/' },
          { text: 'Деньги', link: '/money' },
          { text: 'Частые вопросы', link: '/faq' }
        ]
      },
      {
        text: 'Инженеру',
        items: [
          { text: 'Первая продажа', link: '/quickstart' },
          { text: 'Карточка товара', link: '/cards' },
          { text: 'Заказы и режимы выдачи', link: '/orders' },
          { text: 'Что может пойти не так', link: '/failures' }
        ]
      }
    ],
    outline: { label: 'На этой странице' },
    docFooter: { prev: 'Предыдущая страница', next: 'Следующая страница' },
    sidebarMenuLabel: 'Разделы',
    returnToTopLabel: 'Наверх',
    darkModeSwitchLabel: 'Оформление',
    lightModeSwitchTitle: 'Светлое оформление',
    darkModeSwitchTitle: 'Тёмное оформление'
  }
})
