/**
 * The configuration, which is an external boundary like any other.
 *
 * Only the values that decide where a merchant's browser is sent are checked
 * here. A wrong port fails loudly on the first request; a wrong mount point
 * fails quietly, by pointing every link and every redirect at somewhere the
 * cabinet is not.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("where the cabinet thinks it is mounted", () => {
  it("takes a path, and takes being at the root of its origin", () => {
    expect(loadConfig({}).basePath).toBe("");
    expect(loadConfig({ BASE_PATH: "/cabinet" }).basePath).toBe("/cabinet");
  });

  it("refuses a value that would send every link to another host", () => {
    // "//evil.com" is a path to a regular expression and a protocol-relative
    // URL to a browser. Accepted, every redirect leaves the origin and every
    // stylesheet link points at somebody else's server — with a merchant's
    // session cookie riding along on the redirect they follow.
    expect(() => loadConfig({ BASE_PATH: "//evil.com" })).toThrow(/BASE_PATH/);
    expect(() => loadConfig({ BASE_PATH: "//evil.com/cabinet" })).toThrow(/BASE_PATH/);
  });

  it("refuses a mount point that is not one", () => {
    // A trailing slash would double up against every path built from it, a
    // query or a fragment is not a mount point at all, and a bare word is a
    // relative path that means something different on every page.
    for (const bad of ["/cabinet/", "cabinet", "/cab inet", "/cabinet?x=1", "/cabinet#top"]) {
      expect(() => loadConfig({ BASE_PATH: bad }), bad).toThrow(/BASE_PATH/);
    }
  });

  it("names every problem at once rather than one per restart", () => {
    // The engineer bringing the cabinet up learns the whole list in one go.
    const thrown = (): string => {
      try {
        loadConfig({ BASE_PATH: "//evil.com", PORT: "no", GATEWAY_URL: "not a url" });
        return "";
      } catch (error) {
        return String(error);
      }
    };

    const said = thrown();
    expect(said).toContain("BASE_PATH");
    expect(said).toContain("PORT");
    expect(said).toContain("GATEWAY_URL");
  });

  it("does not leave a double slash in front of every call it makes", () => {
    // The contract's paths all begin with a slash, so a gateway address that
    // ends with one produces "//v0/cards" — which some proxies route somewhere
    // else entirely and others refuse.
    expect(loadConfig({ GATEWAY_URL: "http://gateway:3000/" }).gatewayUrl).toBe(
      "http://gateway:3000",
    );
  });
});
