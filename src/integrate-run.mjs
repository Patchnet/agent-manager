import { join } from "node:path";
import { integrateLanes } from "./integrate.mjs";
import { runDir } from "./paths.mjs";
import { writeReport } from "./report.mjs";
import { readStatus, writeStatus } from "./status.mjs";
import { loadWorkflow } from "./workflow.mjs";

export function integrateRun(runId) {
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  if (status.state === "running" || status.state === "cancelled") {
    throw new Error("run must finish successfully before integration");
  }
  if (status.integrate?.state === "ready") return status;
  if (!(status.lanes || []).length || !status.lanes.every((lane) => lane.state === "done")) {
    throw new Error("all lanes must be done before integration");
  }

  const workflow = loadWorkflow(join(runDir(runId), "workflow.yaml"), {
    repoOverride: status.repoRoot || status.repo,
  });
  status.integrate = { state: "running" };
  writeStatus(runId, status);
  try {
    status.integrate = integrateLanes({ workflow, runId, laneStates: status.lanes });
    status.state = status.integrate.state === "ready" ? "done" : "blocked";
  } catch (error) {
    status.integrate = { state: "failed", error: String(error?.message || error) };
    status.state = "failed";
  }
  status.endedAt ||= new Date().toISOString();
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return saved;
}
