import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStatus, writeStatus } from "./status.mjs";
import { BRAIN_ROOT, assertPathInside, assertSafeSlug, runDir } from "./paths.mjs";
import { branchOf } from "./worktree.mjs";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.mjs";
import { formatRuntime } from "./runtime.mjs";
import {
  recordFiled,
  recordReviewDecision,
  recordReviewPresentation,
  staleGoalHints,
} from "./delivery.mjs";
import { GoalModelError, linkGoalArtifact, updateArtifactLink } from "./goals.mjs";
import { writeReport } from "./report.mjs";

export function buildDeliveryReview(runId, {
  pass = 1,
  write = true,
  verdict = null,
  reviewer = null,
  notes = null,
} = {}) {
  if (![1, 2].includes(pass)) throw new Error("review pass must be 1 or 2");
  let status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  if (!["delivery_review_pending", "correction_pending", "ship_gate_pending"].includes(status.state)) {
    throw new Error(`run ${runId} is not awaiting Delivery Review (state ${status.state})`);
  }
  const structuralPreflight = inspectDeliveryStructure(status);
  if (verdict && ["accept", "accept-with-notes"].includes(verdict) && !structuralPreflight.ok) {
    throw new Error(
      `Delivery Review cannot be accepted; structural preflight failed: ${structuralPreflight.errors.join("; ")}`,
    );
  }
  if (verdict) {
    recordReviewDecision(status, { pass, verdict, reviewer, notes });
    status = writeStatus(runId, status);
    writeReport(runId, status);
  } else if (write && ["delivery_review_pending", "correction_pending"].includes(status.state)
    && status.delivery?.review?.state !== "accepted") {
    recordReviewPresentation(status, { pass });
    status = writeStatus(runId, status);
    writeReport(runId, status);
  }
  const decision = verdict
    ? status.delivery.review.history.find((item) => item.pass === pass)
    : null;
  const lines = [
    `# Delivery Review - Pass ${pass}`,
    "",
    `- Run: \`${status.runId}\``,
    `- Repository: \`${status.repo}\``,
    `- Run state: **${status.state}**`,
    `- Base: \`${status.baseCommit || status.initialRepo?.head || status.baseRef || "unknown"}\``,
    `- Runtime: ${formatRuntime(status.runtime)}`,
    `- Maximum concurrency: ${status.maxConcurrency || "-"}`,
    `- Planning preflight: **${status.planning?.state || "legacy/unrecorded"}**`,
    `- Plan: ${status.planning?.planRef || "-"}`,
    `- Planning context SHA-256: \`${status.planning?.contextDigest || "-"}\``,
    `- Planning verifier: ${status.planning?.verifiedBy || "-"} at ${status.planning?.verifiedAt || "-"}`,
    `- Verdict: **${decision?.verdict || "pending operator review"}**`,
    `- Reviewer: ${decision?.reviewer || "-"}`,
    `- Decided: ${decision?.decidedAt || "-"}`,
    `- Notes: ${decision?.notes || "-"}`,
    `- Structural preflight: **${structuralPreflight.ok ? "passed" : "failed"}**`,
    "",
    "## Lane evidence",
    "",
  ];
  const forcedLaneIds = new Set(status.integrate?.forcedLanes || []);
  for (const lane of status.lanes || []) {
    lines.push(`### ${lane.id} (${lane.harness})`, "");
    lines.push(`- State: ${lane.state}`);
    if (forcedLaneIds.has(lane.id)) {
      lines.push(`- **Force-included in integration:** lane ended \`${lane.state}\`; its snapshot commit was folded on operator instruction`);
    }
    lines.push(`- Kind: ${lane.kind || "legacy/unspecified"}`);
    lines.push(`- Completion contract: ${lane.completion?.state || "legacy/unrecorded"}`);
    lines.push(`- Expected outputs: ${lane.expectedOutputs?.length ? lane.expectedOutputs.map((file) => `\`${file}\``).join(", ") : "none"}`);
    lines.push(`- Scope: ${lane.scope}`);
    lines.push(`- Read-only paths: ${lane.readOnly || "none"}`);
    lines.push(`- Depends on: ${lane.dependsOn?.length ? lane.dependsOn.join(", ") : "none"}`);
    lines.push(`- Dependencies integrated: ${lane.dependenciesIntegrated?.length ? lane.dependenciesIntegrated.join(", ") : "none"}`);
    lines.push(`- Changed files: ${lane.changedFiles?.length ? lane.changedFiles.map((file) => `\`${file}\``).join(", ") : "none"}`);
    lines.push(`- Scope violations: ${lane.scopeViolations?.length ? lane.scopeViolations.join(", ") : "none"}`);
    lines.push(`- Read-only violations: ${lane.readOnlyViolations?.length ? lane.readOnlyViolations.join(", ") : "none"}`);
    lines.push(`- Policy violations: ${lane.policyViolations?.length ? lane.policyViolations.join("; ") : "none"}`);
    lines.push(`- Exit: ${lane.exitCode ?? "-"}`);
    lines.push(`- Evidence log: \`${lane.logPath || "-"}\``, "");
  }
  lines.push("## Integration risk", "");
  lines.push(`- Dependency topology: ${status.topology?.fullySerialized ? "fully serialized" : "parallelizable"}`);
  if (status.topology?.recommendation) lines.push(`- Topology recommendation: ${status.topology.recommendation}`);
  lines.push(`- Structural preflight errors: ${structuralPreflight.errors.length ? structuralPreflight.errors.join("; ") : "none"}`);
  if (structuralPreflight.forceIncluded?.length || status.integrate?.excludedLanes?.length) {
    lines.push(
      `- Force-included lanes (\`--force-lanes ${(status.integrate?.forceLaneSelectors || []).join(",")}\`): ${
        structuralPreflight.forceIncluded?.length ? structuralPreflight.forceIncluded.join("; ") : "none"
      }`,
    );
    lines.push(
      `- Lanes excluded from the fold: ${
        status.integrate?.excludedLanes?.length
          ? status.integrate.excludedLanes.map((lane) => `${lane.id} (${lane.reason})`).join("; ")
          : "none"
      }`,
    );
  }
  lines.push(
    `- Changed-file overlaps: ${
      status.integrate?.changedFileOverlaps?.length
        ? status.integrate.changedFileOverlaps
            .map((item) => `${item.file} (${item.lanes.join(", ")})`)
            .join("; ")
        : "none"
    }`,
  );
  lines.push(
    `- Approved sequential overlaps: ${
      status.integrate?.approvedChangedFileOverlaps?.length
        ? status.integrate.approvedChangedFileOverlaps
            .map((item) => `${item.file} (${item.lanes.join(" -> ")})`)
            .join("; ")
        : "none"
    }`,
  );
  lines.push(`- Integrated verification: ${status.integrate?.verification?.state || "not run"}`, "");
  lines.push("## Verification", "", "- [ ] Planning evidence, reviewed base, and frozen context digest checked", "- [ ] Original request checked against delivered files", "- [ ] Cross-lane contracts checked", "- [ ] Configured integrated verification passed or was explicitly reviewed", "- [ ] Tests rerun by the reviewing host", "- [ ] Public-repository hygiene scan passed", "", "## Decision", "", "Choose one: `accept` | `accept-with-notes` | `revise` | `relaunch` | `reject`", "");
  const transition = reviewTransition(decision, pass, status);
  lines.push(
    "## Transition",
    "",
    "| | |",
    "|---|---|",
    `| **Mode** | \`${transition.mode}\` |`,
    `| **Next action** | ${transition.nextAction} |`,
    `| **Operator input required** | ${transition.input} |`,
    "",
  );
  const markdown = lines.join("\n");
  const path = join(runDir(runId), `delivery-review-pass-${pass}.md`);
  if (write) writePrivateFile(path, markdown, "utf8");
  const decisionPath = join(runDir(runId), `delivery-review-pass-${pass}.json`);
  if (write && decision) {
    writePrivateFile(decisionPath, JSON.stringify({
      schema: "agent-manager.review-decision.v1",
      runId,
      ...decision,
    }, null, 2) + "\n", "utf8");
  }
  return {
    schema: "agent-manager.review.v1",
    runId,
    pass,
    verdict: decision?.verdict || null,
    state: status.state,
    path,
    decisionPath: decision ? decisionPath : null,
    markdown,
  };
}

export function inspectDeliveryStructure(status) {
  const errors = [];
  // Lanes the operator force-included via `integrate --force-lanes`. Their work
  // is in the fold, so a failed state is recorded evidence rather than a
  // structural error — but it is never silently read as `done`.
  const forcedLanes = new Set(status.integrate?.forcedLanes || []);
  const forceIncluded = [];
  const root = runDir(status.runId);
  if (status.planning?.state !== "verified") errors.push("planning evidence is not verified");
  if (!status.planning?.contextSnapshot || !existsSync(status.planning.contextSnapshot)) {
    errors.push("frozen planning context is missing");
  } else {
    const digest = createHash("sha256")
      .update(readFileSync(status.planning.contextSnapshot, "utf8"), "utf8")
      .digest("hex");
    if (digest !== status.planning.contextDigest) errors.push("frozen planning context digest mismatch");
  }
  for (const lane of status.lanes || []) {
    if (lane.state !== "done") {
      if (forcedLanes.has(lane.id)) forceIncluded.push(`${lane.id} (${lane.state})`);
      else errors.push(`lane ${lane.id} is ${lane.state}`);
    }
    if (lane.completion && lane.completion.state !== "verified") {
      errors.push(`lane ${lane.id} completion is ${lane.completion.state}`);
    }
    if (!lane.worktree || !existsSync(lane.worktree)) {
      errors.push(`lane ${lane.id} worktree is missing`);
      continue;
    }
    try {
      assertPathInside(root, lane.worktree, `lane ${lane.id} worktree`);
    } catch (error) {
      errors.push(error.message);
    }
    const branch = branchOf(lane.worktree);
    if (branch !== lane.branch) {
      errors.push(`lane ${lane.id} branch mismatch: expected ${lane.branch}, found ${branch || "detached HEAD"}`);
    }
  }
  for (const target of status.delivery?.targets || []) {
    if (!(target.changedFiles || []).length) errors.push(`delivery target ${target.id} has no changed files`);
    if (!target.branch || !target.base) errors.push(`delivery target ${target.id} is missing branch/base metadata`);
    if (!target.worktree || !existsSync(target.worktree)) {
      errors.push(`delivery target ${target.id} worktree is missing`);
      continue;
    }
    try {
      assertPathInside(root, target.worktree, `delivery target ${target.id} worktree`);
    } catch (error) {
      errors.push(error.message);
    }
    const branch = branchOf(target.worktree);
    if (branch !== target.branch) {
      errors.push(
        `delivery target ${target.id} branch mismatch: expected ${target.branch}, found ${branch || "detached HEAD"}`,
      );
    }
  }
  return { ok: errors.length === 0, errors, forceIncluded };
}

/*
 * Run closeout — filing run outputs as durable brain artifacts.
 *
 * A research or accept-without-ship run still produces evidence worth keeping
 * after its run directory is cleaned. Closeout copies that evidence into a
 * bundle under the brain root and records one `artifact_link` per declared
 * goal reference, so the goal graph can point at the outputs later.
 */

const ARTIFACT_STATE_BY_RUN_STATE = Object.freeze({
  filed: "delivered",
  reviewed: "delivered",
  merged: "delivered",
  released: "delivered",
  rejected: "cancelled",
  cancelled: "cancelled",
  failed: "blocked",
});

export function runArtifactBundleRoot(runId, { root = BRAIN_ROOT } = {}) {
  return join(root, ".artifacts", assertSafeSlug(runId, "run id"));
}

export function runArtifactRef(runId) {
  return `run-artifact:${assertSafeSlug(runId, "run id")}`;
}

/**
 * Run outputs worth filing: the run's own reports and telemetry, every
 * recorded Delivery Review, and each lane's declared expected outputs. Lane
 * logs are deliberately excluded — they are large and not the deliverable.
 */
export function collectRunArtifacts(status, { warnings = [] } = {}) {
  const root = runDir(status.runId);
  const artifacts = [];
  const seen = new Set();

  const add = (source, relPath, label, origin) => {
    if (seen.has(relPath) || !existsSync(source)) return;
    const stats = statSync(source);
    if (!stats.isFile()) return;
    seen.add(relPath);
    artifacts.push({ source, relPath, label, origin, bytes: stats.size });
  };

  add(join(root, "report.md"), "report.md", "run report", "run");
  add(join(root, "status.json"), "status.json", "run telemetry", "run");
  for (const pass of [1, 2]) {
    add(
      join(root, `delivery-review-pass-${pass}.md`),
      `delivery-review-pass-${pass}.md`,
      `Delivery Review pass ${pass}`,
      "review",
    );
    add(
      join(root, `delivery-review-pass-${pass}.json`),
      `delivery-review-pass-${pass}.json`,
      `Delivery Review pass ${pass} decision`,
      "review",
    );
  }

  for (const lane of status.lanes || []) {
    if (!lane.worktree) continue;
    for (const output of lane.expectedOutputs || []) {
      const normalized = String(output).replace(/\\/g, "/").replace(/^\.\//, "");
      let source;
      try {
        source = assertPathInside(lane.worktree, join(lane.worktree, normalized), `lane ${lane.id} output`);
      } catch (error) {
        warnings.push(String(error?.message || error));
        continue;
      }
      if (!existsSync(source)) {
        warnings.push(`lane ${lane.id} expected output is missing: ${normalized}`);
        continue;
      }
      add(source, `lanes/${lane.id}/${normalized}`, `${lane.id} output`, "lane");
    }
  }

  return artifacts;
}

/**
 * Copy this run's outputs into the brain artifact bundle and link the bundle
 * to every goal the run declared. Idempotent: re-filing refreshes the bundle
 * and updates the existing links instead of duplicating them.
 */
export async function fileRunArtifacts(runId, {
  root = BRAIN_ROOT,
  now = new Date(),
  write = true,
} = {}) {
  let status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  const bundleRoot = runArtifactBundleRoot(runId, { root });
  const warnings = [];
  const artifacts = collectRunArtifacts(status, { warnings });
  ensurePrivateDir(bundleRoot);

  const filed = [];
  for (const artifact of artifacts) {
    const destination = assertPathInside(
      bundleRoot,
      join(bundleRoot, ...artifact.relPath.split("/")),
      `run artifact ${artifact.relPath}`,
    );
    ensurePrivateDir(dirname(destination));
    const contents = readFileSync(artifact.source);
    writePrivateFile(destination, contents);
    filed.push({
      path: artifact.relPath,
      label: artifact.label,
      origin: artifact.origin,
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }

  const filedAt = now.toISOString();
  const artifactRef = runArtifactRef(runId);
  const goalRefs = status.goalRefs || [];
  const manifestPath = join(bundleRoot, "manifest.json");
  writePrivateFile(manifestPath, JSON.stringify({
    schema: "agent-manager.run-artifact-bundle.v1",
    runId,
    runState: status.state,
    repo: status.repo,
    title: status.identity?.displayTitle || null,
    artifactRef,
    goalRefs,
    filedAt,
    artifacts: filed,
    warnings,
  }, null, 2) + "\n", "utf8");

  const linkState = ARTIFACT_STATE_BY_RUN_STATE[status.state] || "active";
  const label = `${runId} run outputs (${filed.length} file${filed.length === 1 ? "" : "s"})`;
  const links = [];
  const errors = [];
  for (const goalId of goalRefs) {
    try {
      const link = await linkGoalArtifact({
        goalId,
        artifactType: "other",
        artifactRef,
        relationship: "delivers",
        state: linkState,
        label,
      }, { root, now });
      links.push({ goalId, linkId: link.id, action: "created" });
    } catch (error) {
      const duplicateId = error instanceof GoalModelError
        && error.code === "DUPLICATE_ARTIFACT_LINK"
        ? error.details?.linkId
        : null;
      if (!duplicateId) {
        errors.push({ goalId, message: String(error?.message || error) });
        continue;
      }
      try {
        const link = await updateArtifactLink(duplicateId, { state: linkState, label }, { root, now });
        links.push({ goalId, linkId: link.id, action: "updated" });
      } catch (updateError) {
        errors.push({ goalId, message: String(updateError?.message || updateError) });
      }
    }
  }

  const closeout = {
    schema: "agent-manager.run-closeout.v1",
    state: errors.length ? "partial" : "filed",
    filedAt,
    bundleRoot,
    manifest: manifestPath,
    artifactRef,
    artifactCount: filed.length,
    goalRefs,
    links,
    warnings,
    errors,
  };
  status.closeout = closeout;
  if (write) {
    status = writeStatus(runId, status);
    writeReport(runId, status);
  }
  return { runId, ...closeout, artifacts: filed };
}

/**
 * Terminate an accepted run that will not be shipped: file its outputs, then
 * record the `filed` terminal state. Never use `cancel` for this — filing is
 * a successful outcome, not abandonment.
 */
export async function closeoutRun(runId, {
  operator,
  reason = null,
  fileArtifacts = true,
  root = BRAIN_ROOT,
  now = new Date(),
} = {}) {
  let status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  recordFiled(status, { operator, reason, at: now.toISOString() });
  status = writeStatus(runId, status);
  writeReport(runId, status);

  let closeout = null;
  if (fileArtifacts) {
    try {
      closeout = await fileRunArtifacts(runId, { root, now });
    } catch (error) {
      closeout = {
        schema: "agent-manager.run-closeout.v1",
        state: "failed",
        errors: [{ goalId: null, message: String(error?.message || error) }],
      };
      status.closeout = closeout;
      status = writeStatus(runId, status);
      writeReport(runId, status);
    }
  }

  return {
    schema: "agent-manager.run-filed.v1",
    runId,
    state: status.state,
    filed: status.delivery?.filed || null,
    closeout,
    goalHints: staleGoalHints(status),
  };
}

function reviewTransition(decision, pass, status) {
  if (!decision) {
    return {
      mode: "WAIT_OPERATOR",
      nextAction: "Persist the selected verdict, then advance without another confirmation.",
      input: pass === 2
        ? "`accept | accept-with-notes | reject`"
        : "`accept | accept-with-notes | revise | relaunch | reject`",
    };
  }
  if (["accept", "accept-with-notes"].includes(decision.verdict)) {
    if (status.state === "reviewed") {
      return {
        mode: "TERMINAL",
        nextAction: "Post the accepted review-only outcome and complete source-system closeout.",
        input: "`none`",
      };
    }
    return {
      mode: "AUTO_CONTINUE",
      nextAction: "Present the matching Ship Gate in this turn. If the accepted work will not be shipped, close it with `agent-manager closeout` (terminal `filed`), never `cancel`.",
      input: "`none`",
    };
  }
  if (["revise", "relaunch"].includes(decision.verdict)) {
    return {
      mode: "AUTO_CONTINUE",
      nextAction: "Post Correction kickoff and launch the one authorized correction.",
      input: "`none`",
    };
  }
  return {
    mode: "TERMINAL",
    nextAction: "Post the rejected final outcome and complete source-system closeout.",
    input: "`none`",
  };
}
