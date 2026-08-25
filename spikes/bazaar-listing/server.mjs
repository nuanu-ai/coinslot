// Спайк: config-driven x402-витрина для N мерчантов. Phase 0 — воспроизводим
// wire-формат x402 v2 (402 + PAYMENT-REQUIRED header + extensions.bazaar) по
// specs/x402-specification-v2.md и specs/transports-v2/http.md; оплату НЕ
// верифицируем. В Phase 1 заменяется официальным middleware
// (@coinbase/cdp-sdk/x402 createX402Server + declareDiscoveryExtension).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url)));
const PORT = process.env.PORT ?? 4021;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

const usdToAtomic = (usd) => String(Math.round(usd * 1e6)); // USDC, 6 знаков
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// v2: resource уехал из accepts[] в отдельный объект верхнего уровня,
// туда же — description/mimeType и метаданные сервиса для выдачи Bazaar
function resourceInfo(sku, merchant) {
  return {
    url: `${BASE_URL}${sku.path}`,
    description: sku.description,
    mimeType: "application/json",
    serviceName: merchant.serviceName,
    tags: merchant.tags,
  };
}

// v2: в accepts[] остались только платёжные поля; amount вместо v1 maxAmountRequired
function paymentRequirements(sku, merchant) {
  const d = catalog.defaults;
  return {
    scheme: "exact",
    network: d.network,
    amount: usdToAtomic(sku.priceUsd),
    asset: d.asset,
    payTo: merchant.payTo,
    maxTimeoutSeconds: d.maxTimeoutSeconds,
    extra: d.assetMeta,
  };
}

// JSON Schema для info: фасилитатор обязан провалидировать info против неё
// перед листингом, поэтому собираем её из того же конфига, что и сам info
function bazaarSchema(sku) {
  const isBody = BODY_METHODS.has(sku.method);
  const input = {
    type: "object",
    properties: {
      type: { type: "string", const: "http" },
      method: { type: "string", enum: isBody ? ["POST", "PUT", "PATCH"] : ["GET", "HEAD", "DELETE"] },
      queryParams: sku.inputSchema.queryParams
        ? { type: "object", ...sku.inputSchema.queryParams }
        : { type: "object", additionalProperties: { type: "string" } },
      headers: { type: "object", additionalProperties: { type: "string" } },
    },
    required: isBody ? ["type", "method", "bodyType", "body"] : ["type", "method"],
    additionalProperties: false,
  };
  if (isBody) {
    input.properties.bodyType = { type: "string", enum: ["json", "form-data", "text"] };
    input.properties.body = { type: "object", ...sku.inputSchema.body };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input,
      output: {
        type: "object",
        properties: { type: { type: "string" }, example: {} },
        required: ["type"],
      },
    },
    required: ["input"],
  };
}

const bazaarExtension = (sku) => ({
  info: { input: sku.input, output: { type: "json", example: sku.outputExample } },
  schema: bazaarSchema(sku),
});

function paymentRequired(sku, merchant) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: resourceInfo(sku, merchant),
    accepts: [paymentRequirements(sku, merchant)],
    extensions: { bazaar: bazaarExtension(sku) },
  };
}

// route table из конфига — «автоматизация листинга»: мерчанты добавляются
// строкой в catalog.json, руками ничего не листится.
// Ключ — путь, а не «метод+путь»: платёжный вызов (402) обязан отдаваться на
// любой метод, иначе краулеры и валидатор CDP (ходят только GET) видят 404 на
// POST-ресурсах. Настоящий метод объявлен в bazaar info.input.method.
const routes = new Map();
for (const merchant of catalog.merchants)
  for (const sku of merchant.skus)
    routes.set(sku.path, { merchant, sku });

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const json = (code, body, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body, null, 2));
  };

  if (req.method === "GET" && path === "/catalog") {
    // операторский вид витрины: то, что уйдёт в Bazaar по каждому ресурсу
    return json(200, [...routes.values()].map(({ merchant, sku }) => ({
      merchant: merchant.id,
      paymentRequired: paymentRequired(sku, merchant),
    })));
  }

  const hit = routes.get(path);
  if (!hit) return json(404, { error: "unknown resource" });

  const { merchant, sku } = hit;
  // v2 переименовал X-PAYMENT в PAYMENT-SIGNATURE; старое имя принимаем тоже
  if (!req.headers["payment-signature"] && !req.headers["x-payment"]) {
    const body = paymentRequired(sku, merchant);
    // каноническое место объекта в HTTP-транспорте — base64 в заголовке;
    // тело дублируем как есть, часть клиентов и валидаторов читает его
    return json(402, body, {
      "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
    });
  }
  if (req.method !== sku.method)
    return json(405, { error: `use ${sku.method} for this resource` }, { allow: sku.method });
  // Phase 0: платёж не проверяем — честно помечаем это в ответе и не
  // подделываем PAYMENT-RESPONSE (settlement-заголовок v2)
  res.setHeader("x-spike-warning", "phase0-mock: payment NOT verified");
  json(200, { ...sku.outputExample, _mock: true, _merchant: merchant.id });
});

server.listen(PORT, () =>
  console.log(`[spike] витрина: ${routes.size} ресурсов от ${catalog.merchants.length} мерчантов на ${BASE_URL}`));
