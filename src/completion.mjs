import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export function validateLaneCompletion(lane, laneConfig) {
  const kind = laneConfig.kind || lane.kind || "implementation";
  const changedFiles = lane.changedFiles || [];
  const expectedOutputs = laneConfig.expected_outputs || lane.expectedOutputs || [];
  const missingExpectedOutputs = expectedOutputs.filter((path) => {
    const target = join(lane.worktree, ...path.split("/"));
    return !existsSync(target) || !statSync(target).isFile();
  });
  const noChangesAllowed = laneConfig.allow_no_changes === true || kind === "review";
  let reason = null;
  if (missingExpectedOutputs.length) {
    reason = `required output missing: ${missingExpectedOutputs.join(", ")}`;
  } else if (kind === "implementation" && changedFiles.length === 0 && !noChangesAllowed) {
    reason = "implementation lane exited successfully but delivered zero changed files";
  }
  lane.completion = {
    state: reason ? "failed" : "verified",
    kind,
    changedFileCount: changedFiles.length,
    expectedOutputs: [...expectedOutputs],
    missingExpectedOutputs,
    noChangesAllowed,
    reason,
  };
  if (reason) {
    lane.state = "failed";
    lane.lastActivity = reason;
    return false;
  }
  return true;
}
