import { join } from "node:path";
import { readStatus } from "./status.mjs";
import { runDir } from "./paths.mjs";
import { writePrivateFile } from "./fs-safe.mjs";

export function buildDeliveryReview(runId, { pass = 1, write = true } = {}) {
  if (![1, 2].includes(pass)) throw new Error("review pass must be 1 or 2");
  const status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  const lines = [
    `# Delivery Review - Pass ${pass}`,
    "",
    `- Run: \`${status.runId}\``,
    `- Repository: \`${status.repo}\``,
    `- Run state: **${status.state}**`,
    `- Base: \`${status.initialRepo?.head || status.baseRef || "unknown"}\``,
    "- Verdict: **pending operator review**",
    "",
    "## Lane evidence",
    "",
  ];
  for (const lane of status.lanes || []) {
    lines.push(`### ${lane.id} (${lane.harness})`, "");
    lines.push(`- State: ${lane.state}`);
    lines.push(`- Scope: ${lane.scope}`);
    lines.push(`- Changed files: ${lane.changedFiles?.length ? lane.changedFiles.map((file) => `\`${file}\``).join(", ") : "none"}`);
    lines.push(`- Scope violations: ${lane.scopeViolations?.length ? lane.scopeViolations.join(", ") : "none"}`);
    lines.push(`- Policy violations: ${lane.policyViolations?.length ? lane.policyViolations.join("; ") : "none"}`);
    lines.push(`- Exit: ${lane.exitCode ?? "-"}`);
    lines.push(`- Evidence log: \`${lane.logPath || "-"}\``, "");
  }
  lines.push("## Verification", "", "- [ ] Original request checked against delivered files", "- [ ] Cross-lane contracts checked", "- [ ] Tests rerun by the reviewing host", "- [ ] Public-repository hygiene scan passed", "", "## Decision", "", "Choose one: `accept` | `accept-with-notes` | `revise` | `relaunch` | `reject`", "");
  const markdown = lines.join("\n");
  const path = join(runDir(runId), `delivery-review-pass-${pass}.md`);
  if (write) writePrivateFile(path, markdown, "utf8");
  return { schema: "agent-manager.review.v1", runId, pass, path, markdown };
}
