import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RELEASE_RECEIVER = fileURLToPath(new URL("../../../../deploy/release.sh", import.meta.url));
const REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const executable = (path: string, body: string): void => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

describe("release image retention", () => {
  let archive: string;
  let dockerLog: string;
  let fakeBin: string;
  let home: string;
  let marker: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coinslot-release-retention-"));
    home = join(root, "home");
    fakeBin = join(root, "bin");
    dockerLog = join(root, "docker.log");
    const deployment = join(home, "coinslot-test");
    marker = join(deployment, ".coinslot-revision");
    const payload = join(root, "payload");
    archive = join(root, "release.tar");

    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(deployment, { recursive: true });
    mkdirSync(join(payload, "deploy"), { recursive: true });
    writeFileSync(join(deployment, ".env"), "TEST_ONLY=true\n", { mode: 0o600 });
    writeFileSync(join(payload, "compose.yaml"), "services: {}\n");
    writeFileSync(join(payload, "deploy", "compose.public.yaml"), "services: {}\n");
    writeFileSync(join(payload, "deploy", "smoke-paths"), "/healthz\n");

    const packed = spawnSync("tar", ["-cf", archive, "-C", payload, "."], {
      encoding: "utf8",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    expect(packed.status, packed.stderr).toBe(0);

    executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");
    executable(
      join(fakeBin, "stat"),
      `#!/bin/sh
set -eu
[ "$1" = '-c' ]
[ "$2" = '%a' ]
[ "$3" = "${deployment}/.env" ]
printf '%s\n' '600'
`,
    );
    executable(
      join(fakeBin, "rsync"),
      `#!/usr/bin/env bash
set -euo pipefail
previous=''
current=''
for argument in "$@"; do
  previous="$current"
  current="$argument"
done
mkdir -p "$current"
cp -R "\${previous%/}/." "\${current%/}/"
`,
    );
    executable(
      join(fakeBin, "curl"),
      `#!/bin/sh
printf '%s\n' '<html data-coinslot-surface="test"></html>'
`,
    );
    executable(
      join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >>"\${FAKE_DOCKER_LOG}"
printf '\n' >>"\${FAKE_DOCKER_LOG}"

if [[ "$1" == 'compose' ]]; then
  if [[ " $* " == *' config --format json '* ]]; then
    printf '%s\n' '{}'
  fi
  exit 0
fi

if [[ "$1" == 'run' ]]; then
  exit 0
fi

if [[ "$1 $2" == 'image prune' ]]; then
  grep -qx "release-test ${REVISION} status=origin-verified" "\${FAKE_MARKER}"
  [[ "\${FAKE_PRUNE_FAILURE:-0}" != '1' ]] || exit 37
  exit 0
fi

exit 91
`,
    );
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
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: dockerLog,
        FAKE_MARKER: marker,
        FAKE_PRUNE_FAILURE: pruneFailure ? "1" : "0",
      },
      input: readFileSync(archive),
    });

  it("prunes only release images older than 24 hours after origin verification", () => {
    const result = runRelease();

    expect(result.status, result.stderr).toBe(0);
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
