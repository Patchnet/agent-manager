import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-reply-"));
const runsRoot = join(root, "runs");
const claimsRoot = join(root, "claims");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
process.env.AGENT_MANAGER_CLAIMS_ROOT = claimsRoot;

test.after(() => rmSync(root, { recursive: true, force: true }));

const {
  CORRECTION_TYPE,
  interruptLaneForCorrection,
  prepareCorrection,
  prepareReply,
} = await import("../src/reply.mjs?reply-test");
const { readStatus, writeStatus } = await import("../src/status.mjs?reply-test");

let counter = 0;
function runFixture(laneOverrides = {}) {
  counter += 1;
  const runId = `run-correction-${counter}`;
  const laneDir = join(runsRoot, runId, "lane");
  const worktree = join(laneDir, "wt");
  mkdirSync(worktree, { recursive: true });
  writeStatus(runId, {
    runId,
    state: "running",
    repo: "repo",
    repoRoot: repo,
    claimMode: "off",
    startedAt: new Date().toISOString(),
    supervisor: { pid: process.pid, startedAt: new Date().toISOString(), kind: "run" },
    lanes: [{
      id: "lane",
      harness: "fake",
      state: "running",
      attempt: 1,
      pid: 4242,
      sessionId: "fake-session",
      branch: `am/${runId}/lane`,
      scope: "src/**",
      worktree,
      lastActivity: "working",
      ...laneOverrides,
    }],
  });
  return { runId, laneDir, worktree, markerPath: join(laneDir, "needs-input.json") };
}

/** Stand in for the run supervisor: block the lane once it sees the marker. */
function supervisorSteps(runId, markerPath, { stopAfter = 1 } = {}) {
  let ticks = 0;
  return async () => {
    ticks += 1;
    if (ticks < stopAfter || !existsSync(markerPath)) return;
    const status = readStatus(runId);
    status.lanes[0].state = "blocked";
    status.lanes[0].pid = null;
    status.lanes[0].needsInput = JSON.parse(readFileSync(markerPath, "utf8"));
    status.state = "blocked";
    writeStatus(runId, status);
  };
}

test("a correction pauses a running lane and stages the message for harness resume", async () => {
  const { runId, laneDir, markerPath } = runFixture();
  const prepared = await prepareCorrection(runId, "lane", "rename the flag to --base", {
    pollMs: 1,
    sleep: supervisorSteps(runId, markerPath),
    isSupervisorAlive: () => true,
  });

  assert.equal(prepared.interrupted, true);
  assert.equal(prepared.correction.state, "blocked");
  assert.equal(prepared.lane.state, "running", "the lane is handed to the resume supervisor");
  assert.equal(prepared.lane.attempt, 2);
  assert.equal(prepared.lane.needsInput, null);
  assert.equal(
    readFileSync(join(laneDir, "reply-2.txt"), "utf8").trim(),
    "rename the flag to --base",
  );
  assert.equal(existsSync(markerPath), false, "the pause marker is cleared before resume");
  assert.equal(readStatus(runId).lanes[0].attempt, 2);
  assert.match(readStatus(runId).lanes[0].lastActivity, /operator correction/);
});

test("the pause marker is the supervisor's own needs-input contract", async () => {
  const { runId, markerPath } = runFixture();
  const result = await interruptLaneForCorrection(runId, "lane", "switch to the resolved base", {
    pollMs: 1,
    sleep: supervisorSteps(runId, markerPath, { stopAfter: 2 }),
    isSupervisorAlive: () => true,
  });

  assert.equal(result.interrupted, true);
  assert.equal(result.settled, true);
  const marker = readStatus(runId).lanes[0].needsInput;
  assert.equal(marker.type, CORRECTION_TYPE);
  assert.equal(marker.blocking, true);
  assert.equal(marker.source, "operator");
  assert.equal(marker.prompt, "switch to the resolved base");
});

test("a blocked lane keeps plain reply behaviour", async () => {
  const { runId, laneDir } = runFixture({
    state: "blocked",
    pid: null,
    needsInput: { type: "question", prompt: "which base?", blocking: true },
  });
  const prepared = await prepareCorrection(runId, "lane", "use main", {
    pollMs: 1,
    isSupervisorAlive: () => false,
  });

  assert.equal(prepared.interrupted, false);
  assert.equal(prepared.correction.state, "already-blocked");
  assert.equal(prepared.lane.attempt, 2);
  assert.equal(readFileSync(join(laneDir, "reply-2.txt"), "utf8").trim(), "use main");
});

test("a correction refuses to overwrite a question the worker already raised", async () => {
  const { runId, markerPath, worktree } = runFixture();
  writeFileSync(markerPath, JSON.stringify({ type: "question", prompt: "which base?" }));
  await assert.rejects(
    () => interruptLaneForCorrection(runId, "lane", "use main", { isSupervisorAlive: () => true }),
    /already raised needs-input/,
  );
  rmSync(markerPath, { force: true });

  writeFileSync(join(worktree, "needs-input.json"), JSON.stringify({ prompt: "which base?" }));
  await assert.rejects(
    () => interruptLaneForCorrection(runId, "lane", "use main", { isSupervisorAlive: () => true }),
    /already raised needs-input/,
    "a worktree escalation counts as well",
  );
});

test("a correction fails closed without a live supervisor, session, or pausable lane", async () => {
  const live = runFixture();
  await assert.rejects(
    () => interruptLaneForCorrection(live.runId, "lane", "use main", { isSupervisorAlive: () => false }),
    /no live supervisor/,
  );
  assert.equal(existsSync(live.markerPath), false);

  const sessionless = runFixture({ sessionId: null });
  await assert.rejects(
    () => interruptLaneForCorrection(sessionless.runId, "lane", "use main", { isSupervisorAlive: () => true }),
    /no harness session id yet/,
  );

  const finished = runFixture({ state: "done", pid: null });
  await assert.rejects(
    () => interruptLaneForCorrection(finished.runId, "lane", "use main", { isSupervisorAlive: () => true }),
    /corrections apply to running or blocked lanes/,
  );

  const empty = runFixture();
  await assert.rejects(
    () => interruptLaneForCorrection(empty.runId, "lane", "   ", { isSupervisorAlive: () => true }),
    /non-empty message/,
  );
  await assert.rejects(
    () => interruptLaneForCorrection(empty.runId, "missing", "use main", { isSupervisorAlive: () => true }),
    /no lane missing/,
  );
});

test("an undelivered correction clears its marker instead of leaving the lane paused", async () => {
  const timedOut = runFixture();
  let clock = 0;
  await assert.rejects(
    () => interruptLaneForCorrection(timedOut.runId, "lane", "use main", {
      pollMs: 1,
      timeoutMs: 5,
      now: () => (clock += 4),
      sleep: async () => {},
      isSupervisorAlive: () => true,
    }),
    /timed out waiting for lane lane to pause/,
  );
  assert.equal(existsSync(timedOut.markerPath), false);

  const raced = runFixture();
  await assert.rejects(
    () => interruptLaneForCorrection(raced.runId, "lane", "use main", {
      pollMs: 1,
      isSupervisorAlive: () => true,
      sleep: async () => {
        const status = readStatus(raced.runId);
        status.lanes[0].state = "done";
        status.lanes[0].pid = null;
        writeStatus(raced.runId, status);
      },
    }),
    /reached done before the correction was delivered/,
  );
  assert.equal(existsSync(raced.markerPath), false);
});

test("a paused lane whose harness lingers is reported unsettled, not withdrawn", async () => {
  const { runId, markerPath } = runFixture();
  let clock = 0;
  const result = await interruptLaneForCorrection(runId, "lane", "use the resolved base", {
    pollMs: 1,
    timeoutMs: 100,
    now: () => (clock += 40),
    isSupervisorAlive: () => true,
    sleep: async () => {
      const status = readStatus(runId);
      status.lanes[0].state = "blocked";
      status.state = "blocked";
      writeStatus(runId, status);
    },
  });

  assert.equal(result.interrupted, true);
  assert.equal(result.settled, false, "the harness had not released its pid yet");
  assert.equal(existsSync(markerPath), true, "a delivered correction keeps its marker");
});

test("reply still rejects a lane that is not blocked", () => {
  const { runId } = runFixture();
  assert.throws(() => prepareReply(runId, "lane", "use main"), /is not blocked/);
});
