// Спайк: покупатель. Один настоящий оплаченный вызов через CDP facilitator —
// тот самый settle, который и заводит ресурс в каталог Bazaar.
//
// Сеть — Base mainnet, деньги настоящие: без --confirm и SETTLE_ALLOW_MAINNET=1
// скрипт сам откажется платить (см. «Предохранители» ниже).
//
//   node settle.mjs <resource-url> [--confirm]
//
// Источник кошелька (ровно один):
//   BUYER_PRIVATE_KEY=0x…            локальный EOA (viem)
//   X402_BUYER=cdp                   кошелёк CDP Server Wallet
//                                    (+ CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET)
//
// Настройки вызова:
//   SETTLE_METHOD=POST               метод ресурса (по умолчанию GET)
//   SETTLE_BODY='{"country":"US"}'   тело для POST/PUT/PATCH
//   SETTLE_MAX_USD=0.01              жёсткий потолок суммы (по умолчанию 1 цент)
//   SETTLE_ALLOW_MAINNET=1           явное разрешение mainnet (по умолчанию только testnet)
//
// Предохранители (любой срабатывает → выход без платежа):
//   1) кошелёк не задан;
//   2) payTo ресурса — известная заглушка (0x…dEaD / 0x…bEEF / нулевой адрес);
//   3) сеть — mainnet без SETTLE_ALLOW_MAINNET=1;
//   4) сумма больше SETTLE_MAX_USD;
//   5) нет флага --confirm (по умолчанию — сухой прогон, платёж не делается).
// Приватный ключ нигде не печатается и никуда не пишется.
//
// Диагностика (почему скрипт больше не молчит):
//   В x402 v2 тело 402 ВСЕГДА пустое ({}), а причина отказа лежит в base64-
//   заголовке PAYMENT-REQUIRED (поле error) — там и текст фасилитатора:
//   invalid_exact_evm_payload_signature…, invalid_payload: contract call failed…
//   Раньше скрипт печатал «HTTP 402 / {}» и молча выходил с кодом 0. Теперь:
//     • трассируются обе попытки (без подписи и с ней) с длиной PAYMENT-SIGNATURE;
//     • ошибки самого платёжного клиента печатаются текстом, а не глотаются;
//     • любой исход кроме успешного settle → ненулевой код выхода.

import { readFileSync } from "node:fs";

const [, , resourceUrl, ...flags] = process.argv;
const CONFIRM = flags.includes("--confirm");
const MAX_USD = Number(process.env.SETTLE_MAX_USD ?? "0.01");
const METHOD = (process.env.SETTLE_METHOD ?? "GET").toUpperCase();
const BODY = process.env.SETTLE_BODY;
const ALLOW_MAINNET = process.env.SETTLE_ALLOW_MAINNET === "1";

// eip155:*-сети, где деньги ненастоящие. Всё остальное считаем mainnet.
const TESTNETS = new Set(["eip155:84532", "eip155:11155111", "eip155:80002"]);
// Хвосты адресов-заглушек из catalog.json + нулевой адрес.
const DUMMY_TAILS = ["dead", "beef", "0000"];

const die = (why) => {
  console.error(`[settle] ОТКАЗ: ${why}`);
  process.exit(1);
};
const say = (...a) => console.log("[settle]", ...a);

const isDummyPayTo = (addr) => {
  const a = String(addr ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return true; // не адрес — тоже повод не платить
  const body = a.slice(2);
  return DUMMY_TAILS.some((tail) => body === "0".repeat(40 - tail.length) + tail);
};

// Заглушки из каталога — чтобы список не расходился с витриной.
const catalogDummies = () => {
  try {
    const c = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url)));
    return new Set(c.merchants.map((m) => m.payTo.toLowerCase()).filter(isDummyPayTo));
  } catch {
    return new Set();
  }
};

if (!resourceUrl || !/^https?:\/\//.test(resourceUrl))
  die("нужен URL ресурса: node settle.mjs <resource-url> [--confirm]");

// --- 1. кошелёк -----------------------------------------------------------
const useCdpWallet = process.env.X402_BUYER === "cdp";
const privateKey = process.env.BUYER_PRIVATE_KEY;
if (!useCdpWallet && !privateKey)
  die("BUYER_PRIVATE_KEY не задан (или X402_BUYER=cdp для кошелька CDP) — платить нечем и незачем");
if (useCdpWallet && !(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET))
  die("X402_BUYER=cdp требует CDP_API_KEY_ID, CDP_API_KEY_SECRET и CDP_WALLET_SECRET");
if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey))
  die("BUYER_PRIVATE_KEY не похож на приватный ключ (0x + 64 hex)");

// --- 2. читаем 402 --------------------------------------------------------
const probe = await fetch(resourceUrl, { headers: { accept: "application/json" } });
if (probe.status !== 402) die(`ресурс ответил ${probe.status}, а не 402 — платить не за что`);

// Канон HTTP-транспорта v2 — base64 всего объекта в заголовке; тело читаем как запасной путь.
const header = probe.headers.get("payment-required");
const paymentRequired = header
  ? JSON.parse(Buffer.from(header, "base64").toString("utf8"))
  : await probe.json();

const accepts = paymentRequired.accepts ?? [];
if (accepts.length === 0) die("в 402 нет accepts[]");

// --- 3. предохранители по каждому варианту оплаты -------------------------
const dummies = catalogDummies();
const { getDefaultAsset } = await import("@x402/evm");

const priced = accepts.map((a) => {
  const asset = getDefaultAsset?.(a.network);
  const decimals = asset && asset.asset?.toLowerCase() === String(a.asset).toLowerCase() ? asset.decimals : null;
  const usd = decimals === null ? null : Number(a.amount) / 10 ** decimals;
  return { ...a, usd, symbol: asset?.symbol };
});

for (const a of priced) {
  say(`вариант: ${a.amount} (${a.usd ?? "?"} ${a.symbol ?? "?"}) → ${a.payTo} в ${a.network}`);
  if (isDummyPayTo(a.payTo) || dummies.has(String(a.payTo).toLowerCase()))
    die(`payTo ${a.payTo} — заглушка из каталога. Сначала подставь реальный адрес мерчанта в catalog.json`);
  if (!TESTNETS.has(a.network) && !ALLOW_MAINNET)
    die(`${a.network} — не тестовая сеть. Для настоящих денег нужен явный SETTLE_ALLOW_MAINNET=1`);
  if (a.usd === null) die(`не удалось определить decimals ассета ${a.asset} в ${a.network} — сумму не проверить`);
  if (a.usd > MAX_USD) die(`${a.usd} USD больше потолка SETTLE_MAX_USD=${MAX_USD}`);
}

// --- 4. сухой прогон ------------------------------------------------------
if (!CONFIRM) {
  say("сухой прогон: все предохранители пройдены, платёж НЕ выполнен. Повтори с --confirm.");
  process.exit(0);
}

// --- 5. настоящий платёж --------------------------------------------------
const { wrapFetchWithPayment, decodePaymentResponseHeader } = await import("@x402/fetch");
const { decodePaymentRequiredHeader } = await import("@x402/core/http");

// --- трассировка HTTP-попыток ---------------------------------------------
// wrapFetchWithPayment внутри делает два запроса: без подписи и с ней. Нам
// нужно видеть оба — иначе «HTTP 402» не отличить от «клиент вообще не
// приложил PAYMENT-SIGNATURE». Пишем только метаданные: метод, статус, длину
// заголовка подписи и вердикт сервера. Ни подписи, ни тел, ни ключей.
const attempts = [];
let lastVerify = null;

const traced = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const sig = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  const res = await fetch(req);
  let verify = null;
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      verify = decodePaymentRequiredHeader(header).error ?? null;
    } catch {
      verify = "PAYMENT-REQUIRED не разбирается";
    }
  }
  if (sig) lastVerify = verify; // вердикт именно на попытку с подписью
  attempts.push({
    method: req.method,
    status: res.status,
    sig: sig ? `${sig.length} симв.` : "нет",
    verify,
    settle: res.headers.get("payment-response") ? "есть PAYMENT-RESPONSE" : null,
    serverDate: res.headers.get("date"),
  });
  return res;
};

const report = () => {
  attempts.forEach((a, i) =>
    say(`попытка ${i + 1}: ${a.method} → HTTP ${a.status}, PAYMENT-SIGNATURE: ${a.sig}` +
      (a.verify ? `, вердикт: ${JSON.stringify(a.verify)}` : "") +
      (a.settle ? `, ${a.settle}` : "")));
  if (attempts.length && !attempts.some((a) => a.sig !== "нет"))
    say("ВНИМАНИЕ: подпись не была приложена ни в одной попытке — платёжный клиент пропустил оплату");
  // Часы: EIP-3009 validBefore = now + maxTimeoutSeconds. Убежавшие часы
  // контейнера дают «execution reverted» на ровном месте.
  const d = attempts.find((a) => a.serverDate)?.serverDate;
  if (d) {
    const skew = Math.round((Date.now() - Date.parse(d)) / 1000);
    if (Math.abs(skew) > 30) say(`ВНИМАНИЕ: часы расходятся с сервером на ${skew} c — подпись может быть просрочена`);
  }
};

// У самого x402Client есть СВОЙ потолок на платёж — spendControls
// .maxAmountPerPayment, по умолчанию "$1" (@x402/core/client,
// DEFAULT_MAX_AMOUNT_PER_PAYMENT). Он невидим снаружи и режет платёж до
// подписи: ресурс за $5 у нас так и не оплачивался бы, а наружу это выходило
// голым 402. Держим единственный потолок — SETTLE_MAX_USD.
const spendControls = { maxAmountPerPayment: `$${MAX_USD}` };

let payFetch;
if (useCdpWallet) {
  const { CdpX402Client } = await import("@coinbase/cdp-sdk/x402");
  const client = new CdpX402Client();
  client.setSpendControls(spendControls);
  payFetch = wrapFetchWithPayment(traced, client);
  say("кошелёк: CDP Server Wallet");
} else {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client } = await import("@x402/core/client");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  client.setSpendControls(spendControls);
  payFetch = wrapFetchWithPayment(traced, client);
  say(`кошелёк: локальный EOA ${account.address}`); // публичный адрес, не ключ
}
say(`потолок клиента: ${spendControls.maxAmountPerPayment} за платёж (SETTLE_MAX_USD)`);

const init = { method: METHOD, headers: { accept: "application/json" } };
if (BODY && ["POST", "PUT", "PATCH"].includes(METHOD)) {
  init.headers["content-type"] = "application/json";
  init.body = BODY;
}

let paid;
try {
  paid = await payFetch(resourceUrl, init);
} catch (err) {
  // Клиент @x402/fetch заворачивает свои сбои в Error и не делает второй
  // запрос: «нет схемы под сеть», «нет extra.name/version для EIP-712»,
  // «всё отфильтровано spendControls». Раньше это было видно только как
  // stack trace, теперь — отдельной строкой и с ненулевым кодом выхода.
  report();
  die(`платёжный клиент не смог выполнить запрос: ${err?.message ?? err}` +
    (err?.cause ? `\n[settle]   причина: ${err.cause?.message ?? err.cause}` : ""));
}

const receiptHeader = paid.headers.get("payment-response");
const body = await paid.json().catch(() => null);
report();
say(`HTTP ${paid.status}`);
say("ответ ресурса:", JSON.stringify(body, null, 2));

if (receiptHeader) {
  const receipt = decodePaymentResponseHeader(receiptHeader);
  say("квитанция settle:", JSON.stringify(receipt, null, 2));
  if (!receipt.success) die(`сеттл не прошёл: ${receipt.errorReason ?? "причина не указана"}`);
} else if (paid.status >= 400) {
  // Голый 402 сам по себе ничего не значит: в v2 тело всегда {}, а вердикт
  // фасилитатора лежит в PAYMENT-REQUIRED.error. Не прочитать его — и есть
  // «тихий отказ», из-за которого первый прогон выглядел необъяснимым.
  die(`ресурс ответил ${paid.status} и сеттла не было. Вердикт фасилитатора: ` +
    JSON.stringify(lastVerify ?? "PAYMENT-REQUIRED не пришёл — до фасилитатора не дошло"));
} else {
  die(`HTTP ${paid.status} без PAYMENT-RESPONSE — сеттла не было, товар отдан бесплатно?`);
}

say("готово: платёж прошёл, квитанция получена.");
