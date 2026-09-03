/**
 * The VM accepting only the exact green `main` revision from GitHub.
 *
 * GitHub and the release receiver are process boundaries, so the fixtures
 * replace those two boundaries while the real pull agent performs the
 * decision, archive normalization and durable-state transitions.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PULL_AGENT = fileURLToPath(new URL("../../../../deploy/pull-agent.sh", import.meta.url));
const RELEASE_RECEIVER = fileURLToPath(new URL("../../../../deploy/release.sh", import.meta.url));
const REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const executable = (path: string, body: string): void => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

const workflowRun = (overrides: Record<string, unknown> = {}) => ({
  id: 123456,
  name: "CI",
  head_branch: "main",
  head_sha: REVISION,
  path: ".github/workflows/ci.yml@main",
  run_number: 42,
  run_attempt: 1,
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: "2026-09-03T10:00:00Z",
  updated_at: "2026-09-03T10:05:00Z",
  url: "https://api.github.com/repos/nuanu-ai/coinslot/actions/runs/123456",
  html_url: "https://github.com/nuanu-ai/coinslot/actions/runs/123456",
  ...overrides,
});

describe("the test deployment pull agent", () => {
  let root: string;
  let fakeBin: string;
  let responseFile: string;
  let sourceArchive: string;
  let capturedArchive: string;
  let archiveRoot: string;
  let markerFile: string;
  let releaseCount: string;
  let releaseProgram: string;
  let stateFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coinslot-pull-agent-"));
    fakeBin = join(root, "bin");
    mkdirSync(fakeBin);
    responseFile = join(root, "workflow-runs.json");
    sourceArchive = join(root, "source.tar.gz");
    capturedArchive = join(root, "release.tar");
    releaseCount = join(root, "release-count");
    releaseProgram = join(root, "release");
    stateFile = join(root, "state", "test-pull.state");
    markerFile = join(root, "test-deployment", ".coinslot-revision");

    executable(
      join(fakeBin, "git"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "ls-remote --exit-code --refs https://github.com/nuanu-ai/coinslot.git refs/heads/main" ]]
printf '%s\\trefs/heads/main\\n' "\${FAKE_HEAD_SHA}"
`,
    );

    executable(
      join(fakeBin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
output=''
url=''
while (( $# > 0 )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --header) shift 2 ;;
    --fail | --silent | --show-error | --location) shift ;;
    http*) url="$1"; shift ;;
    *) exit 91 ;;
  esac
done
[[ -n "\${output}" ]]
case "\${url}" in
  *'/actions/workflows/ci.yml/runs?'*) cp "\${FAKE_WORKFLOW_RESPONSE}" "\${output}" ;;
  *'/tarball/'*) cp "\${FAKE_SOURCE_ARCHIVE}" "\${output}" ;;
  *) exit 92 ;;
esac
`,
    );

    executable(
      releaseProgram,
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == 'test' ]]
[[ "$2" == "\${FAKE_HEAD_SHA}" ]]
count=0
[[ ! -f "\${FAKE_RELEASE_COUNT}" ]] || read -r count <"\${FAKE_RELEASE_COUNT}"
printf '%s\\n' "$((count + 1))" >"\${FAKE_RELEASE_COUNT}"
cat >"\${FAKE_CAPTURED_ARCHIVE}"
exit "\${FAKE_RELEASE_EXIT:-0}"
`,
    );

    archiveRoot = join(root, `nuanu-ai-coinslot-${REVISION.slice(0, 7)}`);
    mkdirSync(join(archiveRoot, "deploy"), { recursive: true });
    writeFileSync(join(archiveRoot, "compose.yaml"), "name: exact-revision\n");
    writeFileSync(join(archiveRoot, "deploy", "compose.public.yaml"), "services: {}\n");
    packArchive();
  });

  const packArchive = (): void => {
    const archived = spawnSync(
      "tar",
      ["-czf", sourceArchive, "-C", dirname(archiveRoot), basename(archiveRoot)],
      { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    expect(archived.status, archived.stderr).toBe(0);
  };

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeRuns = (runs: Record<string, unknown>[]): void => {
    writeFileSync(responseFile, JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  };

  const runAgent = (releaseExit = 0) =>
    spawnSync(PULL_AGENT, [releaseProgram, stateFile, markerFile], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_CAPTURED_ARCHIVE: capturedArchive,
        FAKE_HEAD_SHA: REVISION,
        FAKE_RELEASE_COUNT: releaseCount,
        FAKE_RELEASE_EXIT: String(releaseExit),
        FAKE_SOURCE_ARCHIVE: sourceArchive,
        FAKE_WORKFLOW_RESPONSE: responseFile,
      },
    });

  it("delivers the exact green main revision as a rootless release archive", () => {
    writeRuns([workflowRun()]);

    const result = runAgent();

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(stateFile, "utf8")).toBe(`${REVISION} success\n`);
    const extracted = join(root, "extracted");
    mkdirSync(extracted);
    const unpacked = spawnSync("tar", ["-xf", capturedArchive, "-C", extracted], {
      encoding: "utf8",
    });
    expect(unpacked.status, unpacked.stderr).toBe(0);
    expect(readFileSync(join(extracted, "compose.yaml"), "utf8")).toBe("name: exact-revision\n");
  });

  it("does not deliver a run that is not a successful push for that main revision", () => {
    for (const wrongRun of [
      workflowRun({ conclusion: "failure" }),
      workflowRun({ event: "workflow_dispatch" }),
      workflowRun({ head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      workflowRun({ head_branch: "feature/untrusted" }),
    ]) {
      writeRuns([wrongRun]);
      const result = runAgent();
      expect(result.status).not.toBeNull();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not an exact successful push");
      expect(existsSync(capturedArchive)).toBe(false);
    }
  });

  it("does not deliver an exact revision more than once", () => {
    writeRuns([workflowRun()]);
    expect(runAgent().status).toBe(0);

    const repeated = runAgent();

    expect(repeated.status, repeated.stderr).toBe(0);
    expect(readFileSync(releaseCount, "utf8")).toBe("1\n");
  });

  it("records a failed release and refuses to loop on the same candidate", () => {
    writeRuns([workflowRun()]);
    expect(runAgent(23).status).toBe(23);
    expect(readFileSync(stateFile, "utf8")).toBe(`${REVISION} failed\n`);

    const repeated = runAgent();

    expect(repeated.status).not.toBe(0);
    expect(readFileSync(releaseCount, "utf8")).toBe("1\n");
  });

  it("retries a previously interrupted candidate that never reached activation", () => {
    writeRuns([workflowRun()]);
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, `${REVISION} running\n`);

    const recovered = runAgent();

    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(releaseCount, "utf8")).toBe("1\n");
    expect(readFileSync(stateFile, "utf8")).toBe(`${REVISION} success\n`);
  });

  it("recognizes an interrupted candidate that the receiver already verified", () => {
    writeRuns([workflowRun()]);
    mkdirSync(dirname(stateFile), { recursive: true });
    mkdirSync(dirname(markerFile), { recursive: true });
    writeFileSync(stateFile, `${REVISION} running\n`);
    writeFileSync(markerFile, `release-test ${REVISION} status=origin-verified\n`);

    const recovered = runAgent();

    expect(recovered.status, recovered.stderr).toBe(0);
    expect(existsSync(capturedArchive)).toBe(false);
    expect(readFileSync(stateFile, "utf8")).toBe(`${REVISION} success\n`);
  });

  it("does not repeat a candidate that may already have activated", () => {
    writeRuns([workflowRun()]);
    mkdirSync(dirname(stateFile), { recursive: true });
    mkdirSync(dirname(markerFile), { recursive: true });
    writeFileSync(stateFile, `${REVISION} running\n`);
    writeFileSync(markerFile, `release-test ${REVISION} status=activated\n`);

    const uncertain = runAgent();

    expect(uncertain.status).not.toBe(0);
    expect(uncertain.stderr).toContain("may already have activated");
    expect(existsSync(capturedArchive)).toBe(false);
    expect(readFileSync(stateFile, "utf8")).toBe(`${REVISION} running\n`);
  });

  it("keeps a relative archive link whose target stays under the same root", () => {
    writeRuns([workflowRun()]);
    symlinkSync("deploy/compose.public.yaml", join(archiveRoot, "public-compose"));
    packArchive();

    const result = runAgent();

    expect(result.status, result.stderr).toBe(0);
    const extracted = join(root, "extracted-link");
    mkdirSync(extracted);
    expect(spawnSync("tar", ["-xf", capturedArchive, "-C", extracted]).status).toBe(0);
    expect(readlinkSync(join(extracted, "public-compose"))).toBe("deploy/compose.public.yaml");
  });

  it("refuses archive links that leave the extraction root", () => {
    writeRuns([workflowRun()]);
    symlinkSync("../../outside", join(archiveRoot, "escape"));
    packArchive();

    const result = runAgent();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe link target");
    expect(existsSync(capturedArchive)).toBe(false);
  });
});

describe("the release receiver's local test-channel door", () => {
  it("accepts a trusted local SHA before checking server preconditions", () => {
    const home = mkdtempSync(join(tmpdir(), "coinslot-release-home-"));
    try {
      const bin = join(home, "bin");
      mkdirSync(bin);
      // macOS has no flock(1); this test stops before the deployment and only
      // needs the receiver's preceding lock acquisition to succeed.
      executable(join(bin, "flock"), "#!/bin/sh\nexit 0\n");
      const result = spawnSync(RELEASE_RECEIVER, ["test", REVISION], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        input: "",
      });

      expect(result.status).toBe(64);
      expect(result.stderr).toContain("server .env is missing");
      expect(result.stderr).not.toContain('expected "release-test');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not open a local live-channel door", () => {
    const result = spawnSync(RELEASE_RECEIVER, ["live", REVISION], {
      encoding: "utf8",
      env: { ...process.env, HOME: tmpdir() },
      input: "",
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("local releases are limited to the test channel");
  });
});
