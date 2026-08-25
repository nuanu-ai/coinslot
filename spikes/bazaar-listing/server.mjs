// Спайк: config-driven x402-витрина для N мерчантов. Phase 0 — воспроизводим
// wire-формат (402 + extensions.bazaar) по живой записи Bazaar от 2026-08-25;
// оплату НЕ верифицируем. В Phase 1 заменяется официальным middleware
// (@coinbase/cdp-sdk/x402 createX402Server + declareDiscoveryExtension).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url)));
const PORT = process.env.PORT ?? 4021;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

const usdToAtomic = (usd) => String(Math.round(usd * 1e6)); // USDC, 6 знаков

function paymentRequirements(sku, merchant) {
  const d = catalog.defaults;
  return {
    scheme: "exact",
    network: d.network,
    asset: d.asset,
    extra: d.assetMeta,
    amount: usdToAtomic(sku.priceUsd),
    payTo: merchant.payTo,
    maxTimeoutSeconds: d.maxTimeoutSeconds,
    resource: `${BASE_URL}${sku.path}`,
    description: sku.description,
  };
}

function bazaarExtension(sku) {
  return {
    info: { input: sku.input, output: { type: "json", example: sku.outputExample } },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { input: { properties: sku.inputSchema, type: "object" } },
      type: "object",
    },
  };
}

// route table из конфига — «автоматизация листинга»: мерчанты добавляются
// строкой в catalog.json, руками ничего не листится
const routes = new Map();
for (const merchant of catalog.merchants)
  for (const sku of merchant.skus)
    routes.set(`${sku.method} ${sku.path}`, { merchant, sku });

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  };

  if (req.method === "GET" && path === "/catalog") {
    // операторский вид витрины: то, что уйдёт в Bazaar по каждому ресурсу
    return json(200, [...routes.values()].map(({ merchant, sku }) => ({
      merchant: merchant.id,
      resource: `${BASE_URL}${sku.path}`,
      accepts: [paymentRequirements(sku, merchant)],
      description: sku.description,
      extensions: { bazaar: bazaarExtension(sku) },
    })));
  }

  const hit = routes.get(`${req.method} ${path}`);
  if (!hit) return json(404, { error: "unknown resource" });

  const { merchant, sku } = hit;
  if (!req.headers["x-payment"]) {
    return json(402, {
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [paymentRequirements(sku, merchant)],
      extensions: { bazaar: bazaarExtension(sku) },
    });
  }
  // Phase 0: платёж не проверяем — честно помечаем это в ответе
  res.setHeader("x-spike-warning", "phase0-mock: payment NOT verified");
  json(200, { ...sku.outputExample, _mock: true, _merchant: merchant.id });
});

server.listen(PORT, () =>
  console.log(`[spike] витрина: ${routes.size} ресурсов от ${catalog.merchants.length} мерчантов на ${BASE_URL}`));
