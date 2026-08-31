/**
 * What a release channel has to be before anything starts.
 *
 * It reads one document — `docker compose config --format json`, which
 * resolves every variable without starting a container — and answers with a
 * list of everything wrong with it. Deterministic logic over text, which is
 * why it is here and tested rather than inside the shell script that runs it.
 *
 * The last group is a list of equality checks against values anybody can read
 * in `compose.yaml`. It prints no secret and asserts nothing about strength —
 * only that the string in front of it is not the one we published to the
 * world. It stops there deliberately: whether the live site is open to
 * registrations is the operator's line in a file, and a release that tracked
 * whether the first sale had happened yet, in order to permit or forbid that
 * line, would be a state machine about our own intentions rather than a check
 * on a configuration.
 */

/** What each channel declares itself to be. */
const CHANNELS = {
  test: {
    network: "eip155:84532",
    facilitator: "https://x402.org/facilitator",
    surfaceMode: "test",
    origin: "https://test.coinslot.nuanu.ai",
    siteAddress: "test.coinslot.nuanu.ai",
    hostIp: "10.20.10.20",
    publishedPort: "8443",
    credentials: false,
  },
  live: {
    network: "eip155:8453",
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    surfaceMode: "live",
    origin: "https://coinslot.nuanu.ai",
    siteAddress: "coinslot.nuanu.ai",
    hostIp: "10.20.10.20",
    publishedPort: "443",
    credentials: true,
  },
};

/** The strings this repository publishes to the world. None may be deployed. */
const WRITTEN_IN_THIS_REPOSITORY = {
  SANDBOX_MERCHANT_KEY: "csk_test_local-sandbox-merchant-key",
  AUTH_SECRET: "a-sandbox-secret-nobody-should-reuse-anywhere",
  REGISTRATION_INVITATION: "register-on-this-laptop",
};

const envOf = (resolved, service) => resolved.services?.[service]?.environment ?? {};

export function problemsWith(channel, resolved) {
  const wanted = CHANNELS[channel];
  if (wanted === undefined) {
    return [`${channel} is not a release channel; the channels are test and live`];
  }

  const problems = [];
  const gateway = envOf(resolved, "gateway");
  const cabinet = envOf(resolved, "cabinet");
  const web = envOf(resolved, "web");

  const equal = (where, name, given, expected) => {
    if (given !== expected) {
      problems.push(
        `${where}: ${name} is ${JSON.stringify(given ?? null)} and the ${channel} channel is ` +
          `${JSON.stringify(expected)}`,
      );
    }
  };

  // The chain and the facilitator together. This is the one the runtime cannot
  // make for itself: a live chain already refuses every facilitator but
  // Coinbase's, but a test chain must keep accepting sandbox:scripted, because
  // the laptop requires exactly that pairing.
  equal("gateway", "PAYMENT_NETWORK", gateway.PAYMENT_NETWORK, wanted.network);
  equal("gateway", "FACILITATOR_URL", gateway.FACILITATOR_URL, wanted.facilitator);

  if (wanted.credentials) {
    for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET"]) {
      if ((gateway[name] ?? "") === "") {
        problems.push(
          `gateway: ${name} is not set, and the ${channel} channel settles through a facilitator ` +
            "that takes no request without credentials",
        );
      }
    }
  }

  equal("web", "COINSLOT_SURFACE_MODE", web.COINSLOT_SURFACE_MODE, wanted.surfaceMode);

  // The cabinet was handed the gateway's pair, compared value for value. A
  // cabinet on the scripted facilitator beside a gateway on the public one
  // renders a page saying nothing settles here, which is false about a stack
  // that settles on Sepolia — and a probe that asked only whether a banner was
  // present would find one and pass.
  if (cabinet.PAYMENT_NETWORK !== gateway.PAYMENT_NETWORK) {
    problems.push(
      `cabinet: PAYMENT_NETWORK is ${JSON.stringify(cabinet.PAYMENT_NETWORK ?? null)} and its ` +
        `gateway's is ${JSON.stringify(gateway.PAYMENT_NETWORK ?? null)}`,
    );
  }
  if (cabinet.FACILITATOR_URL !== gateway.FACILITATOR_URL) {
    problems.push(
      `cabinet: FACILITATOR_URL is ${JSON.stringify(cabinet.FACILITATOR_URL ?? null)} and its ` +
        `gateway's is ${JSON.stringify(gateway.FACILITATOR_URL ?? null)}`,
    );
  }

  // The mock merchant, which publishes two demonstration cards as it starts.
  if (resolved.services?.merchant !== undefined) {
    problems.push(
      "the mock merchant is among the services: it is the laptop's fixture, it publishes goods " +
        "nobody sells, and on a settling stack its publication is refused so the stack never " +
        "comes up. deploy/compose.public.yaml gives it a profile nothing enables",
    );
  }

  // No laptop default survived.
  if ((resolved.services?.postgres?.ports ?? []).length > 0) {
    problems.push(
      "postgres publishes a port on the host: two stacks cannot both take one, and nothing " +
        "outside the Compose network has any business reaching either database",
    );
  }

  if ((gateway.SANDBOX_MERCHANT_KEY ?? "") === "") {
    problems.push(
      "gateway: SANDBOX_MERCHANT_KEY is not set, so this stack seeds no merchant and there is " +
        "nobody to sign in as",
    );
  }

  for (const [name, published] of Object.entries(WRITTEN_IN_THIS_REPOSITORY)) {
    const where = name === "AUTH_SECRET" ? cabinet : gateway;
    const label = name === "AUTH_SECRET" ? "cabinet" : "gateway";
    if (where[name] === published) {
      problems.push(
        `${label}: ${name} is the value written in this repository, which anybody can read`,
      );
    }
  }

  if (cabinet.COOKIE_SECURE !== "true") {
    problems.push(
      `cabinet: COOKIE_SECURE is ${JSON.stringify(cabinet.COOKIE_SECURE ?? null)} and this stack ` +
        "is reached over https, so a session cookie without it goes to anybody on the path",
    );
  }

  equal("gateway", "PUBLIC_BASE_URL", gateway.PUBLIC_BASE_URL, wanted.origin);
  equal("cabinet", "PUBLIC_BASE_URL", cabinet.PUBLIC_BASE_URL, wanted.origin);
  equal("web", "COINSLOT_SITE_ADDRESS", web.COINSLOT_SITE_ADDRESS, wanted.siteAddress);

  // The whole binding, not just the published number. The container side is
  // 8080 only while COINSLOT_SITE_ADDRESS is a bare port; a hostname turns
  // Caddy's automatic HTTPS on and it listens on 443 instead, so a mapping to
  // 8080 on a public stack forwards to a port with no listener and the site
  // answers nothing. The host IP is checked for the reason compose.yaml already
  // gives: a door open to the edge that passes SNI to it and to nothing else on
  // the machine.
  const bindings = (resolved.services?.web?.ports ?? []).map(
    (port) => `${port.host_ip ?? ""}:${port.published ?? ""}:${port.target ?? ""}`,
  );
  const wantedBinding = `${wanted.hostIp}:${wanted.publishedPort}:443`;
  if (bindings.length !== 1 || bindings[0] !== wantedBinding) {
    problems.push(
      `web: the published bindings are ${JSON.stringify(bindings)} and the ${channel} channel is ` +
        `${JSON.stringify(wantedBinding)}`,
    );
  }

  return problems;
}

// The CLI, for `deploy/release.sh`. Reads the resolved configuration on stdin
// so that no path into a checkout has to be agreed on between two files.
if (process.argv[1]?.endsWith("preflight.mjs")) {
  const channel = process.argv[2];
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let problems;
  try {
    problems = problemsWith(channel, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (thrown) {
    console.error(`preflight: the resolved configuration did not read as JSON — ${thrown}`);
    process.exit(65);
  }

  if (problems.length > 0) {
    console.error(`preflight: the ${channel} channel is not what it claims to be:`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(65);
  }

  console.log(`preflight: the ${channel} channel is what it claims to be`);
}
