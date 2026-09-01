/**
 * The stand's three server-rendered seats.
 *
 * A purchase has three participants, so the console has three tabs and you sit
 * in one at a time: the merchant who publishes, the agent who buys, and the
 * merchant's own code answering orders. What the tabs would otherwise cut is
 * the thread between them, so the log is on all three, grouped by the order it
 * belongs to.
 *
 * Two things this file will not do. It never receives the merchant key — the
 * state it is handed carries the environment the key names and nothing else —
 * and it never says more about the gateway than the connection can support: the
 * words below speak about the key somebody typed, because that is the only
 * thing here that names an environment.
 */

import { type Environment, SITES } from "@coinslot/core";
import {
  API_ROUTES,
  type Card,
  expandPath,
  type MerchantCard,
  type Money,
  type OrderStatus,
  type OrderWithStatus,
  type PublicCard,
  RECOMMENDED_REFUSAL_CODES,
  type Receipt,
  type Refusal,
  type SellingState,
} from "@nuanu-ai/coinslot-contracts";
import type { ChallengeView } from "./stand-buyer.js";
import type { Entry } from "./stand-log.js";
import type { HeldOrder, OrderMood, QuoteMood } from "./stand-merchant.js";
import { TEMPLATES } from "./stand-templates.js";

export type Tab = "catalogue" | "agent" | "orders";

/** One thing said in the agent's conversation with a product. */
export interface Beat {
  readonly who: "agent" | "gateway";
  readonly said: string;
  readonly fact: string;
  readonly detail: unknown;
  readonly tone: "" | "now" | "bad";
}

export interface ExchangeView {
  readonly itemId: string;
  readonly title: string;
  readonly beats: readonly Beat[];
  readonly challenge: ChallengeView | null;
  /** Whether a challenge is in hand, waiting for a signature that is yours to give. */
  readonly holdingChallenge: boolean;
  readonly orderId: string | null;
  readonly waiting: boolean;
  readonly closed: boolean;
}

export interface PageMoods {
  readonly order: OrderMood;
  readonly quote: QuoteMood;
  readonly deliverAfterMs: number;
  readonly refusal: Refusal;
  readonly price: Money;
}

/** What the seats you are not sitting in will do next. */
export interface Standing {
  readonly order: OrderMood;
  readonly quote: QuoteMood;
  readonly held: number;
}

/** How the last action ended, and whether it ended badly. */
export interface SaidBack {
  readonly words: string;
  readonly problem: boolean;
}

export interface PageState {
  readonly tab: Tab;
  readonly address: string | null;
  /**
   * Which environment the merchant key names, read from its prefix alone.
   *
   * Null for a key that names none — a gateway of somebody's own, or the bare
   * string a test connects with. The page says so in those words rather than
   * falling to either side: "I cannot tell" and "there is no real money here"
   * are different sentences and only one of them is true.
   */
  readonly keyEnvironment: Environment | null;
  readonly said: SaidBack | null;
  readonly entries: readonly Entry[];
  readonly standing: Standing;

  readonly cards: readonly MerchantCard[];
  readonly selling: SellingState | null;
  readonly cardDraft: string;

  readonly publicItems: readonly PublicCard[];
  readonly publicItemsRead: boolean;
  readonly chosen: string | null;
  readonly paramsDraft: string;
  readonly exchange: ExchangeView | null;

  readonly moods: PageMoods;
  readonly goodsDraft: string;
  readonly held: readonly HeldOrder[];
  readonly owed: readonly { readonly id: string; readonly merchantItemId: string }[];
  readonly orders: readonly OrderWithStatus[];
  readonly ordersRead: boolean;
  readonly receipts: readonly Receipt[];
  readonly receiptsRead: boolean;
}

const escaped = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const form = (action: string, body: string, label: string, primary = false): string =>
  `<form method="post" class="inline"><input type="hidden" name="action" value="${escaped(action)}">${body}<button type="submit"${primary ? ' class="primary"' : ""}>${escaped(label)}</button></form>`;

const hidden = (name: string, value: string): string =>
  `<input type="hidden" name="${escaped(name)}" value="${escaped(value)}">`;

const field = (label: string, control: string, why?: string): string =>
  `<div class="field"><label><span class="lbl">${escaped(label)}</span>${control}</label>${why === undefined ? "" : `<span class="why">${escaped(why)}</span>`}</div>`;

const dot = (tone: string, text: string): string =>
  `<span class="state ${escaped(tone)}"><span class="dot"></span>${escaped(text)}</span>`;

/**
 * The address behind a panel, taken from the contract's own table.
 *
 * Written out by hand these would be a second copy of the wire, drifting the
 * first time a route is renamed — and drifting silently, because a wrong
 * address printed beside a working button looks exactly like a right one.
 *
 * With values it prints the address that will be called; with none it prints
 * the route as the table writes it, `:order_id` and all. That is the honest
 * label for a panel whose address is not decided until somebody types into it,
 * and it avoids the alternative of feeding a stand-in through `expandPath`,
 * which would percent-encode it into noise.
 */
const route = (name: keyof typeof API_ROUTES, values?: Record<string, string>): string => {
  const { method, path } = API_ROUTES[name];
  return `<code class="addr">${escaped(method)} ${escaped(values === undefined ? path : expandPath(path, values))}</code>`;
};

/* --- words -------------------------------------------------------------- */

interface Choice<T> {
  readonly value: T;
  readonly label: string;
}

/**
 * The seven answers the handler can give, in words that say what happens.
 *
 * Six of them are answers a merchant's own code can give. The seventh is the
 * console's own: real merchant code answers and returns, and holding an order
 * open for a person is a thing only a stand does. It says so where it is
 * offered.
 */
const ORDER_CHOICES: readonly Choice<OrderMood>[] = [
  { value: "deliver", label: "Deliver at once" },
  { value: "accept_then_deliver", label: "Accept, then deliver after the delay" },
  { value: "accept_and_say_nothing", label: "Accept and never deliver" },
  { value: "refuse", label: "Refuse with the code below" },
  { value: "say_nothing", label: "Answer only after the deadline" },
  { value: "answer_wrong_shape", label: "Deliver a shape the card never declared" },
  { value: "ask_me", label: "Hold it and ask me" },
];

const QUOTE_CHOICES: readonly Choice<QuoteMood>[] = [
  { value: "price", label: "Answer the price below" },
  { value: "unavailable", label: "Say the price is unavailable" },
  { value: "say_nothing", label: "Answer only after the deadline" },
];

const labelOf = <T extends string>(choices: readonly Choice<T>[], value: T): string =>
  choices.find((one) => one.value === value)?.label ?? value;

const select = <T extends string>(name: string, choices: readonly Choice<T>[], value: T): string =>
  `<select name="${escaped(name)}" class="applies">${choices
    .map(
      (one) =>
        `<option value="${escaped(one.value)}"${one.value === value ? " selected" : ""}>${escaped(one.label)}</option>`,
    )
    .join("")}</select>`;

const SELLING_WORDS: Readonly<Record<SellingState, { text: string; tone: string }>> = {
  open: { text: "selling", tone: "ok" },
  paused: { text: "paused", tone: "warn" },
  departed: { text: "left", tone: "" },
};

/** What a buyer of this card is in for, in the merchant's own terms. */
const cardTerms = (card: Card): string => {
  const terms: string[] = [];
  switch (card.fulfillment) {
    case "sync":
      terms.push("delivered in the purchase");
      break;
    case "async":
      terms.push(
        card.fulfill_deadline_seconds === undefined
          ? "delivered later, with no deadline"
          : `delivered later, within ${card.fulfill_deadline_seconds} s`,
      );
      break;
    case "confirm":
      terms.push("confirmed first");
      break;
  }
  if (card.price_check !== undefined) {
    terms.push(
      card.price_check === "handler" ? "price asked of the handler" : "price asked of a URL",
    );
  }
  return terms.join(" · ");
};

/* --- the catalogue tab -------------------------------------------------- */

const cardRow = (card: MerchantCard): string => {
  const word = SELLING_WORDS[card.selling];
  return `<tr${card.selling === "open" ? "" : ' class="off"'}>
    <td>
      <div class="title">${escaped(card.card.title)}</div>
      <div class="under">${escaped(card.card.price.amount)} ${escaped(card.card.price.currency)} · ${escaped(cardTerms(card.card))}</div>
      <div class="under mono">${escaped(card.id)} · ${escaped(card.card.merchant_item_id)}</div>
    </td>
    <td><code class="addr">${escaped(expandPath(API_ROUTES.purchase_item.path, { item_id: card.id }))}</code></td>
    <td>
      ${dot(word.tone, word.text)}
      ${card.paused ? '<div class="under">paused on its own</div>' : ""}
    </td>
    <td class="ctl"><div class="actions">
      ${form(card.paused ? "resume_card" : "pause_card", hidden("item_id", card.id), card.paused ? "Resume" : "Pause")}
    </div></td>
  </tr>`;
};

const catalogueTab = (state: PageState): string => {
  const word = state.selling === null ? null : SELLING_WORDS[state.selling];
  const switching =
    state.selling === "open"
      ? form("pause_selling", "", "Stop all selling")
      : form("resume_selling", "", "Resume all selling");
  const table =
    state.cards.length === 0
      ? '<p class="empty">This merchant has published no cards on this gateway yet.</p>'
      : `<div class="scroller"><table>
<thead><tr><th>Card</th><th>Address an agent buys at</th><th>State</th><th></th></tr></thead>
<tbody>${state.cards.map(cardRow).join("")}</tbody>
</table></div>`;
  return `<section class="panel">
  <header>
    <h2>What this merchant sells</h2>
    <div class="side">${word === null ? "Not read yet." : dot(word.tone, `this merchant is ${word.text}`)}${route("list_merchant_cards")}${form("read_cards", "", "Read again")}${switching}</div>
  </header>
  ${table}
</section>
<section class="panel">
  <header>
    <h2>Publish a card</h2>
    <div class="side">${route("publish_card")}</div>
  </header>
  <div class="body">
    <div class="actions">${TEMPLATES.map(
      (one) =>
        `<form method="post" class="inline">${hidden("action", "template")}${hidden("template", one.key)}<button type="submit" title="${escaped(one.about)}">${escaped(one.label)}</button></form>`,
    ).join("")}</div>
    <p>The first three are the files the portal prints on its own pages, read from disk rather than copied — a button that stops publishing is a documented example that stopped working. The fourth is the shape the public x402 catalogue is full of: a synchronous lookup answering with JSON, at a fraction of a cent. The last two are the pilot's own products.</p>
    ${form("publish", field("Card (JSON)", `<textarea name="card">${escaped(state.cardDraft)}</textarea>`), "Publish", true)}
    <p>Publishing the same <code>merchant_item_id</code> again replaces the card. There is no unpublish: the gateway offers publish, pause and resume, so pausing is how a card comes off sale.</p>
  </div>
</section>`;
};

/* --- the agent tab ------------------------------------------------------ */

const publicRow = (
  item: PublicCard,
  chosen: string | null,
): string => `<tr${item.id === chosen ? ' class="picked"' : ""}>
  <td>
    <div class="title">${escaped(item.title)}</div>
    <div class="under mono">${escaped(item.id)}</div>
  </td>
  <td>${escaped(item.price.amount)} ${escaped(item.price.currency)}${item.price_checked_at_purchase ? '<div class="under">asked again at purchase</div>' : ""}</td>
  <td>${escaped(item.fulfillment === "sync" ? "in the purchase" : item.fulfillment === "async" ? "later" : "after a confirmation")}</td>
  <td class="ctl"><div class="actions">${form("choose", hidden("item_id", item.id), item.id === chosen ? "Chosen" : "Choose", item.id !== chosen)}</div></td>
</tr>`;

const beatRow = (one: Beat): string => `<div class="beat ${escaped(one.tone)}">
  <span class="who">${escaped(one.who)}</span>
  <div class="said">
    <div class="head">${escaped(one.said)}${one.fact === "" ? "" : ` <span class="mono">${escaped(one.fact)}</span>`}</div>
    ${one.detail === undefined || one.detail === null ? "" : `<details><summary>what it carried</summary><pre>${escaped(json(one.detail))}</pre></details>`}
  </div>
</div>`;

const requirements = (view: ChallengeView): string => `<div class="reqs">
  <div><div class="k">amount</div><div class="v">${escaped(view.amount)}</div></div>
  <div><div class="k">asset</div><div class="v">${escaped(view.asset)}</div></div>
  <div><div class="k">network</div><div class="v">${escaped(view.network)}</div></div>
  <div><div class="k">pay to</div><div class="v">${escaped(view.payTo)}</div></div>
  <div><div class="k">scheme</div><div class="v">${escaped(view.scheme)}</div></div>
  <div><div class="k">order in extra</div><div class="v">${view.orderId === null ? "none — this challenge is for the card alone" : escaped(view.orderId)}</div></div>
</div>`;

const exchangePanel = (view: ExchangeView): string => {
  const hand =
    view.holdingChallenge && view.challenge !== null
      ? `<div class="beat">
      <span class="who">you</span>
      <div class="said">
        ${requirements(view.challenge)}
        <div class="actions">
          ${form("sign_and_pay", "", "Sign and pay this", true)}
          ${form("pay_badly", "", "Send an unreadable payment")}
          ${form("walk_away", "", "Walk away")}
        </div>
        <p class="aside">The order rides inside the challenge, so signing this pays that order rather than opening a second one. Walking away leaves it to expire, which is a scenario of its own.</p>
      </div>
    </div>`
      : "";
  const waiting = view.waiting
    ? `<div class="beat now"><span class="who">agent</span><div class="said"><div class="waiting"><span class="pulse"></span>The call has not answered yet. A synchronous purchase waits for the handler; if the handler is holding, it is on the Orders tab.</div></div></div>`
    : "";
  return `<section class="panel">
  <header>
    <h2>This exchange</h2>
    <div class="side">${escaped(view.title)}${view.orderId === null ? "" : ` · <span class="mono">${escaped(view.orderId)}</span>`}</div>
  </header>
  <div class="exchange">
    ${view.beats.map(beatRow).join("")}
    ${hand}
    ${waiting}
  </div>
</section>`;
};

const agentTab = (state: PageState): string => {
  const list = !state.publicItemsRead
    ? '<p class="empty">Not read yet. The public catalog is what an agent discovers, and it is a different document from the merchant\'s own list.</p>'
    : state.publicItems.length === 0
      ? '<p class="empty">Nothing is on sale. A card that is paused is not in the public catalog at all.</p>'
      : `<div class="scroller"><table>
<thead><tr><th>Product</th><th>Price</th><th>Delivery</th><th></th></tr></thead>
<tbody>${state.publicItems.map((one) => publicRow(one, state.chosen)).join("")}</tbody>
</table></div>`;

  const chosen =
    state.chosen === null
      ? ""
      : `<section class="panel">
  <header>
    <h2>${escaped(state.exchange?.title ?? state.chosen)}</h2>
    <div class="side"><code class="addr">${escaped(expandPath(API_ROUTES.purchase_item.path, { item_id: state.chosen }))}</code></div>
  </header>
  <div class="body">
    <form method="post">
      ${hidden("item_id", state.chosen)}
      ${field("Parameters this card declares", `<textarea name="params" class="short">${escaped(state.paramsDraft)}</textarea>`, "Filled from the card's own declaration. Parameters that do not fit are refused before any payment is mentioned.")}
      <div class="actions submit">
        <button type="submit" name="action" value="start_purchase" class="primary">Start a purchase</button>
        <button type="submit" name="action" value="buy_now">Buy in one go</button>
        ${form("ask_price", "", "Ask the price")}
      </div>
    </form>
    <p><b>Ask the price</b> is the GET a crawler makes: a challenge for the card alone, naming no order, so nothing is opened. <b>Start a purchase</b> is the unpaid POST — it opens an order, asks the price desk where the card says to, and comes back 402 with the requirements.</p>
  </div>
</section>`;

  return `<section class="panel">
  <header>
    <h2>What an agent finds</h2>
    <div class="side">${route("list_catalog")}${form("read_catalog", "", "Read again")}</div>
  </header>
  ${list}
</section>
${chosen}
${state.exchange === null ? "" : exchangePanel(state.exchange)}
<section class="panel">
  <header><h2>Ask what became of an order</h2><div class="side">${route("get_order_status")}</div></header>
  <div class="body">
    <form method="post" class="row">
      ${hidden("action", "order_status")}
      ${field("Order identifier", '<input required name="order_id" placeholder="ord_…">')}
      <div><button type="submit">Ask</button></div>
    </form>
    <p>Where an agent collects goods that came later, and where you look when this page has forgotten an exchange. It takes no key: an agent has no account here, so the identifier it was handed at the purchase is what stands in for one. Whoever holds that string can read the order — which is why the gateway hands it to exactly one party, and answers an identifier it has never seen exactly as it answers somebody else's.</p>
  </div>
</section>`;
};

/* --- the orders tab ----------------------------------------------------- */

const heldMail = (one: HeldOrder): string => {
  const answer = (value: string, label: string, primary = false): string =>
    form("answer_held", `${hidden("order_id", one.id)}${hidden("answer", value)}`, label, primary);
  return `<div class="mail held">
  <div class="top">
    <span class="what">${escaped(one.merchantItemId)}</span>
    <span class="when mono">${escaped(one.id)}</span>
  </div>
  <pre>${escaped(json(one.params))}</pre>
  <div class="held-for" data-since="${escaped(one.since)}">held for <b>0.0 s</b> — the gateway gives a handler about 3 s</div>
  <div class="actions">
    ${answer("deliver", "Deliver", true)}
    ${answer("accept", "Accept, deliver later")}
    ${answer("refuse", "Refuse")}
    ${answer("say_nothing", "Say nothing")}
  </div>
</div>`;
};

/**
 * What an order's own word means, in the tone a screen paints it.
 *
 * The words are the order machine's and are printed as they arrive: a status
 * this console has never met still reads as itself rather than as a shrug, and
 * a second vocabulary beside the gateway's is exactly what a merchant should
 * not have to learn.
 */
const orderTone = (status: OrderStatus): string =>
  status === "delivered" ? "ok" : status === "in_progress" ? "busy" : "warn";

const orderRow = (one: OrderWithStatus): string => `<tr>
  <td>
    <div class="under mono">${escaped(one.id)}</div>
    <div class="under">${escaped(one.merchant_item_id)}</div>
  </td>
  <td>${dot(orderTone(one.status), one.status.replaceAll("_", " "))}</td>
  <td>${escaped(one.price.amount)} ${escaped(one.price.currency)}${one.test ? ' <span class="tag">test</span>' : ""}</td>
</tr>`;

const receiptRow = (one: Receipt): string => `<tr>
  <td><div class="under mono">${escaped(one.id)}</div></td>
  <td><div class="under mono">${escaped(one.order_id)}</div></td>
  <td>${escaped(one.price.amount)} ${escaped(one.price.currency)}${one.test ? ' <span class="tag">test</span>' : ""}</td>
  <td>${escaped(one.outcome)}</td>
</tr>`;

const ordersTab = (state: PageState): string => {
  const codes = Object.values(RECOMMENDED_REFUSAL_CODES);
  const owed =
    state.owed.length === 0
      ? '<p class="empty">Nothing. An order appears here once the handler has accepted it and still owes the goods.</p>'
      : `<div class="scroller"><table>
<thead><tr><th>Order</th><th>Product</th><th></th></tr></thead>
<tbody>${state.owed
          .map(
            (one) => `<tr>
    <td><div class="under mono">${escaped(one.id)}</div></td>
    <td>${escaped(one.merchantItemId)}</td>
    <td class="ctl"><div class="actions">${form("deliver_owed", hidden("order_id", one.id), "Deliver now", true)}${form("refuse_owed", hidden("order_id", one.id), "Refuse")}</div></td>
  </tr>`,
          )
          .join("")}</tbody>
</table></div>`;

  return `<section class="panel">
  <header>
    <h2>When an order arrives</h2>
    <div class="side">this is the merchant's code, and you are in its chair</div>
  </header>
  <div class="body">
    <form method="post" class="decisions">
      ${hidden("action", "moods")}
      <div class="grid">
        ${field("The handler answers", select("order", ORDER_CHOICES, state.moods.order))}
        ${field("The price desk answers", select("quote", QUOTE_CHOICES, state.moods.quote))}
      </div>
      <details>
        <summary>The numbers and words these answers use</summary>
        <div class="opened">
          <div class="grid">
            ${field("Deliver after (ms)", `<input name="deliver_after_ms" type="number" min="0" value="${escaped(state.moods.deliverAfterMs)}">`, "Used by “accept, then deliver”, and reported as the eta.")}
            ${field("Price amount", `<input name="price_amount" value="${escaped(state.moods.price.amount)}">`)}
            ${field("Price currency", `<input name="price_currency" value="${escaped(state.moods.price.currency)}">`)}
            ${field("Refusal code", `<input name="refusal_code" list="refusal-codes" value="${escaped(state.moods.refusal.code)}"><datalist id="refusal-codes">${codes.map((code) => `<option value="${escaped(code)}"></option>`).join("")}</datalist>`, "The published set is a suggestion; a merchant's own word is allowed.")}
            ${field("Refusal message", `<input name="refusal_message" value="${escaped(state.moods.refusal.message)}">`)}
          </div>
          ${field("Goods (JSON)", `<textarea name="goods" placeholder="Empty means the fields the card declares.">${escaped(state.goodsDraft)}</textarea>`, "What every delivery carries. Leave it empty and each card gets its own declared fields filled in.")}
          <div class="actions submit"><button type="submit" class="primary">Apply</button></div>
        </div>
      </details>
    </form>
    <p>Six of these are answers a merchant's own code can give. <b>Hold it and ask me</b> is the console's own addition — real merchant code answers and returns — and it is on a much shorter clock than it looks: a gateway gives a handler about three seconds, and answers a synchronous purchase inside eight. Hold one and you will usually watch it expire, which is the lesson. The roomy place to decide by hand is <b>Owed</b> below: accept the order inside the budget, and then the clock is the card's own deadline.</p>
  </div>
</section>
<section class="panel">
  <header>
    <h2>Waiting for you</h2>
    <div class="side">${state.held.length === 0 ? "nothing held" : dot("busy", `${state.held.length} held`)}</div>
  </header>
  ${
    state.held.length === 0
      ? '<p class="empty">Nothing is being held. An order arrives here only while the handler is set to ask you.</p>'
      : `<div class="inbox">${state.held.map(heldMail).join("")}</div>`
  }
</section>
<section class="panel">
  <header><h2>Owed</h2><div class="side">accepted, not yet delivered</div></header>
  ${owed}
</section>
<section class="panel">
  <header>
    <h2>Orders</h2>
    <div class="side">${route("list_orders")}${form("read_orders", "", "Read again")}</div>
  </header>
  ${
    !state.ordersRead
      ? '<p class="empty">Not read yet.</p>'
      : state.orders.length === 0
        ? '<p class="empty">None. An order that closed before anybody named a price for it is not in this list at all — the gateway says so, and those are read one at a time by their identifier.</p>'
        : `<div class="scroller"><table>
<thead><tr><th>Order</th><th>State</th><th>Priced at</th></tr></thead>
<tbody>${state.orders.map(orderRow).join("")}</tbody>
</table></div>`
  }
</section>
<section class="panel">
  <header>
    <h2>Receipts</h2>
    <div class="side">${route("list_receipts")}${form("read_receipts", "", "Read again")}</div>
  </header>
  ${
    !state.receiptsRead
      ? '<p class="empty">Not read yet. A receipt is the merchant\'s own record of a sale and is read behind their key.</p>'
      : state.receipts.length === 0
        ? '<p class="empty">None. A receipt is written when the money moves, so a purchase that ended before any payment leaves none.</p>'
        : `<div class="scroller"><table>
<thead><tr><th>Receipt</th><th>Order</th><th>Sold for</th><th>Outcome</th></tr></thead>
<tbody>${state.receipts.map(receiptRow).join("")}</tbody>
</table></div>`
  }
</section>`;
};

/* --- the log ------------------------------------------------------------ */

const LANES: readonly string[] = ["stand", "merchant", "agent", "gateway"];
/**
 * Which way a line went, from this console's side.
 *
 * The lane already says who is speaking and said nothing about direction, so a
 * request and the answer to it read as two sentences about the same thing and
 * the reader had to work out which was which from the wording. A blank is a
 * line that crossed nothing, and blank is the honest mark for it.
 */
const WAY_MARKS: Readonly<Record<string, string>> = {
  sent: "\u2192",
  got: "\u2190",
};

const LANE_LETTERS: Readonly<Record<string, string>> = {
  stand: "st",
  merchant: "me",
  agent: "ag",
  gateway: "gw",
};

const detailOf = (entry: Entry): Record<string, unknown> | null =>
  typeof entry.detail === "object" && entry.detail !== null && !Array.isArray(entry.detail)
    ? (entry.detail as Record<string, unknown>)
    : null;

/**
 * Which purchase a line belongs to.
 *
 * The detail is preferred over the stamp: the merchant's own lines arrive over
 * a subscription and carry the order they are about, which is more reliable
 * than whatever the console happened to be doing at that instant.
 */
const orderOf = (entry: Entry): string | null => {
  const detail = detailOf(entry);
  const named = detail?.order_id;
  return typeof named === "string" ? named : entry.order;
};

/**
 * The one fact worth keeping at the end of a compact line.
 *
 * The order is not among them: it is already the group this line sits in, and
 * repeating it on every row would spend the width that makes the log compact.
 */
const factOf = (entry: Entry): string => {
  const detail = detailOf(entry);
  if (detail === null) return "";
  if (typeof detail.status === "number") return String(detail.status);
  for (const key of ["price_id", "answer", "merchant_item_id", "kind"]) {
    const value = detail[key];
    if (typeof value === "string") return value;
  }
  return "";
};

/**
 * Long opaque identifiers, cut to the part a person actually matches rows on.
 *
 * A price identifier is thirty-six characters and a line is one row high, so
 * printed whole it takes the width the sentence needed and leaves "A pric…".
 * The first eight are enough to pair two lines about one thing by eye, and
 * nothing is lost: the whole of it is in the row's tooltip and in the payload
 * the row opens.
 */
const shortened = (words: string): string =>
  words.replace(/\b([a-z]{2,5}_[0-9a-f]{8})[0-9a-f]{8,}\b/g, "$1\u2026");

/**
 * Whether this line is an answer that did not work.
 *
 * Read off the detail rather than told by the writer: an HTTP status at or
 * above 400, or a detail carrying an error. It is a reading and not a promise —
 * it colours a line amber and nothing branches on it — and what it buys is that
 * the one refusal in two hundred lines is visible without reading them all.
 */
const failed = (entry: Entry): boolean => {
  const detail = detailOf(entry);
  if (detail === null) return false;
  // 402 is the one status in this range that means the protocol is working: it
  // is how a challenge arrives, and it is on the happy path of every purchase.
  if (typeof detail.status === "number" && detail.status >= 400 && detail.status !== 402)
    return true;
  if (detail.error !== undefined) return true;
  // The plural ones are the answers that arrived fine and said no: publishing a
  // card comes back `{ ok }` or `{ errors }` at HTTP 200, and a document that
  // did not fit its schema comes back as issues. An answer whose status is
  // clean and whose body is a refusal is exactly the line this whole reading
  // exists to catch.
  for (const many of [detail.errors, detail.issues]) {
    if (Array.isArray(many) && many.length > 0) return true;
  }
  return false;
};

/**
 * One line of the log.
 *
 * Exported because the stream renders with it too: the page and the live
 * updates were two copies of this markup, and two copies of one thing drift.
 */
export const renderEntry = (one: Entry): string => {
  const lane = LANES.includes(one.kind) ? one.kind : "stand";
  const classes = `lrow ${escaped(lane)}${failed(one) ? " bad" : ""}`;
  const fact = factOf(one);
  // A status the sentence has already said is not worth a column: "Answered
  // 402." beside a 402 spends width on saying it twice.
  const beside = fact !== "" && one.title.includes(fact) ? "" : fact;
  const way = one.way === null ? "" : (WAY_MARKS[one.way] ?? "");
  const inside = `<span class="t">${escaped(one.at.slice(11, 19))}</span><span class="l">${escaped(LANE_LETTERS[lane] ?? "st")}</span><span class="w ${escaped(one.way ?? "none")}" title="${one.way === "sent" ? "this console sent it" : one.way === "got" ? "this console received it" : "nothing crossed the wire"}">${way}</span><span class="m" title="${escaped(one.title)}">${escaped(shortened(one.title))}</span><span class="f" title="${escaped(beside)}">${escaped(shortened(beside))}</span>`;
  const order = orderOf(one);
  const stamp = ` data-order="${escaped(order ?? "")}"`;
  return one.detail === undefined
    ? `<div class="${classes}"${stamp}>${inside}</div>`
    : `<details class="lline"${stamp}><summary class="${classes}">${inside}</summary><pre>${escaped(json(one.detail))}</pre></details>`;
};

/** The lines of one purchase, in the order they arrived on screen. */
interface Group {
  readonly order: string | null;
  readonly lines: Entry[];
}

const grouped = (newestFirst: readonly Entry[]): Group[] => {
  const groups: Group[] = [];
  for (const one of newestFirst) {
    const order = orderOf(one);
    const last = groups.at(-1);
    if (last === undefined || last.order !== order) groups.push({ order, lines: [one] });
    else last.lines.push(one);
  }
  return groups;
};

/*
 * Oldest first, which is what a log is.
 *
 * Newest-first put the answer above the question and the confirmation above the
 * call that earned it, so one purchase read backwards while the purchases
 * themselves read forwards. Written the way it happened, the group heading
 * comes before its lines and a conversation reads as one; the column is parked
 * at the bottom and follows new lines, the way every log anybody has read does.
 */
const logColumn = (entries: readonly Entry[]): string => {
  const rows = grouped(entries).flatMap((group) => {
    // A purchase carrying a refusal is marked at its head, so which one went
    // wrong is visible without opening any of its lines.
    const wrong = group.lines.some(failed);
    return [
      `<div class="rowgroup${wrong ? " bad" : ""}">${group.order === null ? "no order" : escaped(group.order)}</div>`,
      ...group.lines.map(renderEntry),
    ];
  });
  return `<aside class="log">
  <header>
    <div class="top"><h2>Log</h2><span class="tag">threaded by order</span></div>
    <div class="lanes">${LANES.map(
      (lane) =>
        `<label class="sw"><input type="checkbox" checked data-lane="${escaped(lane)}">${escaped(lane)}</label>`,
    ).join("")}</div>
  </header>
  <div class="rows" id="log">${rows.join("")}</div>
</aside>`;
};

/* --- the whole page ----------------------------------------------------- */

/**
 * The gateway the box is filled with before anybody types.
 *
 * The test site rather than a laptop: that is where this console is pointed
 * most of the time, and a local gateway is one paste away. It is built from
 * `SITES` rather than written out, so the address here cannot drift from the
 * one the door refuses a key in the name of.
 */
const GATEWAY_BY_DEFAULT = `https://${SITES.test}`;

const KEY_WORDS: Readonly<Record<Environment, string>> = {
  live: "You connected with a live key. A purchase from this console signs a payment with real money behind it.",
  test: "You connected with a test key: payments settle with test funds, and every order and receipt is marked as a test.",
};

const TAB_LINKS: readonly { readonly tab: Tab; readonly at: string; readonly label: string }[] = [
  { tab: "catalogue", at: "/", label: "Catalogue" },
  { tab: "agent", at: "/agent", label: "Agent" },
  { tab: "orders", at: "/orders", label: "Orders" },
];

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escaped(title)}</title><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/stand.css"></head><body>${body}</body></html>`;

const gate = (said: SaidBack | null): string =>
  shell(
    "Connect — Coinslot stand",
    `<div class="page"><div class="gate"><form method="post">
  ${hidden("action", "connect")}
  <h1>Coinslot stand</h1>
  <p class="lede">Three seats at one wire: the merchant who publishes, the agent who buys, and the merchant's code answering orders. All three need a gateway and a merchant key; the key stays in this process and never reaches this page.</p>
  ${field("Gateway address", `<input required name="address" value="${escaped(GATEWAY_BY_DEFAULT)}">`)}
  ${field("Merchant key", '<input required name="api_key" type="password" autocomplete="off">')}
  <button type="submit" class="primary">Connect</button>
  ${said === null ? "" : `<div class="said-back${said.problem ? " problem" : ""}">${escaped(said.words)}</div>`}
</form></div></div>`,
  );

const standingLine = (standing: Standing): string =>
  `orders: <b>${escaped(labelOf(ORDER_CHOICES, standing.order).toLowerCase())}</b> · price desk: <b>${escaped(labelOf(QUOTE_CHOICES, standing.quote).toLowerCase())}</b>`;

const BODIES: Readonly<Record<Tab, (state: PageState) => string>> = {
  catalogue: catalogueTab,
  agent: agentTab,
  orders: ordersTab,
};

const TITLES: Readonly<Record<Tab, string>> = {
  catalogue: "Catalogue",
  agent: "Agent",
  orders: "Orders",
};

/** Renders the complete local page; it receives no merchant key. */
export const renderPage = (state: PageState): string => {
  if (state.address === null) {
    return gate(state.said);
  }
  const words = state.keyEnvironment === null ? null : KEY_WORDS[state.keyEnvironment];
  const surface =
    words === null
      ? '<div class="surface">This key names no environment Coinslot issues, so the stand cannot say whether money on this gateway is real. Whatever it is, a purchase here signs a payment.</div>'
      : `<div class="surface${state.keyEnvironment === "live" ? " live" : ""}">${escaped(words)}</div>`;
  return shell(
    `${TITLES[state.tab]} — Coinslot stand`,
    `<div class="page">
  <div class="chrome">
    <div class="line1">
      <div class="brand"><span class="wordmark">coinslot</span><span class="what">stand</span></div>
      <div class="who">
        ${state.keyEnvironment === null ? '<span class="tag">key names no environment</span>' : `<span class="tag${state.keyEnvironment === "live" ? " live" : ""}">${escaped(state.keyEnvironment)} key</span>`}
        <span class="addr">${escaped(state.address)}</span>
        ${form("disconnect", "", "Disconnect")}
      </div>
    </div>
    <div class="line2">
      <nav class="tabs">${TAB_LINKS.map((one) =>
        one.tab === state.tab
          ? `<span class="here">${escaped(one.label)}${one.tab === "orders" && state.standing.held > 0 ? ` <span class="tag hot">${state.standing.held}</span>` : ""}</span>`
          : `<a href="${escaped(one.at)}">${escaped(one.label)}${one.tab === "orders" && state.standing.held > 0 ? ` <span class="tag hot">${state.standing.held}</span>` : ""}</a>`,
      ).join("")}</nav>
      <div class="standing">${standingLine(state.standing)}</div>
    </div>
  </div>
  ${surface}
  <div class="split">
    <div class="work">
      ${state.said === null ? "" : `<div class="said-back${state.said.problem ? " problem" : ""}">${escaped(state.said.words)}</div>`}
      ${BODIES[state.tab](state)}
    </div>
    ${logColumn(state.entries)}
  </div>
</div>
<script>
const log = document.getElementById("log");
for (const box of document.querySelectorAll(".lanes input")) {
  const lane = "mute-" + box.dataset.lane;
  const remembered = localStorage.getItem(lane);
  box.checked = remembered !== "off";
  log.classList.toggle(lane, !box.checked);
  box.addEventListener("change", () => {
    log.classList.toggle(lane, !box.checked);
    localStorage.setItem(lane, box.checked ? "on" : "off");
  });
}
// The stream carries the row already rendered, so a line arriving now looks
// exactly like the lines the page came with. A stir means what the page is
// drawing changed underneath it — worth interrupting a reader for, and not
// worth interrupting somebody who is typing.
const following = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
const follow = () => {
  log.scrollTop = log.scrollHeight;
};
follow();
new EventSource("/feed").onmessage = (event) => {
  const news = JSON.parse(event.data);
  if (news.entry !== undefined) {
    const wasFollowing = following();
    log.insertAdjacentHTML("beforeend", news.entry);
    // Only if the reader was already at the live end. Yanking somebody back
    // down while they are reading what went wrong ten lines up is worse than
    // making them scroll.
    if (wasFollowing) follow();
  }
  const typing = document.activeElement !== null && document.activeElement !== document.body;
  if (news.stir === true && !typing) location.reload();
};
// A standing answer is a decision, not a draft: applying it needs no second press.
for (const box of document.querySelectorAll(".decisions .applies")) {
  box.addEventListener("change", () => box.form.submit());
}
// How long a held order has been held. Ticking, because the number it is racing
// is about three seconds and a figure rendered once would always read 0.0.
const clocks = document.querySelectorAll(".held-for[data-since]");
if (clocks.length > 0) {
  const tick = () => {
    for (const clock of clocks) {
      const seconds = (Date.now() - Number(clock.dataset.since)) / 1000;
      clock.querySelector("b").textContent = seconds.toFixed(1) + " s";
    }
  };
  tick();
  setInterval(tick, 100);
}
</script>`,
  );
};
