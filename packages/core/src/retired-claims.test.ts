/**
 * Sentences this repository has retired, and which must not come back.
 *
 * Why this is a test and not a note. One wrong clause in ADR-0004 — that
 * delivery is at-least-once with redelivery by the queue's visibility timeout —
 * propagated into the contract, the gateway, both queue adapters, the SDK, four
 * portal pages and the name of a test. It was corrected three times over two
 * days, and every round left survivors: twice in files the correcting commit
 * had open. What it cost while it stood was not tidiness — the portal told a
 * merchant to guard against receiving an event twice, which cannot happen, and
 * said nothing about the one that can be lost, which is a refund notice for a
 * buyer who paid.
 *
 * The charter's rule is that a rule moves into a machine after it has slipped
 * past people. This one slipped three times, so here it is.
 *
 * What this is not: a style checker. A phrase earns a line here only after it
 * has been believed, written down, and found to be false — and the line records
 * what the truth is, so that whoever trips it learns something rather than
 * searching for a synonym. The decision records are exempt: a corrected
 * decision keeps its wrong sentence on purpose, so that anybody who built on it
 * can see what they read.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * What we search: source, the merchant's pages, and the notes at the root.
 *
 * Walked with the standard library rather than a glob package, because a
 * dependency added for one search is a dependency somebody has to justify at
 * every release afterwards.
 */
const LOOK_IN = ["apps", "packages", "portal", "docs/research"];
const READABLE = /\.(ts|md)$/;
const SKIP = new Set(["node_modules", "dist", ".vitepress", "cache"]);

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) {
      continue;
    }
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...filesUnder(path));
    } else if (READABLE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

const everyFile = (): string[] => LOOK_IN.flatMap(filesUnder);

/**
 * Where a retired sentence is allowed to survive.
 *
 * `docs/decisions/` keeps the wrong words of a corrected decision deliberately,
 * and this file quotes them all by definition.
 */
const EXEMPT = [/^docs\/decisions\//, /retired-claims\.test\.ts$/];

interface Retired {
  /** The words, lowercased, as they were actually written. */
  readonly words: string;
  /** What is true instead, in one sentence a reader can act on. */
  readonly instead: string;
}

const RETIRED: readonly Retired[] = [
  {
    words: "under the same envelope identifier",
    instead:
      "each attempt at an order is a fresh envelope with an identifier of its own; a handler recognises a repeat by the order's identifier inside the payload",
  },
  {
    words: "share no field but the payload",
    instead:
      "two attempts share their kind as well — the only thing they have in common that matters is the order they carry",
  },
  {
    words: "redelivery by visibility timeout",
    instead:
      "the queue's own retries are off; redelivery is decided by the order machine, and a drawn envelope is never re-offered",
  },
];

describe("sentences this repository has retired", () => {
  it("does not carry any of them back into the tree", () => {
    const files = everyFile();
    // A search that found nothing to search would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(100);

    const found: string[] = [];
    for (const path of files) {
      if (EXEMPT.some((exempt) => exempt.test(path))) {
        continue;
      }
      const text = readFileSync(resolve(root, path), "utf8").toLowerCase();
      for (const claim of RETIRED) {
        if (text.includes(claim.words)) {
          found.push(`${path}: "${claim.words}" — ${claim.instead}`);
        }
      }
    }

    expect(found).toStrictEqual([]);
  });

  it("is looking in the places these claims actually spread to", () => {
    // The list above is only worth its line if the search reaches the files
    // that carried the claim: the contract a client is generated from, the
    // queue adapters, the SDK and the merchant's own pages. A glob that
    // silently stopped matching one of them would pass this suite while the
    // claim walked back in through it.
    const files = everyFile();

    for (const wanted of [
      "packages/contracts/src/api.ts",
      "packages/contracts/src/envelope.ts",
      "packages/sdk/src/worker.ts",
      "apps/gateway/src/ports/queue.ts",
      "apps/gateway/src/adapters/pgboss/queue.ts",
      "portal/orders.md",
    ]) {
      expect(files).toContain(wanted);
    }
  });
});
