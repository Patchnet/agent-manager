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
  let latest = null;
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) {
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
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
  assert.equal(launchPayload.runtime.hostPlatform, process.platform);

  const blocked = await waitForStatus(runId, (status) => status.state === "blocked");
  const writer = blocked.lanes.find((lane) => lane.id === "writer");
  const question = blocked.lanes.find((lane) => lane.id === "question");
  assert.equal(writer.state, "done");
  assert.equal(question.state, "blocked");
  assert.match(question.sessionId, /^fake-/);
  assert.equal(question.claim.state, "retained");
  for (const lane of [writer, question]) {
    assert.deepEqual(lane.inheritedInstructionFiles, ["AGENTS.md"]);
    assert.equal(
      readFileSync(join(lane.worktree, "AGENTS.md"), "utf8"),
      "# Local fixture instructions\n",
    );
  }
  assert.equal(blocked.planning.state, "verified");
  assert.equal(blocked.runtime.hostPlatform, process.platform);
  assert.equal(blocked.planning.reviewedBaseSha, fixtureBase);
  assert.match(blocked.planning.contextDigest, /^[0-9a-f]{64}$/);
  const frozenContext = readFileSync(join(runsRoot, runId, "planning-context.md"), "utf8");
  assert.match(frozenContext, /Every lane must preserve the fixture contract/);
  const writerPrompt = readFileSync(join(runsRoot, runId, "writer", "prompt.md"), "utf8");
  const questionPrompt = readFileSync(join(runsRoot, runId, "question", "prompt.md"), "utf8");
  for (const prompt of [writerPrompt, questionPrompt]) {
    assert.match(prompt, /## Verified shared planning context/);
    assert.match(prompt, /Every lane must preserve the fixture contract/);
    assert.match(prompt, new RegExp(blocked.planning.contextDigest));
  }
  writeFileSync(
    join(repo, "agent-manager.context.md"),
    "This later edit must not change the active run.\n",
  );
  await waitForFeed("needs_input", runId);

  const reply = await runCli([
    "reply", runId, "question", "--message", "Use the approved value.", "--json",
  ]);
  const replyPayload = JSON.parse(reply.stdout.trim());
  assert.equal(replyPayload.sessionId, question.sessionId);
  assert.equal(replyPayload.state, "running");

  const done = await waitForStatus(runId, (status) => status.state === "delivery_review_pending");
  const resumed = done.lanes.find((lane) => lane.id === "question");
  assert.equal(resumed.sessionId, question.sessionId);
  assert.equal(resumed.state, "done");
  assert.equal(resumed.claim.state, "released");
  assert.ok(existsSync(join(resumed.worktree, "resume.txt")));
  assert.equal(
    readFileSync(join(runsRoot, runId, "planning-context.md"), "utf8"),
    frozenContext,
  );
  await waitForFeed("workers_done", runId);

  const reviewOutput = await runCli(["review", runId, "--json"]);
  const review = JSON.parse(reviewOutput.stdout.trim());
  assert.equal(review.schema, "agent-manager.review.v1");
  assert.ok(existsSync(review.path));
  assert.match(review.markdown, /Planning preflight: \*\*verified\*\*/);
  assert.match(review.markdown, new RegExp(done.planning.contextDigest));
  assert.match(review.markdown, /WAIT_OPERATOR/);
  assert.equal(JSON.parse(readFileSync(join(runsRoot, runId, "status.json"), "utf8")).delivery.review.state, "awaiting_operator");
  const waitingCadence = JSON.parse((await runCli(["next-action", runId, "--json"])).stdout.trim());
  assert.equal(waitingCadence.transition, "WAIT_OPERATOR");
  assert.deepEqual(waitingCadence.operatorInputRequired, [
    "accept", "accept-with-notes", "revise", "relaunch", "reject",
  ]);

  const acceptedOutput = await runCli([
    "review", runId, "--pass", "1", "--verdict", "accept-with-notes",
    "--reviewer", "test-manager", "--notes", "fixture accepted", "--json",
  ]);
  const accepted = JSON.parse(acceptedOutput.stdout.trim());
  assert.equal(accepted.verdict, "accept-with-notes");
  assert.equal(accepted.state, "ship_gate_pending");
  assert.ok(existsSync(accepted.decisionPath));
  assert.match(accepted.markdown, /AUTO_CONTINUE/);
  const acceptedCadence = JSON.parse((await runCli(["next-action", runId, "--json"])).stdout.trim());
  assert.equal(acceptedCadence.transition, "AUTO_CONTINUE");
  assert.equal(acceptedCadence.stage, "ship_gate_ready");

  const eventNames = feedEvents.filter((item) => item.runId === runId).map((item) => item.event);
  assert.ok(eventNames.includes("run_started"));
  assert.ok(eventNames.filter((name) => name === "lane_started").length >= 3);
  assert.ok(eventNames.includes("lane_done"));
  assert.ok(eventNames.includes("needs_input"));
  assert.ok(eventNames.includes("workers_done"));
  const report = readFileSync(join(runsRoot, runId, "report.md"), "utf8");
  assert.match(report, /\*\*ended:\*\* -/);
  assert.match(report, /## Planning preflight/);
  assert.match(report, new RegExp(done.planning.contextDigest));
  const claims = readFileSync(claimLog, "utf8");
  assert.match(claims, /release --repo fixture-repo --branch am\/run-test-reply\/writer/);
  assert.match(claims, /release --repo fixture-repo --branch am\/run-test-reply\/question/);
  await runCli(["cancel", runId]);
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

test("a zero-change implementation lane fails before delivery review", async () => {
  const runId = "run-zero-change";
  const workflow = writeWorkflow("zero-change", baseWorkflow([{
    id: "empty",
    kind: "implementation",
    scope: "zero-change.txt",
    prompt: "Exit successfully without writing code.",
    fake: { delay_ms: 10, exit_code: 0 },
  }]));
  await runCli(["run", workflow, "--detach", "--run-id", runId, "--json"]);
  const failed = await waitForStatus(runId, (status) => status.state === "failed");
  assert.equal(failed.lanes[0].completion.state, "failed");
  assert.match(failed.lanes[0].completion.reason, /zero changed files/);
  assert.notEqual(failed.state, "delivery_review_pending");
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
  await waitForStatus(runId, (status) => status.state === "delivery_review_pending" && !status.integrate);
  const integratedOutput = await runCli(["integrate", runId, "--json"]);
  const integrated = JSON.parse(integratedOutput.stdout.trim());
  assert.equal(integrated.state, "delivery_review_pending");
  assert.equal(integrated.integrate.state, "ready");
  assert.equal(integrated.integrate.claim.state, "released");
  assert.ok(existsSync(join(integrated.integrate.worktree, "integrated.txt")));
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("failed integrated verification blocks delivery with command evidence", async () => {
  const runId = "run-test-verification-block";
  const workflow = writeWorkflow("verification-block", {
    ...baseWorkflow([
      {
        id: "implementation",
        scope: "verified.txt",
        prompt: "write verification fixture",
        fake: { write: { path: "verified.txt", content: "verify\n" } },
      },
    ]),
    verification: {
      commands: [{ command: "node", args: ["-e", "process.exit(9)"] }],
      timeout_sec: 10,
    },
  });
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  await waitForStatus(runId, (status) => status.state === "delivery_review_pending" && !status.integrate);
  const output = await runCli(["integrate", runId, "--json"]);
  const blocked = JSON.parse(output.stdout.trim());
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.endedAt, null);
  assert.equal(blocked.integrate.verification.state, "failed");
  assert.equal(blocked.integrate.verification.commands[0].exitCode, 9);
  assert.match(blocked.integrate.needsInput.prompt, /verification failed/);
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("five lanes honor bounded concurrency and complete from one immutable base", async () => {
  const runId = "run-test-five-lanes";
  const workflow = writeWorkflow("five-lanes", {
    ...baseWorkflow([1, 2, 3, 4, 5].map((index) => ({
      id: `lane-${index}`,
      scope: `lane-${index}.txt`,
      prompt: `write lane ${index}`,
      fake: {
        delay_ms: 180,
        write: { path: `lane-${index}.txt`, content: `${index}\n` },
      },
    }))),
    max_concurrency: 2,
  });
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);

  let maxRunning = 0;
  const done = await waitForStatus(runId, (status) => {
    maxRunning = Math.max(
      maxRunning,
      status.lanes.filter((lane) => lane.state === "running").length,
    );
    return status.state === "delivery_review_pending";
  });
  assert.equal(done.state, "delivery_review_pending", JSON.stringify(done, null, 2));
  assert.ok(done.execution.endedAt);
  assert.equal(done.lanes.length, 5);
  assert.ok(done.lanes.every((lane) => lane.state === "done"));
  assert.ok(maxRunning <= 2, `observed ${maxRunning} concurrent lanes`);
  assert.equal(new Set(done.lanes.map((lane) => lane.runBaseCommit)).size, 1);
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("dependent lanes can sequentially update prerequisite-owned files", async () => {
  const runId = "run-test-dependencies";
  const workflow = writeWorkflow("dependencies", baseWorkflow([
    {
      id: "contracts",
      scope: "contract.txt",
      prompt: "write contract",
      fake: { write: { path: "contract.txt", content: "contract\n" } },
    },
    {
      id: "consumer",
      depends_on: ["contracts"],
      scope: "contract.txt",
      prompt: "extend contract",
      fake: { write: { path: "contract.txt", content: "contract\nconsumer\n" } },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const done = await waitForStatus(runId, (status) => status.state === "delivery_review_pending");
  const consumer = done.lanes.find((lane) => lane.id === "consumer");
  assert.deepEqual(consumer.dependenciesIntegrated, ["contracts"]);
  assert.ok(existsSync(join(consumer.worktree, "contract.txt")));
  assert.equal(
    readFileSync(join(consumer.worktree, "contract.txt"), "utf8").replace(/\r\n/g, "\n"),
    "contract\nconsumer\n",
  );
  assert.deepEqual(consumer.changedFiles, ["contract.txt"]);

  const integratedOutput = await runCli(["integrate", runId, "--json"]);
  const integrated = JSON.parse(integratedOutput.stdout.trim());
  assert.equal(integrated.integrate.state, "ready");
  assert.ok(existsSync(join(integrated.integrate.worktree, "contract.txt")));
  assert.equal(
    readFileSync(join(integrated.integrate.worktree, "contract.txt"), "utf8")
      .replace(/\r\n/g, "\n"),
    "contract\nconsumer\n",
  );
  assert.deepEqual(integrated.integrate.approvedChangedFileOverlaps, [
    { file: "contract.txt", lanes: ["contracts", "consumer"] },
  ]);
  await runCli(["cancel", runId]);
  await runCli(["cleanup", runId]);
});

test("blocked prerequisites resume before dependent lanes launch", async () => {
  const runId = "run-test-dependent-resume";
  const workflow = writeWorkflow("dependent-resume", baseWorkflow([
    {
      id: "approval",
      scope: "approved.txt",
      prompt: "request approval",
      fake: {
        needs_input: "Approve the contract?",
        resume: { write: { path: "approved.txt", content: "approved\n" } },
      },
    },
    {
      id: "consumer",
      depends_on: ["approval"],
      scope: "consumer-after-approval.txt",
      prompt: "consume approval",
      fake: {
        write: { path: "consumer-after-approval.txt", content: "consumed\n" },
      },
    },
  ]));
  await runCli(["run", workflow, "--detach", "--json", "--run-id", runId]);
  const blocked = await waitForStatus(runId, (status) =>
    status.state === "blocked" &&
    status.lanes.find((lane) => lane.id === "approval")?.state === "blocked"
  );
  assert.equal(
    blocked.lanes.find((lane) => lane.id === "consumer").state,
    "dependency-waiting",
  );

  await runCli([
    "reply", runId, "approval", "--message", "Approved.", "--json",
  ]);
  const done = await waitForStatus(
    runId,
    (status) => status.state === "delivery_review_pending",
    40_000,
  );
  const consumer = done.lanes.find((lane) => lane.id === "consumer");
  assert.equal(consumer.state, "done");
  assert.deepEqual(consumer.dependenciesIntegrated, ["approval"]);
  assert.ok(existsSync(join(consumer.worktree, "approved.txt")));
  await runCli(["cancel", runId]);
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
