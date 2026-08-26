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

  it("hands the gateway everything it needs to run an order", () => {
    // If this failed, the gateway would be reaching into the package's
    // internals for something the package meant to be part of its surface.
    for (const name of [
      "createOrder",
      "transition",
      "deadlines",
      "nextRedelivery",
      "outcomeFor",
      "moneyInvariantViolations",
      "modeOf",
      "isOpen",
      "assertNever",
    ]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("keeps its own test fixtures to itself", () => {
    // An order is built out of a real purchase. A builder that quietly guesses
    // its defaults belongs in the tests and nowhere near the gateway.
    for (const name of ["newOrder", "createInput", "reach", "walk", "must", "TEST_POLICY"]) {
      expect((core as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});
