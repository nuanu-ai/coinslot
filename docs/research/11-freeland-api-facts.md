# Freeland API: факты для контракта и карточек

Источник: документация репозитория Freeland (~/Dev/freeland), прочитана
субагентом 2026-08-25 при подготовке карточек; направление затем сменилось
на toolset, но факты остаются полезными. Код не читался — всё ниже «по
докам», перед использованием сверять с runtime. Приоритет доков внутри
Freeland (их AGENTS.md): docs/current-architecture.md — источник истины,
старые планы могут врать.

## Модель товаров (что продаётся на самом деле)

**Виртуальные номера** — аренда, не одноразовая активация. Помесячные
номера по странам (периоды MONTHLY/90/180/YEAR), авто-продление, отдельное
поле renewalPriceUsd. Понятия «номер под конкретный сервис» (à la
sms-activate) в модели НЕТ — только страна + capabilities. Цена
динамическая: себестоимость провайдера +20% (пример из доков: $7.00 →
$8.75). Ограничения оффера явные: только входящие SMS, OTP-совместимость
зависит от отправителя. OTP-коды из SMS извлекаются автоматически.

**eSIM** — планы country/region; id планов — провайдерские строки (не
UUID). Цена: EUR-себестоимость → конверсия → +20%. Покупка:
POST /api/esim/purchase {planId} + Idempotency-Key. Ответ: iccid, qrData
(LPA:...), iosTapLink, esimPassportUrl; статусы
pending|active|expired|failed. Topup кладётся на тот же ICCID. При «нет
доступных SIM» — 409: живой случай товара, кончившегося у поставщика.

**VPN** — только подписки: monthly/quarterly/half-yearly/yearly = 5/13/22/29
USDT (30/90/180/365 дней). Подтверждает: «минут VPN» не существует. Выдача —
subscription-ссылка (Karing-first, домен go.mf0.online), НЕ WireGuard-файл.
Ссылка одна на подписку, per-device управления у провайдера нет.

## Интеграционные факты (важны для toolset/контракта)

- Idempotency-Key обязателен на всех покупках — модель Freeland уже
  совпадает с нашей «повторная выдача по той же квитанции».
- Ошибки: envelope `{error:{code,message}}`; задокументированы
  PLAN_NOT_FOUND, INSUFFICIENT_BALANCE, ESIM_DELETED,
  VPN_PROVIDER_UNAVAILABLE; для номеров кодов в доках нет вовсе.
- Готовность per-product: GET /api/{esim,virtual-numbers,vpn}/status с
  полем providerAvailable (за ним enum live|configured|offline|error,
  снапшоты health-worker'а). Готовый сигнал для нашего автостопа продаж.
- Динамические цены — норма (cost+markup, FX): quote-механизм в манифесте
  обязателен, одних fixed-цен не хватит.
- Приватность: Freeland запрещает показывать наружу имена upstream-
  провайдеров и сырые тексты их ошибок — наши карточки и сообщения об
  ошибках должны это уважать.

## Находка для команды Freeland (передать им)

Публичный контракт для внешних агентов skills/freeland/SKILL.md (v1.4.0)
устарел по VPN: советует GET /vpn/servers и /vpn/config/:id?protocol=
wireguard («WireGuard config delivery»), которых в текущем API нет;
реальный флоу — Karing subscription-link (current-architecture.md:173).
Из четырёх VPN-планов SKILL упоминает только monthly+yearly. Статус «по
докам, не по коду» — пусть проверят у себя.

## Пробелы (если дойдём до карточек)

- Точных JSON-примеров ответов Freeland-API в доках нет (только upstream
  Yesim и устаревшие TS-интерфейсы из планов) — поля брать из кода
  сервисов (virtual-number-service.ts, esim-service.ts).
- Не документированы: формат SMS-сообщений номера, точный DTO оффера
  номеров, судьба уже выданной VPN-ссылки после истечения подписки.
