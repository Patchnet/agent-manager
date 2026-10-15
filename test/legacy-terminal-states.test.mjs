import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useIsolatedRoots } from "../test-support/isolated-roots.mjs";

const roots = useIsolatedRoots();
const runsRoot = roots.AGENT_MANAGER_RUNS_ROOT;
const { isTerminalState } = await import("../src/status.mjs?legacy-terminal");
const { cleanupStaleRuns } = await import("../src/cleanup.mjs?legacy-terminal");
const { removeWorktree } = await import("../src/worktree.mjs?legacy-terminal");

test.after(() => rmSync(roots.root, { recursive: true, force: true }));

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-08-27T12:00:00.000Z");

function writeRun(runId, status) {
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    runId, repo: "fixture", lanes: [], startedAt: OLD, updatedAt: OLD, ...status,
  }));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

test("runs that finished under 2.x read as finished", () => {
  for (const state of ["released", "filed", "done"]) assert.equal(isTerminalState(state), true, state);
  for (const state of ["merged", "closed", "cancelled"]) assert.equal(isTerminalState(state), true, state);
  for (const state of ["running", "review_pending", "waiting_operator", "blocked"]) {
    assert.equal(isTerminalState(state), false, state);
  }
});

test("stale cleanup covers 2.x end states and keeps going past a run that fails", () => {
  writeRun("run-old-released", { state: "released" });
  writeRun("run-old-filed", { state: "filed" });
  // A worktree path outside its run directory makes cleanupRun throw.
  writeRun("run-old-broken", {
    state: "cancelled",
    lanes: [{ id: "lane", worktree: roots.root }],
  });
  const failures = [];
  const cleaned = cleanupStaleRuns({
    olderThanDays: 30,
    now: NOW,
    onFailure: (runId) => failures.push(runId),
  });
  assert.deepEqual(cleaned.sort(), ["run-old-filed", "run-old-released"]);
  assert.deepEqual(failures, ["run-old-broken"]);
});

test("a worktree directory git already forgot is removed, a full repository never is", () => {
  const repo = join(roots.root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");

  const orphan = join(roots.root, "orphan-wt");
  mkdirSync(orphan);
  writeFileSync(join(orphan, ".git"), "gitdir: /nonexistent\n");
  removeWorktree({ repoRoot: repo, worktreePath: orphan });
  assert.equal(existsSync(orphan), false);

  const other = join(roots.root, "other-repo");
  mkdirSync(other);
  git(other, "init", "-q");
  assert.throws(() => removeWorktree({ repoRoot: repo, worktreePath: other }), /worktree remove failed/);
  assert.equal(existsSync(join(other, ".git")), true);
});
