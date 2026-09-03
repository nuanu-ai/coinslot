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

import { SITES, type SurfaceMode } from "@coinslot/core";
import {
  API_ROUTES,
  expandPath,
  type MerchantCard,
  type MerchantCardList,
  type OrderList,
  type ParamSpec,
  type ParamType,
  type ReceiptList,
  type TestPurchase,
} from "@nuanu-ai/coinslot-contracts";
import { escaped, page, state, type Tab, table } from "./html.js";
import type { PayoutWallet } from "./payout-wallet.js";
import {
  FULFILLMENT_WORDS,
  moment,
  money,
  needsAttention,
  ORDER_WORDS,
  SELLING_WORDS,
  TEST_PURCHASE_STEP_WORDS,
  TEST_PURCHASE_WORDS,
} from "./words.js";

/**
 * Who is looking at a page, and where the cabinet is mounted.
 *
 * The person is here rather than at the edge because every page says who is
 * signed in. That is not decoration: until ADR-0009 there was no person in the
 * system at all — there was a merchant key — and a screen that cannot name who
 * is looking at it is a screen nobody can be held to.
 */
export interface Viewer {
  /** Which stack this person is looking at, as derived from its gateway. */
  readonly mode: SurfaceMode;
  /** Where the cabinet is mounted, "" when it is at the root of its origin. */
  readonly base: string;
  /** The address of the person signed in. */
  readonly who: string;
  /**
   * Whether that address has been confirmed.
   *
   * Every page says which it is, because what an unconfirmed address costs its
   * owner only shows up on the day they have lost their password.
   */
  readonly confirmed: boolean;
  /**
   * The name buyers read beside this merchant's products, where the screen
   * asked the gateway for it.
   *
   * Null is a merchant who has chosen none, and it is what the line at the top
   * of these three screens is drawn from: until a name is set, a card their
   * code publishes is refused. Absent where the screen did not ask — the keys,
   * for the reason `html.ts` gives beside the selling word.
   */
  readonly sellerName?: string | null;
  /**
   * The address this merchant's money arrives at, and anything wrong with what
   * was just typed into the box for it.
   *
   * The refusal travels with the address because one block on one screen draws
   * both, and a screen holding one of them without the other cannot draw that
   * block at all. Absent everywhere the block is not drawn, which today is
   * every screen but the settings — a page that did not ask the gateway must
   * not tell a merchant they have set no address.
   */
  readonly payout?: PayoutWallet;
}

interface Frame {
  readonly viewer: Viewer;
  readonly tab: Tab;
  readonly title: string;
  readonly selling: MerchantCardList["selling"];
  readonly body: string;
}

const framed = (frame: Frame): string =>
  page({
    mode: frame.viewer.mode,
    base: frame.viewer.base,
    who: frame.viewer.who,
    confirmed: frame.viewer.confirmed,
    tab: frame.tab,
    title: frame.title,
    selling: SELLING_WORDS[frame.selling],
    unnamed: frame.viewer.sellerName === null,
    body: frame.body,
  });

/**
 * The line under a card's title: everything about this card that the merchant's
 * own operation has to be ready for.
 *
 * Every fact that applies is listed, not the first one found. A card can both
 * have its price asked at purchase and owe a delivery inside a window, and an
 * earlier version of this showed only the price check — so a merchant read the
 * row and never saw the deadline they are held to. Dropping a promise a
 * merchant is answerable for, because another promise happened to be checked
 * first, is the kind of truncation that has to be said or not done.
 */
const cardAside = (entry: MerchantCard): string => {
  const facts: string[] = [];

  if (entry.card.price_check !== undefined) {
    facts.push("Price asked at purchase");
  }

  const seconds = entry.card.fulfill_deadline_seconds;
  if (seconds !== undefined) {
    const hours = seconds / 3600;
    facts.push(
      hours >= 1 && Number.isInteger(hours)
        ? `delivery within ${hours} ${hours === 1 ? "hour" : "hours"}`
        : `delivery within ${seconds} seconds`,
    );
  }

  if (facts.length === 0) {
    // Neither a price check nor a delivery window, so the one fact left is when
    // the price on the card started being the price. It is `as_of`, and this is
    // the only screen that shows it — a merchant working out why a sale went
    // through at an old number has nowhere else to look.
    return `Price on the card since ${moment(entry.as_of)}`;
  }

  const line = facts.join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
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

/**
 * Whether this cabinet offers a test purchase at all.
 *
 * The buyer that walks one belongs to us and so does what it spends, so the
 * gateway refuses every test purchase where the money is real (ADR-0023). A
 * button drawn there would be the last step of an integration offered as a
 * control that cannot work, so the screen does not draw it and says instead
 * where the walk does happen. The gateway is still the lock: this is the
 * courtesy in front of it, not the rule.
 */
const walksTestPurchases = (mode: SurfaceMode): boolean => mode !== "live";

/**
 * The control that walks a test purchase of one card, with the card's own
 * questions on it.
 *
 * The boxes come from the card's `params` and from nowhere else. That is the
 * whole design: a list written out here would work for the cards somebody had
 * in mind when they wrote it and quietly ask the wrong thing of every other
 * card, and a merchant would find out from a purchase refused for parameters
 * they were never given a box for.
 *
 * A card that declares nothing gets a button and no boxes, because there is
 * nothing to ask. The type is shown beside each question because it is part of
 * the same declaration and because without it a merchant cannot know what to
 * type into a box that wants a number or a yes-or-no.
 *
 * Only on a card that is on sale. A paused card refuses the purchase at the
 * price call, so the walk's ending is known before it starts, and the one thing
 * the merchant would have to do first — put the card back on sale — is the
 * control sitting right beside this one.
 */
const cardWalk = (viewer: Viewer, entry: MerchantCard): string => {
  if (entry.selling !== "open" || !walksTestPurchases(viewer.mode)) {
    return "";
  }

  const asks = Object.entries(entry.card.params ?? {}).map(([name, field]) => {
    const box = `walk-${entry.id}-${name}`;
    const needed = field.required === true;
    return `<label for="${escaped(box)}">${escaped(field.title ?? name)}${
      needed ? '<span class="need">required</span>' : ""
    }<span class="kind">${escaped(field.type)}</span></label>
<input id="${escaped(box)}" name="${escaped(name)}" type="text" autocomplete="off"${needed ? " required" : ""}>`;
  });

  return `<form class="walk" method="post" action="${escaped(viewer.base)}/cards/${encodeURIComponent(entry.id)}/test-purchase">
${asks.join("\n")}
<button type="submit">Test purchase</button></form>`;
};

/**
 * The values a merchant typed, read as this card's own declaration says to read
 * them.
 *
 * The other half of the form above, and it is in the same file for that reason:
 * the names in the boxes and the names read back out of them are one agreement,
 * and two files is where an agreement like that comes apart.
 *
 * Two decisions in here are worth naming. A box left empty on a question the
 * card says is optional is left out of the purchase entirely, because that is
 * what optional means — sending an empty string instead would be answering a
 * question the merchant chose not to answer. And what was typed is passed
 * through exactly as typed, with no space taken off either end: these values
 * reach the merchant's own handler, and the portal's promise about a purchase
 * parameter is that it arrives unchanged.
 *
 * Only the names the card declares are read. A field posted under any other
 * name is not part of this card's purchase and is dropped here rather than sent
 * on to be refused.
 */
export const paramsFromForm = (
  spec: ParamSpec,
  typed: Record<string, unknown>,
): Record<string, unknown> => {
  const values: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(spec)) {
    const written = typed[name];
    if (typeof written !== "string") {
      continue;
    }
    if (written === "" && field.required !== true) {
      continue;
    }
    values[name] = readAs(field.type, written);
  }

  return values;
};

/**
 * One typed value as the declared type.
 *
 * A form posts strings and a card can declare a number or a yes-or-no, so
 * without this a merchant whose card asks for a number could never walk a
 * purchase of it from here — the storefront would refuse every attempt for a
 * reason the merchant could do nothing about.
 *
 * What does not read as the declared type is passed on as it was typed, rather
 * than turned into a null or a nought. The storefront's own words about what it
 * expected and what it got are a better answer than a value this cabinet
 * invented on the merchant's behalf.
 */
const readAs = (type: ParamType, written: string): unknown => {
  switch (type) {
    case "string":
      return written;
    case "number":
    case "integer": {
      const number = Number(written);
      return written.trim() !== "" && Number.isFinite(number) ? number : written;
    }
    case "boolean":
      if (written === "true") return true;
      if (written === "false") return false;
      return written;
  }
};

/**
 * The address an agent buys one card at.
 *
 * Built from the route table rather than written out here, for the reason the
 * cabinet's client gives: a second transcription of the surface is a second
 * chance for it to come apart. What goes in front of it is the origin the
 * deployment is reached at, which is not the gateway address the cabinet itself
 * calls — that one is inside the compose network and means nothing to anybody
 * outside it.
 *
 * The identifier is our catalog one and not the merchant's own. They are two
 * different strings and only one of them is in this address: a merchant who
 * pasted their own `merchant_item_id` into it would be handed a 404 by a
 * gateway that is working perfectly.
 */
const buyingAddress = (origin: string, entry: MerchantCard): string =>
  `${origin}${expandPath(API_ROUTES.purchase_item.path, { item_id: entry.id })}`;

/**
 * One address, marked up so that it wraps where a reader expects it to.
 *
 * An address is longer than the column it sits in, so it wraps; left to the
 * browser it wraps mid-word — "…/pur" above "chase" — which reads as a broken
 * string rather than a wrapped one. `<wbr>` before each separator says where
 * the breaks may fall, so a wrapped address breaks between its parts.
 *
 * It is a zero-width mark and not a soft hyphen: nothing is added to the text,
 * so a merchant who selects this and copies it gets the address and not a
 * hyphenated version of it that no client would accept.
 */
const wrappable = (address: string): string => {
  const [origin, ...segments] = address.split(/(?<!\/)\/(?!\/)/);
  return [escaped(origin ?? "")]
    .concat(segments.map((segment) => `<wbr>/${escaped(segment)}`))
    .join("");
};

export const cardsScreen = (viewer: Viewer, cards: MerchantCardList, origin: string): string => {
  const { base } = viewer;
  const paused = cards.cards.filter((entry) => entry.paused).length;
  // Three words and not two. Folding "departed" into "stopped" would offer a
  // merchant who has left a button that puts them back on sale and a note
  // saying their accepted orders are playing out — and leaving closed those
  // orders and left refunds owed. The whole of `selling.ts` is an argument
  // that this fold is the one not to make.
  const gone = cards.selling === "departed";
  const stopped = cards.selling === "paused";

  const rows = cards.cards.map(
    (entry) => `<tr class="${entry.selling === "open" ? "" : "off"}">
<td><div class="title">${escaped(entry.card.title)}</div><div class="under">${escaped(cardAside(entry))}</div><div class="buy">${wrappable(buyingAddress(origin, entry))}</div></td>
<td class="key">${escaped(entry.card.merchant_item_id)}</td>
<td class="amount">${escaped(money(entry.card.price))}</td>
<td class="quiet">${escaped(FULFILLMENT_WORDS[entry.card.fulfillment])}</td>
<td>${state(SELLING_WORDS[entry.selling])}</td>
<td class="control">${cardControl(base, entry)}${cardWalk(viewer, entry)}</td>
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
      ${
        gone
          ? ""
          : `<form class="inline" method="post" action="${escaped(base)}/selling/${stopped ? "resume" : "pause"}">
        <button class="wide${stopped ? " primary" : ""}" type="submit">${stopped ? "Start selling again" : "Stop all selling"}</button>
      </form>`
      }
    </div>
  </div>
${table(
  ["Product", "Your key", "Price", "Delivery", "State", ""],
  rows,
  // An empty catalogue has two readings and the merchant cannot tell them
  // apart from here: nobody has published anything yet, or something published
  // was refused. While no name is set, the second one is what happens to
  // everything, so the line says it rather than leaving a merchant to work out
  // why their code's card never arrived.
  viewer.sellerName === null
    ? "You have not published a card yet, and until you choose the name buyers see, publishing one is refused. Choose it in your settings and publish again."
    : "You have not published a card yet. Your code publishes them; they appear here.",
)}
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(sellingNote(cards.selling))}</span></div>
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(
    // Text and not a link, and the reason is what happens when you press one.
    // Asking for this address without paying is answered with a demand for
    // payment that travels in a header, so a browser is handed a blank page
    // and a merchant who clicked reads that as their card being broken.
    "The line under each product is the address an agent buys it at. Asking for it without paying" +
      " answers with a demand for payment rather than a page, so it is for handing to an agent or" +
      " trying from a terminal, not for opening here. A card that is off sale is refused at that" +
      " address instead of being offered.",
  )}</span></div>
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(walkNote(viewer.mode))}</span></div>
`;

  return framed({ viewer, tab: "cards", title: "Product cards", selling: cards.selling, body });
};

/**
 * What a test purchase is, and on a live cabinet where one is walked instead.
 *
 * The sentence for the live site is the one worth being careful about. A
 * merchant reading a cards screen with no such control has to be able to tell
 * "we do not offer this" from "this is missing", and the difference is where
 * the money comes from: the buyer is ours, so the walk exists where the money
 * is test money and the address of that site is in the sentence rather than
 * left to be guessed.
 */
const walkNote = (mode: SurfaceMode): string =>
  walksTestPurchases(mode)
    ? "A test purchase buys one of your own cards with a buyer of ours, through the same addresses" +
      " a stranger's agent would use, and comes back with what every door on the way answered." +
      " Nothing it spends is yours: the buyer is ours and it pays with test funds."
    : "Test purchases are not walked here. Ours is the wallet one is paid for out of, so they are" +
      ` walked where the money is test money — on the test site, ${SITES.test} — and what is` +
      " published here is published with this environment's own key.";

/**
 * What the merchant's selling word means for the orders they already have.
 *
 * A pause and a departure differ in exactly the thing a merchant needs to know
 * here, and the difference is not one of degree: a pause leaves the accepted
 * orders to play out, and leaving closed them and left the money for anything
 * paid for and not delivered to be returned. One sentence for both would be
 * wrong for one of them.
 */
const sellingNote = (selling: MerchantCardList["selling"]): string => {
  switch (selling) {
    case "departed":
      return "You have left. The cards are off sale, the orders that were open closed with you, and the money for anything paid for and not delivered is yours to return. Selling does not start again from this page.";
    case "paused":
      return "All selling is stopped: no new order is taken for any card, and the orders you have already accepted play out as usual. Resuming leaves the cards you paused yourself paused.";
    case "open":
      return "A pause takes the card off sale without abandoning orders: the ones you already accepted play out as usual. No new orders arrive while it is paused.";
  }
};

/**
 * What the whole walk came to, in the sentence a merchant reads first.
 *
 * Three sentences because there are three different next moves, and the middle
 * one is the one that has to be got right: a card whose goods come later cannot
 * end holding them, so "the money moved and you took the order on" is a success
 * with a different word rather than a walk that half failed.
 */
const outcomeSentence = (walk: TestPurchase): string => {
  switch (walk.outcome) {
    case "delivered":
      return (
        "The purchase went through. Our buyer walked the same path a stranger's agent walks," +
        " paid at the address on your card, and came away holding the goods your own code" +
        " delivered. There is nothing left to do."
      );
    case "accepted":
      return (
        "The money moved and your code took the order on, so the goods are owed rather than" +
        " handed over. That is the whole of what a card whose goods come later can do inside a" +
        " purchase: the buyer collects them at the order's own address once you have delivered" +
        " them, and until you do, the order is open and the deadline on the card is running."
      );
    case "stopped":
      return (
        "The walk did not get through. The last step below is where it stopped, and beside it" +
        " are the storefront's own words about why — the same words a stranger's agent would" +
        " have read."
      );
  }
};

/**
 * The order the walk opened, and the way to the screen it is on.
 *
 * There is no page for one order, so the link goes to the list; the identifier
 * beside it is what a merchant searches that list with. Null is a real answer
 * and is said as one: a walk that stopped at the price never opened an order,
 * and a merchant told nothing would go looking for one that does not exist.
 */
const walkedOrder = (base: string, walk: TestPurchase): string =>
  walk.order_id === null
    ? `<p class="quiet">${escaped(
        "No order was opened. The walk stopped before there was one, so there is nothing to look" +
          " up and nothing was charged.",
      )}</p>`
    : `<p>The walk opened <a href="${escaped(base)}/orders">${escaped(walk.order_id)}</a>. ${escaped(
        "It is an ordinary order of yours — it reached your code, it sits among your orders and it" +
          " leaves a receipt behind it — and its money is test money, which is what the test mark" +
          " beside it says.",
      )}</p>`;

/**
 * The goods, exactly as the buyer received them.
 *
 * Printed as the JSON that came back rather than laid out field by field. This
 * is the one thing on the page a merchant checks against what their card
 * declares it delivers, and a rendering of our own would be the place that
 * comparison quietly stops being exact.
 */
const walkedGoods = (walk: TestPurchase): string => {
  if (walk.delivered !== null) {
    return `<pre class="delivered">${escaped(JSON.stringify(walk.delivered, null, 2))}</pre>`;
  }
  return `<p class="quiet">${escaped(
    walk.outcome === "accepted"
      ? "The buyer is holding none yet, and on this card it should not be: the goods come later," +
          " and the buyer collects them at the order's own address once you have delivered them."
      : "The buyer is holding none. The walk did not reach a delivery.",
  )}</p>`;
};

/**
 * The page a merchant is answered with when they walk a test purchase.
 *
 * Answered straight from the post rather than after a redirect, which this
 * cabinet otherwise only does for a new key, and for a cousin of the same
 * reason: the transcript exists for the length of one answer and this cabinet
 * keeps no database to put it in, so a redirect would send the merchant to a
 * page that could no longer show them what happened. What it costs is that
 * reloading asks the browser to send the form again, which walks another
 * purchase — the page says so.
 */
export const testPurchaseScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  entry: MerchantCard,
  walk: TestPurchase,
): string => {
  const { base } = viewer;

  const rows = walk.steps.map(
    (step) => `<tr class="${step.ok ? "" : "needs-you"}">
<td>${escaped(TEST_PURCHASE_STEP_WORDS[step.step])}</td>
<td>${state(step.ok ? { text: "yes", tone: "ok" } : { text: "no", tone: "warn" })}</td>
<td><div class="buy">${wrappable(step.address)}</div></td>
<td>${escaped(step.said)}</td>
</tr>`,
  );

  const body = `
  <div class="lede">
    <div>
      <h1>Test purchase</h1>
      <p>${escaped(outcomeSentence(walk))}</p>
    </div>
    <div class="actions">${state(TEST_PURCHASE_WORDS[walk.outcome])}</div>
  </div>
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(
    `This is a walk of "${entry.card.title}", bought with a buyer of ours at the addresses below.` +
      " Every one of them is an address of the public storefront, which is what makes this" +
      " evidence about the door your buyers knock on rather than about our own internals.",
  )}</span></div>
${table(
  ["Step", "Went through", "The address the buyer called", "What came of it"],
  rows,
  // A walk that took no step at all cannot reach this page: the document is
  // refused by the contract before it is drawn. The line is here because the
  // table wants one, and it says the honest thing rather than nothing.
  "This walk recorded no steps, which is not something it can do — nothing here can be read as a purchase that was tried.",
)}
  <div class="lede">
    <div>
      <h2>The order</h2>
      ${walkedOrder(base, walk)}
    </div>
  </div>
  <div class="lede">
    <div>
      <h2>The goods</h2>
      <p>${escaped(
        "What the buyer came away holding, exactly as it arrived. This is the thing to read" +
          " against what your card declares it delivers.",
      )}</p>
    </div>
  </div>
  ${walkedGoods(walk)}
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(
    "Reloading this page asks your browser to send the form again, which walks another purchase" +
      " rather than showing you this one. There is a ceiling on how many one merchant may walk" +
      " in an hour, and the gateway says so in words when it is reached.",
  )}</span></div>
  <p class="quiet"><a href="${escaped(base)}/cards">Back to your cards</a></p>
`;

  return framed({
    viewer,
    tab: "cards",
    title: "Test purchase",
    selling: cards.selling,
    body,
  });
};

export const ordersScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  orders: OrderList,
  open: boolean,
): string => {
  const { base } = viewer;
  const titles = new Map(
    cards.cards.map((entry) => [entry.card.merchant_item_id, entry.card.title]),
  );
  const wanting = orders.orders.filter((order) => needsAttention(order.status));

  const rows = orders.orders.map((order) => {
    const word = ORDER_WORDS[order.status];
    return `<tr class="${needsAttention(order.status) ? "needs-you" : ""}">
<td class="ident">${escaped(order.id)}</td>
<td><div>${escaped(titles.get(order.merchant_item_id) ?? order.merchant_item_id)}</div><div class="under mono">${escaped(order.merchant_item_id)}</div></td>
<td class="amount">${escaped(money(order.price))}${sum(order.test)}</td>
<td>${state(word)}</td>
<td class="quiet">${escaped(moment(order.price.at))}</td>
</tr>`;
  });

  const body = `
  <div class="lede">
    <div>
      <h1>Orders</h1>
      <p>${escaped(ordersLede(orders, open))}</p>
      ${testOrders(orders)}
    </div>
    <div class="filter">
      ${open ? '<span class="here">Open</span>' : `<a href="${escaped(base)}/orders?open=true">Open</a>`}
      ${open ? `<a href="${escaped(base)}/orders">All</a>` : '<span class="here">All</span>'}
    </div>
  </div>
${table(
  // "Price set" and not "Bought": the moment in the row is when we fixed the
  // price for this sale, and on a card whose price is checked at the purchase
  // the buyer may pay well after it. A column headed "Bought" would have a
  // merchant reconciling money against a minute nothing happened in.
  ["Order", "Product", "Amount", "State", "Price set"],
  rows,
  open ? "Nothing is open. Every order you have is finished." : "No orders yet.",
)}
  <div class="note"><span class="mark">&#8627;</span><span>${escaped(
    "One kind of order cannot appear here: a purchase that closed before anybody named a price for it — a product you said was gone, or a price question you did not answer. The row every order is drawn in carries the price it sold at, and those have none. Nothing was charged for them.",
  )}</span></div>
${wanting
  .map(
    (order) => `  <div class="callout">
    <div class="what">Order <span class="mono">${escaped(order.id)}</span> ${escaped(ORDER_WORDS[order.status].text)}</div>
    <div class="why">${escaped(whyItNeedsYou(order.status))}</div>
  </div>
`,
  )
  .join("")}`;

  return framed({ viewer, tab: "orders", title: "Orders", selling: cards.selling, body });
};

/**
 * The sentence at the top of the orders screen.
 *
 * It counts what it can stand behind and says only that. "Open" is the
 * gateway's own filter; "needs you" is `NEEDS_ATTENTION` — the two endings that
 * stay open with something concrete owed — and the sentence is scoped to those
 * two rather than to owing in general.
 *
 * Two earlier versions of this line said more than the code knew. "None of them
 * is owed money or goods by you" was false for an order merely under way, which
 * in the asynchronous mode is money already taken against goods not yet sent.
 * And "the money was taken and the goods have not gone out" described only
 * `refund_due`, while the count beside it also included `delivered_unpaid`,
 * which is the exact inverse. Neither is here now: the count is scoped, and
 * what each order actually needs is said per order in the callouts below,
 * where it can be right.
 */
const ordersLede = (orders: OrderList, open: boolean): string => {
  const wanting = orders.orders.filter((order) => needsAttention(order.status)).length;
  const scope = open ? "open" : "";
  const listed = `${countOf(orders.orders.length, `${scope} order`.trim())} listed.`;

  if (wanting === 0) {
    return `${listed} None of them owes a refund, and none was delivered against a payment that did not execute.`;
  }
  return `${listed} ${countOf(wanting, "order")} ${wanting === 1 ? "needs" : "need"} you, and each one is set out below.`;
};

/**
 * The same warning as on the receipts screen, for the same reason.
 *
 * An order carries the flag too, and the sums in this table are sums a merchant
 * would otherwise take for money that moved.
 */
const testOrders = (orders: OrderList): string => {
  const tests = orders.orders.filter((order) => order.test).length;
  if (tests === 0) {
    return "";
  }
  return `<p class="problem">${escaped(
    tests === orders.orders.length
      ? "Every order here is a test purchase: no real money moved."
      : `${countOf(tests, "order")} here ${tests === 1 ? "is a test purchase" : "are test purchases"}: no real money moved for ${tests === 1 ? "it" : "those"}.`,
  )}</p>`;
};

const whyItNeedsYou = (status: OrderList["orders"][number]["status"]): string =>
  status === "refund_due"
    ? "The money was taken, the delivery window ran out and nothing shipped. You return it from your own wallet — we recorded the amount and the order. A late delivery still clears the debt."
    : "You delivered the goods and the payment did not execute. The order stays open, and a repeat purchase by the same buyer carries the payment through.";

export const receiptsScreen = (
  viewer: Viewer,
  cards: MerchantCardList,
  receipts: ReceiptList,
): string => {
  const titles = new Map(cards.cards.map((entry) => [entry.id, entry.card.title]));
  const delivered = receipts.receipts.filter((receipt) => receipt.outcome === "delivered").length;

  const rows = receipts.receipts.map((receipt) => {
    const word = ORDER_WORDS[receipt.outcome];
    return `<tr class="${receipt.outcome === "refund_due" ? "needs-you" : ""}">
<td class="ident">${escaped(receipt.id)}</td>
<td class="ident">${escaped(receipt.order_id)}</td>
<td>${escaped(titles.get(receipt.item_id) ?? receipt.item_id)}</td>
<td class="amount">${escaped(money(receipt.price))}${sum(receipt.test)}</td>
<td>${state(word)}</td>
<td class="quiet">${escaped(moment(receipt.paid_at))}</td>
<td class="quiet">${escaped(moment(receipt.price.at))}</td>
<td class="quiet">${escaped(moment(receipt.price.as_of))}</td>
</tr>`;
  });

  const body = `
  <div class="lede">
    <div>
      <h1>Receipts</h1>
      <p>A receipt is written when the goods for an order are released: the amount, the moment the money moved, the moment we set that price for the sale, and the instant the price behind it was true. Those three are three different moments, and on a product whose price is asked for at the purchase they can be minutes apart.</p>
      <p>This is not the whole of the money. A purchase whose goods have not gone out has no receipt yet, and in the mode where the money moves at the purchase that means a payment you have already been sent is not on this page. Neither is a refund you owe. Both are on Orders, and until they end there the list below is short of them. A purchase that ended before any payment leaves no receipt at all, and none is written while it is unknown whether the buyer was charged.</p>
      ${testWarning(receipts)}
    </div>
  </div>
  <div class="summary">
    <div class="tile">
      <div class="label">Receipts</div>
      <div class="figure">${receipts.receipts.length}</div>
      <div class="aside">${escaped(sumsOf(receipts))}</div>
    </div>
    <div class="tile">
      <!-- Two tiles and not three. A third counting what is paid for and not
           yet delivered would read nought forever — this gateway writes a
           receipt only when goods are released — and a nought is a positive
           claim that there is none, printed on the screen where a merchant
           looks for money they are owed. What cannot be counted here is said in
           words above the table instead, with the place it can be counted. -->
      <div class="label">Delivered</div>
      <div class="figure${delivered === 0 ? "" : " ok"}">${delivered}</div>
      <div class="aside">of ${countOf(receipts.receipts.length, "receipt")}</div>
    </div>
  </div>
${table(
  ["Receipt", "Order", "Product", "Amount", "Outcome", "Paid", "Price set", "Price true as of"],
  rows,
  "No receipts yet. One is written when the goods for an order are released — a purchase that has been paid for and not delivered is on Orders, not here.",
)}
`;

  return framed({ viewer, tab: "receipts", title: "Receipts", selling: cards.selling, body });
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
  return `priced in ${currencies.sort().join(", ")}`;
};

/**
 * The mark beside a sum that was not real money.
 *
 * A receipt is proof of a payment, and the contract says in as many words that
 * an unmarked receipt for a test purchase is proof of a payment that never
 * happened. Stage one marks every order as a test, so today every row on both
 * screens carries this — which is exactly the situation in which leaving it out
 * would be worst: a merchant would be reading a ledger of payments that did not
 * happen, laid out as a ledger of payments.
 */
const sum = (test: boolean): string => (test ? ' <span class="tag">test</span>' : "");

/**
 * The sentence that says the whole screen is test money, when it is.
 *
 * A mark per row is enough to tell two rows apart. It is not enough to stop a
 * merchant reading a full page of them as their takings, so when every row is a
 * test the page says so once, in a sentence, above the table.
 */
const testWarning = (receipts: ReceiptList): string => {
  const tests = receipts.receipts.filter((receipt) => receipt.test).length;
  if (tests === 0) {
    return "";
  }
  return `<p class="problem">${escaped(
    tests === receipts.receipts.length
      ? "Every receipt here is a test purchase: no money moved, and none of these is proof that any did."
      : `${countOf(tests, "receipt")} here ${tests === 1 ? "is a test purchase" : "are test purchases"}: no money moved for ${tests === 1 ? "it" : "those"}.`,
  )}</p>`;
};

const countOf = (many: number, thing: string): string => `${many} ${thing}${many === 1 ? "" : "s"}`;
