import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./paths.mjs";

export function writeReport(runId, status) {
  const lines = [
    `# agent-manager run report`,
    "",
    `- **runId:** ${runId}`,
    `- **repo:** ${status.repo}`,
    `- **state:** ${status.state}`,
    `- **target_dev_flow:** ${status.target_dev_flow || "-"}`,
    `- **started:** ${status.startedAt || "-"}`,
    `- **ended:** ${status.endedAt || "-"}`,
    `- **workflow:** ${status.workflow || "-"}`,
    `- **initial repo dirty:** ${status.initialRepo?.dirty ? "yes" : "no"}`,
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
  if (status.integrate?.state === "ready") {
    lines.push(`- **Integrate ready:** \`${status.integrate.branch}\``);
    lines.push(`- Worktree: \`${status.integrate.worktree}\``);
    lines.push("- Present Ship Gate for the integrate branch (Formal: no version stamp on branch).");
    lines.push("- On `through-pr` / `all`: push → `gh pr create` → `gh pr merge --auto --squash`.");
    lines.push("- After merge: Ship Gate for VERSION/TAG → `npm run release:formal` when the target repo has it.");
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
    if (status.integrate.shipGateHint) {
      lines.push(`- hint: ${status.integrate.shipGateHint}`);
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
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}
