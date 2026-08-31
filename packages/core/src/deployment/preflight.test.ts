/**
 * The release refusing a channel that is not what it says it is.
 *
 * Everything here is text: the fixtures are what `docker compose config
 * --format json` printed for the two channels, and every case below is that
 * document with one thing changed. The doing — build, up, the curls against a
 * live host — is a shell script talking to one Docker daemon and is not
 * pretended about here.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ResolvedCompose } from "./preflight.d.mts";
import { problemsWith } from "./preflight.mjs";

const fixture = (name: string): ResolvedCompose =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const TEST_CHANNEL = fixture("test-channel");
const LIVE_CHANNEL = fixture("live-channel");

/** The release entry point, run in a separate Node process with controlled stdin. */
const runCli = (channel: string, input: string) =>
  spawnSync(process.execPath, [new URL("./preflight.mjs", import.meta.url).pathname, channel], {
    encoding: "utf8",
    input,
  });

/** Values a public preflight diagnostic must never repeat from a fixture. */
const expectNoFixtureSecrets = (stderr: string, resolved: ResolvedCompose): void => {
  const values = [
    resolved.services.gateway.environment?.SANDBOX_MERCHANT_KEY,
    resolved.services.gateway.environment?.REGISTRATION_INVITATION,
    resolved.services.gateway.environment?.CDP_API_KEY_ID,
    resolved.services.gateway.environment?.CDP_API_KEY_SECRET,
    resolved.services.cabinet.environment?.AUTH_SECRET,
  ];
  for (const value of values) {
    if (value !== undefined && value !== "") {
      expect(stderr).not.toContain(value);
    }
  }
};

/** The document with one service's one variable changed, or taken away. */
const withEnv = (
  resolved: ResolvedCompose,
  service: string,
  name: string,
  value: string | null,
): ResolvedCompose => {
  const next = structuredClone(resolved);
  const environment = next.services[service]?.environment;
  if (environment === undefined) {
    throw new Error(`the fixture has no ${service} service to change`);
  }
  if (value === null) {
    delete environment[name];
  } else {
    environment[name] = value;
  }
  return next;
};

describe("a channel that is what it claims to be", () => {
  it("passes the test channel", () => {
    expect(problemsWith("test", TEST_CHANNEL)).toEqual([]);
  });

  it("passes the live channel", () => {
    expect(problemsWith("live", LIVE_CHANNEL)).toEqual([]);
  });

  it("refuses each channel's configuration presented as the other", () => {
    // The negative control for the whole file: if this passed, every check
    // below would be reading something that is not the channel.
    expect(problemsWith("live", TEST_CHANNEL).length).toBeGreaterThan(0);
    expect(problemsWith("test", LIVE_CHANNEL).length).toBeGreaterThan(0);
  });
});

describe("the chain and the facilitator together", () => {
  // Prevents a public channel claiming settlement while its chain/facilitator pair cannot settle.
  it("refuses the test channel on the scripted facilitator", () => {
    const wrong = withEnv(TEST_CHANNEL, "gateway", "FACILITATOR_URL", "sandbox:scripted");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/FACILITATOR_URL/));
  });

  it("refuses the live channel on the public facilitator", () => {
    const wrong = withEnv(
      LIVE_CHANNEL,
      "gateway",
      "FACILITATOR_URL",
      "https://x402.org/facilitator",
    );
    expect(problemsWith("live", wrong)).toContainEqual(expect.stringMatching(/FACILITATOR_URL/));
  });

  it("refuses the live channel with either credential missing", () => {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) {
      const wrong = withEnv(LIVE_CHANNEL, "gateway", name, null);
      expect(problemsWith("live", wrong)).toContainEqual(expect.stringMatching(name));
    }
  });

  it("refuses a chain neither channel declared", () => {
    const wrong = withEnv(TEST_CHANNEL, "gateway", "PAYMENT_NETWORK", "eip155:11155111");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/PAYMENT_NETWORK/));
  });
});

describe("the surface mode agrees with the channel", () => {
  // Prevents payment pages asserting the opposite of the settlement environment.
  it("refuses a test stack telling readers it is live", () => {
    const wrong = withEnv(TEST_CHANNEL, "web", "COINSLOT_SURFACE_MODE", "live");
    expect(problemsWith("test", wrong)).toContainEqual(
      expect.stringMatching(/COINSLOT_SURFACE_MODE/),
    );
  });

  it("refuses a live stack telling readers it is a sandbox", () => {
    const wrong = withEnv(LIVE_CHANNEL, "web", "COINSLOT_SURFACE_MODE", "sandbox");
    expect(problemsWith("live", wrong)).toContainEqual(
      expect.stringMatching(/COINSLOT_SURFACE_MODE/),
    );
  });
});

describe("the cabinet was handed the gateway's pair", () => {
  // Prevents a cabinet describing another settlement path than the gateway executes.
  it("refuses a cabinet on a different facilitator from its gateway", () => {
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "FACILITATOR_URL", "sandbox:scripted");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/cabinet/));
  });

  it("refuses a cabinet on a different chain from its gateway", () => {
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "PAYMENT_NETWORK", "eip155:8453");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/cabinet/));
  });

  it("refuses a cabinet whose public origin does not name the gateway's door", () => {
    // Prevents a merchant who signed into the cabinet being sent to a different public site.
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "PUBLIC_BASE_URL", "http://localhost:8080");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/PUBLIC_BASE_URL/));
  });
});

describe("the mock merchant is not among the services", () => {
  // Prevents the laptop fixture catalog from blocking or contaminating a public deployment.
  it("refuses a configuration where the profile was edited away", () => {
    const wrong = structuredClone(TEST_CHANNEL);
    wrong.services.merchant = { image: "coinslot-app" };
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/merchant/));
  });
});

describe("no laptop default survived", () => {
  // Prevents public exposure of a database, published defaults, and a dead public door.
  it("refuses PostgreSQL published to the host", () => {
    const wrong = structuredClone(TEST_CHANNEL);
    wrong.services.postgres.ports = [
      { mode: "ingress", target: 5432, published: "5432", protocol: "tcp" },
    ];
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/postgres/));
  });

  it("refuses the seeded key written in this repository", () => {
    const wrong = withEnv(
      TEST_CHANNEL,
      "gateway",
      "SANDBOX_MERCHANT_KEY",
      "csk_test_local-sandbox-merchant-key",
    );
    expect(problemsWith("test", wrong)).toContainEqual(
      expect.stringMatching(/SANDBOX_MERCHANT_KEY/),
    );
  });

  it("refuses a stack with no seeded key at all", () => {
    const wrong = withEnv(TEST_CHANNEL, "gateway", "SANDBOX_MERCHANT_KEY", "");
    expect(problemsWith("test", wrong)).toContainEqual(
      expect.stringMatching(/SANDBOX_MERCHANT_KEY/),
    );
  });

  it("refuses the cabinet's signing secret written in this repository", () => {
    const wrong = withEnv(
      TEST_CHANNEL,
      "cabinet",
      "AUTH_SECRET",
      "a-sandbox-secret-nobody-should-reuse-anywhere",
    );
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/AUTH_SECRET/));
  });

  it("refuses the registration invitation written in this repository", () => {
    const wrong = withEnv(
      TEST_CHANNEL,
      "gateway",
      "REGISTRATION_INVITATION",
      "register-on-this-laptop",
    );
    expect(problemsWith("test", wrong)).toContainEqual(
      expect.stringMatching(/REGISTRATION_INVITATION/),
    );
  });

  it("takes an invitation set to nothing, which is a stack that takes no registrations", () => {
    const closed = withEnv(LIVE_CHANNEL, "gateway", "REGISTRATION_INVITATION", "");
    expect(problemsWith("live", closed)).toEqual([]);
  });

  it("refuses a cookie that is not marked Secure", () => {
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "COOKIE_SECURE", "false");
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/COOKIE_SECURE/));
  });

  it("refuses the wrong public origin, Caddy address or published port", () => {
    expect(
      problemsWith(
        "test",
        withEnv(TEST_CHANNEL, "gateway", "PUBLIC_BASE_URL", "http://localhost:8080"),
      ),
    ).toContainEqual(expect.stringMatching(/PUBLIC_BASE_URL/));

    expect(
      problemsWith("test", withEnv(TEST_CHANNEL, "web", "COINSLOT_SITE_ADDRESS", ":8080")),
    ).toContainEqual(expect.stringMatching(/COINSLOT_SITE_ADDRESS/));

    const wrongPort = structuredClone(TEST_CHANNEL);
    wrongPort.services.web.ports = [
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "443", protocol: "tcp" },
    ];
    expect(problemsWith("test", wrongPort)).toContainEqual(expect.stringMatching(/8443/));
  });

  it("refuses a published port that forwards to a container port with nothing on it", () => {
    const wrongTarget = structuredClone(TEST_CHANNEL);
    wrongTarget.services.web.ports = [
      { mode: "ingress", host_ip: "10.20.10.20", target: 8080, published: "8443", protocol: "tcp" },
    ];
    expect(problemsWith("test", wrongTarget)).toContainEqual(expect.stringMatching(/8443/));
  });

  it("refuses a door open on every interface of the host", () => {
    const everywhere = structuredClone(TEST_CHANNEL);
    everywhere.services.web.ports = [
      { mode: "ingress", target: 443, published: "8443", protocol: "tcp" },
    ];
    expect(problemsWith("test", everywhere)).toContainEqual(expect.stringMatching(/8443/));
  });

  it("refuses two otherwise correct public bindings", () => {
    // Prevents a release from publishing a second public door that the edge never owns.
    const wrong = structuredClone(TEST_CHANNEL);
    wrong.services.web.ports = [
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "8443", protocol: "tcp" },
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "8443", protocol: "tcp" },
    ];
    expect(problemsWith("test", wrong)).toContainEqual(expect.stringMatching(/8443/));
  });
});

describe("the release entry point", () => {
  it("refuses an unknown channel without starting a release", () => {
    // Prevents a typo from being treated as a valid channel with a guessed policy.
    const result = runCli("preview", JSON.stringify(TEST_CHANNEL));
    expect(result.status).toBe(65);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("preview is not a release channel");
  });

  it("refuses a cabinet public origin that diverges from the gateway", () => {
    // Deleting the cabinet origin check would send a signed-in merchant to the wrong public door.
    const wrong = withEnv(TEST_CHANNEL, "cabinet", "PUBLIC_BASE_URL", "http://localhost:8080");
    const result = runCli("test", JSON.stringify(wrong));
    const stderr = result.stderr ?? "";
    expect(result.status).toBe(65);
    expect(result.stdout ?? "").toBe("");
    expect(stderr).toContain("cabinet: PUBLIC_BASE_URL");
    expectNoFixtureSecrets(stderr, TEST_CHANNEL);
  });

  it("refuses two otherwise valid public bindings", () => {
    // Deleting the one-binding rule would publish a second public door outside the edge contract.
    const wrong = structuredClone(TEST_CHANNEL);
    wrong.services.web.ports = [
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "8443", protocol: "tcp" },
      { mode: "ingress", host_ip: "10.20.10.20", target: 443, published: "8443", protocol: "tcp" },
    ];
    const result = runCli("test", JSON.stringify(wrong));
    const stderr = result.stderr ?? "";
    expect(result.status).toBe(65);
    expect(result.stdout ?? "").toBe("");
    expect(stderr).toContain("web: the published bindings");
    expectNoFixtureSecrets(stderr, TEST_CHANNEL);
  });

  it("refuses malformed JSON without printing input", () => {
    // Prevents a parser diagnostic from copying a credential fragment into the release log.
    const sentinel = "synthetic-credential-fragment";
    const result = runCli("live", `{"credential":"${sentinel}"`);
    expect(result.status).toBe(65);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("preflight: the resolved configuration did not read as JSON\n");
    expect(result.stderr).not.toContain(sentinel);
  });
});
