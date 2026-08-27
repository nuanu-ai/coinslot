/**
 * The listing check, wired to the network.
 *
 * It takes the public address of a running gateway and asks the CDP validation
 * endpoint whether it would take that gateway's paid resources:
 *
 *   pnpm smoke:listing https://coinslot.example
 *   pnpm smoke:listing https://coinslot.example itm_4d21bb
 *
 * The endpoint fetches the resource itself, so the gateway has to be reachable
 * from the internet. From a laptop it is not, and the command reports what it
 * actually saw rather than a pass.
 *
 * No database, no key, no wallet, nothing spent. What this file does is only
 * the wiring; the command is in `listing-command.ts`, where the one thing that
 * has to be right — that a probe with no verdict is never reported as a pass —
 * is tested offline.
 */

import { overTheNetwork, runListingCheck } from "./listing-command.js";

process.exitCode = await runListingCheck(process.argv.slice(2), overTheNetwork(), (line) => {
  console.log(line);
});
