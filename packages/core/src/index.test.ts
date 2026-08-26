import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});
