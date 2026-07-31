import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-watch-"));
const runsRoot = join(root, ".runs");
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
mkdirSync(runsRoot, { recursive: true });

const {
  classifyWake,
  formatWakeLine,
  runWatchSignal,
  statusFingerprint,
} = await import("../src/watch-signal.mjs?watch-test");
const { formatMonitorBoard, shouldMonitorExit } = await import("../src/monitor.mjs?watch-test");
const { writeStatus } = await import("../src/status.mjs?watch-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function sampleStatus(overrides = {}) {
  return {
    runId: "run-test-1",
    state: "running",
    repo: "fixture",
    runtime: {
      hostPlatform: "win32",
      os: "windows",
      arch: "x64",
      release: "test",
      shell: "powershell",
      commandMode: "spawn-no-shell",
      pathStyle: "windows",
    },
    updatedAt: "2026-07-30T00:00:00.000Z",
    lanes: [
      {
        id: "core",
        state: "running",
        harness: "claude",
        elapsedSec: 12,
        lastActivity: "tool: Read",
      },
    ],
    ...overrides,
  };
}

test("classifyWake distinguishes heartbeat, state_change, needs_input, terminal", () => {
  const running = sampleStatus();
  assert.equal(classifyWake(running, running, { heartbeatDue: false }), null);
  assert.equal(classifyWake(running, running, { heartbeatDue: true }).reason, "heartbeat");

  const progressed = sampleStatus({
    lanes: [{ id: "core", state: "running", harness: "claude", elapsedSec: 40, lastActivity: "writing" }],
  });
  // fingerprint ignores lastActivity/elapsed — only state/needsInput/exitCode
  assert.equal(statusFingerprint(running), statusFingerprint(progressed));
  assert.equal(classifyWake(running, progressed, { heartbeatDue: false }), null);

  const doneLane = sampleStatus({
    state: "running",
    lanes: [
      { id: "core", state: "done", harness: "claude", exitCode: 0, lastActivity: "ok" },
      { id: "docs", state: "running", harness: "claude", lastActivity: "…" },
    ],
  });
  assert.equal(classifyWake(running, doneLane).reason, "state_change");

  const blocked = sampleStatus({
    state: "blocked",
    lanes: [{
      id: "core",
      state: "blocked",
      harness: "claude",
      needsInput: { type: "question", prompt: "which preset?" },
    }],
  });
  assert.equal(classifyWake(running, blocked).reason, "needs_input");
  assert.equal(classifyWake(running, blocked).laneId, "core");

  const failed = sampleStatus({
    state: "failed",
    lanes: [{ id: "core", state: "failed", harness: "claude", exitCode: 1 }],
  });
  assert.equal(classifyWake(running, failed).reason, "terminal");

  const shipping = sampleStatus({
    state: "shipping",
    ship: {
      state: "running",
      phase: "merge",
      approve: "through-pr",
      lastActivity: "waiting for checks",
      needsInput: null,
    },
  });
  assert.equal(classifyWake(running, shipping).reason, "state_change");
  const shipBlocked = sampleStatus({
    state: "blocked",
    ship: {
      ...shipping.ship,
      state: "blocked",
      needsInput: { type: "blocked", prompt: "merge conflict" },
    },
  });
  const shipWake = classifyWake(shipping, shipBlocked);
  assert.equal(shipWake.reason, "needs_input");
  assert.equal(shipWake.phase, "ship");
  assert.equal(shipWake.runtime.hostPlatform, "win32");
});

test("formatWakeLine matches Cursor notify pattern", () => {
  const line = formatWakeLine("run-test-1", { reason: "heartbeat", runId: "run-test-1", state: "running" });
  assert.match(line, /^AGENT_MANAGER_WAKE_run-test-1 /);
  assert.equal(JSON.parse(line.split(" ").slice(1).join(" ")).reason, "heartbeat");
});

test("runWatchSignal emits state_change then terminal and exits", async () => {
  const runId = "run-signal-loop";
  const dir = join(root, ".runs", runId);
  mkdirSync(dir, { recursive: true });
  writeStatus(runId, sampleStatus({ runId }));

  const lines = [];
  let writes = 0;
  const clock = { t: 1_000 };
  const done = runWatchSignal(runId, {
    heartbeatSec: 180,
    pollMs: 1,
    write: (line) => {
      lines.push(line);
      writes += 1;
      if (writes === 1) {
        // after baseline banner, flip lane done then fail run on next poll cycle
      }
    },
    sleep: async () => {
      if (writes === 1) {
        writeStatus(runId, sampleStatus({
          runId,
          state: "running",
          lanes: [{ id: "core", state: "done", harness: "claude", exitCode: 0 }],
        }));
      } else if (writes >= 2) {
        writeStatus(runId, sampleStatus({
          runId,
          state: "done",
          lanes: [{ id: "core", state: "done", harness: "claude", exitCode: 0 }],
        }));
      }
      clock.t += 10;
    },
    now: () => clock.t,
    maxTicks: 20,
  });

  const result = await done;
  assert.equal(result?.reason, "terminal");
  const wakes = lines.filter((line) => line.startsWith("AGENT_MANAGER_WAKE_"));
  assert.ok(wakes.some((line) => line.includes('"reason":"state_change"')));
  assert.ok(wakes.some((line) => line.includes('"reason":"terminal"')));
});

test("monitor board formats lanes and exits only on done/failed/cancelled", () => {
  const board = formatMonitorBoard(sampleStatus({ feed: { enabled: false } }));
  assert.match(board, /agent-manager · monitor/);
  assert.match(board, /core/);
  assert.match(board, /tool: Read/);
  assert.match(board, /windows\/x64 \(win32\)/);
  assert.equal(shouldMonitorExit(sampleStatus({ state: "blocked" })), false);
  assert.equal(shouldMonitorExit(sampleStatus({ state: "done" })), true);
  assert.equal(shouldMonitorExit(sampleStatus({ state: "failed" })), true);
});
