/**
 * What the cabinet does when the gateway accepts a connection and then says
 * nothing.
 *
 * This is not the same failure as a gateway that is down, and it is the worse
 * one: a refused connection comes back at once, while a half-open one holds the
 * request until something else gives up. The screen a merchant is holding at
 * that moment may be the one that stops their selling, so a call with no
 * deadline is a merchant who cannot stop.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayFor } from "./gateway.js";

let held: Server | null = null;

/** A server that accepts the connection and never answers it. */
const silentServer = async (): Promise<string> => {
  const server = createServer(() => {
    // Deliberately no response, and no timeout of its own: the point is that
    // the caller is the one who has to give up.
  });
  held = server;
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent server did not take a port");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(() => {
  held?.closeAllConnections();
  held?.close();
  held = null;
});

describe("a gateway that answers nothing", () => {
  it("gives up rather than holding the merchant's page open", async () => {
    // The promise: every call this client makes ends. Without a deadline this
    // test does not fail — it hangs until the runner's own timeout kills the
    // file, which is the same thing happening to a merchant with no runner to
    // rescue them.
    // Fifty milliseconds rather than the ten seconds a merchant gets, so the
    // suite stays fast; what is under test is that the deadline exists at all.
    const gateway = gatewayFor(await silentServer(), "a-merchant-key-long-enough", 50);

    const answered = await gateway.cards();

    expect(answered.ok).toBe(false);
    if (answered.ok) {
      throw new Error("the silent gateway answered");
    }
    expect(answered.status).toBe(0);
    // The two silences are told apart, because only one of them is worth
    // trying again in a moment.
    expect(answered.why).toMatch(/in time/);
  });

  it("tells a gateway that is not there from one that will not answer", async () => {
    // Nothing is listening on this port, so the connection is refused at once
    // and the wording is the other one.
    const gateway = gatewayFor("http://127.0.0.1:1", "a-merchant-key-long-enough");

    const answered = await gateway.cards();

    expect(answered.ok).toBe(false);
    if (answered.ok) {
      throw new Error("a port with nothing on it answered");
    }
    expect(answered.why).toBe("the gateway could not be reached");
  });
});
