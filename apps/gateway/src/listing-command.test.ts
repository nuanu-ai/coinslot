/**
 * The listing check, tested without the network.
 *
 * There is one promise here worth more than the rest, and it is not about the
 * catalog: the command must never report a pass it did not see. A probe that
 * was refused, a probe whose endpoint never answered and a probe that came back
 * with something nobody can read are three different things, and only one of
 * them is a resource that is wrong. Folded together, the last two would print
 * as a green tick over a validation that never happened — which is exactly the
 * claim this command exists to make and therefore the one it must never fake.
 *
 * The live call is `pnpm smoke:listing`. Nothing here goes near it.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CatalogPage } from "@coinslot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  overTheNetwork,
  type Reach,
  runListingCheck,
  type ValidateAnswer,
} from "./listing-command.js";

const card = (id: string): CatalogPage["items"][number] => ({
  id,
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  as_of: "2026-08-27T09:00:00Z",
  result: { access_code: { type: "string" } },
  price_checked_at_purchase: false,
  fulfillment: "sync",
});

/** A run: what the two ways out answered, and everything the command said. */
function aRun(options: {
  readonly catalog?: CatalogPage | Error;
  readonly answers?: (resource: string, method: string) => ValidateAnswer;
}) {
  const asked: string[] = [];
  const said: string[] = [];
  const reach: Reach = {
    catalog: async () => {
      const held = options.catalog ?? { items: [card("itm_1")] };
      if (held instanceof Error) throw held;
      return held;
    },
    validate: async (resource, method) => {
      asked.push(`${method} ${resource}`);
      return options.answers?.(resource, method) ?? { kind: "answered", status: 200, body: {} };
    },
  };
  const run = (...argv: string[]) => runListingCheck(argv, reach, (line) => said.push(line));
  return { run, asked, text: () => said.join("\n") };
}

const accepted: ValidateAnswer = {
  kind: "answered",
  status: 200,
  body: { valid: true, checks: [{ name: "resource.reachable", passed: true }] },
};

describe("asking the catalog whether it would take our resources", () => {
  it("asks about every card on sale, on both methods, at the address the catalog names", async () => {
    // Both methods, because they carry different declarations: a crawler probes
    // with GET and an agent buys with POST. Checking one leaves the other
    // unproven, and that asymmetry is what made a resource invisible once.
    const run = aRun({
      catalog: { items: [card("itm_1"), card("itm_2")] },
      answers: () => accepted,
    });

    expect(await run.run("https://coinslot.example")).toBe(0);
    expect(run.asked).toStrictEqual([
      "GET https://coinslot.example/v0/items/itm_1/purchase",
      "POST https://coinslot.example/v0/items/itm_1/purchase",
      "GET https://coinslot.example/v0/items/itm_2/purchase",
      "POST https://coinslot.example/v0/items/itm_2/purchase",
    ]);
    expect(run.text()).toContain("All 4 probes over 2 products were accepted.");
  });

  it("asks about the products it was named rather than the whole catalog", async () => {
    const run = aRun({ answers: () => accepted });

    expect(await run.run("https://coinslot.example", "itm_9")).toBe(0);
    expect(run.asked).toStrictEqual([
      "GET https://coinslot.example/v0/items/itm_9/purchase",
      "POST https://coinslot.example/v0/items/itm_9/purchase",
    ]);
  });

  it("does not let a trailing slash make a second address for one product", async () => {
    // The address is the identity of a listing. Two spellings would be two
    // listings for one product, and a validation of one says nothing about the
    // other.
    const run = aRun({ answers: () => accepted });

    await run.run("https://coinslot.example/", "itm_9");

    expect(run.asked[0]).toBe("GET https://coinslot.example/v0/items/itm_9/purchase");
  });

  it("reports a refusal as a refusal and prints what was said", async () => {
    const run = aRun({
      answers: () => ({
        kind: "answered",
        status: 200,
        body: { valid: false, checks: [{ name: "bazaar.schema", passed: false }] },
      }),
    });

    expect(await run.run("https://coinslot.example")).toBe(1);
    expect(run.text()).toContain("refused");
    expect(run.text()).toContain("2 of 2 probes were refused");
    // The endpoint's own words, whole. What it checks is theirs and changes
    // when they change it, so nothing here picks the answer apart.
    expect(run.text()).toContain("bazaar.schema");
  });

  it("says nothing was proven when the endpoint could not be reached", async () => {
    // Not a failure of the resource, and not a pass. The distinction is the
    // whole point: from a laptop the gateway is not reachable from the
    // internet, and a run that printed a tick here would be the clearest
    // possible claim beyond the evidence.
    const run = aRun({
      answers: () => ({ kind: "unreachable", why: "fetch failed: ENOTFOUND" }),
    });

    expect(await run.run("https://coinslot.example")).toBe(1);
    expect(run.text()).toContain("no verdict");
    expect(run.text()).toContain("2 of 2 probes got no verdict, so nothing is proven about them");
    expect(run.text()).not.toContain("accepted");
    expect(run.text()).not.toContain("refused");
  });

  it("says nothing was proven when the endpoint answered something else", async () => {
    const run = aRun({
      answers: () => ({ kind: "answered", status: 503, body: "<html>upstream</html>" }),
    });

    expect(await run.run("https://coinslot.example")).toBe(1);
    expect(run.text()).toContain("the endpoint answered 503");
    expect(run.text()).not.toContain("were accepted");
  });

  it("says nothing was proven when the answer carries no verdict it can read", async () => {
    // The body belongs to somebody else and changes when they change it. An
    // answer this cannot read is a reason to go and look, not a pass.
    const run = aRun({
      answers: () => ({ kind: "answered", status: 200, body: { status: "ok" } }),
    });

    expect(await run.run("https://coinslot.example")).toBe(1);
    expect(run.text()).toContain("no verdict");
  });

  it("does not read a truthy answer as a true one", async () => {
    // `valid: "true"` is a string, and a lenient reading of it would turn an
    // endpoint change into a silent pass.
    const run = aRun({
      answers: () => ({ kind: "answered", status: 200, body: { valid: "true" } }),
    });

    expect(await run.run("https://coinslot.example")).toBe(1);
  });

  it("keeps a refusal and a silence apart in the same run", async () => {
    const run = aRun({
      answers: (_resource, method) =>
        method === "GET"
          ? { kind: "answered", status: 200, body: { valid: false } }
          : { kind: "unreachable", why: "timed out" },
    });

    expect(await run.run("https://coinslot.example")).toBe(1);
    expect(run.text()).toContain("1 of 2 probes got no verdict");
    expect(run.text()).toContain("1 of 2 probes were refused");
  });

  it("reports an empty catalog as nothing checked rather than as nothing wrong", async () => {
    // Zero resources checked is not zero failures. An empty catalog is exactly
    // the state where every card is paused or none was ever published, and the
    // person running this most needs to be told.
    const run = aRun({ catalog: { items: [] } });

    expect(await run.run("https://coinslot.example")).toBe(1);
    expect(run.text()).toContain("nothing to check");
    expect(run.asked).toStrictEqual([]);
  });

  it("reports a catalog it could not read rather than checking nothing quietly", async () => {
    const run = aRun({ catalog: new Error("connect ECONNREFUSED") });

    expect(await run.run("https://coinslot.example")).toBe(1);
    expect(run.text()).toContain("ECONNREFUSED");
    expect(run.text()).toContain("Nothing was checked.");
  });

  it("refuses a base address carrying a query or a fragment rather than probing it", async () => {
    // The same mistake the gateway's own configuration refuses at start-up. A
    // path is joined onto this string, so either one lands in the middle of
    // every resource address, which answers nothing — and asking about that
    // address would produce a refusal that reads as though the product were
    // wrong.
    const run = aRun({ answers: () => accepted });

    expect(await run.run("https://coinslot.example/?utm=abc")).toBe(2);
    expect(run.text()).toContain("query");
    expect(run.asked).toStrictEqual([]);

    const hashed = aRun({ answers: () => accepted });
    expect(await hashed.run("https://coinslot.example/#top")).toBe(2);
    expect(hashed.text()).toContain("fragment");
    expect(hashed.asked).toStrictEqual([]);
  });

  it("says up front that an address which is not https will get no verdict", async () => {
    // Measured against the live endpoint: it refuses an http resource outright
    // with a 400 and no verdict. Without this line a run against the local
    // sandbox is two identical refusals and no explanation.
    const run = aRun({ answers: () => accepted });

    await run.run("http://localhost:3000", "itm_1");

    expect(run.text()).toContain("not an https address");
    // A warning and not a refusal: it still asks, and still reports what it got.
    expect(run.asked).toHaveLength(2);
  });

  it("says nothing of the kind about an https address", async () => {
    const run = aRun({ answers: () => accepted });

    await run.run("https://coinslot.example", "itm_1");

    expect(run.text()).not.toContain("not an https address");
  });

  it("asks for an address rather than guessing at one", async () => {
    const run = aRun({});

    expect(await run.run()).toBe(2);
    expect(run.text()).toContain("pnpm smoke:listing");
    expect(run.asked).toStrictEqual([]);
  });
});

describe("reading a running gateway's catalog, over a real socket", () => {
  /**
   * Everything above fakes the way out, which leaves the one part that talks to
   * a gateway untested: what it accepts, and what it prints when the answer is
   * not a catalog. This serves the answers over a real socket instead. It is
   * still offline — the server is this process — and the validation endpoint is
   * never called, because every card here fails to be read before any probe.
   */
  let server: Server | null = null;

  const serving = async (answer: {
    readonly status?: number;
    readonly body: string;
    readonly type?: string;
  }): Promise<string> => {
    server = createServer((_request, response) => {
      response.writeHead(answer.status ?? 200, {
        "content-type": answer.type ?? "application/json",
      });
      response.end(answer.body);
    });
    await new Promise<void>((ready) => server?.listen(0, "127.0.0.1", ready));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  };

  afterEach(async () => {
    await new Promise<void>((closed) => {
      if (server === null) return closed();
      server.close(() => closed());
    });
    server = null;
  });

  const card = (id: string) => ({
    id,
    title: "A room for the night",
    description: "One night in room 101",
    price: { amount: "80.00", currency: "USD" },
    as_of: "2026-08-27T09:00:00Z",
    result: { access_code: { type: "string" } },
    price_checked_at_purchase: false,
    fulfillment: "sync",
  });

  /** The command with the real way out, and everything it said. */
  const run = async (base: string) => {
    const said: string[] = [];
    const code = await runListingCheck([base], overTheNetwork(), (line) => said.push(line));
    return { code, text: said.join("\n") };
  };

  it("takes the identifiers out of a catalog it can read", async () => {
    const base = await serving({ body: JSON.stringify({ items: [card("itm_1")] }) });

    const { text } = await run(base);

    // It got as far as probing, which is all this can show without the network:
    // the identifier reached the address a probe is built from.
    expect(text).toContain(`${base}/v0/items/itm_1/purchase`);
    expect(text).not.toContain("could not be read");
  });

  it("reads a catalog from a gateway newer than this checkout", async () => {
    // The one this was getting wrong. The catalog document says in its own
    // description that it grows a paging field the day paging is designed, and
    // this command runs from somebody's local copy against a deployment that
    // may be ahead of it. Held to the whole document, a good catalog from a
    // newer gateway would be refused with a list of complaints about fields
    // this copy has never heard of — and the command would report that it
    // checked nothing, about a gateway that was working.
    const base = await serving({
      body: JSON.stringify({
        items: [{ ...card("itm_1"), badges: ["new"] }],
        next_page: "cursor-42",
      }),
    });

    const { text } = await run(base);

    expect(text).toContain(`${base}/v0/items/itm_1/purchase`);
    expect(text).not.toContain("could not be read");
  });

  it("says what it could not read when something else answers instead", async () => {
    // A proxy, a login page, a maintenance stub — anything in front of the
    // gateway answering for it. The sentence is the point: without it this came
    // out as a stack trace about a property of undefined.
    const base = await serving({ body: JSON.stringify({ error: "unauthorized" }) });

    const { code, text } = await run(base);

    expect(code).toBe(1);
    expect(text).toContain("could not be read");
    expect(text).toContain("Nothing was checked.");
  });

  it("says so when the answer is not JSON at all", async () => {
    const base = await serving({ body: "<html>maintenance</html>", type: "text/html" });

    const { code, text } = await run(base);

    expect(code).toBe(1);
    expect(text).toContain("could not be read");
  });

  it("names the status when the gateway refuses the catalog", async () => {
    const base = await serving({ status: 503, body: JSON.stringify({ items: [] }) });

    const { code, text } = await run(base);

    expect(code).toBe(1);
    expect(text).toContain("503");
    expect(text).toContain("Nothing was checked.");
  });
});
