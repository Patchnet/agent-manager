import { join } from "node:path";
import { readStatus } from "./status.mjs";
import { runDir } from "./paths.mjs";
import { writePrivateFile } from "./fs-safe.mjs";
import { formatRuntime } from "./runtime.mjs";

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
    `- Base: \`${status.baseCommit || status.initialRepo?.head || status.baseRef || "unknown"}\``,
    `- Runtime: ${formatRuntime(status.runtime)}`,
    `- Maximum concurrency: ${status.maxConcurrency || "-"}`,
    `- Planning preflight: **${status.planning?.state || "legacy/unrecorded"}**`,
    `- Plan: ${status.planning?.planRef || "-"}`,
    `- Planning context SHA-256: \`${status.planning?.contextDigest || "-"}\``,
    `- Planning verifier: ${status.planning?.verifiedBy || "-"} at ${status.planning?.verifiedAt || "-"}`,
    "- Verdict: **pending operator review**",
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
  const markdown = lines.join("\n");
  const path = join(runDir(runId), `delivery-review-pass-${pass}.md`);
  if (write) writePrivateFile(path, markdown, "utf8");
  return { schema: "agent-manager.review.v1", runId, pass, path, markdown };
}
