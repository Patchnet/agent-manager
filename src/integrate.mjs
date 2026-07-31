import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { addWorktree } from "./worktree.mjs";
import { claimLane, releaseLane } from "./claim.mjs";
import { snapshotLane } from "./lane-snapshot.mjs";
import { runDir } from "./paths.mjs";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.mjs";
import { findChangedFileOverlaps } from "./scope.mjs";
import { runVerification } from "./verification.mjs";
import { lanesAreSequential } from "./workflow.mjs";

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
    "-c", "user.name=agent-manager",
    "-c", "user.email=agent-manager@users.noreply.github.com",
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
  ensurePrivateDir(integrateDir);

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

  const allChangedFileOverlaps = findChangedFileOverlaps(doneLanes);
  const approvedChangedFileOverlaps = allChangedFileOverlaps.filter((item) => {
    for (let left = 0; left < item.lanes.length; left += 1) {
      for (let right = left + 1; right < item.lanes.length; right += 1) {
        if (!lanesAreSequential(workflow.lanes, item.lanes[left], item.lanes[right])) {
          return false;
        }
      }
    }
    return true;
  });
  const changedFileOverlaps = allChangedFileOverlaps.filter(
    (item) => !approvedChangedFileOverlaps.includes(item),
  );
  if (changedFileOverlaps.length) {
    const needs = {
      type: "blocked",
      prompt:
        "Integration stopped because multiple lanes changed the same file: " +
        changedFileOverlaps
          .map((item) => `${item.file} (${item.lanes.join(", ")})`)
          .join("; "),
      blocking: true,
      changedFileOverlaps,
      approvedChangedFileOverlaps,
    };
    writePrivateFile(join(integrateDir, "needs-input.json"), JSON.stringify(needs, null, 2));
    return {
      state: "blocked",
      branch,
      worktree: null,
      merged: [],
      changedFileOverlaps,
      approvedChangedFileOverlaps,
      needsInput: needs,
      error: needs.prompt,
      claim: { state: "not-acquired" },
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

  const baseShas = [
    ...new Set(doneLanes.map((lane) => lane.runBaseCommit || lane.baseCommit).filter(Boolean)),
  ];
  if (baseShas.length !== 1) {
    throw new Error("lanes do not share one immutable base commit");
  }
  const baseSha = baseShas[0];

  const integrationClaim = claimLane({
    repo: workflow.repo,
    branch,
    lane: "integrate",
    scope: scopes,
    agent: "agt-agent-manager-integrate",
    group: runId,
    mode: workflow.claim_mode,
  });
  const finish = (result) => {
    if (integrationClaim.skipped) {
      return { ...result, claim: { state: "skipped" } };
    }
    if (!integrationClaim.ok) {
      return {
        ...result,
        claim: { state: "advisory-failed", error: integrationClaim.error },
      };
    }
    const released = releaseLane({ repo: workflow.repo, branch, mode: workflow.claim_mode });
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
      baseBranch: baseSha,
    });
  }

  const merged = [];
  for (const lane of doneLanes) {
    const snap = snapshotLane(lane.worktree, lane.id);
    if (!snap.ok) {
      const needs = {
        type: "blocked",
        prompt: `Integrate could not snapshot lane ${lane.id}: ${snap.error}`,
        blocking: true,
      };
      writePrivateFile(join(integrateDir, "needs-input.json"), JSON.stringify(needs, null, 2));
      return finish({
        state: "blocked",
        branch,
        worktree: wt,
        needsInput: needs,
        merged,
        approvedChangedFileOverlaps,
        error: snap.error,
      });
    }

    const merge = git(wt, ["merge", "--no-edit", lane.branch]);
    if (!merge.ok) {
      const needs = {
        type: "blocked",
        prompt: `Merge conflict integrating lane ${lane.id} (${lane.branch}) into ${branch}. The automatic merge was aborted; revise the lane or rerun the merge manually in ${wt}.`,
        blocking: true,
        lane: lane.id,
        stderr: merge.stderr || merge.stdout,
      };
      const aborted = git(wt, ["merge", "--abort"]);
      if (!aborted.ok) needs.abortError = aborted.stderr || aborted.stdout;
      writePrivateFile(join(integrateDir, "needs-input.json"), JSON.stringify(needs, null, 2));
      return finish({
        state: "blocked",
        branch,
        worktree: wt,
        needsInput: needs,
        merged,
        approvedChangedFileOverlaps,
        error: needs.prompt,
      });
    }
    merged.push(lane.id);
  }

  const log = git(wt, ["log", "--oneline", baseSha + "..HEAD"]);
  const diffStat = git(wt, ["diff", "--stat", baseSha + "...HEAD"]);
  const verification = runVerification(wt, workflow.verification, {
    envAllowlist: workflow.env_allowlist,
  });
  writePrivateFile(
    join(integrateDir, "verification.json"),
    JSON.stringify(verification, null, 2) + "\n",
  );
  if (!verification.passed) {
    const needs = {
      type: "blocked",
      prompt: verification.error,
      blocking: true,
      verification,
    };
    writePrivateFile(join(integrateDir, "needs-input.json"), JSON.stringify(needs, null, 2));
    return finish({
      state: "blocked",
      branch,
      worktree: wt,
      merged,
      baseSha,
      changedFileOverlaps,
      approvedChangedFileOverlaps,
      verification,
      needsInput: needs,
      error: needs.prompt,
    });
  }

  const summary = {
    state: "ready",
    branch,
    worktree: wt,
    merged,
    baseSha,
    remote: workflow.remote,
    commits: log.ok ? log.stdout.split("\n").filter(Boolean) : [],
    diffStat: diffStat.ok ? diffStat.stdout : "",
    changedFileOverlaps,
    approvedChangedFileOverlaps,
    verification,
    shipGateHint:
      "Present Ship Gate for this integrate branch. On approval, detach PR Manager to push, open the PR, and merge explicitly.",
  };

  writePrivateFile(join(integrateDir, "summary.json"), JSON.stringify(summary, null, 2));
  writePrivateFile(
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
      `1. Review diff from immutable base ${baseSha}.`,
      "2. Present **Ship Gate** (Formal).",
      `3. On approval, run \`agent-manager ship ${runId} --approve <level> --detach ...\`.`,
      "4. Keep `watch-signal` armed for ship blockers and the terminal outcome.",
      "",
      "Workers do not merge to main or stamp versions.",
      "",
    ].join("\n"),
    "utf8",
  );

  return finish(summary);
  } catch (error) {
    if (integrationClaim.ok && !integrationClaim.skipped) {
      releaseLane({ repo: workflow.repo, branch, mode: workflow.claim_mode });
    }
    throw error;
  }
}
