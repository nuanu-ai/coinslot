/**
 * The command that asks the catalog whether it would take our resources.
 *
 * Everything else about the discovery declaration is checked offline, against
 * the schema the declaration ships with and against the catalog's own
 * sanitiser. None of that is the catalog accepting a resource. The spike this
 * work descends from learned the difference the hard way: its first attempt was
 * structurally fine and was refused outright by a version gate, and nothing
 * short of asking would have found that.
 *
 * So this asks. `POST /platform/v2/x402/validate` at the CDP API is public,
 * needs no key and costs nothing — there is no wallet, no chain and no spending
 * to cap here — and it reports whether the resource is reachable, whether it
 * answers 402, whether the discovery block holds up and whether the payment it
 * asks for is one the facilitator would accept.
 *
 * The one thing it needs is a gateway the endpoint can reach, which means a
 * public address. A laptop is not one. That is the whole reason this is a
 * command somebody runs against a deployment rather than a test: `pnpm test` is
 * offline and free, and a check that fakes this call proves nothing at all.
 *
 * What it must never do is report a pass it did not see. Three different things
 * can happen and they are three different answers: the catalog said the
 * resource is good, the catalog said it is not, and the catalog did not say —
 * an endpoint that was unreachable, an answer that would not parse, an answer
 * with no verdict in it. The third is the one that quietly becomes a green tick
 * if nobody writes it down, so it is written down here and it exits non-zero.
 */

import { API_ROUTES, expandPath } from "@coinslot/contracts";
import { z } from "zod";

/**
 * The whole of a catalog this command reads: one identifier per product.
 *
 * Everything else in the document is somebody else's business here — a price a
 * probe never quotes, a description a probe never shows — and every field this
 * does not name is one more way for a working gateway to be turned away by a
 * copy of the code older than it is.
 */
const CATALOG_IDENTIFIERS = z.object({
  items: z.array(z.object({ id: z.string().min(1) })),
});

/** What a catalog is, to this command. */
type CatalogIdentifiers = z.infer<typeof CATALOG_IDENTIFIERS>;

/** Where the public validation endpoint lives. No key, no cost. */
export const VALIDATE_ENDPOINT = "https://api.cdp.coinbase.com/platform/v2/x402/validate";

/**
 * The two methods our purchase address answers on, and both are asked about.
 *
 * A crawler and the validator itself probe with GET, and the purchase an agent
 * actually makes is a POST — and the two carry different declarations, because
 * a declaration that names a body is only valid on a method that carries one.
 * Checking one of them would leave the other unproven, and it is exactly that
 * asymmetry that made a resource invisible to the catalog once already.
 */
export const PROBED_METHODS = ["GET", "POST"] as const;

/** What the endpoint answered, or why there is no answer. */
export type ValidateAnswer =
  /** It answered. The body is whatever it said, unread. */
  | { readonly kind: "answered"; readonly status: number; readonly body: unknown }
  /** It did not answer, and this is what went wrong reaching it. */
  | { readonly kind: "unreachable"; readonly why: string };

/** The two things this command has to go outside for. */
export interface Reach {
  /** The public catalog of a running gateway, or a reason there is none. */
  readonly catalog: (baseUrl: string) => Promise<CatalogIdentifiers>;
  readonly validate: (resource: string, method: string) => Promise<ValidateAnswer>;
}

/** What one probe came to, in the three words that are actually different. */
type Verdict =
  | { readonly said: "valid" }
  | { readonly said: "invalid" }
  /** The endpoint did not give a verdict. This is not a failure of the resource. */
  | { readonly said: "no answer"; readonly why: string };

const USAGE = [
  "Usage: pnpm smoke:listing <base-url> [item-id ...]",
  "",
  "Asks the public CDP validation endpoint whether it would take this",
  "gateway's paid resources. With no item named it asks about every card in",
  "the public catalog.",
  "",
  "The gateway has to be reachable from the internet: the endpoint fetches",
  "the resource itself. A laptop is not reachable, and this command says so",
  "rather than reporting a pass it did not see.",
  "",
  "Nothing is spent. The endpoint is public, takes no key and moves no money.",
];

export async function runListingCheck(
  argv: readonly string[],
  reach: Reach,
  say: (line: string) => void,
): Promise<number> {
  const [baseUrl, ...named] = argv;

  if (baseUrl === undefined || baseUrl.trim() === "") {
    for (const line of USAGE) {
      say(line);
    }
    return 2;
  }

  const base = baseUrl.replace(/\/+$/, "");

  // The same mistake the gateway's own configuration refuses at start-up, for
  // the same reason: a path is joined onto this, so either one lands in the
  // middle of every resource address. Asking the endpoint about an address like
  // that would come back a refusal, and the refusal would read as though there
  // were something wrong with the product.
  for (const [mark, what] of [
    ["?", "query"],
    ["#", "fragment"],
  ] as const) {
    if (base.includes(mark)) {
      say(`${baseUrl} carries a ${what}, and a path is joined onto this address.`);
      say("Give the address the gateway answers at and nothing after it.");
      return 2;
    }
  }

  if (!base.toLowerCase().startsWith("https://")) {
    // Measured rather than read: put an http address to the endpoint and it
    // answers 400 with "doesn't match the regular expression ^https://.*$".
    // Said here so that a run against a sandbox is a sentence somebody
    // understands instead of two identical refusals with no verdict in them.
    // It is a warning and not a refusal: the endpoint's rules are the
    // endpoint's, and a run that asks and reports what came back is worth more
    // than one that decided in advance.
    say(`${base} is not an https address, and the endpoint only takes those.`);
    say("Expect no verdict. A listing needs a public https gateway.");
  }

  let items: readonly string[];

  if (named.length > 0) {
    items = named;
  } else {
    let catalog: CatalogIdentifiers;
    try {
      catalog = await reach.catalog(base);
    } catch (thrown) {
      say(`The catalog at ${base} could not be read: ${messageOf(thrown)}`);
      say("Nothing was checked.");
      return 1;
    }
    items = catalog.items.map((item) => item.id);
  }

  if (items.length === 0) {
    // Zero resources checked is not zero failures. A command that printed a
    // success here would be reporting on nothing at all, and the catalog is
    // empty exactly when every card is paused or none was ever published —
    // which is the state where somebody most needs to be told.
    say(`There is nothing on sale at ${base}, so there is nothing to check.`);
    return 1;
  }

  const failures: string[] = [];
  const silences: string[] = [];

  for (const itemId of items) {
    const resource = `${base}${expandPath(API_ROUTES.purchase_item.path, { item_id: itemId })}`;
    for (const method of PROBED_METHODS) {
      const answer = await reach.validate(resource, method);
      const verdict = verdictOf(answer);
      say("");
      say(`${method} ${resource}`);
      say(`  ${wordFor(verdict)}`);
      say(indented(answer));

      if (verdict.said === "invalid") {
        failures.push(`${method} ${resource}`);
      }
      if (verdict.said === "no answer") {
        silences.push(`${method} ${resource}: ${verdict.why}`);
      }
    }
  }

  say("");
  const probes = items.length * PROBED_METHODS.length;

  // The three outcomes are kept apart in the summary as well, because "we asked
  // and it said no" and "we never got an answer" want different next moves and
  // only one of them is about the resource.
  if (silences.length > 0) {
    say(`${silences.length} of ${probes} probes got no verdict, so nothing is proven about them:`);
    for (const silence of silences) {
      say(`  ${silence}`);
    }
  }
  if (failures.length > 0) {
    say(`${failures.length} of ${probes} probes were refused:`);
    for (const failure of failures) {
      say(`  ${failure}`);
    }
  }
  if (silences.length === 0 && failures.length === 0) {
    say(`All ${probes} probes over ${items.length} products were accepted.`);
    return 0;
  }
  return 1;
}

/**
 * What one answer means, and the reading is deliberately narrow.
 *
 * Only an answer that says `valid: true` in as many words is a pass. An answer
 * this cannot read is not a pass and it is not a failure of the resource
 * either: it is the endpoint not having told us, and it says so. The shape of
 * the body beyond that one field is not modelled anywhere here — it belongs to
 * somebody else and it changes when they change it, so it is printed whole for
 * a person to read rather than picked apart by us.
 */
function verdictOf(answer: ValidateAnswer): Verdict {
  if (answer.kind === "unreachable") {
    return { said: "no answer", why: answer.why };
  }
  if (answer.status !== 200) {
    return { said: "no answer", why: `the endpoint answered ${answer.status}` };
  }

  const body = answer.body;
  const valid =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).valid : undefined;

  if (valid === true) {
    return { said: "valid" };
  }
  if (valid === false) {
    return { said: "invalid" };
  }
  return { said: "no answer", why: "the answer carried no verdict this command could read" };
}

function wordFor(verdict: Verdict): string {
  switch (verdict.said) {
    case "valid":
      return "accepted";
    case "invalid":
      return "refused";
    case "no answer":
      return `no verdict — ${verdict.why}`;
  }
}

/** The answer whole, indented, for whoever is reading the terminal. */
function indented(answer: ValidateAnswer): string {
  const text =
    answer.kind === "unreachable" ? answer.why : (JSON.stringify(answer.body, null, 2) ?? "null");
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The real way out: one fetch for the catalog and one per probe.
 *
 * Everything that can go wrong on the way is turned into an answer rather than
 * thrown, so that one unreachable probe is one line in the report instead of
 * the end of the run — the operator wants to know which of their products the
 * catalog would take, not which one failed first.
 */
export const overTheNetwork = (): Reach => ({
  catalog: async (baseUrl) => {
    const at = `${baseUrl}${API_ROUTES.list_catalog.path}`;
    const answered = await fetch(at, { headers: { accept: "application/json" } });
    if (!answered.ok) {
      throw new Error(`${at} answered ${answered.status}`);
    }
    // Read for what this command needs and nothing else: the identifiers, so a
    // resource address can be built from each. Two mistakes are avoided at
    // once. Cast rather than read, an answer that is JSON and not a catalog —
    // a proxy, a login page, a maintenance stub answering for the gateway —
    // came out further down as a stack trace about a property of undefined,
    // and the sentence written for exactly that case never printed. Held to
    // the whole catalog document instead, this would refuse a good catalog
    // from a gateway newer than the copy it is run from: that document says in
    // its own words that it grows a paging field the day paging is designed,
    // and this command is run from somebody's local checkout against a
    // deployment that may be ahead of it. Then the report would say nothing
    // was checked, about a gateway that was working.
    return CATALOG_IDENTIFIERS.parse(await answered.json());
  },
  validate: async (resource, method) => {
    try {
      const answered = await fetch(VALIDATE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource, method }),
      });
      const text = await answered.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Kept as the text it was. An endpoint answering HTML is a thing that
        // happens, and "the answer would not parse" is a verdict of its own.
        body = text;
      }
      return { kind: "answered", status: answered.status, body };
    } catch (thrown) {
      return { kind: "unreachable", why: messageOf(thrown) };
    }
  },
});
