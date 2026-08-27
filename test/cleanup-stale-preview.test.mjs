import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { useIsolatedRoots } from "../test-support/isolated-roots.mjs";

const roots = useIsolatedRoots();
const runsRoot = roots.AGENT_MANAGER_RUNS_ROOT;
const { cleanupRun, cleanupStaleRuns, previewStaleRuns } = await import("../src/cleanup.mjs?stale-preview");
const CLI = join(process.cwd(), "bin", "agent-manager.mjs");

test.after(() => rmSync(roots.root, { recursive: true, force: true }));

function writeStatus(runId, status) {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "status.json");
  writeFileSync(path, JSON.stringify({ runId, repo: "fixture", lanes: [], ...status }, null, 2) + "\n");
  return path;
}

test("stale dry-run separates cleanup candidates from operator attention without mutation", () => {
  const terminalPath = writeStatus("run-old-terminal", {
    state: "released",
    classification: "benchmark",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T01:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
  });
  const activePath = writeStatus("run-old-active", {
    state: "blocked",
    classification: "recovery",
    lineage: { parentRunId: "run-parent", relationship: "recovery" },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  const legacyPath = writeStatus("run-old-legacy", {
    state: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T02:00:00.000Z",
    updatedAt: "2026-01-01T02:00:00.000Z",
  });
  const before = [terminalPath, activePath, legacyPath].map((path) => ({
    path,
    body: readFileSync(path, "utf8"),
    mtimeMs: statSync(path).mtimeMs,
  }));
  const now = Date.parse("2026-08-27T12:00:00.000Z");

  const preview = previewStaleRuns({ olderThanDays: 30, now });
  assert.equal(preview.cleanupCandidates, 2);
  assert.equal(preview.operatorAttention, 1);
  assert.deepEqual(
    preview.runs.find((run) => run.runId === "run-old-terminal"),
    {
      runId: "run-old-terminal",
      state: "released",
      classification: "benchmark",
      ageSeconds: 20_602_800,
      reason: "terminal run exceeds the stale threshold",
      recommendedAction: "cleanup",
      category: "cleanup-candidate",
    },
  );
  assert.equal(
    preview.runs.find((run) => run.runId === "run-old-active").recommendedAction,
    "inspect-or-cancel",
  );
  assert.equal(preview.runs.find((run) => run.runId === "run-old-legacy").classification, "unknown");

  const repeated = previewStaleRuns({ olderThanDays: 30, now: now + 5_000 });
  assert.deepEqual(
    repeated.runs.map(({ ageSeconds, ...run }) => run),
    preview.runs.map(({ ageSeconds, ...run }) => run),
  );
  for (const item of before) {
    assert.equal(readFileSync(item.path, "utf8"), item.body);
    assert.equal(statSync(item.path).mtimeMs, item.mtimeMs);
  }

  const cli = JSON.parse(execFileSync(process.execPath, [
    CLI, "cleanup", "--stale", "--dry-run", "--older-than-days", "30", "--json",
  ], { cwd: process.cwd(), env: process.env, encoding: "utf8" }));
  assert.equal(cli.schema, "agent-manager.stale-preview.v1");
  assert.equal(cli.runs.some((run) => run.runId === "run-old-active"), true);
  for (const item of before) assert.equal(readFileSync(item.path, "utf8"), item.body);

  assert.throws(
    () => cleanupRun("run-old-active"),
    /refusing to clean incomplete delivery in state blocked/,
  );
  const cleaned = cleanupStaleRuns({ olderThanDays: 30, now });
  assert.deepEqual(cleaned.sort(), ["run-old-legacy", "run-old-terminal"]);
  assert.equal(readFileSync(activePath, "utf8"), before.find((item) => item.path === activePath).body);
});
