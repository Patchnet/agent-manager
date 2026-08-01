import { existsSync } from "node:fs";
import { join } from "node:path";
import { integrateLanes } from "./integrate.mjs";
import { runDir } from "./paths.mjs";
import { writeReport } from "./report.mjs";
import { readStatus, writeStatus } from "./status.mjs";
import { loadWorkflow } from "./workflow.mjs";
import { markWorkersComplete } from "./delivery.mjs";

export function integrateRun(runId) {
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  if (["running", "shipping", "cancelled", "ship_gate_pending", "reviewed", "merged", "released"].includes(status.state)) {
    throw new Error("run must finish successfully before integration");
  }
  if (status.integrate?.state === "ready") return status;
  if (!(status.lanes || []).length || !status.lanes.every((lane) => lane.state === "done")) {
    throw new Error("all lanes must be done before integration");
  }

  const workflow = loadWorkflow(join(runDir(runId), "workflow.yaml"), {
    repoOverride: status.repoRoot || status.repo,
    planningContextOverride: existsSync(join(runDir(runId), "planning-context.md"))
      ? join(runDir(runId), "planning-context.md")
      : null,
  });
  if (
    status.planning?.contextDigest &&
    workflow.planning?.context_digest !== status.planning.contextDigest
  ) {
    throw new Error("frozen planning context digest does not match recorded run evidence");
  }
  status.integrate = { state: "running" };
  writeStatus(runId, status);
  try {
    status.integrate = integrateLanes({ workflow, runId, laneStates: status.lanes });
    status.state = status.integrate.state === "ready" ? "workers_done" : "blocked";
  } catch (error) {
    status.integrate = { state: "failed", error: String(error?.message || error) };
    status.state = "failed";
  }
  if (status.state === "workers_done") markWorkersComplete(status);
  else if (status.state !== "blocked") status.endedAt ||= new Date().toISOString();
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return saved;
}
