/**
 * Every number the portal names, held to the configuration default it mirrors.
 *
 * The charter's rule is that the documentation's examples are fixtures of the
 * code, and this is that rule applied to the deadlines. The pages used to keep
 * their side of it by naming no numbers at all: six shipped defaults were
 * described as questions nobody had answered yet, and two of them were dressed
 * as hypotheticals that happened to equal the real default to the digit. A
 * merchant cannot size a handler against that, and the way it went wrong is
 * instructive — nothing was lying when it was written, and nothing said so
 * afterwards.
 *
 * So the pages now name them, and this file is what stops the two drifting
 * apart again. It reads the merchant's own sentences out of the markdown and
 * compares what they say against `loadConfig` with nothing but the database in
 * the environment, which is the deployment the portal describes.
 *
 * It lives here rather than beside the other portal tests because the numbers
 * live here: `config.ts` is the one place a deadline is decided, so this is
 * where somebody changing one will be standing when it fails. The pages are
 * read from the repository the same way `packages/contracts/src/portal-fixtures
 * .test.ts` reads them, by a URL relative to this file.
 *
 * What the anchors are for. A pin quotes enough of the sentence around the
 * number to die when the sentence is rewritten rather than quietly matching
 * some other "five" further down the page — the pages say "five seconds" about
 * a merchant's own supplier and "at most five" about tags, and neither is ours.
 * Where a page says the same thing twice, every occurrence is checked, so two
 * paragraphs cannot come to disagree with each other either.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const repoRoot = new URL("../../../", import.meta.url);

/**
 * A page with its line wrapping taken out.
 *
 * The portal wraps its prose at eighty columns, so almost every sentence worth
 * anchoring on is split across two lines and no regular expression written for
 * a reader would match it. Collapsing the whitespace is what lets a pin be
 * written as the sentence a person reads.
 */
const pageText = (file: string): string =>
  readFileSync(new URL(file, repoRoot), "utf8").replace(/\s+/g, " ");

/** The numbers the portal spells out, as it spells them. */
const NUMBER_WORDS: Record<string, number> = { five: 5, eight: 8, ten: 10, thirty: 30 };

/** The stretches of time the portal names instead of counting seconds. */
const PERIOD_MS: Record<string, number> = { hour: 3_600_000, day: 86_400_000 };

/** What kind of quantity the captured word is. */
type Reads = "seconds" | "count" | "period";

/**
 * The number a captured word stands for, in the unit the configuration keeps.
 *
 * A word this cannot read is a failure and not a skip. Rewrite "eight seconds"
 * as "8 seconds" and the pin would otherwise capture something it has no entry
 * for, and a pin that shrugs at what it cannot read is a pin that passes on a
 * page saying anything at all.
 *
 * Case is the one thing forgiven, because a sentence that opens on its number
 * capitalises it and the portal has one of those.
 */
function quantityOf(written: string, reads: Reads): number {
  const word = written.toLowerCase();

  if (reads === "period") {
    const ms = PERIOD_MS[word];
    if (ms === undefined) {
      throw new Error(
        `the portal now writes the period as "${written}", which this test cannot read; add it to PERIOD_MS or write it the way the portal writes periods`,
      );
    }
    return ms;
  }

  const value = NUMBER_WORDS[word];
  if (value === undefined) {
    throw new Error(
      `the portal now writes the number as "${written}", which this test cannot read; add it to NUMBER_WORDS or spell it the way the portal spells numbers`,
    );
  }

  return reads === "seconds" ? value * 1_000 : value;
}

/** Every number the anchor captures on the page, in the order they are written. */
function capturedBy(page: string, anchor: RegExp): string[] {
  const global = new RegExp(anchor.source, `${anchor.flags.replace("g", "")}g`);
  return [...page.matchAll(global)].map((match) => match[1] ?? "");
}

interface Pin {
  /** The promise this sentence makes to the merchant. */
  readonly what: string;
  readonly page: string;
  /** The sentence, with the number as its one capture group. */
  readonly anchor: RegExp;
  readonly reads: Reads;
  /** The configuration default the sentence has to be quoting. */
  readonly is: number;
}

const config = loadConfig({ DATABASE_URL: "postgres://coinslot:secret@localhost:5432/coinslot" });
const { deadlines, redelivery } = config;

const PINS: readonly Pin[] = [
  // --- how long we wait for a price, and how long the answer lives ----------
  {
    what: "how long a price the merchant named goes on being good",
    page: "portal/orders.md",
    anchor: /A price holds for (\w+) seconds/,
    reads: "seconds",
    is: deadlines.quoteTtlMs,
  },
  {
    // The anchor holds the moment as well as the number, and that is the point
    // of it. The page used to hang this thirty on `expires_at`, which is a
    // different and longer number — the gateway works that field out when the
    // question goes out, as our patience for an answer plus the price's own
    // life, because the life cannot start until the answer lands. A pin that
    // read the number alone would have gone on certifying that pairing.
    what: "how long a price holds, and the moment it is counted from",
    page: "portal/cards.md",
    anchor:
      /A price you name holds for (\w+) seconds, counted from the moment your answer reaches us/,
    reads: "seconds",
    is: deadlines.quoteTtlMs,
  },
  {
    what: "how long a price question may go unanswered before it counts as silence",
    page: "portal/failures.md",
    anchor: /no answer within (\w+) seconds/,
    reads: "seconds",
    is: deadlines.quoteResponseMs,
  },
  {
    what: "the same wait, said again where the page says whose setting it is",
    page: "portal/failures.md",
    anchor: /(\w+) seconds is what the system you are connecting to allows/,
    reads: "seconds",
    is: deadlines.quoteResponseMs,
  },
  {
    what: "the same wait, on the page a price handler is written from",
    page: "portal/cards.md",
    anchor: /We wait (\w+) seconds for an answer/,
    reads: "seconds",
    is: deadlines.quoteResponseMs,
  },

  // --- the synchronous answer, and the ceiling around it --------------------
  //
  // The one the merchant sizes a synchronous handler against, and the one it
  // was hardest to find a sentence for: before this, no page named it at all.
  {
    what: "how long a synchronous answer has, in the deadline reference",
    page: "portal/orders.md",
    anchor: /A synchronous answer has (\w+) seconds/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the same, where the page explains what the clock covers",
    page: "portal/orders.md",
    anchor: /The (\w+) seconds run from the moment the agent buys/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    // The one sentence that counts the seconds without naming the unit, because
    // the sentence before it named them: "come out of the same eight".
    what: "the same, in the worked case of a delivery that finished late",
    page: "portal/orders.md",
    anchor: /come out of the same (\w+),/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the same, on the card reference",
    page: "portal/cards.md",
    anchor: /the same for every product: (\w+) seconds/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the same, where the handler is written",
    page: "portal/quickstart.md",
    anchor: /as one number for everybody, and it is (\w+) seconds/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the same, said again where the page warns it is not the handler's own",
    page: "portal/quickstart.md",
    anchor: /They are not (\w+) seconds for your handler/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the same, on the page about what goes wrong",
    page: "portal/failures.md",
    anchor: /(\w+) seconds, counted from the moment the agent buys/,
    reads: "seconds",
    is: deadlines.syncResponseMs,
  },
  {
    what: "the whole purchase the agent is promised, which the answer sits inside",
    page: "portal/orders.md",
    anchor: /fit inside the (\w+) seconds we promise the agent/,
    reads: "seconds",
    is: deadlines.syncBudgetMs,
  },
  {
    what: "the same promise, where the handler is written",
    page: "portal/quickstart.md",
    anchor: /the (\w+) seconds we promise the agent/,
    reads: "seconds",
    is: deadlines.syncBudgetMs,
  },

  // --- what a card that names no deadline of its own is held to -------------
  {
    what: "the delivery deadline a card leaves out, in the deadline reference",
    page: "portal/orders.md",
    anchor: /leave it out and a (\w+) applies/,
    reads: "period",
    is: deadlines.defaultAsyncFulfillmentMs,
  },
  {
    what: "the same, on the card reference",
    page: "portal/cards.md",
    anchor: /A (\w+) applies instead/,
    reads: "period",
    is: deadlines.defaultAsyncFulfillmentMs,
  },
  {
    what: "the same, where the handler is written",
    page: "portal/quickstart.md",
    anchor: /A card that names none is held to a (\w+)\./,
    reads: "period",
    is: deadlines.defaultAsyncFulfillmentMs,
  },
  {
    what: "the same, in the worked case of a delivery that never arrived",
    page: "portal/failures.md",
    anchor: /so the (\w+) we hold it to is the one running/,
    reads: "period",
    is: deadlines.defaultAsyncFulfillmentMs,
  },
  {
    what: "the confirmation deadline a card leaves out, in the deadline reference",
    page: "portal/orders.md",
    anchor: /a deadline of its own — an (\w+), where the card names none/,
    reads: "period",
    is: deadlines.defaultConfirmationResponseMs,
  },
  {
    what: "the same, on the card reference",
    page: "portal/cards.md",
    anchor: /a deadline of its own — an (\w+), where the card names none/,
    reads: "period",
    is: deadlines.defaultConfirmationResponseMs,
  },

  // --- how many times an order that never reached the handler is sent again --
  {
    what: "the attempt cap, where the three answers a handler has are set out",
    page: "portal/orders.md",
    anchor: /we have delivered it (\w+) times/,
    reads: "count",
    is: redelivery.maxAttempts,
  },
  {
    what: "the same cap, said again as the number this deployment is set to",
    page: "portal/orders.md",
    anchor: /(\w+) is what this system is set to/,
    reads: "count",
    is: redelivery.maxAttempts,
  },
  {
    what: "the same cap, on the page about a handler that threw",
    page: "portal/failures.md",
    anchor: /until we have tried (\w+) times/,
    reads: "count",
    is: redelivery.maxAttempts,
  },
];

describe("every number the portal names is the number this gateway ships", () => {
  for (const pin of PINS) {
    it(`${pin.what} (${pin.page})`, () => {
      const captured = capturedBy(pageText(pin.page), pin.anchor);

      // A dead anchor is the failure this file exists to make loud. Without
      // this the pin would pass on a page that had stopped saying anything at
      // all, which is the state the pages were in before they named numbers.
      expect(
        captured.length,
        `${pin.page} no longer carries the sentence this pin reads (${pin.anchor.source}); if it was rewritten, rewrite the pin with it`,
      ).toBeGreaterThan(0);

      for (const word of captured) {
        expect(
          quantityOf(word, pin.reads),
          `${pin.page} tells the merchant "${word}" where the configuration says ${pin.is}`,
        ).toBe(pin.is);
      }
    });
  }

  it("grows the pause between attempts, which is the one claim carrying no number", () => {
    // failures.md: "we repeat the delivery, after a pause that grows with each
    // attempt". Every other claim the portal publishes is a number this file
    // reads back; this one is a shape, and the configuration can falsify it on
    // its own — a factor of one is accepted and means a flat retry, which puts
    // all five attempts inside a couple of seconds on a merchant already in
    // trouble, and the sentence would then be describing nothing that happens.
    expect(redelivery.factor).toBeGreaterThan(1);
  });
});

describe("a number the portal publishes is not also called undecided", () => {
  // The other half of the same promise, and the half that decays quietly. A
  // page can name a deadline in its body and go on listing that deadline in
  // "What is not settled yet", and then the merchant has read both a number and
  // a statement that there is no number. Each entry below names what is true
  // instead, in the manner of `packages/core/src/retired-claims.test.ts`.
  const RESOLVED: readonly {
    readonly page: string;
    readonly claim: RegExp;
    readonly truth: string;
  }[] = [
    {
      page: "portal/orders.md",
      claim: /how long we wait for a synchronous answer/,
      truth: "eight seconds, named in “Time ran out”",
    },
    {
      page: "portal/quickstart.md",
      claim: /how long we wait for a synchronous answer/,
      truth: "eight seconds, named on step 3",
    },
    {
      page: "portal/orders.md",
      claim: /how many times we do it/,
      truth: "five attempts, named where a handler's three answers are set out",
    },
    {
      page: "portal/failures.md",
      claim: /how many times we repeat it/,
      truth: "five attempts, named under “The handler crashed without answering”",
    },
    {
      page: "portal/failures.md",
      claim: /freshness threshold/,
      truth: "there is no such check: the timestamp on a price answer is carried and never weighed",
    },
    {
      page: "portal/cards.md",
      claim: /how long we wait for an answer/,
      truth: "five seconds, named under “Asking the price and availability”",
    },
    {
      page: "portal/quickstart.md",
      claim: /the build that would let the command start/,
      truth: "the SDK builds and `npx coinslot verify` runs; `scripts/outside.sh` runs it",
    },
    // The two entries about a number the portal does not name, and the reason
    // they belong anyway: the pause between attempts is settled in `config.ts`
    // — a base, a factor and a cap — and is deliberately left unpublished,
    // because a merchant sizes nothing against it. Calling it an open question
    // was the same half-claim the deadlines were, and what settled it was
    // deleting the bullet rather than naming a schedule.
    {
      page: "portal/orders.md",
      claim: /The delay before we resend/,
      truth:
        "settled in configuration and deliberately unpublished as internal mechanics: the repeating is automatic and is bounded by the deadline and the attempt count, and both of those are named",
    },
    {
      page: "portal/failures.md",
      claim: /The delay before we repeat/,
      truth:
        "settled in configuration and deliberately unpublished as internal mechanics: the page says the pauses grow, which is the whole of what a handler needs",
    },
  ];

  function unsettledSection(page: string): string {
    const text = readFileSync(new URL(page, repoRoot), "utf8");
    const start = text.indexOf("## What is not settled yet");
    if (start === -1) throw new Error(`${page} has no "What is not settled yet" section`);
    return text.slice(start).replace(/\s+/g, " ");
  }

  for (const { page, claim, truth } of RESOLVED) {
    it(`${page} no longer asks about ${claim.source}`, () => {
      expect(
        unsettledSection(page),
        `${page} lists this as unsettled again, and it is settled: ${truth}`,
      ).not.toMatch(claim);
    });
  }

  it("is reading the sections and not an empty string", () => {
    // The negative control for the guard above: every one of those assertions
    // passes against nothing at all.
    for (const page of ["portal/orders.md", "portal/cards.md", "portal/failures.md"]) {
      expect(unsettledSection(page).length).toBeGreaterThan(200);
    }
    expect(() => unsettledSection("portal/WRITING.md")).toThrowError(
      /no "What is not settled yet"/,
    );
  });
});

describe("the pin itself", () => {
  // Everything above is worth exactly as much as these few functions. A reader
  // that silently found nothing, or a matcher that took any number it met,
  // would leave the whole file green against a portal saying anything.

  it("reads a sentence the page has wrapped across two lines", () => {
    const wrapped =
      "answer is set by us, the same for every\nproduct: eight seconds. That one runs";

    expect(
      capturedBy(wrapped.replace(/\s+/g, " "), /the same for every product: (\w+) seconds/),
    ).toStrictEqual(["eight"]);
  });

  it("finds nothing when the sentence is gone, rather than a number from elsewhere", () => {
    // The page still says "five seconds" — about a supplier of the merchant's
    // own, which is not our number and never was.
    const page = "a supplier that did not answer within five seconds is not worth a refusal";

    expect(capturedBy(page, /until we have tried (\w+) times/)).toStrictEqual([]);
  });

  it("catches a number that changed under an unchanged sentence", () => {
    const page = "A synchronous answer has nine seconds.";
    const [word] = capturedBy(page, /A synchronous answer has (\w+) seconds/);

    expect(word).toBe("nine");
    expect(() => quantityOf(word ?? "", "seconds")).toThrowError(/cannot read/);
    expect(quantityOf("eight", "seconds")).toBe(8_000);
  });

  it("holds every occurrence, so one paragraph cannot drift from another", () => {
    const page = "A synchronous answer has eight seconds. A synchronous answer has nine seconds.";

    expect(capturedBy(page, /A synchronous answer has (\w+) seconds/)).toStrictEqual([
      "eight",
      "nine",
    ]);
  });

  it("reads periods and counts in the units the configuration keeps them in", () => {
    expect(quantityOf("day", "period")).toBe(86_400_000);
    expect(quantityOf("hour", "period")).toBe(3_600_000);
    expect(quantityOf("five", "count")).toBe(5);
    expect(quantityOf("thirty", "seconds")).toBe(30_000);
    expect(() => quantityOf("fortnight", "period")).toThrowError(/cannot read/);
    // A sentence that opens on its number writes it with a capital.
    expect(quantityOf("Five", "count")).toBe(5);
  });

  it("leaves none of the numbers the portal publishes without a pin", () => {
    // Deleting a sentence from the portal and its pin together is a decision
    // somebody can take; losing the pin on its own is how the number goes back
    // to drifting. Each of these is a default a page names in words, so each
    // has to be somebody's `is` above.
    const pinned = new Set(PINS.map((pin) => pin.is));

    for (const [what, value] of [
      ["how long we wait for a price", deadlines.quoteResponseMs],
      ["how long a price holds", deadlines.quoteTtlMs],
      ["how long a synchronous answer has", deadlines.syncResponseMs],
      ["the purchase the agent is promised", deadlines.syncBudgetMs],
      ["the delivery deadline a card leaves out", deadlines.defaultAsyncFulfillmentMs],
      ["the confirmation deadline a card leaves out", deadlines.defaultConfirmationResponseMs],
      ["how many times an order is sent again", redelivery.maxAttempts],
    ] as const) {
      expect(pinned, `nothing above holds the portal to ${what}`).toContain(value);
    }
  });
});
