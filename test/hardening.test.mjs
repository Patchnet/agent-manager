import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-hardening-"));
const runsRoot = join(root, "runs");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;

execFileSync("git", ["init", "-b", "main", repo]);
writeFileSync(join(repo, "README.md"), "base\n");
execFileSync("git", ["-C", repo, "add", "README.md"]);
execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);

test.after(() => rmSync(root, { recursive: true, force: true }));

const { loadWorkflow, assertDangerousPermissionApproval } = await import("../src/workflow.mjs?hardening");
const { runDir } = await import("../src/paths.mjs?hardening");
const { currentHead, validateLaneGuardrails } = await import("../src/guardrails.mjs?hardening");
const { buildHarnessEnv } = await import("../src/environment.mjs?hardening");
const { getHarnessAdapter } = await import("../src/harness/index.mjs?hardening");
const { isTerminalState, readEvents, writeStatus } = await import("../src/status.mjs?hardening");
const { prepareReply, resumeLane } = await import("../src/reply.mjs?hardening");

function workflow(name, value) {
  const path = join(root, name + ".json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function valid(overrides = {}) {
  return {
    repo: "repo",
    lanes: [{ id: "lane", scope: "src/**", prompt: "work" }],
    ...overrides,
  };
}

test("workflow validation rejects traversal, duplicate ids, wrong booleans, credentials, and unknown fields", () => {
  assert.throws(() => loadWorkflow(workflow("scope-traversal", valid({ lanes: [{ id: "lane", scope: "../outside", prompt: "work" }] }))), /stay inside/);
  assert.throws(() => loadWorkflow(workflow("duplicate", valid({ lanes: [{ id: "same", scope: "src/**", prompt: "a" }, { id: "same", scope: "docs/**", prompt: "b" }] }))), /duplicate lane id/);
  assert.throws(() => loadWorkflow(workflow("boolean", valid({ policy: { allow_commit: "yes" } }))), /must be a boolean/);
  assert.throws(() => loadWorkflow(workflow("feed-creds", valid({ feed: { enabled: true, baseUrl: "https://user:pass@example.invalid" } }))), /must not embed credentials/);
  assert.throws(() => loadWorkflow(workflow("unknown", { ...valid(), surprise: true })), /unknown field/);
  assert.throws(() => runDir("../escape"), /safe slug/);
  assert.throws(() => runDir("run..escape"), /not safe for paths and Git refs/);
  assert.throws(() => loadWorkflow(workflow("invalid-ref-id", valid({ lanes: [{ id: "bad.lock", scope: "src/**", prompt: "work" }] }))), /not safe for paths and Git refs/);
});

test("dangerous permission policy needs a separate invocation approval", () => {
  const loaded = loadWorkflow(workflow("dangerous", valid({ policy: { dangerously_skip_permissions: true } })));
  assert.throws(() => assertDangerousPermissionApproval(loaded, false), /requires --allow-dangerous-permissions/);
  assert.doesNotThrow(() => assertDangerousPermissionApproval(loaded, true));
});

test("scope checks include committed changes even when commits are allowed", () => {
  const base = currentHead(repo);
  writeFileSync(join(repo, "outside.txt"), "committed outside\n");
  execFileSync("git", ["-C", repo, "add", "outside.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "outside"]);
  const result = validateLaneGuardrails({ worktree: repo, scope: "README.md", baseCommit: base, policy: { allow_commit: true } });
  assert.equal(result.commitCount, 1);
  assert.deepEqual(result.scopeViolations, ["outside.txt"]);
  assert.equal(result.ok, false);
});

test("worker environment is allowlisted and fake harness requires test process opt-in", () => {
  const source = { PATH: "bin", HOME: "home", UNRELATED_SECRET: "do-not-pass", EXTRA_SAFE: "yes" };
  assert.deepEqual(buildHarnessEnv(["EXTRA_SAFE"], source), { PATH: "bin", HOME: "home", EXTRA_SAFE: "yes", AGENT_MANAGER_WORKER: "1" });
  const previous = process.env.AGENT_MANAGER_TEST_MODE;
  delete process.env.AGENT_MANAGER_TEST_MODE;
  assert.throws(() => getHarnessAdapter("fake"), /test-only/);
  process.env.AGENT_MANAGER_TEST_MODE = "1";
  assert.equal(getHarnessAdapter("fake").name, "fake");
  if (previous === undefined) delete process.env.AGENT_MANAGER_TEST_MODE;
  else process.env.AGENT_MANAGER_TEST_MODE = previous;
});

test("blocked is resumable, and status transitions produce JSONL events", () => {
  const runId = "run-event-test";
  writeStatus(runId, { runId, state: "running", repo: "repo", startedAt: new Date().toISOString(), lanes: [{ id: "lane", harness: "claude", state: "running" }] });
  writeStatus(runId, { runId, state: "blocked", repo: "repo", startedAt: new Date().toISOString(), lanes: [{ id: "lane", harness: "claude", state: "blocked", needsInput: { prompt: "choose" } }] });
  assert.equal(isTerminalState("blocked"), false);
  assert.equal(isTerminalState("done"), true);
  const events = readEvents(runId);
  assert.equal(events.length, 2);
  assert.equal(events[1].state, "blocked");
  assert.equal(events[1].schema, "agent-manager.event.v1");
  assert.match(readFileSync(join(runsRoot, runId, "events.jsonl"), "utf8"), /"state":"blocked"/);
});
test("reply and resume reject forged paths outside the run", async () => {
  const runId = "run-reply-path-test";
  writeStatus(runId, {
    runId,
    state: "blocked",
    repo: "repo",
    repoRoot: repo,
    startedAt: new Date().toISOString(),
    lanes: [{ id: "lane", harness: "fake", state: "blocked", sessionId: "fake-session", worktree: root, needsInput: { prompt: "question" } }],
  });
  assert.throws(() => prepareReply(runId, "lane", "answer"), /escapes its configured root/);
  await assert.rejects(() => resumeLane(runId, "lane", join(root, "outside-message.txt")), /escapes its configured root/);
});
