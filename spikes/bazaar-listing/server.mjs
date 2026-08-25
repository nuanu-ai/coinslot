// Спайк, Phase 1: config-driven x402-витрина для N мерчантов на ОФИЦИАЛЬНОМ стеке.
//
// Самописный 402 (Phase 0) заменён на:
//   @coinbase/cdp-sdk/x402  createX402Server  — resource server + CDP facilitator
//   @x402/extensions/bazaar declareDiscoveryExtension — блок discovery для Bazaar
//   @x402/express           paymentMiddlewareFromHTTPServer — HTTP-обвязка
//
// Платёж теперь проверяется и сеттлится по-настоящему (verify/settle в CDP
// facilitator по CDP_API_KEY_ID/CDP_API_KEY_SECRET из окружения). Моком остаётся
// только фулфилмент: за деньги отдаётся пример из каталога, а не реальный товар.
//
// Витрина по-прежнему целиком генерируется из catalog.json: маршруты, цены,
// payTo на ресурс, метаданные мерчанта и discovery-блок. Новый мерчант = запись
// в конфиге, руками ничего не листится.
import express from "express";
import { readFileSync } from "node:fs";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";

const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url)));
const PORT = process.env.PORT ?? 4021;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// Цена уходит в SDK как Money-строка ("$5", "$0.001"): asset и extra
// (USDC на Base, EIP-712 name/version) подставляет сам стек из таблицы
// дефолтных ассетов сети. В Phase 0 мы собирали эти поля руками.
const money = (usd) => `$${usd}`;

// accepts[] на ресурс: единственное, что здесь «наше» — payTo мерчанта.
// Заглушки 0x…dEaD / 0x…bEEF живут в catalog.json; замена на реальный адрес —
// правка одной строки конфига, кода это не касается.
const paymentOption = (sku, merchant) => ({
  scheme: "exact",
  network: catalog.defaults.network,
  price: money(sku.priceUsd),
  payTo: merchant.payTo,
  maxTimeoutSeconds: catalog.defaults.maxTimeoutSeconds,
});

// Discovery-блок строит сам SDK; от нас — пример входа, JSON Schema входа и
// пример выхода. Поле info.input.method SDK дописывает на лету, из МЕТОДА
// ВХОДЯЩЕГО ЗАПРОСА (см. bazaarResourceServerExtension.enrichDeclaration).
const queryDeclaration = (sku) =>
  declareDiscoveryExtension({
    input: sku.input.queryParams,
    inputSchema: sku.inputSchema?.queryParams,
    output: { example: sku.outputExample },
  });

const bodyDeclaration = (sku) =>
  declareDiscoveryExtension({
    bodyType: sku.input.bodyType ?? "json",
    input: sku.input.body,
    inputSchema: sku.inputSchema?.body,
    output: { example: sku.outputExample },
  });

// Метаданные ресурса.
//   resource — канонический URL. По умолчанию SDK собирает его из запроса
//     (protocol + Host + originalUrl): за Caddy это даёт http:// и тащит
//     query-строку в идентификатор ресурса. Пиним из BASE_URL, как в Phase 0.
//   serviceName/tags — фасилитатор режет их по printable ASCII (≤32 символа,
//     ≤5 тегов), так что своя валидация мерчант-полей обязательна.
const resourceMeta = (sku, merchant) => ({
  resource: `${BASE_URL}${sku.path}`,
  description: sku.description,
  mimeType: "application/json",
  serviceName: merchant.serviceName,
  tags: merchant.tags,
});

// Таблица маршрутов для SDK. Ключ без глагола ⇒ verb "*" ⇒ 402 отдаётся на
// ЛЮБОЙ метод пути. Это не косметика: валидатор CDP и краулеры ходят GET-ом,
// и paywall, привязанный к одному методу, делает POST-ресурсы невидимыми.
//
// Но у body-деклараций есть ограничение спеки: bodyType валиден только при
// методе POST/PUT/PATCH, а SDK подставляет реальный метод запроса. Поэтому у
// body-ресурса ДВЕ записи: точная "POST /path" (правильные метаданные для
// покупателя) и wildcard "/path" с query-декларацией (валидный 402 для GET-проб).
// Порядок важен: совпадает первая подходящая запись.
const listings = [];
const routes = {};
for (const merchant of catalog.merchants) {
  for (const sku of merchant.skus) {
    const base = { accepts: [paymentOption(sku, merchant)], ...resourceMeta(sku, merchant) };
    if (BODY_METHODS.has(sku.method)) {
      routes[`${sku.method} ${sku.path}`] = { ...base, extensions: bodyDeclaration(sku) };
      routes[sku.path] = { ...base, extensions: queryDeclaration({ ...sku, input: {} }) };
    } else {
      routes[sku.path] = { ...base, extensions: queryDeclaration(sku) };
    }
    listings.push({ merchant, sku });
  }
}

const x402 = await createX402Server({
  // payTo берём из каталога поштучно, поэтому кошелёк CDP не провижоним
  // (и CDP_WALLET_SECRET не нужен) — нужны только API-ключи для фасилитатора.
  payToConfig: { type: "address" },
  routes,
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // за Caddy: X-Forwarded-Proto → req.protocol

// --- лог запросов ----------------------------------------------------------
// Без него отладить платёж нечем: в v2 тело 402 всегда пустое ({}), а причина
// отказа лежит в base64-заголовке PAYMENT-REQUIRED.error (его пишет
// @x402/core: createHTTPPaymentRequiredResponse). Логируем ФАКТ подписи и её
// длину, но не саму подпись и не тела — секретов и payload'ов в логе нет.
const b64json = (v) => {
  try {
    return JSON.parse(Buffer.from(String(v), "base64").toString("utf8"));
  } catch {
    return null;
  }
};

app.use((req, res, next) => {
  const t0 = Date.now();
  const sig = req.get("payment-signature") ?? req.get("x-payment");
  res.on("finish", () => {
    const parts = [
      `${req.method} ${req.path}`,
      `status=${res.statusCode}`,
      `sig=${sig ? `yes(${sig.length}b)` : "no"}`,
      `ms=${Date.now() - t0}`,
    ];
    const receipt = b64json(res.getHeader("PAYMENT-RESPONSE"));
    if (receipt) {
      // сеттл дошёл до фасилитатора: успех + хеш транзакции или причина отказа
      parts.push(`settle=${receipt.success ? "ok" : "FAILED"}`);
      if (receipt.transaction) parts.push(`tx=${receipt.transaction}`);
      if (!receipt.success) parts.push(`reason=${JSON.stringify(receipt.errorReason ?? "?")}`);
    } else if (res.statusCode === 402 || res.statusCode === 412) {
      // verify не прошёл (или подписи вообще не было) — тут лежит текст фасилитатора
      const required = b64json(res.getHeader("PAYMENT-REQUIRED"));
      parts.push(`verify=${JSON.stringify(required?.error ?? "?")}`);
    }
    console.log("[req]", parts.join(" "));
  });
  next();
});

app.use(express.json({ limit: "64kb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true, resources: listings.length }));

// Операторский вид витрины: то, что реально обслуживает SDK. x402.routes —
// уже разрешённая таблица (payTo подставлены, расширения смёржены с теми, что
// CDP добавляет сам: gas sponsoring, builder-code).
app.get("/catalog", (_req, res) =>
  res.json({
    baseUrl: BASE_URL,
    facilitator: "cdp",
    note:
      "bazaar.info.input.method отсутствует до энричмента — SDK дописывает его " +
      "из метода входящего запроса при выдаче 402",
    resources: listings.map(({ merchant, sku }) => ({
      merchant: merchant.id,
      url: `${BASE_URL}${sku.path}`,
      method: sku.method,
      routeKeys: Object.keys(routes).filter((k) => k === sku.path || k.endsWith(` ${sku.path}`)),
      served: x402.routes[BODY_METHODS.has(sku.method) ? `${sku.method} ${sku.path}` : sku.path],
    })),
  }));

app.use(paymentMiddlewareFromHTTPServer(x402));

// Досюда запрос доходит только после verify+settle через CDP facilitator.
// Метод намеренно НЕ проверяем: деньги на этом шаге уже списаны, отдавать 405
// после успешного сеттла — хуже, чем отдать товар.
for (const { merchant, sku } of listings)
  app.all(sku.path, (req, res) =>
    res.json({
      ...sku.outputExample,
      _merchant: merchant.id,
      _method: req.method,
      _note: "spike: платёж настоящий (CDP facilitator), фулфилмент — пример из каталога",
    }));

app.use((_req, res) => res.status(404).json({ error: "unknown resource" }));

app.listen(PORT, () =>
  console.log(
    `[spike] витрина: ${listings.length} ресурсов от ${catalog.merchants.length} мерчантов, ` +
      `${Object.keys(routes).length} маршрутов, facilitator=CDP, base=${BASE_URL}`));
