import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { addWorktree } from "./worktree.mjs";
import { claimLane, releaseLane } from "./claim.mjs";
import { runDir } from "./paths.mjs";

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    status: r.status ?? 1,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

function ensureLaneCommitted(worktreePath, laneId) {
  const status = git(worktreePath, ["status", "--porcelain"]);
  if (!status.ok) {
    return { ok: false, error: status.stderr || "git status failed" };
  }
  if (!status.stdout) {
    // No local changes — ensure branch has at least one commit ahead of its base tip
    return { ok: true, committed: false };
  }
  const add = git(worktreePath, ["add", "-A"]);
  if (!add.ok) return { ok: false, error: add.stderr || "git add failed" };
  const commit = git(worktreePath, [
    "commit",
    "-m",
    `wip(${laneId}): lane integrate snapshot`,
  ]);
  if (!commit.ok) return { ok: false, error: commit.stderr || "git commit failed" };
  return { ok: true, committed: true };
}

/**
 * After coding lanes succeed, fold their branches into am/<runId>/integrate.
 * Does not push, open a PR, stamp versions, or merge to main.
 * Master Dev + Ship Gate own commit message polish / push / gh pr merge --auto.
 */
export function integrateLanes({ workflow, runId, laneStates }) {
  const integrateDir = join(runDir(runId), "integrate");
  const wt = join(integrateDir, "wt");
  mkdirSync(integrateDir, { recursive: true });

  const branch = `am/${runId}/integrate`;
  const doneLanes = laneStates.filter((l) => l.state === "done" && l.worktree && l.branch);
  if (doneLanes.length === 0) {
    return {
      state: "skipped",
      branch: null,
      worktree: null,
      error: "no successful lanes to integrate",
    };
  }

  const scopes = [
    ...new Set(
      doneLanes.flatMap((l) =>
        String(l.scope || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ),
  ];

  // Refresh main for a clean base
  git(workflow.repoRoot, ["fetch", "origin", "main"]);

  claimLane({
    repo: workflow.repo,
    branch,
    lane: "integrate",
    scope: scopes,
    agent: "agt-agent-manager-integrate",
  });
  const finish = (result) => {
    const released = releaseLane({ repo: workflow.repo, branch });
    return {
      ...result,
      claim: { state: released.ok ? "released" : "release-failed" },
    };
  };

  try {

  if (!existsSync(wt)) {
    addWorktree({
      repoRoot: workflow.repoRoot,
      worktreePath: wt,
      branch,
      baseBranch: "origin/main",
    });
  }

  const merged = [];
  for (const lane of doneLanes) {
    const snap = ensureLaneCommitted(lane.worktree, lane.id);
    if (!snap.ok) {
      const needs = {
        type: "blocked",
        prompt: `Integrate could not snapshot lane ${lane.id}: ${snap.error}`,
        blocking: true,
      };
      writeFileSync(join(integrateDir, "needs-input.json"), JSON.stringify(needs, null, 2));
      return finish({
        state: "blocked",
        branch,
        worktree: wt,
        needsInput: needs,
        merged,
        error: snap.error,
      });
    }

    const merge = git(wt, ["merge", "--no-edit", lane.branch]);
    if (!merge.ok) {
      const needs = {
        type: "blocked",
        prompt: `Merge conflict integrating lane ${lane.id} (${lane.branch}) into ${branch}. Resolve in ${wt} or abandon.`,
        blocking: true,
        lane: lane.id,
        stderr: merge.stderr || merge.stdout,
      };
      writeFileSync(join(integrateDir, "needs-input.json"), JSON.stringify(needs, null, 2));
      git(wt, ["merge", "--abort"]);
      return finish({
        state: "blocked",
        branch,
        worktree: wt,
        needsInput: needs,
        merged,
        error: needs.prompt,
      });
    }
    merged.push(lane.id);
  }

  const log = git(wt, ["log", "--oneline", "origin/main..HEAD"]);
  const diffStat = git(wt, ["diff", "--stat", "origin/main...HEAD"]);

  const summary = {
    state: "ready",
    branch,
    worktree: wt,
    merged,
    commits: log.ok ? log.stdout.split("\n").filter(Boolean) : [],
    diffStat: diffStat.ok ? diffStat.stdout : "",
    shipGateHint:
      "Present Ship Gate for this integrate branch. On through-pr/all: push → gh pr create → gh pr merge --auto --squash. Do not stamp Version.md on the branch.",
  };

  writeFileSync(join(integrateDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(integrateDir, "README.md"),
    [
      `# Integrate · ${runId}`,
      "",
      `- **branch:** \`${branch}\``,
      `- **worktree:** \`${wt}\``,
      `- **merged lanes:** ${merged.join(", ")}`,
      "",
      "## Next (Master Dev)",
      "",
      "1. Review diff vs `origin/main`.",
      "2. Present **Ship Gate** (Formal).",
      "3. On `through-pr` / `all`: push branch, `gh pr create`, then `gh pr merge --auto --squash`.",
      "4. After merge + Ship Gate for VERSION/TAG: `npm run release:formal` in the target repo when available.",
      "",
      "Workers do not merge to main or stamp versions.",
      "",
    ].join("\n"),
    "utf8",
  );

  return finish(summary);
  } catch (error) {
    releaseLane({ repo: workflow.repo, branch });
    throw error;
  }
}
