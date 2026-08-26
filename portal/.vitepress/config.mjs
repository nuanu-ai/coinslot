import { defineConfig } from 'vitepress'

// Тема — дефолтная, без визуальной кастомизации. В themeConfig только
// навигация, локальный поиск и русские подписи стандартных элементов темы.
export default defineConfig({
  lang: 'ru-RU',
  title: 'Coinslot',
  description: 'Документация продавца: подключение, карточки, деньги, отказы.',
  cleanUrls: true,
  srcExclude: ['WRITING.md'],
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
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск' },
          modal: {
            displayDetails: 'Показать подробности',
            resetButtonTitle: 'Очистить запрос',
            backButtonTitle: 'Закрыть поиск',
            noResultsText: 'Ничего не найдено по запросу',
            footer: {
              selectText: 'открыть',
              navigateText: 'перейти',
              closeText: 'закрыть'
            }
          }
        }
      }
    },
    outline: { label: 'На этой странице' },
    docFooter: { prev: 'Предыдущая страница', next: 'Следующая страница' },
    sidebarMenuLabel: 'Разделы',
    returnToTopLabel: 'Наверх',
    darkModeSwitchLabel: 'Оформление',
    lightModeSwitchTitle: 'Светлое оформление',
    darkModeSwitchTitle: 'Тёмное оформление'
  }
})
