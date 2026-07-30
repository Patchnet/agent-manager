import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { RUNS_ROOT, assertSafeSlug, runDir } from "./paths.mjs";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.mjs";

export function writeStatus(runId, status) {
  assertSafeSlug(runId, "run id");
  const dir = ensurePrivateDir(runDir(runId));
  const path = join(dir, "status.json");
  if (status.state !== "cancelled" && existsSync(join(dir, "cancelled.json"))) {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : status;
  }
  const previous = existsSync(path) ? safeParse(path) : null;
  const payload = { ...status, runId, updatedAt: new Date().toISOString() };
  const tempPath = path + ".tmp";
  writePrivateFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(tempPath, path);
  if (eventFingerprint(previous) !== eventFingerprint(payload)) {
    appendEvent(runId, {
      schema: "agent-manager.event.v1",
      type: "status",
      at: payload.updatedAt,
      runId,
      state: payload.state,
      lanes: (payload.lanes || []).map((lane) => ({
        id: lane.id,
        harness: lane.harness,
        state: lane.state,
        exitCode: lane.exitCode ?? null,
        needsInput: lane.needsInput || null,
      })),
      ship: payload.ship
        ? {
            state: payload.ship.state,
            phase: payload.ship.phase,
            approve: payload.ship.approve,
            prUrl: payload.ship.prUrl || null,
            needsInput: payload.ship.needsInput || null,
          }
        : null,
    });
  }
  return payload;
}

export function appendEvent(runId, event) {
  const dir = ensurePrivateDir(runDir(runId));
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify(event) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function readEvents(runId) {
  const path = join(runDir(assertSafeSlug(runId, "run id")), "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
  return state === "done" || state === "failed" || state === "cancelled";
}

export function readStatus(runId) {
  if (!runId) return null;
  const path = join(runDir(assertSafeSlug(runId, "run id")), "status.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function latestRunId() {
  if (!existsSync(RUNS_ROOT)) return null;
  const dirs = readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(entry.name))
    .map((entry) => entry.name)
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
    lines.push(`[${spin}] ${lane.id.padEnd(12)} ${lane.state.padEnd(8)} ${lane.harness}  ${lane.branch || "-"}`);
    lines.push(`      scope: ${lane.scope}`);
    lines.push(`      last: ${lane.lastActivity || "-"}`);
    if (lane.elapsedSec != null) lines.push(`      elapsed: ${lane.elapsedSec}s  pid=${lane.pid ?? "-"}`);
    if (lane.exitCode != null) lines.push(`      exit: ${lane.exitCode}`);
    if (lane.sessionId) lines.push(`      session: ${lane.sessionId}`);
    if (lane.endedAt) lines.push(`      ended: ${lane.endedAt}`);
    if (lane.claim?.state) lines.push(`      claim: ${lane.claim.state}`);
    if (lane.scopeViolations?.length) lines.push(`      scope violations: ${lane.scopeViolations.join(", ")}`);
    lines.push("");
  }
  if (status.integrate) {
    lines.push(`integrate: ${status.integrate.state}  branch=${status.integrate.branch || "-"}`);
    if (status.integrate.error) lines.push(`      error: ${status.integrate.error}`);
    lines.push("");
  }
  if (status.ship) {
    lines.push(`ship: ${status.ship.state}  phase=${status.ship.phase || "-"}  approve=${status.ship.approve || "-"}`);
    lines.push(`      branch: ${status.ship.branch || "-"}  base=${status.ship.base || "-"}`);
    if (status.ship.prUrl) lines.push(`      pr: ${status.ship.prUrl}`);
    if (status.ship.mergeSha) lines.push(`      merge: ${status.ship.mergeSha}`);
    if (status.ship.tag) lines.push(`      tag: ${status.ship.tag}`);
    if (status.ship.lastActivity) lines.push(`      last: ${status.ship.lastActivity}`);
    if (status.ship.needsInput?.prompt) lines.push(`      needs input: ${status.ship.needsInput.prompt}`);
    lines.push("");
  }
  if (status.feed?.lastError) lines.push(`feed warning: ${status.feed.lastError}`);
  return lines.join("\n");
}

export async function watchStatus(runId, options = {}) {
  const { runMonitor } = await import("./monitor.mjs");
  return runMonitor(runId, options);
}

function safeParse(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function eventFingerprint(status) {
  if (!status) return null;
  return JSON.stringify({
    state: status.state,
    lanes: (status.lanes || []).map((lane) => ({
      id: lane.id,
      state: lane.state,
      exitCode: lane.exitCode ?? null,
      needsInput: lane.needsInput || null,
    })),
    ship: status.ship
      ? {
          state: status.ship.state,
          phase: status.ship.phase,
          prUrl: status.ship.prUrl || null,
          mergeSha: status.ship.mergeSha || null,
          tag: status.ship.tag || null,
          needsInput: status.ship.needsInput || null,
        }
      : null,
  });
}
