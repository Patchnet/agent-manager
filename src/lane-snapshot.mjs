import { spawnSync } from "node:child_process";

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

export function snapshotLane(worktree, laneId) {
  const status = git(worktree, ["status", "--porcelain"]);
  if (!status.ok) return { ok: false, error: status.stderr || "git status failed" };
  if (!status.stdout) return { ok: true, committed: false };

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
  return { ok: true, committed: true };
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
