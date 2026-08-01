import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readStatus, writeStatus } from "./status.mjs";
import { assertPathInside, runDir } from "./paths.mjs";
import { branchOf } from "./worktree.mjs";
import { writePrivateFile } from "./fs-safe.mjs";
import { formatRuntime } from "./runtime.mjs";
import { recordReviewDecision, recordReviewPresentation } from "./delivery.mjs";
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
  for (const lane of status.lanes || []) {
    lines.push(`### ${lane.id} (${lane.harness})`, "");
    lines.push(`- State: ${lane.state}`);
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
    if (lane.state !== "done") errors.push(`lane ${lane.id} is ${lane.state}`);
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
  return { ok: errors.length === 0, errors };
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
      nextAction: "Present the matching Ship Gate in this turn.",
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
