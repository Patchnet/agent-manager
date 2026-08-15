import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-reply-failed-"));
const runsRoot = join(root, "runs");
const claimsRoot = join(root, "claims");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
process.env.AGENT_MANAGER_CLAIMS_ROOT = claimsRoot;

test.after(() => rmSync(root, { recursive: true, force: true }));

const { prepareReply } = await import("../src/reply.mjs?reply-failed-test");
const { readStatus, writeStatus } = await import("../src/status.mjs?reply-failed-test");

let counter = 0;

/**
 * A run that ended `failed` because one lane died after raising needs-input —
 * the resume-crash shape this recovery path exists for.
 */
function failedRunFixture({ laneOverrides = {}, extraLanes = [], worktree = true } = {}) {
  counter += 1;
  const runId = `run-recover-${counter}`;
  const laneDir = join(runsRoot, runId, "lane");
  const lanePath = join(laneDir, "wt");
  mkdirSync(worktree ? lanePath : laneDir, { recursive: true });
  const endedAt = new Date().toISOString();
  writeStatus(runId, {
    runId,
    state: "failed",
    error: "lane lane failed: harness exited 2",
    repo: "repo",
    repoRoot: repo,
    claimMode: "off",
    startedAt: endedAt,
    endedAt,
    execution: { state: "failed", endedAt },
    supervisor: { pid: null, startedAt: endedAt, kind: "run" },
    lanes: [
      {
        id: "lane",
        harness: "fake",
        state: "failed",
        attempt: 2,
        pid: null,
        exitCode: 2,
        sessionId: "fake-session",
        branch: `am/${runId}/lane`,
        scope: "src/**",
        worktree: lanePath,
        endedAt,
        needsInput: null,
        lastActivity: "harness exited 2",
        ...laneOverrides,
      },
      ...extraLanes,
    ],
  });
  return { runId, laneDir, worktree: lanePath, markerPath: join(laneDir, "needs-input.json") };
}

function writeMarker(path) {
  writeFileSync(
    path,
    JSON.stringify({ type: "question", prompt: "which base?", blocking: true }, null, 2),
  );
}

test("reply answers a failed lane that still holds its needs-input marker", () => {
  const { runId, laneDir, markerPath } = failedRunFixture();
  writeMarker(markerPath);

  const prepared = prepareReply(runId, "lane", "Use the approved value.");

  assert.equal(prepared.recovered, true);
  assert.equal(prepared.previousLaneState, "failed");
  assert.equal(prepared.previousRunState, "failed");
  assert.equal(prepared.lane.state, "running");
  assert.equal(prepared.lane.attempt, 3);
  assert.equal(prepared.lane.exitCode, null);
  assert.equal(prepared.lane.endedAt, null);
  assert.equal(prepared.lane.recovery.from, "failed");
  assert.equal(prepared.lane.recovery.needsInputMarker, true);
  assert.equal(prepared.lane.recovery.forced, false);
  assert.equal(existsSync(markerPath), false, "the answered escalation is cleared");
  assert.equal(
    readFileSync(join(laneDir, "reply-3.txt"), "utf8").trim(),
    "Use the approved value.",
  );

  const status = readStatus(runId);
  assert.equal(status.state, "running");
  assert.equal(status.endedAt, null);
  assert.equal(status.execution.state, "running");
  assert.equal(status.execution.endedAt, null);
  assert.equal(status.error, undefined, "the run-level failure is cleared with the lane's");
  assert.equal(status.lanes[0].state, "running");
});

test("a worktree escalation and a recorded needs-input both count as the marker", () => {
  const worktreeMarker = failedRunFixture();
  writeMarker(join(worktreeMarker.worktree, "needs-input.json"));
  assert.equal(prepareReply(worktreeMarker.runId, "lane", "use main").lane.state, "running");
  assert.equal(
    existsSync(join(worktreeMarker.worktree, "needs-input.json")),
    false,
    "the worktree escalation is cleared too",
  );

  const recorded = failedRunFixture({
    laneOverrides: { needsInput: { type: "question", prompt: "which base?", blocking: true } },
  });
  const prepared = prepareReply(recorded.runId, "lane", "use main");
  assert.equal(prepared.lane.state, "running");
  assert.equal(prepared.lane.needsInput, null);
  assert.equal(prepared.lane.recovery.needsInputMarker, true);
});

test("a failed lane with no escalation needs --force", () => {
  const silent = failedRunFixture();
  assert.throws(
    () => prepareReply(silent.runId, "lane", "keep going"),
    /failed without a needs-input marker; rerun with --force/,
  );
  assert.equal(readStatus(silent.runId).state, "failed", "a refused reply changes nothing");
  assert.equal(readStatus(silent.runId).lanes[0].state, "failed");

  const forced = prepareReply(silent.runId, "lane", "keep going", { force: true });
  assert.equal(forced.lane.state, "running");
  assert.equal(forced.lane.recovery.forced, true);
  assert.equal(forced.lane.recovery.needsInputMarker, false);
});

test("recovery refuses a lane with nothing left to resume", () => {
  const gone = failedRunFixture({ worktree: false });
  writeMarker(gone.markerPath);
  assert.throws(
    () => prepareReply(gone.runId, "lane", "keep going"),
    /has no worktree left to resume/,
  );

  const sessionless = failedRunFixture({ laneOverrides: { sessionId: null } });
  writeMarker(sessionless.markerPath);
  assert.throws(
    () => prepareReply(sessionless.runId, "lane", "keep going"),
    /no harness session id to resume/,
  );
});

test("the run-level failure survives while another lane is still failed", () => {
  const { runId, markerPath } = failedRunFixture({
    extraLanes: [{
      id: "other",
      harness: "fake",
      state: "failed",
      attempt: 1,
      sessionId: "fake-other",
      branch: "am/other/other",
      scope: "docs/**",
      worktree: null,
      lastActivity: "stalled",
    }],
  });
  writeMarker(markerPath);

  prepareReply(runId, "lane", "use main");
  const status = readStatus(runId);
  assert.equal(status.state, "running");
  assert.match(status.error, /harness exited 2/);
  assert.equal(status.lanes[1].state, "failed");
});

test("reply still refuses every state that is not blocked or failed", () => {
  for (const state of ["done", "running", "cancelled", "queued"]) {
    const { runId, markerPath } = failedRunFixture({ laneOverrides: { state } });
    writeMarker(markerPath);
    assert.throws(
      () => prepareReply(runId, "lane", "use main"),
      /is not blocked/,
      `${state} must not be replyable`,
    );
  }
});
