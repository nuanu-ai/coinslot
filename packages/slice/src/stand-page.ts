/** The stand's server-rendered console. */

import type { MerchantCard, Money, Refusal } from "@nuanu-ai/coinslot-contracts";
import { filledFrom } from "./stand-goods.js";
import type { Entry } from "./stand-log.js";
import type { OrderMood, QuoteMood } from "./stand-merchant.js";

export interface PageMoods {
  readonly order: OrderMood;
  readonly quote: QuoteMood;
  readonly deliverAfterMs: number;
  readonly refusal: Refusal;
  readonly price: Money;
}

export interface PageState {
  readonly address: string | null;
  readonly moods: PageMoods;
  readonly cardDraft: string;
  readonly goodsDraft: string;
  readonly paramsDraft: string;
  readonly cards: readonly MerchantCard[];
  readonly selling: string | null;
  readonly heldOrders: readonly { readonly id: string; readonly merchantItemId: string }[];
  readonly message: string | null;
  readonly entries: readonly Entry[];
}

const escaped = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const option = (value: string, selected: string, label: string = value): string =>
  `<option value="${escaped(value)}"${value === selected ? " selected" : ""}>${escaped(label)}</option>`;

const form = (action: string, body: string, label: string): string =>
  `<form method="post"><input type="hidden" name="action" value="${escaped(action)}">${body}<button type="submit">${escaped(label)}</button></form>`;

const entry = (one: Entry): string =>
  `<article class="entry"><small>${escaped(one.at)} · ${escaped(one.kind)}</small><h3>${escaped(one.title)}</h3><pre>${escaped(json(one.detail))}</pre></article>`;

const cardRow = (card: MerchantCard): string => {
  const publicId = card.id;
  const parameters = json(filledFrom(card.card.params));
  const paused = card.paused ? "paused" : "open";
  return `<article class="card">
    <h3>${escaped(card.card.title)}</h3>
    <p><code>${escaped(publicId)}</code> — public id; <code>${escaped(card.card.merchant_item_id)}</code> — merchant item id.</p>
    <p>Card: ${escaped(paused)}. Merchant selling: ${escaped(card.selling)}.</p>
    <p>Filled purchase parameters:</p><pre>${escaped(parameters)}</pre>
    <div class="actions">
      ${form(card.paused ? "resume_card" : "pause_card", `<input type="hidden" name="item_id" value="${escaped(publicId)}">`, card.paused ? "Resume card" : "Pause card")}
      ${form("fill", `<input type="hidden" name="item_id" value="${escaped(publicId)}">`, "Fill parameters")}
      ${form("buy", `<input type="hidden" name="item_id" value="${escaped(publicId)}"><input type="hidden" name="params" value="${escaped(parameters)}">`, "Buy this card")}
    </div>
  </article>`;
};

/** Renders the complete local page; it receives no merchant key. */
export const renderPage = (state: PageState): string => {
  const connection =
    state.address === null
      ? form(
          "connect",
          '<label>Gateway address <input required name="address" value="http://localhost:8080"></label><label>Merchant key <input required name="api_key" type="password" autocomplete="off"></label>',
          "Connect",
        )
      : `<p>Connected to <code>${escaped(state.address)}</code>. Every gateway-facing action uses this gateway.</p>${form("disconnect", "", "Disconnect")}`;
  const templates = `${form("template", '<input type="hidden" name="template" value="0">', "Rented-number template")}${form("template", '<input type="hidden" name="template" value="1">', "eSIM template")}`;
  const publish = form(
    "publish",
    `<label>Card JSON<textarea name="card">${escaped(state.cardDraft)}</textarea></label>`,
    "Publish draft",
  );
  const selling = `${form("pause_selling", "", "Pause all selling")}${form("resume_selling", "", "Resume all selling")}`;
  const catalog =
    state.cards.length === 0
      ? "<p>No published cards read yet.</p>"
      : state.cards.map(cardRow).join("\n");
  const handlerBody = `<div class="grid"><label>Order mood <select name="order">${option("deliver", state.moods.order)}${option("accept_then_deliver", state.moods.order, "accept, then deliver")}${option("accept_and_say_nothing", state.moods.order, "accept and say nothing")}${option("refuse", state.moods.order)}${option("say_nothing", state.moods.order, "say nothing")}${option("answer_wrong_shape", state.moods.order, "answer wrong shape")}</select></label><label>Quote mood <select name="quote">${option("price", state.moods.quote)}${option("unavailable", state.moods.quote)}${option("say_nothing", state.moods.quote, "say nothing")}</select></label><label>Deliver after milliseconds <input name="deliver_after_ms" type="number" min="0" value="${escaped(state.moods.deliverAfterMs)}"></label><label>Price amount <input name="price_amount" value="${escaped(state.moods.price.amount)}"></label><label>Price currency <input name="price_currency" value="${escaped(state.moods.price.currency)}"></label><label>Refusal code <input name="refusal_code" value="${escaped(state.moods.refusal.code)}"></label><label>Refusal message <input name="refusal_message" value="${escaped(state.moods.refusal.message)}"></label></div><label>Goods JSON (empty means the card declaration)<textarea name="goods">${escaped(state.goodsDraft)}</textarea></label>`;
  const buyer = `${form("buy", `<label>Buy a public item id not in this list <input name="item_id"></label><label>Purchase parameters JSON<textarea name="params">${escaped(state.paramsDraft)}</textarea></label>`, "Buy")}${form("invalid_payment", `<label>Public item id <input required name="item_id"></label><label>Purchase parameters JSON<textarea name="params">${escaped(state.paramsDraft)}</textarea></label>`, "Send unreadable payment")}${form("status", '<label>Order id <input required name="order_id"></label>', "Ask status")}${form("receipts", "", "Read merchant receipts")}`;
  const held =
    state.heldOrders.length === 0
      ? "<p>None.</p>"
      : `<ul>${state.heldOrders.map((one) => `<li><code>${escaped(one.id)}</code> — ${escaped(one.merchantItemId)}</li>`).join("")}</ul>`;
  const feed = [...state.entries].reverse().map(entry).join("\n");
  const notice = state.message === null ? "" : `<p class="message">${escaped(state.message)}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Coinslot stand</title><style>body{font:16px/1.45 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#17211d;background:#fbfcfa}section{border:1px solid #cdd8d1;border-radius:.5rem;padding:1rem;margin:1rem 0}textarea,input,select{font:inherit;max-width:100%;box-sizing:border-box}textarea{width:100%;min-height:8rem}input{padding:.35rem}button{padding:.4rem .65rem;margin:.15rem}.actions{display:flex;gap:.4rem;flex-wrap:wrap}.actions form{display:inline}pre{overflow:auto;background:#f0f4f1;padding:.65rem;white-space:pre-wrap}.card,.entry{border-top:1px solid #dce4de;padding:.7rem 0}.entry h3{margin:.2rem 0}small{color:#52625a}.message{padding:.75rem;background:#fff4d8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}label{display:block;margin:.45rem 0}</style></head><body><h1>Coinslot stand</h1><p>The feed is this console's record of its wire traffic, not the gateway journal.</p>${notice}<section><h2>Connection</h2>${connection}</section><section><h2>Catalog</h2><div class="actions">${templates}</div>${publish}<p>Merchant selling: ${escaped(state.selling ?? "not read")}</p><div class="actions">${selling}</div>${catalog}</section><section><h2>Handler</h2>${form("moods", handlerBody, "Set handler moods")}</section><section><h2>Buyer</h2>${buyer}</section><section><h2>Held orders</h2>${held}</section><section><h2>Feed</h2><div id="feed">${feed}</div></section><script>const feed=document.getElementById("feed");const stream=new EventSource("/feed");stream.onmessage=(event)=>{const item=JSON.parse(event.data);const article=document.createElement("article");article.className="entry";const small=document.createElement("small");small.textContent=item.at+" · "+item.kind;const heading=document.createElement("h3");heading.textContent=item.title;const detail=document.createElement("pre");detail.textContent=JSON.stringify(item.detail,null,2);article.append(small,heading,detail);feed.prepend(article)};</script></body></html>`;
};
