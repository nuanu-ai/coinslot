/**
 * One sentence, three renderers.
 *
 * The cabinet imports its wording; the landing and the portal cannot — one is
 * static HTML served through a Caddy template and the other is a build hook —
 * so the words are spelled out in those two files. This is what stops the
 * three copies drifting: the files themselves are read here and held against
 * the module the cabinet reads.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "./environment.js";

const LANDING = readFileSync(
  new URL("../../../../apps/landing/public/index.html", import.meta.url),
  "utf8",
);
const PORTAL_CONFIG = readFileSync(
  new URL("../../../../portal/.vitepress/config.mjs", import.meta.url),
  "utf8",
);

describe("the landing", () => {
  it("names the mode it is rendering", () => {
    expect(LANDING).toContain(
      `${SURFACE_MARKER_ATTRIBUTE}="<!--{{env \`COINSLOT_SURFACE_MODE\`}}-->"`,
    );
  });

  it("keeps the band on the words and not on the marker", () => {
    // A live stack renders neither paragraph, so a styled marker element would
    // leave it an empty band — a banner in every way except the words.
    expect(LANDING).not.toContain(`class="surface" ${SURFACE_MARKER_ATTRIBUTE}`);
  });

  it("carries both banners word for word", () => {
    expect(LANDING).toContain(SURFACE_WORDS.test);
    expect(LANDING).toContain(SURFACE_WORDS.sandbox);
  });

  it("renders nothing for a live stack", () => {
    // The live branch is the absence of a banner, not the absence of a marker.
    expect(LANDING).toContain('<!--{{if eq (env "COINSLOT_SURFACE_MODE") "test"}}-->');
    expect(LANDING).toContain('<!--{{else if eq (env "COINSLOT_SURFACE_MODE") "sandbox"}}-->');
  });
});

describe("the portal's build hook", () => {
  it("writes the same marker into every page it builds", () => {
    expect(PORTAL_CONFIG).toContain(SURFACE_MARKER_ATTRIBUTE);
    expect(PORTAL_CONFIG).toContain(SURFACE_WORDS.test);
    expect(PORTAL_CONFIG).toContain(SURFACE_WORDS.sandbox);
  });
});
