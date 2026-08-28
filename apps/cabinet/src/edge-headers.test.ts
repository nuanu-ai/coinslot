/**
 * The one header at the edge that can stop every form in this cabinet working.
 *
 * This is a test about a file the cabinet does not read, which needs saying.
 * `deploy/Caddyfile` is what serves the cabinet's pages on a deployment, and one
 * of the headers it sets decides whether the browser will tell us where a form
 * came from. The cabinet then refuses forms that came from somewhere else. Those
 * two facts live in two repositoriesworth of distance from each other — a header
 * block in a web server's configuration and a middleware in an express app — and
 * nothing connected them until this file.
 *
 * What happened without it: the edge sent `Referrer-Policy: no-referrer`,
 * because it looked like free hardening and the comment beside it said it
 * "cannot break a page". By the fetch specification a request whose method is
 * not GET or HEAD and whose referrer policy is `no-referrer` carries
 * `Origin: null` rather than the page's own origin. Every form post in the
 * cabinet therefore arrived claiming to come from nowhere, the check refused it,
 * and a merchant could not sign into the live site at all. It cost the better
 * part of a day, and the reason it cost that much is that nothing about it
 * looked like a header: the identical request from a command line, which
 * implements no referrer policy, sailed through, so the evidence pointed at the
 * check rather than at the page it was checking.
 *
 * The charter says a rule moves into a machine once it has slipped past people.
 * This one did.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const caddyfile = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "deploy",
  "Caddyfile",
);

/**
 * The referrer policies a browser reads as "send no origin either".
 *
 * One entry, because one value has this effect. It is a list rather than a
 * comparison so that a second value with the same consequence has somewhere to
 * go, and so the name of the list says what the entries have in common.
 */
const POLICIES_THAT_NULL_THE_ORIGIN = ["no-referrer"];

describe("the headers the edge puts on the cabinet's pages", () => {
  it("does not use a referrer policy that makes a browser hide the origin", () => {
    const configuration = readFileSync(caddyfile, "utf8");
    // A search that found nothing to search would pass for the wrong reason.
    expect(configuration).toContain("Referrer-Policy");

    const said = /^\s*Referrer-Policy\s+(\S+)\s*$/m.exec(configuration)?.[1];
    expect(said, "the Caddyfile sets a Referrer-Policy this test could not read").toBeDefined();
    expect(
      POLICIES_THAT_NULL_THE_ORIGIN,
      `Referrer-Policy is "${said}", and a browser then posts every form with Origin: null,` +
        " which the cabinet refuses — nobody can sign in. Use same-origin.",
    ).not.toContain(said);
  });

  it("still keeps a referrer off other people's sites", () => {
    // The reason the line exists at all. Dropping the header entirely would
    // also fix the sign-in, and it would send the address of a merchant's
    // cabinet page to whatever they click through to.
    const said = /^\s*Referrer-Policy\s+(\S+)\s*$/m.exec(readFileSync(caddyfile, "utf8"))?.[1];
    expect(["same-origin", "strict-origin", "strict-origin-when-cross-origin"]).toContain(said);
  });
});
