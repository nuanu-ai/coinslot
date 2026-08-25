// Спайк: пробы трёх сторон витрины.
//   node probe.mjs local            — как агент видит наш 402 (локально)
//   node probe.mjs validate <url> [method]  — официальная валидация листинга (без API-ключа)
//   node probe.mjs bazaar <query>   — поиск по живому каталогу Bazaar
const [, , cmd, arg, arg2] = process.argv;
const out = (label, body) => console.log(`\n== ${label} ==\n` + JSON.stringify(body, null, 2));

if (cmd === "local") {
  const base = arg ?? "http://localhost:4021";
  const catalog = await (await fetch(`${base}/catalog`)).json();
  out("операторский вид: /catalog", catalog.map((r) => ({ merchant: r.merchant, resource: r.resource, price: r.accepts[0].amount })));
  const r = await fetch(`${base}/freeland/vpn/config?protocol=wireguard`);
  out(`агент без оплаты → HTTP ${r.status}`, await r.json());
} else if (cmd === "validate") {
  // POST /platform/v2/x402/validate — проверяет достижимость, 402, bazaar-блок,
  // приемлемость для CDP facilitator. Нужен ПУБЛИЧНЫЙ url ресурса.
  // Валидатор пробит ресурс через GET по умолчанию: для POST/PUT/PATCH-ресурсов
  // метод надо передать явно, иначе падает bazaar.info.input.method.matches_request.
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
  console.log("usage: node probe.mjs local|validate <url> [method]|bazaar <query>");
}
