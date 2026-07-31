import { writePrivateFile } from "./fs-safe.mjs";
import { join } from "node:path";
import { runDir } from "./paths.mjs";
import { formatRuntime } from "./runtime.mjs";

export function writeReport(runId, status) {
  const lines = [
    `# agent-manager run report`,
    "",
    `- **runId:** ${runId}`,
    `- **repo:** ${status.repo}`,
    `- **state:** ${status.state}`,
    `- **target_dev_flow:** ${status.target_dev_flow || "-"}`,
    `- **runtime:** ${formatRuntime(status.runtime)}`,
    `- **started:** ${status.startedAt || "-"}`,
    `- **ended:** ${status.endedAt || "-"}`,
    `- **workflow:** ${status.workflow || "-"}`,
    `- **immutable base:** ${status.baseCommit || status.initialRepo?.head || "-"}`,
    `- **max concurrency:** ${status.maxConcurrency || "-"}`,
    `- **initial repo dirty:** ${status.initialRepo?.dirty ? "yes" : "no"}`,
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
    "## Lanes",
    "",
  ];
  for (const lane of status.lanes || []) {
    lines.push(`### ${lane.id}`);
    lines.push("");
    lines.push(`- harness: ${lane.harness}`);
    lines.push(`- state: ${lane.state}`);
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
  lines.push("## Next");
  lines.push("");
  if (status.ship?.state === "done") {
    lines.push(`- **Ship complete:** ${status.ship.prUrl || status.ship.tag || status.ship.branch}`);
    lines.push("- Review the Ship outcome board and clean retained run artifacts when appropriate.");
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
  lines.push("");

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
