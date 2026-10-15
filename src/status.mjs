import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { RUNS_ROOT, assertSafeSlug, runDir } from "./paths.mjs";
import { ensurePrivateDir, writePrivateFile } from "./fs-safe.mjs";
import { formatRuntime } from "./runtime.mjs";
import { emitEvent, transitionEvents } from "./events.mjs";

export const TERMINAL_STATES = new Set(["merged", "reviewed", "closed", "rejected", "failed", "cancelled"]);
// End states written by 2.x runs. 3.0 never writes them, but runs that
// finished under 2.x keep them on disk and must still read as finished.
const LEGACY_TERMINAL_STATES = new Set(["released", "filed", "done"]);

export function writeStatus(runId, status) {
  assertSafeSlug(runId, "run id");
  const dir = ensurePrivateDir(runDir(runId));
  const path = join(dir, "status.json");
  const lockPath = join(dir, ".status-lock");
  acquireStatusLock(lockPath);
  try {
    if (status.state !== "cancelled" && existsSync(join(dir, "cancelled.json"))) {
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : status;
    }
    const previous = existsSync(path) ? safeParse(path) : null;
    const lanes = preserveNewerLaneAttempts(status.lanes, previous?.lanes);
    const payload = {
      ...status,
      lanes,
      runId,
      updatedAt: new Date().toISOString(),
    };
    const tempPath = path + "." + process.pid + "." + Date.now() + ".tmp";
    writePrivateFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    replaceFileWithRetry(tempPath, path);
    for (const event of transitionEvents(previous, payload)) {
      try {
        void emitEvent(event);
      } catch {
        // The event log is telemetry; it never fails a status write.
      }
    }
    return payload;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function deriveRunState(status) {
  if (status.state === "cancelled") return "cancelled";
  const states = (status.lanes || []).map((lane) => lane.state);
  if (states.some((state) => state === "blocked")) return "blocked";
  if (states.some((state) => ["running", "queued", "dependency-waiting"].includes(state))) {
    return "running";
  }
  if (states.some((state) => state === "failed")) return "failed";
  return "workers_done";
}

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state) || LEGACY_TERMINAL_STATES.has(state);
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
    `${status.identity?.displayTitle || `run ${status.runId}`}  state=${status.state}  updated=${status.updatedAt || "-"}`,
    `repo=${status.repo}  runId=${status.runId}  dev_flow=${status.target_dev_flow || "-"}`,
    `runtime=${formatRuntime(status.runtime)}`,
    `started=${status.startedAt || "-"}  ended=${status.endedAt || "-"}`,
    "",
  ];
  for (const lane of status.lanes || []) {
    lines.push(`[${lane.state === "running" ? "*" : " "}] ${lane.id.padEnd(12)} ${lane.state.padEnd(8)} ${lane.harness}  model=${lane.modelObserved || lane.modelRequested || "default"}  ${lane.branch || "-"}`);
    lines.push(`      scope: ${lane.scope}`);
    lines.push(`      last: ${lane.lastActivity || "-"}`);
    if (lane.exitCode != null) lines.push(`      exit: ${lane.exitCode}  elapsed=${lane.elapsedSec ?? "-"}s`);
    if (lane.sessionId) lines.push(`      session: ${lane.sessionId}`);
    if (lane.waitingFor?.length) lines.push(`      waiting for: ${lane.waitingFor.join(", ")}`);
    if (lane.needsInput?.prompt) lines.push(`      needs input: ${lane.needsInput.prompt}`);
    if (lane.scopeViolations?.length) lines.push(`      scope violations: ${lane.scopeViolations.join(", ")}`);
    if (lane.readOnlyViolations?.length) lines.push(`      read-only violations: ${lane.readOnlyViolations.join(", ")}`);
    lines.push("");
  }
  if (status.integrate) {
    lines.push(`integrate: ${status.integrate.state}  branch=${status.integrate.branch || "-"}`);
    if (status.integrate.error) lines.push(`      error: ${status.integrate.error}`);
    lines.push("");
  }
  const review = status.delivery?.review;
  if (review?.verdict) lines.push(`review: ${review.verdict} by ${review.reviewer || "-"}${review.notes ? ` — ${review.notes}` : ""}`);
  for (const target of status.delivery?.targets || []) {
    lines.push(`target ${target.id}: ${target.state}  tier=${target.tier ?? "-"}  pr=${target.prUrl || "-"}  merge=${target.mergeSha || "-"}`);
    if (target.waitingOperator) lines.push(`      waiting: ${target.waitingOperator}`);
  }
  if (status.error) lines.push(`error: ${status.error}`);
  return lines.join("\n");
}

function safeParse(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function preserveNewerLaneAttempts(nextLanes = [], previousLanes = []) {
  return nextLanes.map((lane) => {
    const previous = previousLanes.find((item) => item.id === lane.id);
    return Number(previous?.attempt || 1) > Number(lane.attempt || 1)
      ? previous
      : lane;
  });
}

function acquireStatusLock(lockPath) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  throw new Error("timed out waiting for status lock");
}

function replaceFileWithRetry(source, target) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      if (!["EACCES", "EPERM"].includes(error?.code) || attempt === 99) {
        rmSync(source, { force: true });
        throw error;
      }
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
}
