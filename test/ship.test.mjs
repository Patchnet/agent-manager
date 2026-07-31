import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-ship-"));
const runsRoot = join(root, "runs");
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
mkdirSync(runsRoot, { recursive: true });

const {
  diagnoseBlockedMerge,
  execCommand,
  prepareShipHandoff,
  queueShip,
  resolveSpawnCommand,
  runShip,
  ShipBlockedError,
} = await import("../src/ship-run.mjs?ship-test");
const { readEvents, readStatus, writeStatus } = await import("../src/status.mjs?ship-test");
const { classifyWake } = await import("../src/watch-signal.mjs?ship-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr = "failed") {
  return { ok: false, status: 1, stdout: "", stderr };
}

test("Windows npm commands run through cmd.exe without enabling shell mode", () => {
  assert.deepEqual(
    resolveSpawnCommand("npm", ["run", "check:version"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm", "run", "check:version"],
    },
  );
  assert.deepEqual(
    resolveSpawnCommand("git", ["status"], { platform: "win32" }),
    { command: "git", args: ["status"] },
  );
});

function writeRun(runId, overrides = {}) {
  const dir = join(runsRoot, runId);
  const worktree = join(dir, "integrate", "wt");
  const repoRoot = join(root, "fixture");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return writeStatus(runId, {
    runId,
    state: "done",
    repo: "fixture",
    repoRoot,
    target_dev_flow: "formal",
    baseRef: "main",
    startedAt: "2026-07-30T00:00:00.000Z",
    endedAt: "2026-07-30T00:01:00.000Z",
    lanes: [],
    integrate: {
      state: "ready",
      branch: `am/${runId}/integrate`,
      worktree,
      remote: "origin",
    },
    ...overrides,
  });
}

function formalExec(branch, mode = "merged") {
  let views = 0;
  return (command, args) => {
    if (command === "git") {
      if (args.includes("--version")) return ok("git version test");
      if (args.includes("branch") && args.includes("--show-current")) return ok(branch);
      if (args.includes("status")) return ok("");
      return ok();
    }
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth" && args[1] === "status") return ok("authenticated");
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      views += 1;
      if (views === 1) {
        return ok(JSON.stringify({
          state: "OPEN",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
          url: "https://example.invalid/pull/7",
          number: 7,
          headRefName: branch,
          baseRefName: "main",
        }));
      }
      if (mode === "conflict") {
        return ok(JSON.stringify({
          state: "OPEN",
          mergeStateStatus: "DIRTY",
          mergeable: "CONFLICTING",
          statusCheckRollup: [],
          url: "https://example.invalid/pull/7",
          number: 7,
          headRefName: branch,
          baseRefName: "main",
        }));
      }
      return ok(JSON.stringify({
        state: "MERGED",
        mergeStateStatus: "UNKNOWN",
        mergeable: "UNKNOWN",
        statusCheckRollup: [],
        url: "https://example.invalid/pull/7",
        number: 7,
        headRefName: branch,
        baseRefName: "main",
        mergeCommit: { oid: "abc123" },
      }));
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") return ok();
    return fail(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("ship handoff requires the exact approval and release inputs", () => {
  const runId = "run-ship-contract";
  writeRun(runId);
  assert.throws(() => prepareShipHandoff(runId, {}), /--approve all\|through-pr/);
  assert.throws(
    () => prepareShipHandoff(runId, { approve: "all" }),
    /--version <semver>/,
  );
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
  });
  assert.equal(handoff.flow, "formal");
  assert.equal(handoff.branch, `am/${runId}/integrate`);
});

test("Formal through-pr shipping records PR merge telemetry and events", async () => {
  const runId = "run-ship-through-pr";
  const initial = writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const queued = readStatus(runId);
  const result = await runShip(runId, handoff, {
    exec: formalExec(handoff.branch),
    sleep: async () => {},
  });
  assert.equal(result.state, "done");
  assert.equal(result.ship.state, "done");
  assert.equal(result.ship.prUrl, "https://example.invalid/pull/7");
  assert.equal(result.ship.mergeSha, "abc123");
  assert.equal(result.ship.tag, null);
  const events = readEvents(runId);
  assert.ok(events.some((event) => event.ship?.phase === "merge"));
  assert.equal(classifyWake(initial, queued).reason, "state_change");
});

test("Formal merge conflicts block and wake the operator", async () => {
  const runId = "run-ship-conflict";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const running = readStatus(runId);
  const result = await runShip(runId, handoff, {
    exec: formalExec(handoff.branch, "conflict"),
    sleep: async () => {},
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.ship.state, "blocked");
  assert.match(result.ship.needsInput.prompt, /merge conflicts/);
  const wake = classifyWake(running, result);
  assert.equal(wake.reason, "needs_input");
  assert.equal(wake.phase, "ship");

  const retry = prepareShipHandoff(runId, {
    approve: "through-pr",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, retry);
  const recovered = await runShip(runId, retry, {
    exec: formalExec(retry.branch),
    sleep: async () => {},
  });
  assert.equal(recovered.state, "done");
  assert.equal(recovered.ship.attempt, 2);
});

test("Simple all shipping stamps, pushes, waits for CI, and tags", async () => {
  const runId = "run-ship-simple";
  const repo = join(root, "simple-repo");
  const remote = join(root, "simple-remote.git");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, "Version.md"),
    "---\nenabled: true\ncurrent: 1.0.0\ndev_flow: simple\n---\n\n# Version History\n\n## 1.0.0 - 2026-07-01\n\nInitial release.\n",
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }, null, 2) + "\n",
  );
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "chore: initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });

  writeRun(runId, {
    repo: ".",
    repoRoot: repo,
    target_dev_flow: "simple",
    integrate: undefined,
  });
  const handoff = prepareShipHandoff(runId, {
    approve: "all",
    branch: "main",
    base: "main",
    remote: "origin",
    commitMessage: "feat: ship approved release",
    version: "1.1.0",
    summary: "Add detached shipping.",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const exec = (command, args, options) => {
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth" && args[1] === "status") return ok("authenticated");
    if (command === "gh" && args[0] === "run" && args[1] === "list") {
      return ok(JSON.stringify([{
        databaseId: 1,
        status: "completed",
        conclusion: "success",
        url: "https://example.invalid/actions/1",
        workflowName: "CI",
        event: "push",
      }]));
    }
    return execCommand(command, args, options);
  };
  const result = await runShip(runId, handoff, { exec, sleep: async () => {} });
  assert.equal(result.state, "done");
  assert.equal(result.ship.tag, "v1.1.0");
  assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version, "1.1.0");
  assert.equal(
    execFileSync("git", ["ls-remote", "--tags", remote, "refs/tags/v1.1.0"], { encoding: "utf8" }).trim().length > 0,
    true,
  );
  assert.equal(existsSync(join(runsRoot, runId, "ship", "summary.json")), true);
});

test("CLI ship detaches and completes in the background", async () => {
  const runId = "run-ship-detached";
  const repo = join(root, "detached-repo");
  const remote = join(root, "detached-remote.git");
  const fakeGh = join(root, "fake-gh.mjs");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
  writeFileSync(
    join(repo, "Version.md"),
    "---\nenabled: true\ncurrent: 1.0.0\ndev_flow: simple\n---\n\n# Version History\n\n## 1.0.0 - 2026-07-01\n\nInitial release.\n",
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "detached-fixture", version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify({ name: "detached-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "detached-fixture", version: "1.0.0" } } }, null, 2) + "\n",
  );
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "chore: initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });
  writeFileSync(
    fakeGh,
    [
      'if (process.argv[2] === "--version") {',
      '  console.log("gh version test");',
      '} else if (process.argv[2] === "auth" && process.argv[3] === "status") {',
      '  console.log("authenticated");',
      "} else {",
      '  console.error("unexpected fake gh command");',
      "  process.exitCode = 2;",
      "}",
    ].join("\n") + "\n",
  );
  writeRun(runId, {
    repo: ".",
    repoRoot: repo,
    target_dev_flow: "simple",
    integrate: undefined,
  });

  const cli = join(process.cwd(), "bin", "agent-manager.mjs");
  const launch = JSON.parse(execFileSync(
    process.execPath,
    [
      cli,
      "ship",
      runId,
      "--approve",
      "all",
      "--branch",
      "main",
      "--base",
      "main",
      "--commit-message",
      "feat: detached approved release",
      "--version",
      "1.1.0",
      "--summary",
      "Add detached shipping.",
      "--detach",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_MANAGER_GH_BIN: fakeGh },
      encoding: "utf8",
      windowsHide: true,
    },
  ));
  assert.equal(launch.state, "detached");
  assert.equal(launch.phase, "ship");

  const deadline = Date.now() + 20_000;
  let status;
  while (Date.now() < deadline) {
    status = readStatus(runId);
    if (["done", "blocked", "failed", "cancelled"].includes(status?.state)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.equal(status?.state, "done", readFileSync(launch.supervisorLog, "utf8"));
  assert.equal(status.ship.tag, "v1.1.0");
});

test("diagnoseBlockedMerge detects required check name mismatch", () => {
  const pr = {
    state: "OPEN",
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
    reviewDecision: "",
    baseRefName: "main",
    statusCheckRollup: [
      {
        name: "Quality + mandatory Chromium journey",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
  };
  const exec = (command, args) => {
    assert.equal(command, "gh");
    assert.ok(args.includes("repos/{owner}/{repo}/branches/main/protection/required_status_checks"));
    return ok(JSON.stringify(["quality"]));
  };
  const error = diagnoseBlockedMerge(pr, exec, root);
  assert.ok(error instanceof ShipBlockedError);
  assert.match(error.message, /exact name: quality/);
  assert.match(error.message, /Quality \+ mandatory Chromium journey/);
  assert.ok(error.options.some((option) => /display name/i.test(option)));
  assert.ok(error.options.some((option) => /human PR approval/i.test(option)));
});

test("diagnoseBlockedMerge waits while checks are still running", () => {
  const error = diagnoseBlockedMerge(
    {
      state: "OPEN",
      mergeStateStatus: "BLOCKED",
      reviewDecision: "",
      baseRefName: "main",
      statusCheckRollup: [
        { name: "quality", status: "IN_PROGRESS", conclusion: "" },
      ],
    },
    () => ok(JSON.stringify(["quality"])),
    root,
  );
  assert.equal(error, null);
});
