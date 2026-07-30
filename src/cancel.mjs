import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir, repoPath } from "./paths.mjs";
import { readStatus, writeStatus } from "./status.mjs";
import { releaseLane } from "./claim.mjs";
import { removeWorktree } from "./worktree.mjs";
import { createFeedPublisher, publishFeedEvent } from "./feed.mjs";
import { writeReport } from "./report.mjs";

export async function cancelRun(runId, { removeWorktrees = false } = {}) {
  const status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  if (status.state === "cancelled") return status;
  if (status.state === "done" || status.state === "failed") {
    throw new Error("cannot cancel terminal run " + runId + " (" + status.state + ")");
  }

  const cancelledAt = new Date().toISOString();
  writeFileSync(
    join(runDir(runId), "cancelled.json"),
    JSON.stringify({ at: cancelledAt }, null, 2) + "\n",
  );

  for (const lane of status.lanes || []) {
    if (lane.pid) {
      try {
        process.kill(lane.pid);
      } catch {
        /* already gone */
      }
    }
    if (lane.branch) {
      const released = releaseLane({ repo: status.repo, branch: lane.branch });
      lane.claim = { state: released.ok ? "released" : "release-failed", at: cancelledAt };
    }
    if (removeWorktrees && lane.worktree && existsSync(lane.worktree)) {
      removeWorktree({
        repoRoot: repoPath(status.repo),
        worktreePath: lane.worktree,
      });
    }
    if (lane.state === "running" || lane.state === "queued" || lane.state === "blocked") {
      lane.state = "cancelled";
    }
    lane.pid = null;
    lane.endedAt ||= cancelledAt;
  }
  status.state = "cancelled";
  status.endedAt = cancelledAt;
  writeStatus(runId, status);
  const publisher = createFeedPublisher(status.feed || {});
  await publishFeedEvent(publisher, status, "run_failed", {
    endedAt: cancelledAt,
    reason: "cancelled",
  });
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return saved;
}
