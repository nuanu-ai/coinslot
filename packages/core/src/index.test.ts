import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import { assertNever } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("@coinslot/core", () => {
  it("stops the work on an unhandled variant and names it", () => {
    // We fool the types exactly the way life does: the value arrived from the
    // database, and the case analysis knows nothing about it. The core's
    // promise is a visible refusal instead of quietly carrying on with an
    // order nobody handled.
    const fromDatabase = "refunded" as never;

    expect(() => assertNever(fromDatabase, "order status")).toThrowError(/order status/);
    expect(() => assertNever(fromDatabase, "order status")).toThrowError(/refunded/);
  });

  it("drags in not a single runtime dependency", () => {
    // The core is pure logic: it can be run in a test, in a script and in
    // someone else's environment without installing anything at all
    // (ADR-0003 §2).
    expect(manifest.dependencies ?? {}).toStrictEqual({});
  });

  it("hands the gateway everything it needs to run an order, and nothing more", () => {
    // Two ways to fail, and the second is why this is an equality rather than a
    // loop of `typeof`. A name missing means the gateway is reaching into the
    // package's internals for something that was meant to be on the surface. A
    // name that is here and not below means a function nobody outside this
    // package calls, and every one of those is surface a stranger's engineer is
    // now obliged to read. `effectsOnQuoted` and `isArmed` sat there for a
    // while, and the comment that used to be here explained them instead of
    // taking them off — so the rule is a machine now.
    const called = [
      "createOrder",
      "transition",
      "deadlines",
      // Read by the gateway when it decides whether another delivery attempt
      // could still land in time.
      "fulfillmentDeadline",
      "nextRedelivery",
      "outcomeFor",
      "moneyInvariantViolations",
      "modeOf",
      "isOpen",
      "assertNever",
    ];
    const exported = Object.entries(core)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);

    expect(exported.sort()).toStrictEqual([...called].sort());
  });

  it("keeps its own test fixtures to itself", () => {
    // An order is built out of a real purchase. A builder that quietly guesses
    // its defaults belongs in the tests and nowhere near the gateway.
    for (const name of ["newOrder", "createInput", "reach", "walk", "must", "TEST_POLICY"]) {
      expect((core as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});
