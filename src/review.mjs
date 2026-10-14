import { existsSync } from "node:fs";
import { closeRun, recordReview } from "./delivery.mjs";
import { ratificationGap } from "./ratify.mjs";
import { writeReport } from "./report.mjs";
import { readStatus, writeStatus } from "./status.mjs";

/** Structural problems that make an `accept` meaningless. Judgment stays with the reviewer. */
export function inspectDeliveryStructure(status) {
  const errors = [];
  const forced = new Set(status.integrate?.forcedLanes || []);
  for (const lane of status.lanes || []) {
    if (lane.state !== "done" && !forced.has(lane.id)) errors.push(`lane ${lane.id} is ${lane.state}`);
    const gap = ratificationGap(lane);
    if (gap.length) errors.push(`lane ${lane.id} has unratified guardrail violations: ${gap.join(", ")}`);
  }
  for (const target of status.delivery?.targets || []) {
    if (target.state === "no_changes") continue;
    if (!target.worktree || !existsSync(target.worktree)) errors.push(`target ${target.id} worktree is missing`);
  }
  return { ok: errors.length === 0, errors };
}

export function reviewRun(runId, { verdict, reviewer, notes = null }) {
  const status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  if (verdict === "accept") {
    const structure = inspectDeliveryStructure(status);
    if (!structure.ok) throw new Error(`cannot accept ${runId}:\n- ${structure.errors.join("\n- ")}`);
  }
  recordReview(status, { verdict, reviewer, notes });
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return saved;
}

export function closeRunById(runId, { reason } = {}) {
  const status = readStatus(runId);
  if (!status) throw new Error(`no status for ${runId}`);
  const saved = writeStatus(runId, closeRun(status, { reason }));
  writeReport(runId, saved);
  return saved;
}
