/**
 * Which facilitator client a configuration means, and how it authenticates.
 *
 * This is a fork between two addresses and nothing else. A gateway told to talk
 * to Coinbase's facilitator signs every call with the credentials it was given;
 * a gateway told to talk to anything else — the x402.org testnet facilitator,
 * something self-hosted — sends nothing at all. The sandbox never reaches here:
 * it settles against nothing and is chosen a level up, in `main.ts` (ADR-0008).
 *
 * The fork is on the address and deliberately not on whether credentials happen
 * to be set, and the difference is a security boundary rather than tidiness. A
 * bearer token is a key: it is good for the account it was issued to, and
 * handing it to whichever host an environment variable names would be handing
 * somebody's Coinbase credentials to a stranger because a line was left in a
 * file. Credentials go to Coinbase or they go nowhere.
 *
 * Nothing here contacts anything. Building the payment layer reads configuration
 * and returns an object, and the first request the process makes to a
 * facilitator is the first payment it has to ask about. That is a property worth
 * naming, because the obvious way to build this does not have it: the spike's
 * server — `spikes/bazaar-listing/server.mjs`, on the official all-in-one
 * resource server — synchronised its supported schemes with the facilitator
 * while starting, and died on startup when the facilitator was unreachable. A
 * storefront that a supplier's outage can stop from booting is a storefront that
 * cannot be relied on, so the sequence here is the machine's and the protocol is
 * the library's, which is the same division `http/x402.ts` draws.
 */

import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { isCdpFacilitator, type PaymentConfig } from "../../config.js";

/**
 * The calls the client makes, and the method each is made on.
 *
 * A CDP token is signed against one method, one host and one path, and is
 * refused for anything else — so this table has to agree with what
 * `HTTPFacilitatorClient` actually requests. It does: the client posts to
 * `/verify` and `/settle` and gets `/supported`. The three names are also the
 * keys the library asks for its headers under, which is why the same table
 * serves both.
 */
const OPERATIONS = {
  verify: "POST",
  settle: "POST",
  supported: "GET",
} as const;

/**
 * A client that signs every call with Coinbase's credentials.
 *
 * The signing itself is `@coinbase/cdp-sdk`'s and is not reimplemented here.
 * What a CDP token has to contain is somebody else's specification — the
 * algorithm chosen from the shape of the key, a nonce in the header, a claim
 * naming the one request the token is good for, a life measured in a couple of
 * minutes — and a gateway that wrote its own would be a second implementation of
 * that specification, wrong in ways that show up only against the live API. The
 * dependency is the commodity and the seam is ours.
 *
 * What is ours is the address arithmetic, and it is worth reading. The token
 * names the request it is good for, so the host and the path have to be the
 * host and the path the client will really ask for — and the client strips
 * trailing slashes off the base before joining `/verify` onto it, so a base
 * written with one would otherwise be signed for a path with two. The host
 * carries the port when there is one, because that is what a request's own
 * `Host` header carries.
 *
 * The `Correlation-Context` header the CDP SDK sends alongside is deliberately
 * not sent. It names the SDK and its version as the source of the call, and
 * this is not that SDK; sending it would be a claim about who is calling that
 * happens not to be true, and nothing in the API asks for it.
 */
export function cdpAuthenticatedClient(
  facilitatorUrl: string,
  apiKeyId: string,
  apiKeySecret: string,
): HTTPFacilitatorClient {
  const { host, pathname } = new URL(facilitatorUrl);
  const basePath = pathname.replace(/\/+$/, "");

  const bearerFor = async (
    operation: keyof typeof OPERATIONS,
  ): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: OPERATIONS[operation],
      requestHost: host,
      requestPath: `${basePath}/${operation}`,
    })}`,
  });

  return new HTTPFacilitatorClient({
    url: facilitatorUrl,
    // Signed per call rather than once, because each token names the one
    // request it is good for and expires in about two minutes. The library asks
    // for all three at once and picks the one it needs, so all three are made;
    // a flat headers object is refused by it outright rather than silently
    // dropping the auth on every request.
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([
        bearerFor("verify"),
        bearerFor("settle"),
        bearerFor("supported"),
      ]);
      return { verify, settle, supported };
    },
  });
}

/**
 * The facilitator client this configuration asks for.
 *
 * Both branches build the library's HTTP client and the return type says so
 * rather than narrowing to the interface: what separates them is what goes on
 * the request, and `createAuthHeaders` is how the library itself answers that
 * question — which makes it the one place a test can read what a configuration
 * would send without sending it to Coinbase.
 *
 * The refusal below is a second lock on a door the configuration already holds
 * shut: `loadConfig` will not let a gateway start pointed at Coinbase without
 * credentials. It is repeated because this function can be called from anywhere
 * in the process, and a client built without them would not fail here — it
 * would fail at the first charge, in front of a buyer, with the facilitator
 * refusing every call for a reason nobody would connect to a missing variable.
 */
export function facilitatorClientFor(payment: PaymentConfig): HTTPFacilitatorClient {
  if (!isCdpFacilitator(payment.facilitatorUrl)) {
    return new HTTPFacilitatorClient({ url: payment.facilitatorUrl });
  }

  const { cdpApiKeyId, cdpApiKeySecret } = payment;
  if (cdpApiKeyId === null || cdpApiKeySecret === null) {
    throw new Error(
      `the facilitator at ${payment.facilitatorUrl} takes no request without credentials, and ` +
        "CDP_API_KEY_ID or CDP_API_KEY_SECRET is not set, so there is no client to build",
    );
  }

  return cdpAuthenticatedClient(payment.facilitatorUrl, cdpApiKeyId, cdpApiKeySecret);
}
