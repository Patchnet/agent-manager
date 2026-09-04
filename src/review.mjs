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
import {
  assertGoalsExist,
  GOAL_DISPOSITIONS,
  GoalModelError,
  linkGoalArtifact,
  recordGoalDisposition,
  updateArtifactLink,
} from "./goals.mjs";
import { ratificationGap } from "./ratify.mjs";
import { writeReport } from "./report.mjs";
import { inspectPortableScriptLineEndings } from "./guardrails.mjs";
import {
  AuthorizationError,
  materializeReviewAuthorization,
  resolveReviewerIdentity,
} from "./authorization.mjs";

const AWAITING_REVIEW_STATES = ["delivery_review_pending", "correction_pending", "ship_gate_pending"];
/**
 * A run that died, stalled, or was cancelled never reaches an awaiting-review
 * state, so its verdict had nowhere to live. `--recovered` lets Master record
 * one anyway — explicitly, and stamped as recovered so nobody later reads it as
 * an ordinary review. It only relaxes the state gate: structural preflight
 * still gates acceptance.
 */
const RECOVERABLE_REVIEW_STATES = ["blocked", "failed", "cancelled"];

export function buildDeliveryReview(runId, {
  pass = 1,
  write = true,
  verdict = null,
  reviewer = null,
  reviewerRole = null,
  automationPolicy = null,
  notes = null,
  recovered = false,
} = {}) {
  if (![1, 2].includes(pass)) throw new Error("review pass must be 1 or 2");
  let status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  let recoveredFrom = null;
  if (!AWAITING_REVIEW_STATES.includes(status.state)) {
    const recoverable = RECOVERABLE_REVIEW_STATES.includes(status.state);
    if (!recovered || !recoverable) {
      throw new Error(
        `run ${runId} is not awaiting Delivery Review (state ${status.state})` +
          (recoverable ? "; rerun with --recovered to record a verdict on a recovered run" : ""),
      );
    }
    recoveredFrom = status.state;
  }
  const structuralPreflight = inspectDeliveryStructure(status);
  if (verdict && ["accept", "accept-with-notes"].includes(verdict) && !structuralPreflight.ok) {
    throw new Error(
      `Delivery Review cannot be accepted; structural preflight failed: ${structuralPreflight.errors.join("; ")}`,
    );
  }
  if (verdict) {
    const reviewerIdentity = resolveReviewerIdentity(status, reviewerRole);
    recordReviewDecision(status, { pass, verdict, reviewer, reviewerIdentity, notes });
    if (automationPolicy && ["accept", "accept-with-notes"].includes(verdict)) {
      try {
        const materialized = materializeReviewAuthorization(status, { policyPath: automationPolicy });
        const reviewDecision = status.delivery.review.history.find((item) => item.pass === pass);
        reviewDecision.authorization = {
          mode: "repo-policy",
          policyDigest: materialized.grant.policyBinding.digest,
          grantDigest: materialized.grant.grantDigest,
        };
        status.authorization = materialized.summary;
      } catch (error) {
        const failureCode = error instanceof AuthorizationError ? error.code : "policy-invalid";
        const nextAction = error instanceof AuthorizationError
          ? error.action
          : "Use the manual Ship Gate, or repair and independently review the repo policy in a new run.";
        status.authorization = {
          schema: "agent-manager.authorization-summary.v1",
          state: "blocked",
          valid: false,
          level: null,
          grantDigest: null,
          failureCode,
          nextAction,
        };
      }
    }
    stampRecovery(status, pass, recoveredFrom);
    // A cancelled run stays cancelled. `writeStatus` refuses to move a run off
    // `cancelled` while its cancel marker exists, so leaving the verdict's own
    // state transition in place would drop the whole write on the floor — and a
    // verdict is evidence about abandoned work, not a resurrection of it. The
    // decision itself is recorded on the delivery record either way.
    if (recoveredFrom === "cancelled") {
      status.state = "cancelled";
      status.endedAt ||= status.delivery.review.decidedAt;
    }
    status = writeStatus(runId, status);
    writeReport(runId, status);
    assertRecoveredDecisionPersisted(status, pass, recoveredFrom, runId);
  } else if (write
    && (recoveredFrom || ["delivery_review_pending", "correction_pending"].includes(status.state))
    && status.delivery?.review?.state !== "accepted") {
    recordReviewPresentation(status, { pass });
    stampRecovery(status, pass, recoveredFrom);
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
    `- Conditional authorization: ${status.authorization?.valid
      ? `**ready** (grant \`${status.authorization.grantDigest}\`)`
      : status.authorization
        ? `**blocked** (${status.authorization.failureCode || "policy-invalid"}; manual Ship Gate required)`
        : "not enabled; manual Ship Gate required"}`,
    `- Structural preflight: **${structuralPreflight.ok ? "passed" : "failed"}**`,
    ...(recoveredFrom || status.delivery?.review?.recoveredFrom
      ? [`- Recovered review: **recorded from \`${recoveredFrom || status.delivery.review.recoveredFrom}\`**`]
      : []),
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
    lines.push(`- Scope extensions: ${formatScopeExtensions(lane)}`);
    lines.push(`- Read-only paths: ${lane.readOnly || "none"}`);
    lines.push(`- Depends on: ${lane.dependsOn?.length ? lane.dependsOn.join(", ") : "none"}`);
    lines.push(`- Dependencies integrated: ${lane.dependenciesIntegrated?.length ? lane.dependenciesIntegrated.join(", ") : "none"}`);
    lines.push(`- Changed files: ${lane.changedFiles?.length ? lane.changedFiles.map((file) => `\`${file}\``).join(", ") : "none"}`);
    lines.push(`- Scope violations: ${lane.scopeViolations?.length ? lane.scopeViolations.join(", ") : "none"}`);
    lines.push(`- Read-only violations: ${lane.readOnlyViolations?.length ? lane.readOnlyViolations.join(", ") : "none"}`);
    lines.push(`- Portable-script line-ending violations: ${lane.portableScriptViolations?.length ? lane.portableScriptViolations.join(", ") : "none"}`);
    lines.push(`- Policy violations: ${lane.policyViolations?.length ? lane.policyViolations.join("; ") : "none"}`);
    // A ratified lane is never rendered as clean: the violations stay on the
    // record above, and this line says who accepted them and why.
    if (lane.ratification) {
      const ratified = (lane.ratification.violations || []).map((file) => `\`${file}\``).join(", ");
      lines.push(
        `- **Ratified violations:** ${ratified || "none recorded"} - ${lane.ratification.reason} ` +
          `(${lane.ratification.by || "-"}, ${lane.ratification.at || "-"})`,
      );
      const uncovered = ratificationGap(lane);
      if (uncovered.length) {
        lines.push(`- **Violations recorded after ratification:** ${uncovered.join("; ")}`);
      }
    }
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
    lines.push(
      `- Lanes folded on a recorded ratification: ${
        status.integrate?.ratifiedLanes?.length ? status.integrate.ratifiedLanes.join(", ") : "none"
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
  lines.push(
    `- Portable-script line-ending violations: ${
      structuralPreflight.portableScriptViolations.length
        ? structuralPreflight.portableScriptViolations.map((file) => `\`${file}\``).join(", ")
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
    authorization: status.authorization || null,
    markdown,
  };
}

/**
 * Mark a review that was recorded outside the ordinary awaiting-review states,
 * on both the decision and the review summary, so the run's own telemetry says
 * where the verdict came from.
 */
/**
 * `writeStatus` can silently discard a write and hand back the on-disk record.
 * A recovered verdict that was dropped that way must not be reported as
 * recorded, so re-read what actually landed before returning.
 */
function assertRecoveredDecisionPersisted(status, pass, recoveredFrom, runId) {
  if (!recoveredFrom) return;
  const persisted = (status.delivery?.review?.history || [])
    .some((item) => item.pass === Number(pass) && item.recovered === true);
  if (!persisted) {
    throw new Error(
      `recovered Delivery Review pass ${pass} for ${runId} was not persisted; ` +
        "inspect the run directory before recording it again",
    );
  }
}

function stampRecovery(status, pass, recoveredFrom) {
  if (!recoveredFrom) return;
  const review = status.delivery?.review;
  if (!review) return;
  review.recovered = true;
  review.recoveredFrom = recoveredFrom;
  const decision = (review.history || []).find((item) => item.pass === Number(pass));
  if (decision) {
    decision.recovered = true;
    decision.recoveredFrom = recoveredFrom;
  }
}

function formatScopeExtensions(lane) {
  const grants = lane.scopeExtensions || [];
  if (!grants.length) return "none";
  return grants
    .map((grant) => {
      const patterns = (grant.patterns || []).map((pattern) => `\`${pattern}\``).join(", ");
      return `${patterns || "none"} (${grant.by || "-"}, ${grant.at || "-"})`;
    })
    .join("; ");
}

export function inspectDeliveryStructure(status) {
  const errors = [];
  const portableScriptViolations = new Set(status.integrate?.portableScriptViolations || []);
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
    if (status.baseCommit) {
      try {
        for (const file of inspectPortableScriptLineEndings({
          worktree: target.worktree,
          baseCommit: status.baseCommit,
        })) {
          portableScriptViolations.add(file);
        }
      } catch (error) {
        errors.push(`delivery target ${target.id} portable-script inspection failed: ${error.message}`);
      }
    }
  }
  if (portableScriptViolations.size) {
    errors.push(
      "portable Unix scripts use CRLF line endings: " +
        [...portableScriptViolations].sort().join(", "),
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    forceIncluded,
    portableScriptViolations: [...portableScriptViolations].sort(),
  };
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

const ARTIFACT_STATE_BY_DISPOSITION = Object.freeze({
  delivered: "delivered",
  superseded: "superseded",
  deferred: "planned",
  open: "active",
  cancelled: "cancelled",
});

function normalizeGoalDispositions(status, values = null, { requireAll = status.state === "filed" } = {}) {
  const supplied = values || status.closeout?.dispositions || [];
  const dispositions = supplied.map((item) => ({
    goalId: String(item.goalId || ""),
    disposition: String(item.disposition || ""),
  })).sort((left, right) => left.goalId.localeCompare(right.goalId));
  const refs = [...new Set(status.goalRefs || [])].sort();
  const duplicate = dispositions.find((item, index) => (
    dispositions.findIndex((candidate) => candidate.goalId === item.goalId) !== index
  ));
  if (duplicate) throw new Error(`goal disposition repeated for ${duplicate.goalId}`);
  for (const item of dispositions) {
    if (!refs.includes(item.goalId)) throw new Error(`run ${status.runId} did not declare goal ${item.goalId}`);
    if (!GOAL_DISPOSITIONS.includes(item.disposition)) {
      throw new Error(`unsupported goal disposition: ${item.disposition}`);
    }
  }
  const missing = refs.filter((goalId) => !dispositions.some((item) => item.goalId === goalId));
  if (requireAll && missing.length) {
    throw new Error(`closeout requires --goal-disposition for every declared goal: ${missing.join(", ")}`);
  }
  return dispositions;
}

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
  goalDispositions = null,
  operator = null,
  reason = null,
} = {}) {
  let status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  const dispositions = normalizeGoalDispositions(status, goalDispositions);
  const dispositionByGoal = new Map(dispositions.map((item) => [item.goalId, item.disposition]));
  if (status.goalRefs?.length) await assertGoalsExist(status.goalRefs, { root });
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
    dispositions,
    filedAt,
    artifacts: filed,
    warnings,
  }, null, 2) + "\n", "utf8");

  const defaultLinkState = ARTIFACT_STATE_BY_RUN_STATE[status.state] || "active";
  const label = `${runId} run outputs (${filed.length} file${filed.length === 1 ? "" : "s"})`;
  const links = [];
  const errors = [];
  for (const goalId of goalRefs) {
    const disposition = dispositionByGoal.get(goalId);
    const linkState = ARTIFACT_STATE_BY_DISPOSITION[disposition] || defaultLinkState;
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

  const recordedDispositions = [];
  for (const item of dispositions) {
    try {
      const recorded = await recordGoalDisposition(item.goalId, {
        disposition: item.disposition,
        operator: operator || status.delivery?.filed?.operator,
        reason: reason ?? status.delivery?.filed?.reason ?? null,
        runId,
      }, { root, now });
      recordedDispositions.push({
        goalId: item.goalId,
        disposition: item.disposition,
        lifecycle: recorded.goal.lifecycle,
        changed: recorded.changed,
      });
    } catch (error) {
      errors.push({ goalId: item.goalId, message: String(error?.message || error) });
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
    dispositions: recordedDispositions,
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
  goalDispositions = [],
} = {}) {
  let status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  if (!fileArtifacts) throw new Error("closeout must retain the run artifact bundle");
  const dispositions = normalizeGoalDispositions(status, goalDispositions, { requireAll: true });
  const priorDispositions = (status.closeout?.dispositions || [])
    .map((item) => ({ goalId: item.goalId, disposition: item.disposition }))
    .sort((left, right) => left.goalId.localeCompare(right.goalId));
  const sameCloseout = status.state === "filed"
    && status.closeout?.state === "filed"
    && status.delivery?.filed?.operator === String(operator || "").trim()
    && status.delivery?.filed?.reason === (reason ? String(reason).trim() : null)
    && JSON.stringify(priorDispositions) === JSON.stringify(dispositions);
  if (sameCloseout) {
    return {
      schema: "agent-manager.run-filed.v1",
      runId,
      state: status.state,
      filed: status.delivery.filed,
      closeout: status.closeout,
      goalHints: staleGoalHints(status),
    };
  }
  if (status.state === "filed" && status.closeout?.state === "filed") {
    throw new Error(`run ${runId} is already filed with a different settled closeout receipt`);
  }
  if (status.goalRefs?.length) await assertGoalsExist(status.goalRefs, { root });
  recordFiled(status, { operator, reason, at: now.toISOString() });
  status = writeStatus(runId, status);
  writeReport(runId, status);

  let closeout = null;
  if (fileArtifacts) {
    try {
      closeout = await fileRunArtifacts(runId, {
        root,
        now,
        goalDispositions: dispositions,
        operator,
        reason,
      });
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
  status = readStatus(runId) || status;

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
    if (status.authorization?.valid) {
      return {
        mode: "AUTO_CONTINUE",
        nextAction: `Launch \`agent-manager ship ${status.runId} --authorized --detach\`; the accepting review already materialized the immutable grant.`,
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
