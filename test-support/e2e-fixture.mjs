import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// Each importing test file gets a fully isolated fixture: its own temp root,
// git repository, runs root, claim log, feed server, and frozen context file.
// Nothing here may be shared across Node test-file processes.
export async function createE2eFixture() {
  const cli = join(process.cwd(), "bin", "agent-manager.mjs");
  const root = mkdtempSync(join(tmpdir(), "agent-manager-e2e-"));
  const runsRoot = join(root, ".runs");
  const repo = join(root, "fixture-repo");
  const tools = join(root, "tools");
  const claimLog = join(root, "claim.log");
  mkdirSync(repo, { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(repo, "README.md"), "fixture\n");
  writeFileSync(join(repo, "agent-manager.context.md"), [
    "# E2E shared context",
    "",
    "Every lane must preserve the fixture contract.",
    "",
  ].join("\n"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "add", "README.md", "agent-manager.context.md"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", repo]);
  const fixtureBase = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
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

  const feedEvents = [];
  const feedServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    feedEvents.push(JSON.parse(payload.body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "event-" + feedEvents.length, cursor: "cursor-" + feedEvents.length }));
  });
  await new Promise((resolve) => feedServer.listen(0, "127.0.0.1", resolve));
  const feedPort = feedServer.address().port;

  const env = {
    ...process.env,
    AGENT_MANAGER_DEV_ROOT: root,
    AGENT_MANAGER_RUNS_ROOT: runsRoot,
    AGENT_MANAGER_CLAIM_BIN: claimScript,
    AGENT_MANAGER_TEST_MODE: "1",
    CLAIM_LOG: claimLog,
  };

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

  async function waitForFeed(event, runId, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (feedEvents.some((item) => item.event === event && item.runId === runId)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting for feed event " + event);
  }

  function baseWorkflow(lanes) {
    return {
      repo: "fixture-repo",
      harness_default: "fake",
      target_dev_flow: "formal",
      feed: {
        enabled: true,
        baseUrl: "http://127.0.0.1:" + feedPort,
        topic: "agent-manager/tests",
      },
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
      planning: {
        source_refs: ["test-source"],
        plan_ref: "test-plan",
        context_file: "agent-manager.context.md",
        reviewed_base_sha: fixtureBase,
        verified_by: "test-manager",
        verified_at: "2026-01-01T00:00:00Z",
        reviewed_paths: ["README.md", "agent-manager.context.md"],
        repository_instruction_refs: ["test fixture instructions"],
        attestations: {
          source_reviewed: true,
          repository_instructions_reviewed: true,
          relevant_code_reviewed: true,
          scope_verified: true,
        },
      },
      lanes,
    };
  }

  async function close() {
    await new Promise((resolve) => feedServer.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }

  return {
    root,
    runsRoot,
    repo,
    claimLog,
    fixtureBase,
    feedEvents,
    writeWorkflow,
    runCli,
    waitForStatus,
    waitForFeed,
    baseWorkflow,
    close,
  };
}
