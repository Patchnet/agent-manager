import { RUNS_ROOT } from "./paths.mjs";
import { isTerminalState, latestRunId, readStatus } from "./status.mjs";

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_HEARTBEAT_SEC = 180;

/**
 * Stable fingerprint of run/lane states that should wake Master Dev.
 */
export function statusFingerprint(status) {
  if (!status) return null;
  return JSON.stringify({
    state: status.state,
    lanes: (status.lanes || []).map((lane) => ({
      id: lane.id,
      state: lane.state,
      needsInput: Boolean(lane.needsInput),
      exitCode: lane.exitCode ?? null,
    })),
    ship: status.ship
      ? {
          state: status.ship.state,
          phase: status.ship.phase,
          prUrl: status.ship.prUrl || null,
          mergeSha: status.ship.mergeSha || null,
          tag: status.ship.tag || null,
          needsInput: Boolean(status.ship.needsInput),
        }
      : null,
  });
}

export function laneSummary(status) {
  return (status?.lanes || []).map((lane) => ({
    id: lane.id,
    state: lane.state,
    elapsedSec: lane.elapsedSec ?? null,
    lastActivity: lane.lastActivity || null,
    needsInput: Boolean(lane.needsInput),
  }));
}

/**
 * Classify a wake reason from previous → next status snapshots.
 * Returns null when nothing should be emitted.
 */
export function classifyWake(previous, next, { heartbeatDue = false } = {}) {
  if (!next) return null;

  const prevFp = statusFingerprint(previous);
  const nextFp = statusFingerprint(next);
  const changed = prevFp !== nextFp;

  if (changed) {
    if (
      next.ship?.needsInput &&
      !previous?.ship?.needsInput
    ) {
      return buildPayload(next, "needs_input", {
        phase: "ship",
        shipPhase: next.ship.phase,
      });
    }
    const needsLane = (next.lanes || []).find(
      (lane) => lane.state === "blocked" || lane.needsInput,
    );
    const prevNeeds = new Set(
      (previous?.lanes || [])
        .filter((lane) => lane.state === "blocked" || lane.needsInput)
        .map((lane) => lane.id),
    );
    if (needsLane && !prevNeeds.has(needsLane.id)) {
      return buildPayload(next, "needs_input", { laneId: needsLane.id });
    }
    if (isTerminalState(next.state)) {
      return buildPayload(next, "terminal");
    }
    return buildPayload(next, "state_change");
  }

  if (heartbeatDue && !isTerminalState(next.state)) {
    return buildPayload(next, "heartbeat");
  }

  return null;
}

function buildPayload(status, reason, extra = {}) {
  return {
    reason,
    runId: status.runId,
    state: status.state,
    repo: status.repo || null,
    runtime: status.runtime || null,
    updatedAt: status.updatedAt || null,
    lanes: laneSummary(status),
    ship: status.ship
      ? {
          state: status.ship.state,
          phase: status.ship.phase,
          approve: status.ship.approve,
          prUrl: status.ship.prUrl || null,
          tag: status.ship.tag || null,
          lastActivity: status.ship.lastActivity || null,
          needsInput: status.ship.needsInput || null,
        }
      : null,
    ...extra,
  };
}

export function formatWakeLine(runId, payload) {
  return `AGENT_MANAGER_WAKE_${runId} ${JSON.stringify(payload)}`;
}

/**
 * Poll status.json and print wake sentinels for Cursor notify_on_output.
 * Exits after emitting a terminal wake.
 */
export async function runWatchSignal(runId, {
  heartbeatSec = DEFAULT_HEARTBEAT_SEC,
  pollMs = DEFAULT_POLL_MS,
  write = (line) => process.stdout.write(line + "\n"),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  maxTicks = Infinity,
} = {}) {
  const id = runId || latestRunId();
  if (!id) throw new Error(`no runs found under ${RUNS_ROOT}`);

  let previous = null;
  let lastHeartbeatAt = 0;
  let ticks = 0;

  write(`watch-signal ${id} heartbeat=${heartbeatSec}s poll=${pollMs}ms`);

  while (ticks < maxTicks) {
    ticks += 1;
    const next = readStatus(id);
    const heartbeatDue =
      lastHeartbeatAt === 0
        ? false // first loop: wait a full heartbeat interval (skill: no double-run at start)
        : now() - lastHeartbeatAt >= heartbeatSec * 1000;

    // Seed previous without emitting until we have a baseline, unless already terminal.
    if (!previous) {
      previous = next;
      lastHeartbeatAt = now();
      if (next && isTerminalState(next.state)) {
        const payload = buildPayload(next, "terminal");
        write(formatWakeLine(id, payload));
        return payload;
      }
      await sleep(pollMs);
      continue;
    }

    const payload = classifyWake(previous, next, { heartbeatDue });
    if (payload) {
      write(formatWakeLine(id, payload));
      previous = next;
      if (payload.reason === "heartbeat") lastHeartbeatAt = now();
      else if (payload.reason !== "terminal") {
        // state changes reset the heartbeat clock so pulses stay spaced
        lastHeartbeatAt = now();
      }
      if (payload.reason === "terminal") return payload;
    }

    await sleep(pollMs);
  }

  return null;
}
