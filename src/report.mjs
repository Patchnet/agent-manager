import { join } from "node:path";
import { writePrivateFile } from "./fs-safe.mjs";
import { runDir } from "./paths.mjs";
import { formatRuntime } from "./runtime.mjs";

const list = (values) => (values?.length ? values.join(", ") : "-");

export function writeReport(runId, status) {
  const lines = [
    "# agent-manager run report",
    "",
    `- **run:** ${runId} — ${status.identity?.displayTitle || "-"}`,
    `- **repo:** ${status.repo} · dev_flow ${status.target_dev_flow || "-"} · base ${status.baseCommit || "-"}`,
    `- **state:** ${status.state}`,
    `- **goal:** ${status.goal || "-"}`,
    `- **engine:** ${status.agentManager?.version || "unknown"} · runtime ${formatRuntime(status.runtime)}`,
    `- **started / ended:** ${status.startedAt || "-"} / ${status.endedAt || "-"}`,
    "",
    "## Lanes",
    "",
  ];
  for (const lane of status.lanes || []) {
    lines.push(
      `### ${lane.id} — ${lane.state}`,
      "",
      `- harness: ${lane.harness} · model ${lane.modelObserved || lane.modelRequested || "default"} · session ${lane.sessionId || "-"}`,
      `- branch: ${lane.branch || "-"} · worktree ${lane.worktree || "-"}`,
      `- scope: ${lane.scope} · read-only ${lane.readOnly || "-"}`,
      `- exit: ${lane.exitCode ?? "-"} · elapsed ${lane.elapsedSec ?? "-"}s · claim ${lane.claim?.state || "-"}`,
      `- changed files: ${list(lane.changedFiles)}`,
      `- last activity: ${lane.lastActivity || "-"}`,
    );
    const violations = [...(lane.scopeViolations || []), ...(lane.readOnlyViolations || []), ...(lane.policyViolations || [])];
    if (violations.length) lines.push(`- **guardrail violations:** ${violations.join(", ")}${lane.ratification ? " (ratified)" : ""}`);
    if (lane.needsInput?.prompt) lines.push(`- **needs input:** ${lane.needsInput.prompt}`);
    lines.push("");
  }
  if (status.integrate) {
    lines.push("## Integrate", "", `- state: ${status.integrate.state} · branch ${status.integrate.branch || "-"}`);
    if (status.integrate.error) lines.push(`- error: ${status.integrate.error}`);
    lines.push("");
  }
  const review = status.delivery?.review;
  lines.push("## Delivery", "", `- review: ${review?.verdict || "pending"}${review?.reviewer ? ` by ${review.reviewer}` : ""}${review?.notes ? ` — ${review.notes}` : ""}`);
  for (const target of status.delivery?.targets || []) {
    lines.push(`- target ${target.id}: ${target.state} · tier ${target.tier ?? "-"} · PR ${target.prUrl || "-"} · merge ${target.mergeSha || "-"}`);
  }
  if (status.error) lines.push("", `**error:** ${status.error}`);
  const path = join(runDir(runId), "report.md");
  writePrivateFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}
