import { RUNS_ROOT } from "./paths.mjs";
import { isTerminalState, latestRunId, readStatus } from "./status.mjs";
import { deriveOperatorCadence, OPERATOR_TRANSITIONS } from "./cadence.mjs";
import { createNotifier, notifyEnabled } from "./notify.mjs";
import { finalizeMasterReturnWatcher } from "./master-return.mjs";

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_HEARTBEAT_SEC = 180;
export const DEFAULT_WATCHER_TTL_SEC = 7 * 24 * 60 * 60;

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
          lastActivity: status.ship.lastActivity || null,
          steps: (status.ship.steps || []).map((step) => [step.name, step.state, step.detail || null]),
          checks: (status.ship.checks || []).map((check) => [check.name, check.status, check.conclusion]),
          ci: (status.ship.ci?.runs || []).map((run) => [run.id, run.status, run.conclusion]),
          needsInput: Boolean(status.ship.needsInput),
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
    if (isTerminalState(next.state)) {
      return buildPayload(next, "terminal");
    }
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
    const cadence = deriveOperatorCadence(next, { wakeReason: "state_change" });
    if (cadence.transition === OPERATOR_TRANSITIONS.WAIT_OPERATOR) {
      return buildPayload(next, "needs_input", {
        phase: next.ship ? "ship" : "delivery",
        deliveryState: next.delivery?.state || next.state,
      });
    }
    return buildPayload(next, "state_change");
  }

  if (heartbeatDue && !isTerminalState(next.state)) {
    const cadence = deriveOperatorCadence(next, { wakeReason: "heartbeat" });
    if (cadence.transition !== OPERATOR_TRANSITIONS.AUTO_CONTINUE) return null;
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
          steps: status.ship.steps || [],
          checks: status.ship.checks || [],
          ci: status.ship.ci || null,
          needsInput: status.ship.needsInput || null,
        }
      : null,
    delivery: status.delivery
      ? {
          state: status.delivery.state,
          mode: status.delivery.mode,
          review: status.delivery.review || null,
          targets: status.delivery.targets || [],
          release: status.delivery.release || null,
        }
      : null,
    cadence: deriveOperatorCadence(status, { wakeReason: reason }),
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
  onWake = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  maxTicks = Infinity,
  watcherTtlSec = DEFAULT_WATCHER_TTL_SEC,
  notify = null,
  notifier = null,
  env = process.env,
} = {}) {
  const id = runId || latestRunId();
  if (!id) throw new Error(`no runs found under ${RUNS_ROOT}`);

  // Opt-in OS toasts: the same wakes that print a sentinel also raise a
  // desktop notification for the four events an operator must not miss.
  const sink = notifier || createNotifier({
    enabled: notifyEnabled({ notify }, env),
    env,
    log: (line) => write(line),
  });

  let previous = null;
  let lastHeartbeatAt = 0;
  let ticks = 0;
  const watcherStartedAt = now();

  const emitWake = async (payload, status) => {
    write(formatWakeLine(id, payload));
    sink?.notify?.(payload, status); // the sink swallows its own failures
    if (onWake) await onWake(payload, status);
  };

  write(`watch-signal ${id} heartbeat=${heartbeatSec}s poll=${pollMs}ms notify=${sink?.enabled ? "on" : "off"}`);

  while (ticks < maxTicks) {
    ticks += 1;
    const next = readStatus(id);
    const heartbeatDue =
      lastHeartbeatAt === 0
        ? false // first loop: wait a full heartbeat interval (skill: no double-run at start)
        : now() - lastHeartbeatAt >= heartbeatSec * 1000;

    // Seed active runs quietly, but do not miss an actionable stage that was
    // reached before the watcher attached.
    if (!previous) {
      previous = next;
      lastHeartbeatAt = now();
      if (next && isTerminalState(next.state)) {
        const payload = buildPayload(next, "terminal");
        await emitWake(payload, next);
        finalizeMasterReturnWatcher(id, "terminal");
        return payload;
      }
      if (next) {
        const cadence = deriveOperatorCadence(next, { wakeReason: "state_change" });
        const actionableStage = [
          "delivery_review_pending",
          "correction_pending",
          "ship_gate_pending",
          "release_pending",
          "blocked",
        ].includes(next.state);
        if (actionableStage || cadence.transition === OPERATOR_TRANSITIONS.WAIT_OPERATOR) {
          const reason = cadence.transition === OPERATOR_TRANSITIONS.WAIT_OPERATOR
            ? "needs_input"
            : "state_change";
          const blockedLane = (next.lanes || []).find((lane) => lane.state === "blocked" || lane.needsInput);
          await emitWake(buildPayload(next, reason, {
            phase: next.ship?.needsInput ? "ship" : "delivery",
            ...(blockedLane ? { laneId: blockedLane.id } : {}),
          }), next);
          if (onWake) previous = readStatus(id) || previous;
        }
      }
      await sleep(pollMs);
      continue;
    }

    const payload = classifyWake(previous, next, { heartbeatDue });
    if (payload) {
      await emitWake(payload, next);
      // A host callback can advance the run (for example, Master Dev can
      // present Delivery Review while handling a workers-complete wake).
      // Refresh after callback completion so the watcher does not re-deliver
      // the transition that the callback already handled.
      previous = onWake ? (readStatus(id) || next) : next;
      if (payload.reason === "heartbeat") lastHeartbeatAt = now();
      else if (payload.reason !== "terminal") {
        // state changes reset the heartbeat clock so pulses stay spaced
        lastHeartbeatAt = now();
      }
      if (payload.reason === "terminal") {
        finalizeMasterReturnWatcher(id, "terminal");
        return payload;
      }
    }

    if (Number.isFinite(watcherTtlSec) && watcherTtlSec >= 0 &&
      now() - watcherStartedAt >= watcherTtlSec * 1000) {
      const expired = {
        reason: "watcher_expired",
        runId: id,
        state: next?.state || null,
        recoverable: !isTerminalState(next?.state),
      };
      write(`watch-signal ${id} watcher TTL reached; run state unchanged (${expired.state || "missing"})`);
      finalizeMasterReturnWatcher(id, "watcher_ttl");
      return expired;
    }

    await sleep(pollMs);
  }

  return null;
}
