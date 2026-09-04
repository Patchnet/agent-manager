import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { releaseLane } from "./claim.mjs";
import { assertPathInside, assertSafeSlug, repoPath, RUNS_ROOT, runDir } from "./paths.mjs";
import { isTerminalState, readStatus, writeStatus } from "./status.mjs";
import { removeWorktree } from "./worktree.mjs";
import { classificationForRecord } from "./run-classification.mjs";
import { requiresGoalDisposition } from "./delivery.mjs";

export function cleanupRun(runId, { keepLogs = false } = {}) {
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  if (!isTerminalState(status.state)) {
    throw new Error(`refusing to clean incomplete delivery in state ${status.state}; cancel or complete it first`);
  }
  if (requiresGoalDisposition(status)) {
    throw new Error(`refusing to clean ${status.state} run before declared goals have explicit dispositions`);
  }

  const root = resolve(RUNS_ROOT);
  const target = resolve(runDir(runId));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel.includes(":")) {
    throw new Error("refusing cleanup outside runs root: " + target);
  }

  const repoRoot = status.repoRoot || repoPath(status.repo);
  const removed = [];
  for (const lane of status.lanes || []) {
    if (lane.branch) {
      const released = releaseLane({ repo: status.repo, branch: lane.branch, mode: status.claimMode });
      lane.claim = {
        state: released.ok ? "released" : "release-failed",
        at: new Date().toISOString(),
      };
    }
    if (lane.worktree && existsSync(lane.worktree)) {
      const safeWorktree = assertPathInside(target, lane.worktree, `lane ${lane.id} worktree`);
      removeWorktree({ repoRoot, worktreePath: safeWorktree });
      removed.push(safeWorktree);
    }
    if (!keepLogs) {
      const laneDir = join(target, assertSafeSlug(lane.id, "lane id"));
      if (existsSync(laneDir)) {
        rmSync(laneDir, { recursive: true, force: true });
        removed.push(laneDir);
      }
    }
  }

  if (status.integrate?.branch) {
    releaseLane({ repo: status.repo, branch: status.integrate.branch, mode: status.claimMode });
  }
  if (status.integrate?.worktree && existsSync(status.integrate.worktree)) {
    const safeIntegrateWorktree = assertPathInside(target, status.integrate.worktree, "integrate worktree");
    removeWorktree({ repoRoot, worktreePath: safeIntegrateWorktree });
    removed.push(safeIntegrateWorktree);
  }
  if (!keepLogs) {
    for (const path of [join(target, "integrate"), join(target, "ship"), join(target, "supervisor.log")]) {
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
export function cleanupStaleRuns({ olderThanDays = 30, keepLogs = false, now = Date.now() } = {}) {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    throw new Error("olderThanDays must be at least 1");
  }
  if (!existsSync(RUNS_ROOT)) return [];
  const cutoff = now - olderThanDays * 86_400_000;
  const cleaned = [];
  for (const entry of readdirSync(RUNS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(entry.name)) continue;
    const status = readStatus(entry.name);
    if (!status || !isTerminalState(status.state) || requiresGoalDisposition(status)) continue;
    const timestamp = Date.parse(status.updatedAt || status.endedAt || status.startedAt || "");
    if (!Number.isFinite(timestamp) || timestamp > cutoff) continue;
    cleanupRun(entry.name, { keepLogs });
    cleaned.push(entry.name);
  }
  return cleaned;
}

export function previewStaleRuns({ olderThanDays = 30, now = Date.now() } = {}) {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    throw new Error("olderThanDays must be at least 1");
  }
  const thresholdSeconds = olderThanDays * 86_400;
  const cutoff = now - thresholdSeconds * 1_000;
  const runs = [];
  if (existsSync(RUNS_ROOT)) {
    for (const entry of readdirSync(RUNS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(entry.name)) continue;
      const status = readStatus(entry.name);
      if (!status) continue;
      const timestamp = Date.parse(status.updatedAt || status.endedAt || status.startedAt || "");
      if (!Number.isFinite(timestamp) || timestamp > cutoff) continue;
      const terminal = isTerminalState(status.state);
      const dispositionPending = terminal && requiresGoalDisposition(status);
      runs.push({
        runId: status.runId || entry.name,
        state: status.state || "unknown",
        classification: classificationForRecord(status),
        ageSeconds: Math.max(0, Math.floor((now - timestamp) / 1_000)),
        reason: dispositionPending
          ? "terminal run still requires explicit goal dispositions"
          : terminal
          ? "terminal run exceeds the stale threshold"
          : "nonterminal run exceeds the stale threshold",
        recommendedAction: dispositionPending
          ? "reconcile-goals"
          : terminal ? "cleanup" : "inspect-or-cancel",
        category: terminal && !dispositionPending ? "cleanup-candidate" : "operator-attention",
      });
    }
  }
  runs.sort((left, right) => left.runId.localeCompare(right.runId));
  return {
    schema: "agent-manager.stale-preview.v1",
    dryRun: true,
    olderThanDays,
    thresholdSeconds,
    runs,
    cleanupCandidates: runs.filter((run) => run.category === "cleanup-candidate").length,
    operatorAttention: runs.filter((run) => run.category === "operator-attention").length,
  };
}
