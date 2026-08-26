# Как крупные платформы решают развилку push/pull

Проверка нашей развилки чужим опытом: мерчант выставляет нам живой
каталог-эндпоинт, который мы читаем (pull), или мы даём management API и SDK,
а мерчант заливает карточки и подписывается на заказы (push). Материал собран
2026-08-26 по документации платформ, спекам, их блогам и вторичным источникам.
Уверенность помечена там, где факт не из первичной документации.

Короткий ответ, который повторяется у всех: развилки в чистом виде ни у кого
нет. Идентичность товара заливается пушем, а цена и наличие проверяются
отдельным механизмом ближе к моменту покупки, и этот второй механизм почти
всегда pull. Спорят платформы не про push против pull, а про то, кто держит
сервер, насколько поздно происходит проверка и что случается, когда она не
отвечает.

## Stripe

Классический каталог Stripe — чистый push, устроенный ровно по нашей идее
холодной идентичности. Product создаётся с идентификатором, который выбирает
вызывающая сторона («unlike most Stripe resources, you can choose the ID of the
product yourself»), а Price по денежным полям неизменяем: сменить цену значит
создать новый Price и заархивировать старый, «to make sure that we keep the
existing price as an immutable record of past transactions». Связку между
стабильной идентичностью и меняющейся ценой держит `lookup_key`, который
переносится на новый Price атомарно через `transfer_lookup_key`. Отдельно есть
inline-цены `price_data` — одноразовые, ссылающиеся на постоянный Product и
предназначенные специально для случая, «когда вы ведёте каталог вне Stripe».
Экономика подталкивает туда же: запись в API не лимитирована вовсе, а чтение
выдаётся из расчёта в среднем 500 запросов на транзакцию, причём у
Connect-платформы эта квота считается агрегированно по всем подключённым
аккаунтам. Платформа, которая держала бы каталог мерчантов пуллом, платит за
это своим бюджетом чтения.

Куда интереснее Agentic Commerce Suite, запущенный в декабре 2025 и расширенный
на Sessions в апреле 2026: там Stripe столкнулся ровно с нашей задачей.
Каталог продавец заливает пушем — CSV через
`POST /v2/commerce/product_catalog/imports`, presigned URL, до 4 ГБ, режимы
`upsert` и `replace`, удаление только явным `delete=true`. Фиды разделены по
волатильности: описания раз в сутки, наличие и цены каждые 15 минут. Порядок
обработки не гарантируется. Есть даже флаг `disable_checkout=true` для позиций,
которые синдицируются агентам только ради находимости и уводят покупателя на
сайт мерчанта.

Свежесть закрывают хуки, которые Stripe вызывает у мерчанта. Product price and
availability hook — буквально наш quote-hook: запрос с одним `sku_id`, ответ с
`availability`, `price` и полем `as_of`, отмечающим, на какой момент данные
верны. Приоритет сформулирован однозначно: «If the product price and
availability hook returns a different `price` or `sale_price` than your feed,
the hook value takes precedence». Order approval hook — наш «отказ до
списания»: «Before we complete the checkout flow, we send an approval request
to your service. You must approve or decline the request».

Две детали этой конструкции стоит перенять целиком. Первая — разные политики
отказа. Таймаут у обоих хуков четыре секунды, но «a timeout on this hook
causes Stripe to fall back to your feed data and continue the checkout. This
differs from the approval hook behavior, where a timeout causes Stripe to
decline the checkout»: свежесть цены проваливается открыто, к снапшоту, а
решение о списании — закрыто, в отказ. Вторая — нагрузкой на мерчанта
управляет платформа, а не мерчант: «manages request rates so your systems
aren't overwhelmed» и «proactively calls the hook for items showing low
inventory». Опубликована и цель по качеству: держать долю покупок,
упирающихся в «товара нет», ниже 5%.

Заказы доходят до продавца тремя способами сразу: вебхук
`checkout.session.completed`, курсорный поллинг
`GET /v1/checkout/sessions?created[gt]=…&starting_after=…` для пакетной
обработки, и дашборд. То же со статусом импорта фида: сначала «we recommend
listening for webhook events… instead of polling», тут же — «if you can't
receive webhook events, poll for status instead».

В общем событийном слое та же логика. Event один, транспортов три:
webhook-эндпоинт, Amazon EventBridge и Azure Event Grid, все создаются одним
`POST /v2/core/event_destinations`. Плюс `GET /v1/events` с окном хранения 30
дней и фильтром `delivery_success=false`, который отдаёт ровно то, что не
доехало ни до одного эндпоинта. Ретраи до трёх суток; порядок не
гарантируется; дубликаты ожидаемы, причём ключом дедупликации не всегда служит
id события. Сам Stripe советует класть входящие в очередь, потому что «any
large spike in webhook deliveries… might overwhelm your endpoint hosts». Thin
events довели мысль до конца: тело события сведено к ссылке на объект именно
потому, что снапшот успевает устареть к моменту обработки. А `stripe listen` —
исходящий WebSocket от CLI к Stripe, снимающий требование публичного URL;
явного запрета на прод в документации нет, но вся подача — «developer tool», и
сессия по конструкции без ретраев и бэклога [прод-статус не подтверждён].

## Shopify

Запись в каталог только push, и направление миграции говорит само за себя: от
пофилдовых мутаций к декларативному `productSet`, который принимает продукт
целиком и умеет адресоваться по `customId`, то есть по внешнему
идентификатору мерчанта. Списки в нём заменяются целиком — варианта нет во
входе, вариант удаляется.

Ближайший к нам прецедент — sales channel, внешняя витрина, которой надо знать
каталог магазина. Shopify рекомендует contextual product feeds и устроил их как
pull один раз плюс push навсегда: канал вызывает `productFullSync`, получает
весь каталог потоком вебхуков `PRODUCT_FEEDS_FULL_SYNC` по одному на товар, а
дальше живёт на `PRODUCT_FEEDS_INCREMENTAL_SYNC`. Повторно каталог никто не
вычитывает. Узкую полосу для настоящего pull Shopify оставил и описал ровно
нашими словами: Storefront API предназначен для «real-time product lookups at
checkout or browsing time», а чтение каталога через Admin API с
bulk-операциями прямо помечено как доступное, но не рекомендованное.

Доставка заказов наружу — самая поучительная часть. Ретраи: восемь попыток за
четыре часа с экспоненциальным откатом (с 2024-09-10). Порядок не
гарантируется ни внутри топика, ни между топиками для одного ресурса; доставка
at-least-once; при устойчивых провалах подписка удаляется молча, а точный
порог Shopify не публикует — только «after multiple failures in a 24-hour
period». Вторичные источники называют разные числа и противоречат друг другу.
Вывод Shopify делает сам и записывает в best practices: не полагайтесь на
вебхуки, стройте reconciliation-джобы. А тем, кому нужен объём, предлагает
сменить транспорт на Google Pub/Sub или Amazon EventBridge, потому что «if you
need to manage large volumes of event notifications to build a scalable and
reliable system, you can configure subscriptions to send webhooks using Amazon
EventBridge or Google Cloud Pub/Sub rather than using HTTPS».

Агентная витрина Shopify (Storefront и Global Catalog MCP по адресам вида
`https://catalog.shopify.com/api/ucp/mcp`) для мерчанта Shopify включается
тумблером и не требует интеграции: каталог Shopify забирает сам, заказ
приходит в обычную админку, мерчант остаётся merchant of record. Расхождение с
тем, что видел агент, Cart MCP возвращает не ошибкой протокола, а сообщением в
успешном ответе — код `quantity_adjusted`, текст вида «requested 100 units but
only 12 available». Для не-Shopify мерчантов есть Agentic Plan, но это только
синдикация каталога: покупка завершается на сайте мерчанта.

## Amazon SP-API

Amazon держит push-каталог дольше всех и дольше всех чинит одни и те же
слабости. Первое поколение — Feeds API: асинхронный батч через S3, поллинг
статуса и документированное «feeds can take up to eight hours to process».
Второе — Listings Items API с per-SKU PATCH. Показательно, чем он объявлен: не
заменой очереди, а приоритетной полосой перед ней — «provides a priority
processing lane and can bypass congested feed queues». Порог выбора
опубликован: меньше 1500 позиций за пять минут быстрее синхронным API.

Свежести Amazon не обещает вовсе. Единственное публикуемое число — «the Amazon
backend updates every 15 minutes», SLA нет. Цену за устаревание платит
продавец: Pre-fulfillment Cancel Rate должен держаться ниже 2,5% по скользящей
неделе, иначе офферы отключаются [порог — вторичное, Seller Central за
логином].

Заказы — самый сильный аргумент в пользу очереди. Поллинг `getOrders`
ограничен одним запросом в минуту, а в новой версии Orders API стал ещё
медленнее; вдобавок в pull-путь встроена двухминутная слепая зона, потому что
`LastUpdatedBefore` обязан отставать от текущего времени. Push-альтернатива —
Notifications API, и вот ключевой факт: HTTPS-вебхука там нет и никогда не
было. `createDestination` принимает ровно два типа получателя, `sqs` и
`eventBridge`, причём очередь создаёт и оплачивает сам мерчант в своём
AWS-аккаунте. Так было и в предыдущем поколении API (MWS Subscriptions, закрыт
2024-03-31). За две генерации и примерно десятилетие Amazon не сделал вебхука
ни разу. Доставка при этом at-least-once с best-effort порядком, а сам Amazon
советует держать запасной путь получения и предписывает реконсиляцию отчётом
раз в 6–12 часов. Цена такого дизайна для мерчанта — обязанность завести
AWS-аккаунт и очередь; это самая критикуемая часть конструкции, а не её
достоинство.

Отдельная находка бьёт по идее «push достаточно». Построив канонический
push-каталог, Amazon всё равно вычитывает внешний веб, чтобы проверить,
настоящая ли выложенная цена: Competitive External Price — «the lowest price
for an item… recently found at another reputable retailer outside the Amazon
store», список ритейлеров не раскрывается, а превышение порога делает оффер
неподходящим для Featured Offer.

## Google Merchant Center

Google — самый прямой прецедент «push сломался о свежесть, добавили pull».
Базовый механизм остаётся фидом: scheduled fetch с частотой daily, weekly или
monthly (часового значения в enum Merchant API просто нет), файл до 4 ГБ, сто
загрузок в сутки для основного источника и пятьсот для дополнительных и
инвентарных. Товар без обновления живёт 30 дней: «all products expire from your
Merchant Center account 30 days after the last refresh».

Поверх этого Google построил краулер. Automatic item updates читает лендинги
мерчанта и правит фид по schema.org-микроразметке, а при её отсутствии — по
ML-экстракторам: «in order to detect and update mismatches, Google crawls the
landing pages listed in your data source». Чинит четыре поля: цену, цену
распродажи, наличие и состояние. Включено по умолчанию [в гайде Content API до
сих пор написано обратное — одна из страниц устарела].

Три вещи здесь важны для нас. Google явно запрещает считать pull заменой
пушу — «automatic item updates isn't a replacement for frequent updates of your
product data on Google». Pull-путь положил нагрузку на инфраструктуру мерчанта,
и под это пришлось завести отдельный класс ошибки, «Insufficient crawling
capacity», с требованием не троттлить Googlebot. А при частом расхождении фида
и лендинга Google просто выключает автообновления до восстановления
совпадения, причём сами расхождения остаются нарушением: «we continue to treat
products with mismatches as critical errors», вплоть до приостановки аккаунта.
Числового допуска по цене Google не публикует нигде [не проверено, существует
ли непубличный].

Отрицательный прецедент по заказам тоже принадлежит Google. Buy on Google
(бывший Shopping Actions, 2018) держал заказ у себя и отдавал мерчанту через
Content API `orders` с паттерном «поллинг `/new` плюс `acknowledge`». Закрыт в
США 26 сентября 2023, API снесён в 2024, объяснение — «Buy on Google was a
small feature that a very limited number of merchants used». Отступление было
от роли продавца, а не от оркестрации покупки: в 2026 Google вернулся к
агентному чекауту, но так, что merchant of record остаётся мерчантом.

## Агентная коммерция 2025–2026

Главная находка этой части — не устройство протоколов, а то, что с ними
случилось за год.

Agentic Commerce Protocol (Stripe, OpenAI, Meta; текущая стабильная версия
спеки `2026-04-17`, Apache 2.0, статус beta) кладёт на мерчанта роль сервера
почти целиком. Мерчант поднимает пять HTTPS-эндпоинтов чекаута
(`POST /checkout_sessions`, обновление, `GET`, `/complete`, `/cancel`),
пересчитывает цену и наличие на каждом вызове и возвращает out-of-stock как
`422` с `MessageError{code:"out_of_stock"}` и JSONPath на позицию. Каталог
мерчант отдаёт пушем — «provide the entire feed once a day via file upload, and
then send updates throughout the day via the API»; в самой спеке блок `servers`
у feed-файла указывает на мерчанта, что противоречит документации OpenAI и
похоже на скопированный из чекаута шаблон [конфликт не разрешён]. Заказ идёт от
мерчанта к платформе: `POST /agentic_checkout/webhooks/order_events` хостит
OpenAI, события `order_create` и `order_update` подписывает мерчант заголовком
`Merchant-Signature`. Идемпотентность обязательна на всех мутирующих вызовах, с
эхо-заголовком `Idempotent-Replayed`.

И вот что с этим стало. В марте 2026 OpenAI свернул нативный Instant Checkout:
«the initial version of Instant Checkout did not offer the level of flexibility
that we aspire to provide, so we're allowing merchants to use their own
checkout experiences while we focus our efforts on product discovery». К
моменту разворота на нём было меньше тридцати мерчантов Shopify, а Walmart
сообщал о конверсии в чате втрое хуже собственного сайта. Уцелели фиды и
discovery. Не масштабировалась ровно та часть, которую мерчант должен был
поднять у себя, — чекаут-колбэк [пресса: searchengineland 2026-03-06, CNBC
2026-03-24].

Universal Commerce Protocol (Google и Shopify, объявлен 2026-01-11) устроен
похоже — манифест по `/.well-known/ucp`, живые `POST /checkout-sessions` у
мерчанта, `out_of_stock` как неустранимая ошибка до движения денег, сессия с
`expires_at` и дефолтным TTL в шесть часов. Но статус каталога в нём прописан
честнее: ответы каталога «are not transactional commitments — checkout is
authoritative» и «SHOULD NOT be reused across sessions without re-validation».
Идентичность при этом всё равно приходит фидом Merchant Center, где появились
атрибуты `native_commerce(checkout_eligibility)` и `merchant_item_id` — второй
нужен ровно потому, что идентификатор в фиде и идентификатор в Checkout API
мерчанта могут не совпадать. AP2 (перешёл в FIDO Alliance 2026-04-28) добавляет
к этому подписанный мерчантом JWT с зафиксированной ценой: «all selections that
may alter a cart price must be completed prior to the CartMandate being able to
be created».

Дальше начинается самое интересное. Раз спека требует от мерчанта поднять
сервер, а мерчанты этого не делают, между ними встали посредники. Stripe ACS —
именно такой посредник: в стандартном пути продавец не хостит ничего, а в
кастомном Stripe всё равно остаётся фронтом — «implement a reverse API that
defines the requests Stripe sends to your commerce backend… when an agent
routes a checkout request through Stripe, Stripe calls these endpoints on your
behalf». Microsoft Copilot Checkout (запуск 2026-01-08, UCP, а не ACP) устроен
так же: в обычном сценарии мерчант не хостит ничего, UCP за него держит PSP или
платформа. То есть push-с-хуками — это не альтернатива протоколам, а слой,
который вырос перед ними, потому что сами протоколы оказались слишком тяжёлыми
для мерчанта.

Наш собственный рельс живёт по третьей схеме. У x402 Bazaar management API для
продавца нет вовсе: индексация происходит в момент оплаты, когда фасилитатор
обрабатывает `PaymentPayload` с эхом расширения `bazaar`; достаточно объявить
расширение и провести один платёж. Делистинг только пассивный — серия
проваленных health-probe, прекращение ответов 402 или 30 дней без settle.
Сам протокол в июле 2026 перешёл под Linux Foundation (x402 Foundation
операционен с 2026-07-14, 40 участников). Обзор экосистемы подтверждает, что
ниша пуста: ни одной площадки, которая держала бы листинги чужих продавцов и
принимала заказы за них, ни одного seller-дашборда, ни одного management API —
Bazaar, x402scan, gold-402 и Onyx все просто индексы.

Ближайший работающий прецедент продажи реальных товаров за x402 —
Cryptorefills, и его флоу инвертирован относительно нашего: `POST /v1/orders`
возвращает 402 с ценой, известной на момент запроса, повтор с подписью даёт
`{order_id, status:"processing", poll_url}`, и дальше **агент** опрашивает
мерчанта. При этом у них не документированы ни окно жизни котировки, ни
поведение при отсутствии товара после оплаты, ни процедура возврата — дыра
ровно в том месте, которое мы пытаемся закрыть.

## Очередь у платформы и воркер у мерчанта

Ни один коммерческий протокол не описывает очередь, которую вычерпывает
мерчант. UCP прямо пишет, что мерчант «SHOULD rely on webhooks as the primary
order update channel»; long-poll, стриминга и SDK-подписки нет ни в ACP, ни в
UCP, ни в MCP, ни в x402. Единственный санкционированный pull-путь для заказов
во всей выборке — курсорный дренаж Stripe ACS: «instead of fulfilling each
order individually, bulk fulfill orders using the List CheckoutSessions
endpoint… to prevent duplicate fulfillments, use the `starting_after`
parameter».

Зато вне коммерции модель зрелая. Salesforce Pub/Sub API — самый близкий
аналог: подписка по gRPC, хранение 72 часа, Replay ID для переподключения с
последнего обработанного, а с 2024 года ещё и Managed Subscriptions, где
«Salesforce will maintain the replay store, and manage and track the Replay ID
for the clients on the Pub/Sub API side» — курсор переехал на сторону
платформы, чтобы клиент мог быть stateless. Это ровно та эволюция, которую мы
закладываем [бета с лета 2024, GA к 2026 не подтверждён]. Slack Socket Mode
делает то же для приложений «behind a corporate firewall». Telegram Bot API
десятилетиями держит оба транспорта параллельно, `getUpdates` и `setWebhook`,
взаимоисключающими. Temporal строит на long-poll всю архитектуру: воркеры
входящих портов не открывают вовсе. Google Cloud Pub/Sub официально
рекомендует pull для долгоживущих потребителей, которым нужны пропускная
способность и контроль темпа. Zapier, агрегирующий тысячи чужих API, по
умолчанию делает поллинг-триггеры и сам дедуплицирует по `id`.

Общий вывод по транспорту: индустрия десять лет двигалась от вебхука к
очереди, а обратно — никогда. Shopify, Amazon и Stripe все трое пришли к
EventBridge, Pub/Sub и SQS как к варианту для тех, кому важна надёжность, и ни
у кого вебхук не остался единственным способом узнать о заказе.

## Сквозные паттерны

Идентичность товара везде push, по одной и той же причине: она меняется редко,
её надо валидировать, индексировать и хранить, и никому не нужно вычитывать её
заново на каждый показ. Горячие поля вынесены в отдельный, более быстрый
механизм, и этот механизм почти всегда pull: у Stripe хук, у Google краулер, у
Shopify Storefront API на чекауте, у Amazon вычитывание внешнего веба ради
проверки чужой цены. Ни одна платформа не доверила свежесть одному источнику.

Момент проверки у всех сдвинут максимально близко к оплате — тем же приёмом
десятилетиями живут travel-рельсы. Amadeus называет Flight Offers Price
обязательным шагом перед созданием заказа, потому что цена и доступность
меняются между поиском и покупкой. Expedia Rapid требует пройти по
`price_check` из результата поиска и получить `MATCHED` вместе со ссылкой, по
которой только и можно бронировать, а расхождение цены прямо называет
ожидаемой ситуацией. Кеш для поиска, живой вызов для коммита.

У двух режимов отказа разные политики, и это осознанный дизайн, а не
случайность: свежесть цены проваливается открыто, к снапшоту, решение о
списании — закрыто, в отказ. Stripe описывает обе политики в одном абзаце и
явно их противопоставляет.

Заказ нигде не доставляется одним транспортом, и везде требуется
идемпотентность. Расхождение с тем, что видел покупатель, тоже везде
проектируется как штатное событие, а не как ошибка: `quantity_adjusted` у
Shopify, `price_change` и `out_of_stock` в теле успешного ответа у ACP,
messages с severity у UCP.

И последнее: эффект живой проверки наличия измерим и велик. DoorDash, требуя от
партнёрских POS-интеграций real-time item availability, приводит снижение доли
провалившихся заказов на 75% и отмен на 42% [вторичное: страницы DoorDash
отдают 403, факт по сниппетам поиска].

## Проекция на Coinslot

Гипотеза-синтез подтверждается, и сильнее, чем мы рассчитывали. Stripe в
декабре 2025 отгрузил её почти дословно: push холодной идентичности фидом,
live-хук цены и наличия с приоритетом над фидом, approval-хук, останавливающий
списание, и заказы через несколько транспортов сразу. Это не гипотеза, а
работающий продукт с публичной документацией. Ставка на очередь тоже
подтверждается: у Amazon за две генерации API вебхука не было ни разу, Shopify
и Stripe добавили очереди позже как ответ на ненадёжность HTTP, обратного
движения нет ни у кого.

Сильнее всего гипотезу подтверждает отрицательный результат. ACP и UCP
устроены наоборот: мерчант поднимает сервер, платформа его опрашивает. В марте
2026 OpenAI свернул именно эту часть, оставив фиды и discovery, и объяснил
разворот тем, что мерчанты должны пользоваться собственным чекаутом. Прямо
поверх этих протоколов выросли посредники — Stripe ACS и Copilot через PSP, —
которые снимают с мерчанта роль сервера и подставляют себя. Coinslot
относительно x402 занимает структурно ту же позицию.

Развилка «А или Б» оказывается ложной ещё и с другой стороны. Bazaar
индексирует живые 402-эндпоинты и не имеет никакого management API, значит
pull-поверхность мы держим в любом случае — вопрос лишь в том, чем она
питается. Спорить надо не про push против pull, а про то, где проходит граница
между снапшотом и живым запросом и что происходит, когда живой запрос молчит.

Три чужие шишки можно не повторять. Не отдавать свежесть краулеру: Google
пошёл этим путём и получил зависимость от чужой разметки, нагрузку на
инфраструктуру мерчанта, отдельный класс ошибки про троттлинг и механизм
самоотключения при частых расхождениях; хук по конкретному SKU на порядок
дешевле и точнее. Не делать доставку заказа одноканальной: все три платформы,
начавшие с одного канала, добавили второй и написали в документации, что
полагаться на один нельзя. Не перекладывать инфраструктуру очереди на
мерчанта: требование Amazon завести AWS-аккаунт и SQS-очередь — самая
критикуемая часть его дизайна, и наш SDK существует ровно затем, чтобы этой
цены не было.

Чего в гипотезе не хватает:

- **Двух разных политик отказа.** У нас «отказ до списания» сформулирован как
  один принцип. У Stripe это два хука с противоположным поведением на таймаут.
  Нужно развести явно, иначе секундная недоступность мерчанта будет убивать
  продажу, которую можно было провести по снапшоту.
- **Управления нагрузкой как нашей обязанности.** Stripe обещает троттлинг
  хука и проактивный опрос только по позициям с низким остатком. Freeland с
  его `providerAvailable` даёт дешёвый сигнал для такой избирательности.
- **Отметки свежести в ответе.** У Stripe в ответе хука есть `as_of`. Без неё
  мы не отличим «мерчант проверил сейчас» от «мерчант отдал свой кеш».
- **Окна жизни котировки.** У ACP его нет вовсе, у Cryptorefills тоже — и это
  ровно та дыра, из-за которой у них не описано поведение при отсутствии
  товара после оплаты. У UCP дефолт шесть часов, у Stripe Checkout Session от
  30 минут до 24 часов. Нам нужно своё число и своё поведение по истечении.
- **Метрики качества.** Опубликованная Stripe цель «меньше 5% покупок,
  упирающихся в отсутствие товара» — готовый SLO; у Amazon аналог жёстче,
  2,5% отмен до выдачи. Своя цифра нужна до пилота, иначе «свежесть»
  останется словом.
- **Переносимого идентификатора.** `lookup_key` у Stripe, `customId` у
  Shopify, `merchant_item_id` у Google и Microsoft — все отдельно решали
  задачу «идентификатор в каталоге не совпадает с идентификатором у
  мерчанта». У нас в манифесте один `id`, и этого мало.
- **Ответа про остатки.** Открытый вопрос из `10-design-backlog.md` (пункт 6)
  закрывается прецедентами: никто из четверых не ведёт остаток за мерчанта,
  все спрашивают у мерчанта в момент покупки. Дизайн, где источник правды об
  остатке — мерчант, это и есть quote-hook.

Что проверить отдельно перед ADR: у ACP и UCP заказ уходит от мерчанта к
платформе и подписывается мерчантом. Если мы когда-нибудь захотим быть
транзитом в эти протоколы, направление order-события окажется противоположным
нашему. Для пилота не блокер, но ядро лучше не привязывать к одному
направлению. И вторая линия: Девятый округ 2026-08-04 отменил инъюнкцию против
Perplexity на том основании, что агент работал на машине пользователя и по его
команде, — но суд отдельно отметил, что более автономный server-to-server агент
может отвечать по CFAA. Coinslot по конструкции именно server-to-server, так
что consent-first у нас не украшение [пресса].

## Источники

Stripe: docs.stripe.com — products-prices, api/prices, api/checkout/sessions,
rate-limits, webhooks, event-destinations, webhooks/process-undelivered-events,
cli/listen, connect/*, agentic-commerce/for-sellers и вложенные hooks,
handle-checkout-failures, custom, product-feed, agentic-commerce/acp; все
прочитаны 2026-08-26. Анонс ACS — декабрь 2025, расширение — Sessions, апрель
2026; блог stripe.dev про thin events — 2026-06-24.

Shopify: shopify.dev — productSet, rate-limits, sales-channels/product-sync и
contextual-product-feeds, webhooks/best-practices и configuration/eventbridge,
agents/catalog/*, agents/orders/*, apps/build/storefront-mcp. Changelog про
ретраи — 2024-09-10. Winter '26 — 2025-12-10, Agentic Storefronts по умолчанию
— неделя 2026-03-24, Spring '26 — 2026-06-17.

Amazon: developer-docs.amazon — submit-a-feed, listings-apis-faq,
listings-api-migration-faq, building-listings-management-workflows-guide,
orders-api-rate-limits, reference/getorders и createdestination,
set-up-notifications-with-amazon-sqs и -eventbridge, notifications-api,
pricing-faq; репозиторий amzn/selling-partner-api-samples, обсуждения
2025-04-05, 2025-05-06, 2025-12-09.

Google: support.google.com/merchants — 3246284, 6098259, 6098251, 12157888,
15071338, 14916353, 6150127, 6324499, 14991445, 16564100;
developers.google.com/merchant/api и /merchant/ucp. UCP анонс — 2026-01-11,
закрытие Buy on Google — 2023-09-26.

Протоколы: спека ACP `2026-04-17` прочитана напрямую из
github.com/agentic-commerce-protocol и agenticcommerce.dev;
developers.openai.com/commerce; ucp.dev и github.com/Universal-Commerce-Protocol;
AP2 v0.2 (2026-04-28, FIDO Alliance); docs.x402.org/extensions/bazaar и
docs.cdp.coinbase.com/x402 (плюс наш спайк `04-spike-bazaar-listing.md`);
x402.cryptorefills.com и github.com/Cryptorefills/agents. Разворот OpenAI —
searchengineland 2026-03-06 и CNBC 2026-03-24 [пресса]. Copilot Checkout —
about.ads.microsoft.com, запуск 2026-01-08, UCP-фиды GA в MMC 2026-04-21.

Очередь и воркер: developer.salesforce.com/pub-sub-api (event-message-durability,
managedsubscribe) и блог про Managed Subscriptions 2024-05-23; docs.slack.dev
socket mode; docs.cloud.google.com/pubsub subscription-overview;
docs.temporal.io task-queue; docs.zapier.com triggers; github.com/probot/smee-client.

Свежесть в travel: developers.amadeus.com (Flight Offers Price) и
developers.expediagroup.com/rapid/lodging (price_check). DoorDash —
merchants.doordash.com и developer.doordash.com, доступны только по сниппетам
поиска.
