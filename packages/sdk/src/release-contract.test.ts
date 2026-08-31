/**
 * The release tag is the authority that makes an immutable package version
 * public. These tests execute the same resolver as the workflow: a similarly
 * named tag, an unreleased manifest or an unearned npm dist-tag must stop
 * before authentication and before `npm publish`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const resolver = fileURLToPath(
  new URL("../../../scripts/check-sdk-release-tag.sh", import.meta.url),
);
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { force: true, recursive: true });
});

const resolverFor = (
  sdkVersion: string,
  contractsVersion: string,
  extraPublicPackage?: string,
): string => {
  const root = mkdtempSync(join(tmpdir(), "coinslot-sdk-release-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "packages", "sdk"), { recursive: true });
  mkdirSync(join(root, "packages", "contracts"), { recursive: true });

  const executable = join(root, "scripts", "check-sdk-release-tag.sh");
  copyFileSync(resolver, executable);
  chmodSync(executable, 0o755);
  writeFileSync(
    join(root, "packages", "sdk", "package.json"),
    JSON.stringify({ name: "@nuanu-ai/coinslot", version: sdkVersion }),
  );
  writeFileSync(
    join(root, "packages", "contracts", "package.json"),
    JSON.stringify({ name: "@nuanu-ai/coinslot-contracts", version: contractsVersion }),
  );
  if (extraPublicPackage) {
    mkdirSync(join(root, "packages", "extra"), { recursive: true });
    writeFileSync(
      join(root, "packages", "extra", "package.json"),
      JSON.stringify({ name: extraPublicPackage, version: "1.0.0" }),
    );
  }
  return executable;
};

const resolve = (tag: string, sdkVersion: string, contractsVersion = sdkVersion): string =>
  execFileSync(resolverFor(sdkVersion, contractsVersion), [tag], { encoding: "utf8" });

const refuse = (tag: string, sdkVersion: string, contractsVersion = sdkVersion) =>
  spawnSync(resolverFor(sdkVersion, contractsVersion), [tag], { encoding: "utf8" });

describe("the SDK release tag", () => {
  it("names the exact SDK version and the stable npm channel", () => {
    expect(resolve("sdk-v0.1.0", "0.1.0")).toBe(
      "sdk_version=0.1.0\ncontracts_version=0.1.0\ndist_tag=latest\n",
    );
  });

  it("refuses prereleases instead of deriving an unsafe npm channel", () => {
    for (const version of ["0.2.0-rc.3", "0.2.0-latest.1", "0.2.0-1"]) {
      const result = refuse(`sdk-v${version}`, version);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a stable semantic version");
    }
  });

  it("refuses a tag for any version other than the one it would publish", () => {
    const result = refuse("sdk-v0.1.1", "0.1.0");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be sdk-v0.1.0");
  });

  it("refuses manifests that still say unreleased", () => {
    for (const [sdk, contracts] of [
      ["0.0.0", "0.1.0"],
      ["0.1.0", "0.0.0"],
    ] as const) {
      const result = refuse(`sdk-v${sdk}`, sdk, contracts);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("0.0.0 is not publishable");
    }
  });

  it("refuses to let Changesets publish another public workspace package", () => {
    const result = spawnSync(resolverFor("0.1.0", "0.1.0", "@nuanu-ai/extra"), ["sdk-v0.1.0"], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SDK release may publish only");
    expect(result.stderr).toContain("@nuanu-ai/extra");
  });
});
