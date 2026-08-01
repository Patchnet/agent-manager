import { join } from "node:path";
import { readStatus, writeStatus } from "./status.mjs";
import { runDir } from "./paths.mjs";
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
    "",
    "## Lane evidence",
    "",
  ];
  for (const lane of status.lanes || []) {
    lines.push(`### ${lane.id} (${lane.harness})`, "");
    lines.push(`- State: ${lane.state}`);
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
  const transition = reviewTransition(decision, pass);
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

function reviewTransition(decision, pass) {
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
