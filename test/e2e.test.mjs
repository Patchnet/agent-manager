import test from "node:test";
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
const cli = join(process.cwd(), "bin", "agent-manager.mjs");
const root = mkdtempSync(join(tmpdir(), "agent-manager-e2e-"));
const runsRoot = join(root, ".runs");
const repo = join(root, "fixture-repo");
const tools = join(root, "tools");
const claimLog = join(root, "claim.log");
mkdirSync(repo, { recursive: true });
mkdirSync(tools, { recursive: true });
writeFileSync(join(repo, "README.md"), "fixture\n");
execFileSync("git", ["init", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "add", "README.md"]);
execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
execFileSync("git", ["-C", repo, "remote", "add", "origin", repo]);

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

test.after(async () => {
  await new Promise((resolve) => feedServer.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

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
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) {
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      if (predicate(status)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for " + runId);
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
    lanes,
  };
}

test("detached run publishes feed events, resumes the exact session, and releases claims", async () => {
  const runId = "run-test-reply";
  const workflow = writeWorkflow("reply", baseWorkflow([
    {
      id: "writer",
      scope: "allowed.txt",
      prompt: "write allowed file",
      fake: { write: { path: "allowed.txt", content: "allowed\n" } },
    },
    {
      id: "question",
      scope: "resume.txt",
      prompt: "ask then resume",
      fake: {
        needs_input: "Which value should I use?",
        resume: { write: { path: "resume.txt", content: "answered\n" } },
      },
    },
  ]));

  const launchStarted = Date.now();
  const launch = await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  assert.ok(Date.now() - launchStarted < 1_000, "detached launch should return immediately");
  const launchPayload = JSON.parse(launch.stdout.trim());
  assert.equal(launchPayload.runId, runId);
  assert.equal(launchPayload.state, "detached");

  const blocked = await waitForStatus(runId, (status) => status.state === "blocked");
  const writer = blocked.lanes.find((lane) => lane.id === "writer");
  const question = blocked.lanes.find((lane) => lane.id === "question");
  assert.equal(writer.state, "done");
  assert.equal(question.state, "blocked");
  assert.match(question.sessionId, /^fake-/);
  assert.equal(question.claim.state, "retained");
  await waitForFeed("needs_input", runId);

  const reply = await runCli([
    "reply", runId, "question", "--message", "Use the approved value.", "--json",
  ]);
  const replyPayload = JSON.parse(reply.stdout.trim());
  assert.equal(replyPayload.sessionId, question.sessionId);
  assert.equal(replyPayload.state, "running");

  const done = await waitForStatus(runId, (status) => status.state === "done" && status.endedAt);
  const resumed = done.lanes.find((lane) => lane.id === "question");
  assert.equal(resumed.sessionId, question.sessionId);
  assert.equal(resumed.state, "done");
  assert.equal(resumed.claim.state, "released");
  assert.ok(existsSync(join(resumed.worktree, "resume.txt")));
  await waitForFeed("run_done", runId);

  const reviewOutput = await runCli(["review", runId, "--json"]);
  const review = JSON.parse(reviewOutput.stdout.trim());
  assert.equal(review.schema, "agent-manager.review.v1");
  assert.ok(existsSync(review.path));

  const eventNames = feedEvents.filter((item) => item.runId === runId).map((item) => item.event);
  assert.ok(eventNames.includes("run_started"));
  assert.ok(eventNames.filter((name) => name === "lane_started").length >= 3);
  assert.ok(eventNames.includes("lane_done"));
  assert.ok(eventNames.includes("needs_input"));
  assert.ok(eventNames.includes("run_done"));
  const report = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
  assert.doesNotMatch(report, /\*\*ended:\*\* -/);
  const claims = readFileSync(claimLog, "utf8");
  assert.match(claims, /release --repo fixture-repo --branch am\/run-test-reply\/writer/);
  assert.match(claims, /release --repo fixture-repo --branch am\/run-test-reply\/question/);
  await runCli(["cleanup", runId]);
});

test("scope violations fail the lane and publish run_failed", async () => {
  const runId = "run-test-scope";
  const workflow = writeWorkflow("scope", baseWorkflow([
    {
      id: "scoped",
      scope: "allowed-only.txt",
      prompt: "write outside scope",
      fake: { write: { path: "outside.txt", content: "violation\n" } },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const failed = await waitForStatus(runId, (status) => status.state === "failed");
  assert.deepEqual(failed.lanes[0].scopeViolations, ["outside.txt"]);
  assert.match(failed.lanes[0].lastActivity, /scope violation/);
  assert.equal(failed.lanes[0].claim.state, "released");
  await waitForFeed("run_failed", runId);
  await runCli(["cleanup", runId]);
});

test("manual integrate folds a successful lane and releases its integration claim", async () => {
  const runId = "run-test-integrate";
  const workflow = writeWorkflow("integrate", baseWorkflow([
    {
      id: "integration",
      scope: "integrated.txt",
      prompt: "write integration file",
      fake: { write: { path: "integrated.txt", content: "integrated\n" } },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "done" && !status.integrate);
  const integratedOutput = await runCli(["integrate", runId, "--json"]);
  const integrated = JSON.parse(integratedOutput.stdout.trim());
  assert.equal(integrated.state, "done");
  assert.equal(integrated.integrate.state, "ready");
  assert.equal(integrated.integrate.claim.state, "released");
  assert.ok(existsSync(join(integrated.integrate.worktree, "integrated.txt")));
  await runCli(["cleanup", runId]);
});

test("cancel remains authoritative and cleanup removes abandoned worktrees and logs", async () => {
  const runId = "run-test-cancel";
  const workflow = writeWorkflow("cancel", baseWorkflow([
    {
      id: "slow",
      scope: "slow.txt",
      prompt: "wait",
      fake: { delay_ms: 250, write: { path: "slow.txt", content: "late\n" } },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const running = await waitForStatus(runId, (status) => status.lanes?.[0]?.state === "running");
  const worktree = running.lanes[0].worktree;
  await runCli(["cancel", runId, "--remove-worktrees"]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const cancelled = JSON.parse(readFileSync(join(runsRoot, runId, "status.json"), "utf8"));
  assert.equal(cancelled.state, "cancelled");
  assert.ok(cancelled.endedAt);
  await waitForFeed("run_failed", runId);

  cancelled.repo = ".";
  writeFileSync(join(runsRoot, runId, "status.json"), JSON.stringify(cancelled, null, 2));
  await runCli(["cleanup", runId]);
  const cleaned = JSON.parse(readFileSync(join(runsRoot, runId, "status.json"), "utf8"));
  assert.ok(cleaned.cleanup.at);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(join(runsRoot, runId, "slow")), false);
  assert.equal(existsSync(join(runsRoot, runId, "status.json")), true);
});
