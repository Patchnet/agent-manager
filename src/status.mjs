import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { RUNS_ROOT, runDir } from "./paths.mjs";

export function writeStatus(runId, status) {
  const dir = runDir(runId);
  const path = join(dir, "status.json");
  if (status.state !== "cancelled" && existsSync(join(dir, "cancelled.json"))) {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : status;
  }
  const payload = {
    ...status,
    runId,
    updatedAt: new Date().toISOString(),
  };
  const tempPath = path + ".tmp";
  writeFileSync(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(tempPath, path);
  return payload;
}

export function deriveRunState(status) {
  if (status.state === "cancelled") return "cancelled";
  const states = (status.lanes || []).map((lane) => lane.state);
  if (states.some((state) => state === "running" || state === "queued")) return "running";
  if (states.some((state) => state === "failed")) return "failed";
  if (states.some((state) => state === "blocked")) return "blocked";
  return "done";
}

export function isTerminalState(state) {
  return state === "done" || state === "failed" || state === "cancelled" || state === "blocked";
}

export function readStatus(runId) {
  const path = join(runDir(runId), "status.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function latestRunId() {
  if (!existsSync(RUNS_ROOT)) return null;
  const dirs = readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

export function formatStatus(status) {
  if (!status) return "no status";
  const lines = [
    `run ${status.runId}  state=${status.state}  repo=${status.repo}  updated=${status.updatedAt || "-"}`,
    `target_dev_flow=${status.target_dev_flow || "-"}  workflow=${status.workflow || "-"}`,
    `started=${status.startedAt || "-"}  ended=${status.endedAt || "-"}  initialDirty=${status.initialRepo?.dirty ? "yes" : "no"}`,
    "",
  ];
  for (const lane of status.lanes || []) {
    const spin = lane.state === "running" ? "*" : " ";
    lines.push(
      `[${spin}] ${lane.id.padEnd(12)} ${lane.state.padEnd(8)} ${lane.harness}  ${lane.branch || "-"}`,
    );
    lines.push(`      scope: ${lane.scope}`);
    lines.push(`      last: ${lane.lastActivity || "-"}`);
    if (lane.elapsedSec != null) lines.push(`      elapsed: ${lane.elapsedSec}s  pid=${lane.pid ?? "-"}`);
    if (lane.exitCode != null) lines.push(`      exit: ${lane.exitCode}`);
    if (lane.sessionId) lines.push(`      session: ${lane.sessionId}`);
    if (lane.endedAt) lines.push(`      ended: ${lane.endedAt}`);
    if (lane.claim?.state) lines.push(`      claim: ${lane.claim.state}`);
    if (lane.scopeViolations?.length) {
      lines.push(`      scope violations: ${lane.scopeViolations.join(", ")}`);
    }
    lines.push("");
  }
  if (status.integrate) {
    lines.push(
      `integrate: ${status.integrate.state}  branch=${status.integrate.branch || "-"}`,
    );
    if (status.integrate.error) lines.push(`      error: ${status.integrate.error}`);
    lines.push("");
  }
  if (status.feed?.lastError) lines.push(`feed warning: ${status.feed.lastError}`);
  return lines.join("\n");
}

/** @deprecated Prefer runMonitor — kept as alias for status --watch. */
export async function watchStatus(runId, options = {}) {
  const { runMonitor } = await import("./monitor.mjs");
  return runMonitor(runId, options);
}
