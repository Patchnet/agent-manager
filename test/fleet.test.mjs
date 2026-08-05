import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-fleet-"));
const runsRoot = join(root, "runs");
mkdirSync(runsRoot, { recursive: true });

const {
  buildFleetSnapshot,
  describeCommand,
  diffFleetSnapshots,
  formatFleetBoard,
  parseDuration,
  parseFleetArgs,
  parseHarnessLog,
  runFleet,
} = await import("../src/fleet.mjs?fleet-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function writeRun(runId, status, { events = [], logLines = [] } = {}) {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  const lanes = (status.lanes || []).map((lane) => {
    const laneDir = join(dir, lane.id);
    mkdirSync(laneDir, { recursive: true });
    const logPath = join(laneDir, "stdout.log");
    if (logLines.length) writeFileSync(logPath, logLines.join("\n") + "\n");
    return { ...lane, logPath };
  });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status, runId, lanes }, null, 2));
  if (events.length) {
    writeFileSync(join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
}

function runningStatus(overrides = {}) {
  return {
    state: "running",
    repo: "fixture-repo",
    startedAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:05:00.000Z",
    planning: { planRef: "ticket-session-authority" },
    delivery: { state: "workers_running", review: { state: "not_started" } },
    lanes: [{
      id: "authority",
      harness: "codex",
      state: "running",
      elapsedSec: 300,
      lastActivity: "turn.completed",
      waitingFor: [],
      needsInput: null,
    }],
    ...overrides,
  };
}

test("fleet options parse durations, filters, and output modes", () => {
  assert.equal(parseDuration("24h"), 86_400_000);
  assert.equal(parseDuration("1.5m"), 90_000);
  assert.equal(parseDuration("all"), Infinity);
  assert.throws(() => parseDuration("tomorrow"), /duration must look like/);

  const options = parseFleetArgs([
    "run-one", "--active", "--since", "2h", "--repo", "fixture-repo",
    "--limit", "7", "--interval", "0.5", "--no-color", "--no-effects",
  ]);
  assert.equal(options.runId, "run-one");
  assert.equal(options.activeOnly, true);
  assert.equal(options.sinceMs, 7_200_000);
  assert.equal(options.repo, "fixture-repo");
  assert.equal(options.limit, 7);
  assert.equal(options.intervalMs, 500);
  assert.equal(options.color, false);
  assert.equal(options.effects, false);
  assert.throws(() => parseFleetArgs(["--stream", "--json"]), /cannot be combined/);
});

test("harness log parsing keeps worker narrative separate from command activity", () => {
  const log = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "The contract is implemented and focused tests pass." } }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test", status: "in_progress" } }),
  ].join("\n");
  assert.deepEqual(parseHarnessLog(log), {
    summary: "The contract is implemented and focused tests pass.",
    tool: "running tests",
  });
  assert.equal(describeCommand("npx tsc -p tsconfig.json", 1, "failed"), "typecheck failed");
  assert.equal(describeCommand("apply_patch *** Begin Patch"), "editing files");
});

test("fleet snapshot and board show tickets, lane progress, narrative, and transitions", () => {
  const runId = "run-20260804-120000-12345678";
  const logLines = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "The authority contract is implemented; 46 focused tests pass." } }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test", status: "in_progress" } }),
  ];
  const firstEvent = {
    at: "2026-08-04T12:00:01.000Z",
    state: "running",
    lanes: [{ id: "authority", state: "running", needsInput: null }],
    ship: null,
  };
  const secondEvent = {
    at: "2026-08-04T12:05:00.000Z",
    state: "running",
    lanes: [{ id: "authority", state: "done", needsInput: null }],
    ship: null,
  };
  writeRun(runId, runningStatus(), { events: [firstEvent, secondEvent], logLines });

  const snapshot = buildFleetSnapshot({}, {
    runsRoot,
    now: () => Date.parse("2026-08-04T12:06:00.000Z"),
  });
  assert.equal(snapshot.counts.active, 1);
  assert.equal(snapshot.runs[0].ticket, "ticket-session-authority");
  assert.match(snapshot.runs[0].lanes[0].summary, /46 focused tests pass/);
  assert.equal(snapshot.runs[0].lanes[0].tool, "running tests");
  assert.ok(snapshot.recentEvents.some((event) => /authority → done/.test(event.text)));

  const board = formatFleetBoard(snapshot, { width: 130, color: false, frame: 1 });
  assert.match(board, /AGENT MANAGER/);
  assert.match(board, /ticket-session-authority/);
  assert.match(board, /46 focused tests pass/);
  assert.match(board, /RECENT TRANSITIONS/);
  assert.doesNotMatch(board, /\u001b\[/);

  const colorful = formatFleetBoard(snapshot, { width: 130, color: true, effects: true, frame: 2 });
  assert.match(colorful, /\u001b\[/);
});

test("fleet snapshot honors active and recent filters", () => {
  writeRun("run-old-terminal", runningStatus({
    state: "released",
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T01:00:00.000Z",
    endedAt: "2026-07-01T01:00:00.000Z",
    lanes: [{ id: "old", harness: "codex", state: "done", elapsedSec: 60 }],
  }));
  writeRun("run-legacy-done", runningStatus({
    state: "done",
    startedAt: "2026-08-04T11:00:00.000Z",
    updatedAt: "2026-08-04T11:30:00.000Z",
    endedAt: "2026-08-04T11:30:00.000Z",
    lanes: [{ id: "legacy", harness: "codex", state: "done", elapsedSec: 60 }],
  }));
  const now = Date.parse("2026-08-04T12:06:00.000Z");
  const active = buildFleetSnapshot({ activeOnly: true }, { runsRoot, now: () => now });
  assert.ok(active.runs.every((run) => run.state === "running"));
  assert.equal(active.runs.some((run) => run.runId === "run-legacy-done"), false);
  const recent = buildFleetSnapshot({ sinceMs: 60_000 }, { runsRoot, now: () => now });
  assert.equal(recent.runs.some((run) => run.runId === "run-old-terminal"), false);
});

test("fleet surfaces integration blockers after worker lanes settle", () => {
  const runId = "run-20260804-121000-integ001";
  writeRun(runId, runningStatus({
    state: "blocked",
    updatedAt: "2026-08-04T12:10:00.000Z",
    lanes: [{ id: "worker", harness: "codex", state: "done", elapsedSec: 600, needsInput: null }],
    integrate: {
      state: "blocked",
      error: "verification failed",
      needsInput: { type: "blocked", prompt: "verification failed: npm test", blocking: true },
    },
  }));
  const snapshot = buildFleetSnapshot({ runId }, {
    runsRoot,
    now: () => Date.parse("2026-08-04T12:11:00.000Z"),
  });
  assert.deepEqual(snapshot.runs[0].blocker, {
    scope: "integrate",
    id: "integrate",
    prompt: "verification failed: npm test",
  });
  assert.equal(snapshot.counts.blocked, 1);
  const board = formatFleetBoard(snapshot, { width: 120, color: false });
  assert.match(board, /NEEDS INPUT.*integrate/);
  assert.match(board, /verification failed: npm test/);
  assert.match(board, /agent-manager status/);
});

test("fleet diffs produce lane and worker update stream events", () => {
  const before = {
    at: "2026-08-04T12:00:00.000Z",
    runs: [{
      runId: "run-one", shortId: "run-one", ticket: "ticket", state: "running",
      deliveryState: "workers_running", shipState: null, shipPhase: null,
      lanes: [{ id: "lane", state: "running", summary: "inspecting", needsInput: null }],
    }],
  };
  const afterUpdate = structuredClone(before);
  afterUpdate.at = "2026-08-04T12:00:01.000Z";
  afterUpdate.runs[0].lanes[0].summary = "tests pass";
  assert.ok(diffFleetSnapshots(before, afterUpdate).some((event) => event.kind === "worker_update"));

  const afterDone = structuredClone(afterUpdate);
  afterDone.at = "2026-08-04T12:00:02.000Z";
  afterDone.runs[0].lanes[0].state = "done";
  assert.ok(diffFleetSnapshots(afterUpdate, afterDone).some((event) => event.kind === "lane_state"));
});

test("fleet once JSON mode is stable for scripts", async () => {
  let output = "";
  const stream = {
    isTTY: false,
    columns: 120,
    write(value) { output += value; },
  };
  const snapshot = await runFleet({ once: true, json: true }, {
    runsRoot,
    output: stream,
    now: () => Date.parse("2026-08-04T12:06:00.000Z"),
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.schema, "agent-manager.fleet.v1");
  assert.equal(parsed.runs.length, snapshot.runs.length);
});
