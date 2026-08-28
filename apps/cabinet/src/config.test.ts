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

  it("starts with no merchant key anywhere in its environment", () => {
    // ADR-0014 §2: the key comes off the row of whoever is signed in, so there
    // is no key in the configuration at all. A cabinet that still refused to
    // start without one would be a deployment that cannot be brought up until
    // somebody sets a variable nothing reads — and, worse, one whose operator
    // reasonably believes that variable is what the screens are drawn with.
    expect(loadConfig(given()).gatewayUrl).toBe("http://localhost:3000");
    expect(Object.keys(loadConfig(given()))).not.toContain("merchantApiKey");
  });

  it("does not refuse a key it is handed anyway, because it is not its business", () => {
    // A deployment that has not had the variable taken out of its compose file
    // yet must still come up. What used to be checked here — a floor under the
    // key's length — is checked where a key is now taken in, which is the
    // command that makes an account.
    expect(() => loadConfig(given({ MERCHANT_API_KEY: "short" }))).not.toThrow();
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

describe("where the cabinet's two messages go", () => {
  it("sends nothing anywhere unless a deployment says where", () => {
    // The whole flow — registering, confirming, losing a password — walks on a
    // laptop with no provider account, no domain and no network, because the
    // sandbox word writes every message to the log instead of sending it.
    expect(loadConfig(given()).mailUrl).toBe("sandbox:log");
  });

  it("refuses a real credential beside the word that means nothing is sent", () => {
    // The mistake worth catching is a production environment file copied onto a
    // sandbox. A credential exists only to talk to a provider, so beside an
    // address that sends nothing it is somebody's leftovers rather than a
    // choice — and left unnoticed it sits there until one other line changes.
    expect(() => loadConfig(given({ MAIL_API_KEY: "re_a_real_looking_key" }))).toThrow(
      /MAIL_API_KEY/,
    );
  });

  it("refuses a provider it could not authenticate against, or send from", () => {
    // A cabinet that appears to send mail and silently does not is discovered
    // by a merchant who has lost a password and is waiting for a link that was
    // never accepted.
    expect(() =>
      loadConfig(
        given({
          MAIL_URL: "https://api.resend.com",
          MAIL_FROM: "Coinslot <no-reply@mail.example.com>",
          PUBLIC_BASE_URL: "https://coinslot.example.com",
        }),
      ),
    ).toThrow(/MAIL_API_KEY/);
    expect(() =>
      loadConfig(
        given({
          MAIL_URL: "https://api.resend.com",
          MAIL_API_KEY: "re_a_real_looking_key",
          PUBLIC_BASE_URL: "https://coinslot.example.com",
        }),
      ),
    ).toThrow(/MAIL_FROM/);
  });

  it("refuses to send real mail whose links point at the reader's own computer", () => {
    // The public address defaults to a laptop so that the cabinet runs with
    // nothing set. A deployment that turns mail on and leaves it there would
    // send every merchant a link into their own machine, and the merchant
    // reading it would have no way of knowing that is what happened.
    expect(() =>
      loadConfig(
        given({
          MAIL_URL: "https://api.resend.com",
          MAIL_API_KEY: "re_a_real_looking_key",
          MAIL_FROM: "Coinslot <no-reply@mail.example.com>",
        }),
      ),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it("takes a provider that is set up properly", () => {
    const config = loadConfig(
      given({
        MAIL_URL: "https://api.resend.com",
        MAIL_API_KEY: "re_a_real_looking_key",
        MAIL_FROM: "Coinslot <no-reply@mail.example.com>",
        PUBLIC_BASE_URL: "https://coinslot.example.com/",
      }),
    );

    expect(config.mailUrl).toBe("https://api.resend.com");
    // The trailing slash comes off, because a path is joined onto this and two
    // slashes in the middle of a link is a link somebody has to think about.
    expect(config.publicBaseUrl).toBe("https://coinslot.example.com");
  });
});

describe("what the configuration says about itself", () => {
  it("does not put the database password into the sentence it throws", () => {
    // The startup failure goes to a log, and a log goes places the environment
    // does not. A message quoting the value that was wrong would carry the one
    // secret left in this file into every one of them.
    const thrown = (): string => {
      try {
        loadConfig({
          ...given({ PORT: "no" }),
          DATABASE_URL: "postgres://coinslot:s3cret-database-password@postgres:5432/coinslot",
        });
        return "";
      } catch (error) {
        return String(error);
      }
    };

    const said = thrown();
    expect(said).toContain("PORT");
    expect(said).not.toContain("s3cret-database-password");
  });
});
