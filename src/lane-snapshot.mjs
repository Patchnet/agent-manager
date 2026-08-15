import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Lane states that mean the lane will not write to its worktree again. */
const LANE_END_STATES = new Set(["done", "failed"]);
const READ_ONLY_PERMISSION_MODES = new Set(["readOnly", "read-only", "read_only"]);

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function splitLines(value) {
  return value ? value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

export function snapshotLane(worktree, laneId) {
  const status = git(worktree, ["status", "--porcelain"]);
  if (!status.ok) return { ok: false, error: status.stderr || "git status failed" };
  if (!status.stdout) return { ok: true, committed: false };

  const parent = git(worktree, ["rev-parse", "HEAD"]);
  const add = git(worktree, ["add", "-A"]);
  if (!add.ok) return { ok: false, error: add.stderr || "git add failed" };
  const commit = git(worktree, [
    "-c", "user.name=agent-manager",
    "-c", "user.email=agent-manager@users.noreply.github.com",
    "commit",
    "-m",
    `wip(${laneId}): lane integrate snapshot`,
  ]);
  if (!commit.ok) return { ok: false, error: commit.stderr || "git commit failed" };
  const head = git(worktree, ["rev-parse", "HEAD"]);
  const files = git(worktree, ["show", "--pretty=format:", "--name-only", "HEAD"]);
  return {
    ok: true,
    committed: true,
    commit: head.ok ? head.stdout : null,
    parent: parent.ok ? parent.stdout : null,
    files: files.ok ? splitLines(files.stdout).map((file) => file.replace(/\\/g, "/")) : [],
  };
}

/** A review lane (or a lane running in a read-only permission mode) never owns commits. */
export function isWritableLane(lane) {
  if (!lane) return false;
  if (lane.kind === "review") return false;
  return !READ_ONLY_PERMISSION_MODES.has(lane.permissionMode);
}

/**
 * Commit whatever a lane left behind, so a lane branch always points at the
 * work even when the lane died. Runs at lane end only — a blocked lane is still
 * mid-turn, and its snapshot would land inside the worker's own next attempt.
 *
 * Records the outcome on `lane.snapshot` and returns it. Never throws: a lane
 * that already failed must not fail differently because Git did.
 */
export function snapshotLaneAtEnd(lane) {
  const at = new Date().toISOString();
  const skip = (reason) => ({ state: "skipped", ok: true, committed: false, reason, at });
  if (!lane) return skip("no lane");
  if (!LANE_END_STATES.has(lane.state)) {
    lane.snapshot = skip(`lane state ${lane.state || "unknown"} is not a lane end`);
    return lane.snapshot;
  }
  if (!isWritableLane(lane)) {
    lane.snapshot = skip("read-only lane");
    return lane.snapshot;
  }
  if (!lane.worktree || !existsSync(lane.worktree)) {
    lane.snapshot = skip("no worktree on disk");
    return lane.snapshot;
  }
  let result;
  try {
    result = snapshotLane(lane.worktree, lane.id);
  } catch (error) {
    result = { ok: false, error: String(error?.message || error) };
  }
  if (!result.ok) {
    lane.snapshot = { state: "failed", ok: false, committed: false, error: result.error, at };
  } else if (!result.committed) {
    lane.snapshot = { state: "clean", ok: true, committed: false, at };
  } else {
    lane.snapshot = {
      state: "committed",
      ok: true,
      committed: true,
      commit: result.commit,
      parent: result.parent,
      files: result.files || [],
      at,
    };
  }
  return lane.snapshot;
}

/**
 * Undo a recovery snapshot before a lane resumes, so the resumed turn starts
 * from exactly the working tree its worker left. Without this the snapshot
 * commit would read as a worker commit under `allow_commit: false`.
 *
 * Only ever rewinds a snapshot commit this tool made and that is still HEAD.
 */
export function restoreLaneSnapshot(worktree, snapshot) {
  if (!snapshot || snapshot.state !== "committed" || !snapshot.commit || !snapshot.parent) {
    return { ok: true, restored: false, reason: "no snapshot commit to restore" };
  }
  if (!worktree || !existsSync(worktree)) {
    return { ok: true, restored: false, reason: "no worktree on disk" };
  }
  const head = git(worktree, ["rev-parse", "HEAD"]);
  if (!head.ok) return { ok: false, restored: false, error: head.stderr || "git rev-parse failed" };
  if (head.stdout !== snapshot.commit) {
    return { ok: true, restored: false, reason: "lane HEAD is no longer the snapshot commit" };
  }
  const reset = git(worktree, ["reset", "--mixed", snapshot.parent]);
  if (!reset.ok) return { ok: false, restored: false, error: reset.stderr || "git reset failed" };
  return { ok: true, restored: true, head: snapshot.parent };
}

export function mergeDependencyBranches(worktree, dependencies) {
  const merged = [];
  for (const dependency of dependencies) {
    const snapshot = snapshotLane(dependency.worktree, dependency.id);
    if (!snapshot.ok) {
      return {
        ok: false,
        merged,
        dependency: dependency.id,
        error: `could not snapshot dependency ${dependency.id}: ${snapshot.error}`,
      };
    }
    const merge = git(worktree, ["merge", "--no-edit", dependency.branch]);
    if (!merge.ok) {
      const aborted = git(worktree, ["merge", "--abort"]);
      return {
        ok: false,
        merged,
        dependency: dependency.id,
        error: `could not merge dependency ${dependency.id}: ${merge.stderr || merge.stdout}`,
        abortError: aborted.ok ? null : aborted.stderr || aborted.stdout,
      };
    }
    merged.push(dependency.id);
  }
  return { ok: true, merged };
}
