/**
 * The bootstrap purchase, wired to the network and to a wallet.
 *
 * It buys, for real, from a running gateway, so that the products it buys are
 * catalogued by Coinbase's Bazaar — which happens on the first settle through
 * the CDP facilitator and on nothing else. Then it watches the catalog and says
 * what it saw.
 *
 *   COINSLOT_SMOKE=1 GATEWAY_URL=https://coinslot.example SMOKE_BUYER_KEY=0x… \
 *     pnpm smoke:bootstrap --confirm
 *
 * Nothing is spent without `--confirm`, and no run can spend more than
 * `SMOKE_TOTAL_USD`. What this file does is only the wiring; the command is in
 * `bootstrap-command.ts`, where the parts that can be got wrong without a
 * network — the caps, the gates, and what a facilitator's answer means — are
 * tested offline.
 *
 * The way out is built from settings the command has already held to shape, and
 * that order is the point: the key is read from the environment inside the
 * command, and every refusal about it — absent, malformed, or typed onto the
 * command line where `ps` shows it to the whole machine — happens before
 * anything here touches it.
 */

import { overTheNetwork, runBootstrap } from "./bootstrap-command.js";

process.exitCode = await runBootstrap(
  process.argv.slice(2),
  process.env,
  (settings) => overTheNetwork(settings),
  (line) => {
    console.log(line);
  },
);
