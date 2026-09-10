import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RELEASE_RECEIVER = fileURLToPath(new URL("../../../../deploy/release.sh", import.meta.url));
const REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// The host's commands are checked-in files rather than scripts this test
// writes, because macOS scans each newly created executable on its first run —
// a quarter of a second apiece, five of them per case — and that alone put this
// file over vitest's default timeout during a full suite. See the README beside
// them; they read their expectations out of the environment.
const HOST_BIN = fileURLToPath(new URL("./fixtures/release-host-bin", import.meta.url));

describe("release image retention", () => {
  let archive: string;
  let dockerLog: string;
  let environmentFile: string;
  let home: string;
  let marker: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coinslot-release-retention-"));
    home = join(root, "home");
    dockerLog = join(root, "docker.log");
    const deployment = join(home, "coinslot-test");
    environmentFile = join(deployment, ".env");
    marker = join(deployment, ".coinslot-revision");
    const payload = join(root, "payload");
    archive = join(root, "release.tar");

    mkdirSync(deployment, { recursive: true });
    mkdirSync(join(payload, "deploy"), { recursive: true });
    writeFileSync(environmentFile, "TEST_ONLY=true\n", { mode: 0o600 });
    writeFileSync(join(payload, "compose.yaml"), "services: {}\n");
    writeFileSync(join(payload, "deploy", "compose.public.yaml"), "services: {}\n");
    writeFileSync(join(payload, "deploy", "smoke-paths"), "/healthz\n");

    const packed = spawnSync("tar", ["-cf", archive, "-C", payload, "."], {
      encoding: "utf8",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    expect(packed.status, packed.stderr).toBe(0);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runRelease = (pruneFailure = false) =>
    spawnSync(RELEASE_RECEIVER, ["test", REVISION], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${HOST_BIN}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: dockerLog,
        FAKE_ENV_FILE: environmentFile,
        FAKE_MARKER: marker,
        FAKE_VERIFIED_MARKER: `release-test ${REVISION} status=origin-verified`,
        FAKE_PRUNE_FAILURE: pruneFailure ? "1" : "0",
      },
      input: readFileSync(archive),
    });

  it("prunes only release images older than 24 hours after origin verification", () => {
    const result = runRelease();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("image retention failed");
    const pruneCalls = readFileSync(dockerLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("image prune"));
    expect(pruneCalls).toEqual([
      "image prune -a -f --filter until=24h --filter label=com.docker.compose.project=coinslot ",
      "image prune -a -f --filter until=24h --filter label=com.docker.compose.project=coinslot-test ",
    ]);
  });

  it("keeps a verified release successful when image pruning fails", () => {
    const result = runRelease(true);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("image retention failed for coinslot");
    expect(result.stderr).toContain("image retention failed for coinslot-test");
    expect(readFileSync(marker, "utf8")).toBe(`release-test ${REVISION} status=origin-verified\n`);
  });
});
