import { writePrivateFile } from "./fs-safe.mjs";
import { join } from "node:path";
import { runDir } from "./paths.mjs";
import { formatRuntime } from "./runtime.mjs";
import { deriveOperatorCadence } from "./cadence.mjs";
import { isOverallTerminalState, staleGoalHints } from "./delivery.mjs";

export function writeReport(runId, status) {
  const cadence = deriveOperatorCadence(status);
  const goalHints = staleGoalHints(status);
  const lines = [
    `# agent-manager run report`,
    "",
    `- **runId:** ${runId}`,
    `- **title:** ${status.identity?.displayTitle || "-"}`,
    `- **repo:** ${status.repo}`,
    `- **manager harness:** ${status.identity?.manager?.harness || "-"}`,
    `- **manager model:** ${status.identity?.manager?.model || "-"}`,
    `- **state:** ${status.state}`,
    `- **target_dev_flow:** ${status.target_dev_flow || "-"}`,
    `- **runtime:** ${formatRuntime(status.runtime)}`,
    `- **started:** ${status.startedAt || "-"}`,
    `- **ended:** ${status.endedAt || "-"}`,
    `- **workflow:** ${status.workflow || "-"}`,
    `- **immutable base:** ${status.baseCommit || status.initialRepo?.head || "-"}`,
    `- **max concurrency:** ${status.maxConcurrency || "-"}`,
    `- **effective parallelism:** ${status.topology?.effectiveParallelism || "-"}`,
    `- **fully serialized:** ${status.topology?.fullySerialized ? "yes" : "no"}`,
    `- **topology recommendation:** ${status.topology?.recommendation || "-"}`,
    `- **initial repo dirty:** ${status.initialRepo?.dirty ? "yes" : "no"}`,
    `- **operator transition:** ${cadence.transition}`,
    "",
    "## Planning preflight",
    "",
    `- **state:** ${status.planning?.state || "legacy/unrecorded"}`,
    `- **plan:** ${status.planning?.planRef || "-"}`,
    `- **source references:** ${status.planning?.sourceRefs?.join(", ") || "-"}`,
    `- **reviewed base:** ${status.planning?.reviewedBaseSha || "-"}`,
    `- **launch base:** ${status.planning?.actualBaseSha || "-"}`,
    `- **context file:** ${status.planning?.contextFile || "-"}`,
    `- **context SHA-256:** ${status.planning?.contextDigest || "-"}`,
    `- **verified by:** ${status.planning?.verifiedBy || "-"}`,
    `- **verified at:** ${status.planning?.verifiedAt || "-"}`,
    `- **reviewed paths:** ${status.planning?.reviewedPaths?.join(", ") || "-"}`,
    `- **repository instructions:** ${status.planning?.repositoryInstructionRefs?.join(", ") || "-"}`,
    `- **attestations:** ${status.planning?.attestations ? Object.entries(status.planning.attestations).map(([key, value]) => `${key}=${value}`).join(", ") : "-"}`,
    "",
    "## Goal context",
    "",
    `- **goal references:** ${status.goalRefs?.length ? status.goalRefs.join(", ") : "-"}`,
    `- **frozen goals:** ${status.goals?.goals?.length ?? 0}`,
    `- **artifact links:** ${status.goals?.artifactLinks?.length ?? 0}`,
    `- **context SHA-256:** ${status.goals?.contextDigest || "-"}`,
    `- **context snapshot:** ${status.goals?.contextSnapshot || "-"}`,
    `- **goals awaiting advancement:** ${
      goalHints.length
        ? goalHints.map((hint) => `${hint.id} (${hint.lifecycle})`).join(", ")
        : "none"
    }`,
    "",
    "## Cross-run awareness",
    "",
    `- **state:** ${status.awareness?.state || "legacy/unrecorded"}`,
    `- **repository key:** ${status.awareness?.repoKey || "-"}`,
    `- **identity source:** ${status.awareness?.repoIdentitySource || "-"}`,
    `- **intent:** ${status.awareness?.intentId || "-"}`,
    `- **active related runs:** ${status.awareness?.activeRelated?.map((item) => item.runId).join(", ") || "-"}`,
    `- **delivery dependencies:** ${status.awareness?.deliveryDependencies?.map((item) => item.runId).join(", ") || "-"}`,
    `- **awareness context SHA-256:** ${status.awareness?.contextDigest || "-"}`,
    `- **warning:** ${status.awareness?.lastError || "-"}`,
    "",
    "## Lanes",
    "",
  ];
  for (const lane of status.lanes || []) {
    lines.push(`### ${lane.id}`);
    lines.push("");
    lines.push(`- harness: ${lane.harness}`);
    lines.push(`- model requested: ${lane.modelRequested || "default"}`);
    lines.push(`- model observed: ${lane.modelObserved || "unverified"}`);
    lines.push(`- kind: ${lane.kind || "-"}`);
    lines.push(`- state: ${lane.state}`);
    lines.push(`- completion: ${lane.completion?.state || "-"}`);
    lines.push(`- expected outputs: ${lane.expectedOutputs?.length ? lane.expectedOutputs.join(", ") : "-"}`);
    lines.push(`- branch: ${lane.branch || "-"}`);
    lines.push(`- worktree: ${lane.worktree || "-"}`);
    lines.push(`- scope: ${lane.scope}`);
    lines.push(`- read-only: ${lane.readOnly || "-"}`);
    lines.push(`- depends on: ${lane.dependsOn?.length ? lane.dependsOn.join(", ") : "-"}`);
    lines.push(`- dependencies integrated: ${lane.dependenciesIntegrated?.length ? lane.dependenciesIntegrated.join(", ") : "-"}`);
    if (lane.waitingFor?.length) lines.push(`- waiting for: ${lane.waitingFor.join(", ")}`);
    if (lane.queueReason) lines.push(`- queue reason: ${lane.queueReason}`);
    lines.push(`- elapsed: ${lane.elapsedSec ?? "-"}s`);
    lines.push(`- exit: ${lane.exitCode ?? "-"}`);
    lines.push(`- session: ${lane.sessionId || "-"}`);
    lines.push(`- ended: ${lane.endedAt || "-"}`);
    lines.push(`- claim: ${lane.claim?.state || "-"}`);
    lines.push(`- last activity: ${lane.lastActivity || "-"}`);
    if (lane.changedFiles?.length) {
      lines.push(`- changed files: ${lane.changedFiles.join(", ")}`);
    }
    if (lane.scopeViolations?.length) {
      lines.push(`- **scope violations:** ${lane.scopeViolations.join(", ")}`);
    }
    if (lane.readOnlyViolations?.length) {
      lines.push(`- **read-only violations:** ${lane.readOnlyViolations.join(", ")}`);
    }
    if (lane.policyViolations?.length) {
      lines.push(`- **policy violations:** ${lane.policyViolations.join("; ")}`);
    }
    if (lane.needsInput) {
      lines.push(`- **needs input:** ${JSON.stringify(lane.needsInput)}`);
    }
    lines.push(`- log: ${lane.logPath || "-"}`);
    lines.push("");
  }
  if (status.delivery) {
    lines.push("## Delivery");
    lines.push("");
    lines.push(`- state: ${status.delivery.state}`);
    lines.push(`- mode: ${status.delivery.mode || "-"}`);
    lines.push(`- workers completed: ${status.delivery.workersCompletedAt || "-"}`);
    lines.push(`- release required: ${status.delivery.releaseRequired ? "yes" : "no"}`);
    lines.push(`- review: ${status.delivery.review?.state || "-"}`);
    lines.push(`- verdict: ${status.delivery.review?.verdict || "-"}`);
    lines.push(`- review pass: ${status.delivery.review?.latestPass || 0}`);
    if (status.delivery.filed) {
      lines.push(`- filed: ${status.delivery.filed.filedAt || "-"} by ${status.delivery.filed.operator || "-"}`);
      lines.push(`- filing reason: ${status.delivery.filed.reason || "-"}`);
      if (status.delivery.filed.unshippedTargets?.length) {
        lines.push(`- accepted but unshipped targets: ${status.delivery.filed.unshippedTargets.join(", ")}`);
      }
    }
    for (const target of status.delivery.targets || []) {
      lines.push(`- target ${target.order}. ${target.id}: ${target.state} · lane ${target.laneId} · branch ${target.branch || "-"} · PR ${target.prUrl || target.pr || "-"} · merge ${target.mergeSha || "-"}`);
    }
    if (status.delivery.release?.tag || status.delivery.release?.sha) {
      lines.push(`- release: ${status.delivery.release.tag || "-"} at ${status.delivery.release.sha || "-"}`);
    }
    lines.push("");
  }
  lines.push("## Next");
  lines.push("");
  lines.push(`- **Stage:** ${cadence.stage}`);
  lines.push(`- **Transition:** ${cadence.transition}`);
  lines.push(`- **Next action:** ${cadence.nextAction}`);
  lines.push(`- **Operator input required:** ${cadence.operatorInputRequired.length ? cadence.operatorInputRequired.join(" | ") : "none"}`);
  if (status.state === "delivery_review_pending") {
    lines.push("- **Delivery Review required:** worker completion is not delivery completion.");
    lines.push(`- Record the decision with \`agent-manager review ${runId} --pass 1 --verdict <decision> --reviewer <id>\`.`);
    lines.push("- Ship Gate remains blocked until an accepted review is persisted.");
  } else if (status.state === "correction_pending") {
    lines.push("- **Correction required:** follow the recorded Delivery Review verdict.");
    lines.push("- After the single correction cycle, record Delivery Review Pass 2.");
  } else if (status.state === "ship_gate_pending") {
    lines.push("- **Ship Gate pending:** Delivery Review is accepted; obtain explicit shipping approval.");
    lines.push("- For a train, ship each target in order with `--target <id>`.");
    lines.push(`- Accepting without shipping: \`agent-manager closeout ${runId} --operator <id>\` files the outputs and ends the run as \`filed\`. Do not use \`cancel\` for accepted work.`);
  } else if (status.state === "release_pending") {
    lines.push("- **Release pending:** all delivery targets merged; verify ancestry and publish the approved release.");
  } else if (status.state === "filed") {
    lines.push("- **Filed:** the accepted work was closed without shipping; this is a delivered outcome, not an abandoned run.");
    lines.push(status.closeout?.bundleRoot
      ? `- Artifact bundle: ${status.closeout.bundleRoot}`
      : `- Artifact bundle: not filed — run \`agent-manager file-artifacts ${runId}\``);
    lines.push("- Nothing was committed, pushed, merged, or tagged by this run.");
  } else if (["reviewed", "released", "merged"].includes(status.state)) {
    lines.push(`- **Delivery complete:** ${status.delivery?.release?.tag || status.ship?.prUrl || status.ship?.branch || status.state}`);
    lines.push("- Review the Ship outcome board and clean retained run artifacts when appropriate.");
  } else if (status.ship?.state === "done") {
    lines.push(`- **Ship complete:** ${status.ship.prUrl || status.ship.tag || status.ship.branch}`);
    lines.push("- Continue the remaining delivery targets; this run is not complete until state is reviewed, merged, or released.");
  } else if (status.ship?.state === "blocked") {
    lines.push(`- **Ship blocked:** ${status.ship.needsInput?.prompt || status.ship.error || "see ship telemetry"}`);
    lines.push("- Resolve the blocker or cancel the ship phase. Do not guess or bypass policy.");
  } else if (status.ship?.state === "running" || status.ship?.state === "queued") {
    lines.push(`- **Ship in progress:** phase \`${status.ship.phase}\``);
    lines.push("- Keep `watch-signal` armed; the host chat does not poll CI or merge inline.");
  } else if (status.integrate?.state === "ready") {
    lines.push(`- **Integrate ready:** \`${status.integrate.branch}\``);
    lines.push(`- Worktree: \`${status.integrate.worktree}\``);
    lines.push("- Present Ship Gate for the integrate branch (Formal: no version stamp on branch).");
    lines.push("- After Ship Gate approval, detach PR Manager with `agent-manager ship <runId> ... --detach`.");
  } else if (status.integrate?.state === "blocked") {
    lines.push(`- **Integrate blocked:** ${status.integrate.error || status.integrate.needsInput?.prompt || "see needs-input"}`);
    lines.push("- Answer escalate in Master Dev chat; resolve conflicts in the integrate worktree.");
  } else {
    lines.push("- Review lane worktrees / branches.");
    lines.push("- Answer any needs-input escalations in Master Dev chat.");
    lines.push("- Present Ship Gate before commit/push/PR/merge/tag.");
  }
  if (isOverallTerminalState(status.state) && goalHints.length) {
    lines.push("- **Goal advancement (hint only):** this run ended while the following declared goals were still open.");
    for (const hint of goalHints) {
      lines.push(`  - \`${hint.id}\` — ${hint.lifecycle}${hint.title ? ` · ${hint.title}` : ""}`);
    }
    lines.push("- Agent Manager never advances a goal. Master decides and runs `agent-manager goal update <id> --lifecycle <value>`.");
  }
  lines.push("");

  if (status.closeout) {
    lines.push("## Closeout");
    lines.push("");
    lines.push(`- state: ${status.closeout.state}`);
    lines.push(`- filed: ${status.closeout.filedAt || "-"}`);
    lines.push(`- artifact reference: ${status.closeout.artifactRef || "-"}`);
    lines.push(`- artifacts filed: ${status.closeout.artifactCount ?? 0}`);
    lines.push(`- bundle: ${status.closeout.bundleRoot || "-"}`);
    lines.push(`- manifest: ${status.closeout.manifest || "-"}`);
    lines.push(
      `- goal links: ${
        status.closeout.links?.length
          ? status.closeout.links.map((link) => `${link.goalId} → ${link.linkId} (${link.action})`).join(", ")
          : "none"
      }`,
    );
    for (const warning of status.closeout.warnings || []) {
      lines.push(`- **warning:** ${warning}`);
    }
    for (const error of status.closeout.errors || []) {
      lines.push(`- **error:** ${error.goalId ? `${error.goalId}: ` : ""}${error.message}`);
    }
    lines.push("");
  }

  if (status.integrate) {
    lines.push("## Integrate");
    lines.push("");
    lines.push(`- state: ${status.integrate.state}`);
    lines.push(`- branch: ${status.integrate.branch || "-"}`);
    lines.push(`- worktree: ${status.integrate.worktree || "-"}`);
    if (status.integrate.merged?.length) {
      lines.push(`- merged lanes: ${status.integrate.merged.join(", ")}`);
    }
    if (status.integrate.changedFileOverlaps?.length) {
      lines.push(
        `- **changed-file overlaps:** ${status.integrate.changedFileOverlaps
          .map((item) => `${item.file} (${item.lanes.join(", ")})`)
          .join("; ")}`,
      );
    }
    if (status.integrate.approvedChangedFileOverlaps?.length) {
      lines.push(
        `- approved sequential overlaps: ${status.integrate.approvedChangedFileOverlaps
          .map((item) => `${item.file} (${item.lanes.join(" -> ")})`)
          .join("; ")}`,
      );
    }
    if (status.integrate.verification) {
      lines.push(`- verification: ${status.integrate.verification.state}`);
      for (const command of status.integrate.verification.commands || []) {
        lines.push(
          `  - \`${command.command.join(" ")}\`: ${command.passed ? "passed" : `failed (${command.exitCode})`}`,
        );
      }
    }
    if (status.integrate.shipGateHint) {
      lines.push(`- hint: ${status.integrate.shipGateHint}`);
    }
    lines.push("");
  }

  if (status.ship) {
    lines.push("## Ship");
    lines.push("");
    lines.push(`- state: ${status.ship.state}`);
    lines.push(`- phase: ${status.ship.phase || "-"}`);
    lines.push(`- approval: ${status.ship.approve || "-"}`);
    lines.push(`- branch: ${status.ship.branch || "-"}`);
    lines.push(`- base: ${status.ship.base || "-"}`);
    lines.push(`- PR: ${status.ship.prUrl || "-"}`);
    lines.push(`- merge SHA: ${status.ship.mergeSha || "-"}`);
    lines.push(`- release SHA: ${status.ship.releaseSha || "-"}`);
    lines.push(`- tag: ${status.ship.tag || "-"}`);
    lines.push(`- last activity: ${status.ship.lastActivity || "-"}`);
    for (const step of status.ship.steps || []) {
      lines.push(`- step ${step.name}: ${step.state} · ${step.detail || "-"}`);
    }
    if (status.ship.ci?.runs?.length) {
      lines.push(`- GitHub Actions: ${status.ship.ci.state || "unknown"}`);
      for (const run of status.ship.ci.runs) {
        lines.push(`  - ${run.workflow || run.id || "run"}: ${run.conclusion || run.status || "pending"}${run.url ? ` · ${run.url}` : ""}`);
      }
    }
    if (status.ship.needsInput?.prompt) {
      lines.push(`- **needs input:** ${status.ship.needsInput.prompt}`);
    }
    lines.push("");
  }

  lines.push("## Agent Feed");
  lines.push("");
  lines.push(`- enabled: ${status.feed?.enabled ? "yes" : "no"}`);
  lines.push(`- topic: ${status.feed?.topic || "-"}`);
  lines.push(`- last event: ${status.feed?.lastEvent || "-"}`);
  lines.push(`- last error: ${status.feed?.lastError || "-"}`);
  lines.push("");

  const path = join(runDir(runId), "report.md");
  writePrivateFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}
