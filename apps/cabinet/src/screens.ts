/**
 * The three screens: the cards, the orders, the receipts.
 *
 * Each one is a function from the documents the gateway answered with to a
 * page, and none of them fetches anything or decides anything. That is what
 * lets the tests read the page a merchant would actually be looking at, and it
 * is why every claim on these screens can be traced to a field in a document
 * rather than to something the cabinet worked out on its own.
 *
 * Where a screen would like to say more than the API can support, it says the
 * weaker thing. `words.ts` carries those cases and the reasons.
 */

import type { MerchantCard, MerchantCardList, OrderList, ReceiptList } from "@coinslot/contracts";
import { escaped, page, state, type Tab, table } from "./html.js";
import {
  FULFILLMENT_WORDS,
  moment,
  money,
  needsAttention,
  ORDER_WORDS,
  SELLING_WORDS,
} from "./words.js";

interface Frame {
  readonly base: string;
  readonly tab: Tab;
  readonly title: string;
  readonly selling: MerchantCardList["selling"];
  readonly body: string;
}

const framed = (frame: Frame): string =>
  page({
    base: frame.base,
    tab: frame.tab,
    title: frame.title,
    selling: SELLING_WORDS[frame.selling],
    body: frame.body,
  });

/**
 * The line under a card's title.
 *
 * It says the one thing about this card that changes what the merchant's own
 * operation has to do, and it is drawn from the card rather than from a
 * separate field: a card whose price is asked for at the moment of purchase
 * needs somebody answering that question, and a card delivered later has a
 * window to deliver inside.
 */
const cardAside = (entry: MerchantCard): string => {
  if (entry.card.price_check !== undefined) {
    return "Price asked at purchase";
  }
  const seconds = entry.card.fulfill_deadline_seconds;
  if (seconds !== undefined) {
    const hours = seconds / 3600;
    return hours >= 1 && Number.isInteger(hours)
      ? `Delivery within ${hours} ${hours === 1 ? "hour" : "hours"}`
      : `Delivery within ${seconds} seconds`;
  }
  // No price check and no delivery window, so the one fact left is when the
  // price on the card started being the price. It is `as_of`, and this is the
  // only screen that shows it — a merchant working out why a sale went through
  // at an old number has nowhere else to look.
  return `Price on the card since ${moment(entry.as_of)}`;
};

/**
 * Which switch is holding a card off sale.
 *
 * This is the sentence the contract's own document warns about: with all
 * selling stopped every card reads paused, and resuming one of them changes
 * nothing a merchant can see. Saying which switch is holding it is the whole
 * reason the document carries two fields instead of one.
 */
const cardControl = (base: string, entry: MerchantCard): string => {
  if (entry.paused) {
    return `<form class="inline" method="post" action="${escaped(base)}/cards/${encodeURIComponent(entry.id)}/resume">
<button class="primary" type="submit">Resume</button></form>`;
  }
  if (entry.selling !== "open") {
    return '<span class="quiet">All selling is stopped</span>';
  }
  return `<form class="inline" method="post" action="${escaped(base)}/cards/${encodeURIComponent(entry.id)}/pause">
<button type="submit">Pause</button></form>`;
};

export const cardsScreen = (base: string, cards: MerchantCardList): string => {
  const paused = cards.cards.filter((entry) => entry.paused).length;
  const stopped = cards.selling !== "open";

  const rows = cards.cards.map(
    (entry) => `<tr class="${entry.selling === "open" ? "" : "off"}">
<td><div class="title">${escaped(entry.card.title)}</div><div class="under">${escaped(cardAside(entry))}</div></td>
<td class="key">${escaped(entry.card.merchant_item_id)}</td>
<td class="amount">${escaped(money(entry.card.price))}</td>
<td class="quiet">${escaped(FULFILLMENT_WORDS[entry.card.fulfillment])}</td>
<td>${state(SELLING_WORDS[entry.selling])}</td>
<td class="control">${cardControl(base, entry)}</td>
</tr>`,
  );

  const body = `
  <div class="lede">
    <div>
      <h1>Product cards</h1>
      <p>${escaped(
        `${countOf(cards.cards.length, "card")} published, ${paused} paused by you.` +
          " Your code creates and updates a card; here you can see it and stop it.",
      )}</p>
    </div>
    <div class="actions">
      <form class="inline" method="post" action="${escaped(base)}/selling/${stopped ? "resume" : "pause"}">
        <button class="wide${stopped ? " primary" : ""}" type="submit">${stopped ? "Start selling again" : "Stop all selling"}</button>
      </form>
    </div>
  </div>
${table(
  ["Product", "Your key", "Price", "Delivery", "State", ""],
  rows,
  "You have not published a card yet. Your code publishes them; they appear here.",
)}
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(
    stopped
      ? "All selling is stopped: no new order is taken for any card, and the orders you have already accepted play out as usual. Resuming leaves the cards you paused yourself paused."
      : "A pause takes the card off sale without abandoning orders: the ones you already accepted play out as usual. No new orders arrive while it is paused.",
  )}</span></div>
`;

  return framed({ base, tab: "cards", title: "Product cards", selling: cards.selling, body });
};

export const ordersScreen = (
  base: string,
  cards: MerchantCardList,
  orders: OrderList,
  open: boolean,
): string => {
  const titles = new Map(
    cards.cards.map((entry) => [entry.card.merchant_item_id, entry.card.title]),
  );
  const wanting = orders.orders.filter((order) => needsAttention(order.status));

  const rows = orders.orders.map((order) => {
    const word = ORDER_WORDS[order.status];
    return `<tr class="${needsAttention(order.status) ? "needs-you" : ""}">
<td class="ident">${escaped(order.id)}</td>
<td><div>${escaped(titles.get(order.merchant_item_id) ?? order.merchant_item_id)}</div><div class="under mono">${escaped(order.merchant_item_id)}</div></td>
<td class="amount">${escaped(money(order.price))}</td>
<td>${state(word)}</td>
<td class="quiet">${escaped(moment(order.price.at))}</td>
</tr>`;
  });

  const body = `
  <div class="lede">
    <div>
      <h1>Orders</h1>
      <p>${escaped(ordersLede(orders, open))}</p>
    </div>
    <div class="filter">
      ${open ? '<span class="here">Open</span>' : `<a href="${escaped(base)}/orders?open=true">Open</a>`}
      ${open ? `<a href="${escaped(base)}/orders">All</a>` : '<span class="here">All</span>'}
    </div>
  </div>
${table(
  ["Order", "Product", "Amount", "State", "Bought"],
  rows,
  open ? "Nothing is open. Every order you have is finished." : "No orders yet.",
)}
${wanting
  .map(
    (order) => `  <div class="callout">
    <div class="what">Order <span class="mono">${escaped(order.id)}</span> ${escaped(ORDER_WORDS[order.status].text)}</div>
    <div class="why">${escaped(whyItNeedsYou(order.status))}</div>
  </div>
`,
  )
  .join("")}`;

  return framed({ base, tab: "orders", title: "Orders", selling: cards.selling, body });
};

/**
 * The sentence at the top of the orders screen.
 *
 * It counts what it can stand behind and nothing else. "Open" is the gateway's
 * own filter; "needs you" is the two endings that stay open with something
 * concrete owed. An order merely under way is open and is not counted as
 * needing anything, because this API cannot tell one the merchant has taken on
 * from one created a second ago.
 */
const ordersLede = (orders: OrderList, open: boolean): string => {
  const wanting = orders.orders.filter((order) => needsAttention(order.status)).length;
  const scope = open ? "open" : "";
  const listed = `${countOf(orders.orders.length, `${scope} order`.trim())} listed.`;

  if (wanting === 0) {
    return `${listed} None of them is owed money or goods by you right now.`;
  }
  return `${listed} ${countOf(wanting, "order")} ${wanting === 1 ? "needs" : "need"} you: the money was taken and the goods have not gone out.`;
};

const whyItNeedsYou = (status: OrderList["orders"][number]["status"]): string =>
  status === "refund_due"
    ? "The money was taken, the delivery window ran out and nothing shipped. You return it from your own wallet — we recorded the amount and the order. A late delivery still clears the debt."
    : "You delivered the goods and the payment did not execute. The order stays open, and a repeat purchase by the same buyer carries the payment through.";

export const receiptsScreen = (
  base: string,
  cards: MerchantCardList,
  receipts: ReceiptList,
): string => {
  const titles = new Map(cards.cards.map((entry) => [entry.id, entry.card.title]));
  const delivered = receipts.receipts.filter((receipt) => receipt.outcome === "delivered").length;
  const owed = receipts.receipts.filter((receipt) => receipt.outcome === "refund_due");

  const rows = receipts.receipts.map((receipt) => {
    const word = ORDER_WORDS[receipt.outcome];
    return `<tr class="${receipt.outcome === "refund_due" ? "needs-you" : ""}">
<td class="ident">${escaped(receipt.id)}</td>
<td class="ident">${escaped(receipt.order_id)}</td>
<td>${escaped(titles.get(receipt.item_id) ?? receipt.item_id)}</td>
<td class="amount">${escaped(money(receipt.price))}</td>
<td>${state(word)}</td>
<td class="quiet">${escaped(moment(receipt.price.at))}</td>
<td class="quiet">${escaped(moment(receipt.price.as_of))}</td>
</tr>`;
  });

  const body = `
  <div class="lede">
    <div>
      <h1>Receipts</h1>
      <p>A receipt is the proof of a payment: the amount, the moment of purchase, and the instant the price behind it was true. A purchase that ended before any payment leaves no receipt, and none is written while it is unknown whether the buyer was charged.</p>
    </div>
  </div>
  <div class="summary">
    <div class="tile">
      <div class="label">Receipts</div>
      <div class="figure">${receipts.receipts.length}</div>
      <div class="aside">${escaped(sumsOf(receipts))}</div>
    </div>
    <div class="tile">
      <div class="label">Delivered</div>
      <div class="figure${delivered === 0 ? "" : " ok"}">${delivered}</div>
      <div class="aside">of ${receipts.receipts.length} paid</div>
    </div>
    <div class="tile">
      <div class="label">Refund due</div>
      <!-- A zero owed is good news, so it is not painted as a warning: a red
           nought reads as a problem across a room, which is how a summary
           starts lying before anybody has read a word of it. -->
      <div class="figure${owed.length === 0 ? "" : " warn"}">${owed.length}</div>
      <div class="aside">${escaped(owed.length === 0 ? "nothing owed back" : `${countOf(owed.length, "order")}, returned by you`)}</div>
    </div>
  </div>
${table(
  ["Receipt", "Order", "Product", "Amount", "Outcome", "Bought", "Price true as of"],
  rows,
  "No receipts yet. One is written the moment a payment goes through.",
)}
`;

  return framed({ base, tab: "receipts", title: "Receipts", selling: cards.selling, body });
};

/**
 * What was sold, by currency.
 *
 * Amounts are not added up across currencies and are not added up at all: they
 * are exact decimal strings on the wire so that nothing turns a price into a
 * float, and a total computed here in JavaScript would be the one number on
 * this screen that had been through one. The currencies present are named
 * instead, which is a fact rather than an arithmetic claim.
 */
const sumsOf = (receipts: ReceiptList): string => {
  const currencies = [...new Set(receipts.receipts.map((receipt) => receipt.price.currency))];
  if (currencies.length === 0) {
    return "nothing sold yet";
  }
  return `paid in ${currencies.sort().join(", ")}`;
};

const countOf = (many: number, thing: string): string => `${many} ${thing}${many === 1 ? "" : "s"}`;
