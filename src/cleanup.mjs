import { existsSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { releaseLane } from "./claim.mjs";
import { repoPath, RUNS_ROOT, runDir } from "./paths.mjs";
import { readStatus, writeStatus } from "./status.mjs";
import { removeWorktree } from "./worktree.mjs";

export function cleanupRun(runId, { keepLogs = false } = {}) {
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  if (status.state === "running") {
    throw new Error("refusing to clean a running run; cancel it first");
  }

  const root = resolve(RUNS_ROOT);
  const target = resolve(runDir(runId));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel.includes(":")) {
    throw new Error("refusing cleanup outside runs root: " + target);
  }

  const repoRoot = repoPath(status.repo);
  const removed = [];
  for (const lane of status.lanes || []) {
    if (lane.branch) {
      const released = releaseLane({ repo: status.repo, branch: lane.branch });
      lane.claim = {
        state: released.ok ? "released" : "release-failed",
        at: new Date().toISOString(),
      };
    }
    if (lane.worktree && existsSync(lane.worktree)) {
      removeWorktree({ repoRoot, worktreePath: lane.worktree });
      removed.push(lane.worktree);
    }
    if (!keepLogs) {
      const laneDir = join(target, lane.id);
      if (existsSync(laneDir)) {
        rmSync(laneDir, { recursive: true, force: true });
        removed.push(laneDir);
      }
    }
  }

  if (status.integrate?.branch) {
    releaseLane({ repo: status.repo, branch: status.integrate.branch });
  }
  if (status.integrate?.worktree && existsSync(status.integrate.worktree)) {
    removeWorktree({ repoRoot, worktreePath: status.integrate.worktree });
    removed.push(status.integrate.worktree);
  }
  if (!keepLogs) {
    for (const path of [join(target, "integrate"), join(target, "supervisor.log")]) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      }
    }
  }

  status.cleanup = {
    at: new Date().toISOString(),
    keepLogs,
    removed,
  };
  return writeStatus(runId, status);
}
