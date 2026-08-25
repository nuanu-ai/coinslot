// Спайк: пробы сторон витрины.
//   node probe.mjs local [base]              — операторский вид + взгляд агента
//   node probe.mjs raw <url> [method]        — точный 402: заголовки + тело + расшифровка PAYMENT-REQUIRED
//   node probe.mjs validate <url> [method]   — официальная валидация листинга (без API-ключа)
//   node probe.mjs bazaar <query>            — поиск по живому каталогу Bazaar
const [, , cmd, arg, arg2] = process.argv;
const out = (label, body) => console.log(`\n== ${label} ==\n` + JSON.stringify(body, null, 2));

if (cmd === "local") {
  const base = arg ?? "http://localhost:4021";
  const catalog = await (await fetch(`${base}/catalog`)).json();
  out("операторский вид: /catalog", catalog.resources.map((r) => ({
    merchant: r.merchant, url: r.url, method: r.method, routeKeys: r.routeKeys,
  })));
  const r = await fetch(`${base}/freeland/vpn/config?protocol=wireguard`, { headers: { accept: "application/json" } });
  // официальный стек кладёт весь PaymentRequired в заголовок, тело оставляет пустым
  const h = r.headers.get("payment-required");
  out(`агент без оплаты → HTTP ${r.status} (PAYMENT-REQUIRED, тело ${await r.text()})`,
    h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null);
} else if (cmd === "raw") {
  // Ровно то, что видит клиент: статус, все заголовки, тело и расшифрованный
  // PAYMENT-REQUIRED. Нужно, чтобы сравнивать wire-формат стека с самописным.
  const r = await fetch(arg, { method: arg2 ?? "GET", headers: { accept: "application/json" } });
  const header = r.headers.get("payment-required");
  out(`raw ${arg} (${arg2 ?? "GET"}) → HTTP ${r.status}`, {
    headers: Object.fromEntries(r.headers),
    paymentRequiredHeaderDecoded: header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null,
    body: await r.json().catch(() => null),
  });
} else if (cmd === "validate") {
  // POST /platform/v2/x402/validate — проверяет достижимость, 402, bazaar-блок,
  // приемлемость для CDP facilitator. Нужен ПУБЛИЧНЫЙ url ресурса.
  // Валидатор пробит ресурс через GET по умолчанию: для POST/PUT/PATCH-ресурсов
  // метод надо передать явно, иначе проверяется не тот вариант маршрута.
  const r = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource: arg, ...(arg2 ? { method: arg2 } : {}) }),
  });
  out(`validate ${arg} (${arg2 ?? "GET"}) → HTTP ${r.status}`, await r.json().catch(() => ({})));
} else if (cmd === "bazaar") {
  const r = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100");
  const { items, pagination } = await r.json();
  const q = (arg ?? "").toLowerCase();
  const hits = items.filter((i) => JSON.stringify(i).toLowerCase().includes(q));
  out(`bazaar: всего ${pagination.total}, на странице совпадений с "${arg}": ${hits.length}`,
    hits.slice(0, 3).map((i) => ({ resource: i.resource, description: i.description?.slice(0, 120) })));
} else {
  console.log("usage: node probe.mjs local [base]|raw <url> [method]|validate <url> [method]|bazaar <query>");
}
