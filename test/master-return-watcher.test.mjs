import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv } from "../test-support/isolated-roots.mjs";
import { summarizeEvent } from "../src/harness/claude.mjs";

const cli = join(import.meta.dirname, "..", "bin", "agent-manager.mjs");

function exitedPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return Number(child.stdout);
}

function stopWatcher(pid) {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

test("touching a live run restarts a dead return watcher and clears a stopped return", () => {
  const env = isolatedEnv();
  const runId = "run-20261011-120000-watcher1";
  const dir = join(env.AGENT_MANAGER_RUNS_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    runId,
    state: "delivery_review_pending",
    lanes: [],
    delivery: { state: "review_pending", review: { state: "not_started", latestPass: 0, history: [] }, targets: [] },
    updatedAt: new Date().toISOString(),
  }));
  const deadPid = exitedPid();
  // Signal mode never launches a host, so the restarted watcher stays inert.
  writeFileSync(join(dir, "master-return.json"), JSON.stringify({
    schema: "agent-manager.master-return.v1",
    host: "cursor",
    mode: "signal",
    source: "cli",
    configuredAt: new Date().toISOString(),
    state: "stopped",
    stoppedStage: "workers_complete",
    attempts: 3,
    watcherPid: deadPid,
  }));

  spawnSync(process.execPath, [cli, "next-action", runId, "--json"], { env, encoding: "utf8", windowsHide: true });

  const channel = JSON.parse(readFileSync(join(dir, "master-return.json"), "utf8"));
  try {
    assert.notEqual(channel.watcherPid, deadPid);
    assert.equal(channel.stoppedStage, undefined);
    assert.notEqual(channel.state, "stopped");
  } finally {
    stopWatcher(channel.watcherPid);
  }
});

test("a failed Claude session reports its message, not the success subtype", () => {
  assert.equal(
    summarizeEvent({
      type: "result",
      subtype: "success",
      terminal_reason: "api_error",
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
    }),
    "result: Failed to authenticate: OAuth session expired and could not be refreshed",
  );
  assert.equal(
    summarizeEvent({ type: "result", subtype: "success", terminal_reason: "completed", result: "done text" }),
    "result: success",
  );
});
