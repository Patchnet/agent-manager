import {
  appendFileSync,
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
import { deriveOperatorCadence } from "./cadence.mjs";
import { isOverallTerminalState } from "./delivery.mjs";

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
    const payload = { ...status, lanes, runId, updatedAt: new Date().toISOString() };
    const tempPath = path + "." + process.pid + "." + Date.now() + ".tmp";
    writePrivateFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    replaceFileWithRetry(tempPath, path);
    if (eventFingerprint(previous) !== eventFingerprint(payload)) {
      appendEvent(runId, {
        schema: "agent-manager.event.v1",
        type: "status",
        at: payload.updatedAt,
        runId,
        state: payload.state,
        runtime: payload.runtime || null,
        lanes: (payload.lanes || []).map((lane) => ({
          id: lane.id,
          harness: lane.harness,
          state: lane.state,
          exitCode: lane.exitCode ?? null,
          needsInput: lane.needsInput || null,
          waitingFor: lane.waitingFor || [],
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
        delivery: payload.delivery
          ? {
              state: payload.delivery.state,
              reviewState: payload.delivery.review?.state || null,
              verdict: payload.delivery.review?.verdict || null,
              targets: (payload.delivery.targets || []).map((target) => ({
                id: target.id,
                state: target.state,
                mergeSha: target.mergeSha || null,
              })),
            }
          : null,
        cadence: deriveOperatorCadence(payload),
      });
    }
    return payload;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
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
  if (states.some((state) => state === "blocked")) return "blocked";
  if (states.some((state) => ["running", "queued", "dependency-waiting"].includes(state))) {
    return "running";
  }
  if (states.some((state) => state === "failed")) return "failed";
  return "workers_done";
}

export function isTerminalState(state) {
  return isOverallTerminalState(state);
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
  const cadence = deriveOperatorCadence(status);
  if (!status) return "no status";
  const lines = [
    `run ${status.runId}  state=${status.state}  repo=${status.repo}  updated=${status.updatedAt || "-"}`,
    `target_dev_flow=${status.target_dev_flow || "-"}  workflow=${status.workflow || "-"}`,
    `runtime=${formatRuntime(status.runtime)}`,
    `transition=${cadence.transition}  stage=${cadence.stage}`,
    `next=${cadence.nextAction}`,
    `started=${status.startedAt || "-"}  ended=${status.endedAt || "-"}  initialDirty=${status.initialRepo?.dirty ? "yes" : "no"}`,
    `planning=${status.planning?.state || "legacy/unrecorded"}  plan=${status.planning?.planRef || "-"}`,
    `reviewedBase=${status.planning?.reviewedBaseSha || "-"}  contextSha256=${status.planning?.contextDigest || "-"}`,
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
    if (lane.waitingFor?.length) lines.push(`      waiting for: ${lane.waitingFor.join(", ")}`);
    if (lane.queueReason) lines.push(`      queue: ${lane.queueReason}`);
    if (lane.scopeViolations?.length) lines.push(`      scope violations: ${lane.scopeViolations.join(", ")}`);
    if (lane.readOnlyViolations?.length) lines.push(`      read-only violations: ${lane.readOnlyViolations.join(", ")}`);
    lines.push("");
  }
  if (status.integrate) {
    lines.push(`integrate: ${status.integrate.state}  branch=${status.integrate.branch || "-"}`);
    if (status.integrate.error) lines.push(`      error: ${status.integrate.error}`);
    lines.push("");
  }
  if (status.delivery) {
    lines.push(`delivery: ${status.delivery.state}  mode=${status.delivery.mode || "-"}  releaseRequired=${status.delivery.releaseRequired ? "yes" : "no"}`);
    lines.push(`      review: ${status.delivery.review?.state || "-"}  verdict=${status.delivery.review?.verdict || "-"}  pass=${status.delivery.review?.latestPass || 0}`);
    for (const target of status.delivery.targets || []) {
      lines.push(`      target ${target.id}: ${target.state}  lane=${target.laneId}  pr=${target.prUrl || target.pr || "-"}  merge=${target.mergeSha || "-"}`);
    }
    if (status.delivery.release?.tag) lines.push(`      release: ${status.delivery.release.tag}  sha=${status.delivery.release.sha || "-"}`);
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

function eventFingerprint(status) {
  if (!status) return null;
  return JSON.stringify({
    state: status.state,
    lanes: (status.lanes || []).map((lane) => ({
      id: lane.id,
      state: lane.state,
      exitCode: lane.exitCode ?? null,
      needsInput: lane.needsInput || null,
      waitingFor: lane.waitingFor || [],
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
    delivery: status.delivery
      ? {
          state: status.delivery.state,
          reviewState: status.delivery.review?.state || null,
          verdict: status.delivery.review?.verdict || null,
          targets: (status.delivery.targets || []).map((target) => ({
            id: target.id,
            state: target.state,
            mergeSha: target.mergeSha || null,
          })),
        }
      : null,
  });
}
