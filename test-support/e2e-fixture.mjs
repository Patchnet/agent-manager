import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertIsolated, isolatedRoot, sandboxRoot } from "./isolated-roots.mjs";

const execFileAsync = promisify(execFile);

// Each importing test file gets a fully isolated fixture: its own temp root,
// git repository, runs root, claims root, and claim log. Nothing here may be shared across Node test-file processes,
// and nothing here may resolve onto an operator's real registries.
export async function createE2eFixture() {
  const cli = join(process.cwd(), "bin", "agent-manager.mjs");
  const root = isolatedRoot("e2e-");
  const runsRoot = join(root, ".runs");
  const claimsRoot = join(root, ".claims");
  const repo = join(root, "fixture-repo");
  const tools = join(root, "tools");
  const claimLog = join(root, "claim.log");
  mkdirSync(repo, { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["init", "-b", "main", repo], { windowsHide: true });
  execFileSync("git", ["-C", repo, "add", "README.md"], { windowsHide: true });
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"], { windowsHide: true });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { windowsHide: true });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { windowsHide: true });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", repo], { windowsHide: true });
  const fixtureBase = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  appendFileSync(join(repo, ".git", "info", "exclude"), "\nAGENTS.md\n");
  writeFileSync(join(repo, "AGENTS.md"), "# Local fixture instructions\n");

  const claimScript = join(tools, "claim.mjs");
  writeFileSync(
    claimScript,
    [
      'import { appendFileSync } from "node:fs";',
      'appendFileSync(process.env.CLAIM_LOG, process.argv.slice(2).join(" ") + "\\n");',
      'console.log("ok");',
    ].join("\n"),
  );

  const env = {
    ...process.env,
    AGENT_MANAGER_TEST_ROOT: sandboxRoot(),
    AGENT_MANAGER_DEV_ROOT: root,
    AGENT_MANAGER_RUNS_ROOT: runsRoot,
    AGENT_MANAGER_CLAIMS_ROOT: claimsRoot,
    AGENT_MANAGER_CLAIM_BIN: claimScript,
    AGENT_MANAGER_TEST_MODE: "1",
    CLAIM_LOG: claimLog,
  };
  // An ambient AGENT_MANAGER_CONFIG must not reintroduce operator roots.
  delete env.AGENT_MANAGER_CONFIG;
  assertIsolated({ root, runsRoot, claimsRoot }, "e2e fixture");

  function writeWorkflow(name, value) {
    const path = join(root, name + ".json");
    writeFileSync(path, JSON.stringify(value, null, 2));
    return path;
  }

  async function runCli(args, timeout = 10_000) {
    return await execFileAsync("node", [cli, ...args], {
      cwd: process.cwd(),
      env,
      timeout,
      windowsHide: true,
    });
  }

  async function waitForStatus(runId, predicate, timeoutMs = 30_000) {
    const statusPath = join(runsRoot, runId, "status.json");
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      if (existsSync(statusPath)) {
        const status = JSON.parse(readFileSync(statusPath, "utf8"));
        assert.match(status.agentManager?.version || "", /^\d+\.\d+\.\d+/);
        latest = status;
        if (predicate(status)) return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out waiting for " + runId + ": " + JSON.stringify(latest));
  }

  async function waitForEvent(kind, runId, timeoutMs = 20_000) {
    const path = join(runsRoot, runId, "events.jsonl");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = existsSync(path)
        ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        : [];
      const found = events.find((item) => item.kind === kind);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting for event " + kind);
  }

  function baseWorkflow(lanes) {
    return {
      repo: "fixture-repo",
      harness_default: "fake",
      target_dev_flow: "formal",
      policy: {
        allow_commit: false,
        allow_pr: false,
        poll_interval_ms: 100,
        stall_timeout_sec: 5,
      },
      delivery: {
        mode: lanes.length > 1 ? "train" : "single",
        targets: lanes.map((lane) => ({ id: lane.id, lane: lane.id, base: "main" })),
      },
      lanes,
    };
  }

  async function close() {
    rmSync(root, { recursive: true, force: true });
  }

  return {
    root,
    runsRoot,
    claimsRoot,
    env,
    repo,
    claimLog,
    fixtureBase,
    writeWorkflow,
    runCli,
    waitForStatus,
    waitForEvent,
    baseWorkflow,
    close,
  };
}
