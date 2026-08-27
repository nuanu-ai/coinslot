/**
 * The configuration, which is an external boundary like any other.
 *
 * Only the values that decide where a merchant's browser is sent, or that the
 * cabinet cannot work at all without, are checked here. A wrong port fails
 * loudly on the first request; a wrong mount point fails quietly, by pointing
 * every link and every redirect at somewhere the cabinet is not.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

/** What a deployment has to set for the cabinet to be able to do anything. */
const REQUIRED = {
  DATABASE_URL: "postgres://coinslot:coinslot@postgres:5432/coinslot",
  MERCHANT_API_KEY: "a-merchant-key-long-enough",
};

const given = (environment: Record<string, string> = {}): Record<string, string> => ({
  ...REQUIRED,
  ...environment,
});

describe("what the cabinet will not start without", () => {
  it("refuses to start with no database to keep its accounts and sessions in", async () => {
    // ADR-0009 puts the people who sign in, and their sessions, in rows. With
    // no database there is nowhere to look one up, so every visitor would be a
    // stranger — a cabinet that renders a sign-in form and can never accept one.
    const { DATABASE_URL: _absent, ...withoutDatabase } = given();

    expect(() => loadConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it("refuses to start with no merchant key to reach the gateway with", async () => {
    // The key comes from the cabinet's own configuration now rather than out of
    // a visitor's cookie (ADR-0009 §4). Without one, every screen is a 401 that
    // no password can fix.
    const { MERCHANT_API_KEY: _absent, ...withoutKey } = given();

    expect(() => loadConfig(withoutKey)).toThrow(/MERCHANT_API_KEY/);
  });

  it("refuses a merchant key short enough to guess", () => {
    // The same floor the gateway holds its own key to. The comparison at the
    // other end is constant-time over equal lengths, and a key short enough to
    // walk through makes that care pointless.
    expect(() => loadConfig(given({ MERCHANT_API_KEY: "short" }))).toThrow(/MERCHANT_API_KEY/);
  });
});

describe("where the cabinet thinks it is mounted", () => {
  it("takes a path, and takes being at the root of its origin", () => {
    expect(loadConfig(given()).basePath).toBe("");
    expect(loadConfig(given({ BASE_PATH: "/cabinet" })).basePath).toBe("/cabinet");
  });

  it("refuses a value that would send every link to another host", () => {
    // "//evil.com" is a path to a regular expression and a protocol-relative
    // URL to a browser. Accepted, every redirect leaves the origin and every
    // stylesheet link points at somebody else's server — with a merchant's
    // session cookie riding along on the redirect they follow.
    // Both spellings. The URL standard treats a backslash after the first
    // slash exactly as a second slash, so `new URL("/\\evil.com", origin)`
    // resolves to https://evil.com/ in every browser — a lookahead that only
    // covered "/" left the same hole open under a different character.
    for (const bad of ["//evil.com", "//evil.com/cabinet", "/\\evil.com", "/\\\\evil.com"]) {
      expect(() => loadConfig(given({ BASE_PATH: bad })), bad).toThrow(/BASE_PATH/);
    }
    expect(new URL("/\\evil.com", "https://cabinet.example/").host).toBe("evil.com");
  });

  it("refuses a mount point that is not one", () => {
    // A trailing slash would double up against every path built from it, a
    // query or a fragment is not a mount point at all, and a bare word is a
    // relative path that means something different on every page.
    for (const bad of ["/cabinet/", "cabinet", "/cab inet", "/cabinet?x=1", "/cabinet#top"]) {
      expect(() => loadConfig(given({ BASE_PATH: bad })), bad).toThrow(/BASE_PATH/);
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
    expect(said).toContain("DATABASE_URL");
    expect(said).toContain("MERCHANT_API_KEY");
  });

  it("does not leave a double slash in front of every call it makes", () => {
    // The contract's paths all begin with a slash, so a gateway address that
    // ends with one produces "//v0/cards" — which some proxies route somewhere
    // else entirely and others refuse.
    expect(loadConfig(given({ GATEWAY_URL: "http://gateway:3000/" })).gatewayUrl).toBe(
      "http://gateway:3000",
    );
  });
});

describe("what the configuration says about itself", () => {
  it("does not put the merchant key or the database password into the sentence it throws", () => {
    // The startup failure goes to a log, and a log goes places the environment
    // does not. A message quoting the value that was wrong would carry the two
    // secrets in this file into every one of them.
    const thrown = (): string => {
      try {
        loadConfig({
          ...given({ PORT: "no" }),
          DATABASE_URL: "postgres://coinslot:s3cret-database-password@postgres:5432/coinslot",
          MERCHANT_API_KEY: "a-very-secret-merchant-key",
        });
        return "";
      } catch (error) {
        return String(error);
      }
    };

    const said = thrown();
    expect(said).toContain("PORT");
    expect(said).not.toContain("s3cret-database-password");
    expect(said).not.toContain("a-very-secret-merchant-key");
  });
});
