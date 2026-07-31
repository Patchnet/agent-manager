import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertPathInside, repoPath, runDir } from "./paths.mjs";
import { readStatus, writeStatus } from "./status.mjs";
import { releaseLane } from "./claim.mjs";
import { removeWorktree } from "./worktree.mjs";
import { createFeedPublisher, publishFeedEvent } from "./feed.mjs";
import { writeReport } from "./report.mjs";
import { writePrivateFile } from "./fs-safe.mjs";

export async function cancelRun(runId, { removeWorktrees = false } = {}) {
  const status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  if (status.state === "cancelled") return status;
  if (status.state === "done" || status.state === "failed") {
    throw new Error(`cannot cancel terminal run ${runId} (${status.state})`);
  }

  const cancelledAt = new Date().toISOString();
  const dir = runDir(runId);
  writePrivateFile(join(dir, "cancelled.json"), JSON.stringify({ at: cancelledAt }, null, 2) + "\n", "utf8");

  for (const lane of status.lanes || []) {
    if (
      lane.branch &&
      !["released", "skipped", "advisory-failed", "release-failed"].includes(lane.claim?.state)
    ) {
      const released = releaseLane({ repo: status.repo, branch: lane.branch, mode: status.claimMode });
      lane.claim = { state: released.ok ? "released" : "release-failed", at: cancelledAt };
    }
    if (["running", "queued", "dependency-waiting", "blocked"].includes(lane.state)) {
      lane.state = "cancelled";
    }
    lane.pid = null;
    lane.endedAt ||= cancelledAt;
  }
  if (status.ship && ["queued", "running", "blocked"].includes(status.ship.state)) {
    status.ship.state = "cancelled";
    status.ship.pid = null;
    status.ship.endedAt = cancelledAt;
    status.ship.lastActivity = "cancel requested";
  }
  status.state = "cancelled";
  status.endedAt = cancelledAt;
  writeStatus(runId, status);

  const publisher = createFeedPublisher(status.feed || {});
  await publishFeedEvent(publisher, status, "run_failed", { endedAt: cancelledAt, reason: "cancelled" });
  let saved = writeStatus(runId, status);

  if (removeWorktrees) {
    const stopped = await waitForSupervisorExit(join(dir, "supervisor.lock"));
    if (!stopped) {
      saved.cancelCleanup = { state: "deferred", reason: "supervisor did not exit within 10 seconds" };
    } else {
      const root = status.repoRoot || repoPath(status.repo);
      const removed = [];
      for (const lane of status.lanes || []) {
        if (!lane.worktree || !existsSync(lane.worktree)) continue;
        const worktree = assertPathInside(dir, lane.worktree, `lane ${lane.id} worktree`);
        removeWorktree({ repoRoot: root, worktreePath: worktree });
        removed.push(worktree);
      }
      saved.cancelCleanup = { state: "removed", worktrees: removed };
    }
    saved = writeStatus(runId, saved);
  }

  writeReport(runId, saved);
  return saved;
}

async function waitForSupervisorExit(lockPath, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(lockPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !existsSync(lockPath);
}
