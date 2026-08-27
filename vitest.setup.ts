/**
 * The rule that `pnpm test` never leaves this machine, moved into a machine.
 *
 * `vitest.config.ts` has always said the suite is free, deterministic and works
 * without a network. It was text, and text is what it stayed until a pair of
 * tests handed a command the real way out to a validation endpoint at
 * `api.cdp.coinbase.com`. Four requests went out on every run of the suite. The
 * assertions never looked at the answers, so it passed either way — offline it
 * cost the wait for a name that does not resolve, and there is at least one
 * place on record where that host is intercepted outright.
 *
 * Nothing could have caught it. A test cannot assert that another test made no
 * request, and a reviewer reading a call site sees a plausible-looking name.
 * So this refuses the request instead, at the one place every request goes
 * through, and the failure names the test that made it.
 *
 * Loopback is allowed and is the whole point of the exception: several suites
 * stand a real server up in this process and talk to it over a real socket,
 * which is deterministic, free and offline. What is refused is anything else.
 *
 * If a test genuinely needs to reach the outside world, it does not belong in
 * `pnpm test`. It belongs beside `pnpm smoke`, where the network is expected
 * and what it costs is accounted for.
 */

import { afterEach } from "vitest";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

const isLocal = (target: string): boolean => {
  if (target.startsWith("/")) {
    // A relative address has no host to leave by.
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    // Unparseable is not a host either; whatever it is, it is not a request
    // going somewhere, and letting it through gives a clearer error than this
    // file would.
    return true;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
    return true;
  }
  return LOOPBACK.has(parsed.hostname);
};

const addressOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const reachesOutside = globalThis.fetch;

/**
 * Where a refused request is written down as well as refused.
 *
 * Throwing alone is not enough, and the case that showed it is the one this
 * file was written for: the command that makes the request catches everything
 * on the way out, on purpose, so that one unreachable probe is a line in a
 * report rather than the end of a run. Under that, a throw here becomes a
 * verdict of "no answer", the test goes green, and the only sign left is that
 * nothing happened. So the attempt is recorded too, and the record is read
 * after each test by something no code under test can catch.
 */
const refused: string[] = [];

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const target = addressOf(input);
  if (!isLocal(target)) {
    refused.push(`${init?.method ?? "GET"} ${target}`);
    throw new Error(
      `pnpm test does not leave this machine, and something asked for ${target}. ` +
        "It is free, deterministic and works offline, and a request to anywhere " +
        "but this process is none of those. Stub the call, or move the test to " +
        "a smoke command where the network is expected.",
    );
  }
  return reachesOutside(input as never, init);
}) as typeof fetch;

afterEach(() => {
  if (refused.length === 0) {
    return;
  }
  const asked = refused.join(", ");
  refused.length = 0;
  throw new Error(
    `this test asked to leave the machine: ${asked}. ` +
      "The request was refused, so whatever the test saw instead is not what it " +
      "would see on somebody's laptop with a network. Stub the call, or move it " +
      "to a smoke command.",
  );
});
