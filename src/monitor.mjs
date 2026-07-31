import { RUNS_ROOT } from "./paths.mjs";
import { isTerminalState, latestRunId, readStatus } from "./status.mjs";
import { formatRuntime } from "./runtime.mjs";

const DONE_EXIT_STATES = new Set(["done", "failed", "cancelled"]);

function pad(value, width) {
  const text = String(value ?? "-");
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function truncate(value, width) {
  const text = String(value ?? "-").replace(/\s+/g, " ");
  if (text.length <= width) return text;
  return text.slice(0, Math.max(0, width - 1)) + "…";
}

/**
 * Rich side-terminal board for a run. Pure formatter for tests.
 */
export function formatMonitorBoard(status, { previousLaneStates = {} } = {}) {
  if (!status) return "no status";

  const feedEnabled = status.feed?.enabled ? "yes" : "no";
  const feedErr = status.feed?.lastError ? `  feedError=${status.feed.lastError}` : "";
  const lines = [
    "╔══════════════════════════════════════════════════════════════════════════╗",
    "║ agent-manager · monitor                                                  ║",
    "╚══════════════════════════════════════════════════════════════════════════╝",
    `runId   ${status.runId}`,
    `repo    ${status.repo || "-"}`,
    `state   ${status.state}    target_dev_flow=${status.target_dev_flow || "-"}`,
    `runtime ${formatRuntime(status.runtime)}`,
    `started ${status.startedAt || "-"}`,
    `updated ${status.updatedAt || "-"}    ended=${status.endedAt || "-"}`,
    `feed    enabled=${feedEnabled}${feedErr}`,
    "",
    `${pad("Lane", 14)} ${pad("State", 10)} ${pad("Harness", 8)} ${pad("Elapsed", 9)} Last activity`,
    `${"-".repeat(14)} ${"-".repeat(10)} ${"-".repeat(8)} ${"-".repeat(9)} ${"-".repeat(40)}`,
  ];

  for (const lane of status.lanes || []) {
    const prev = previousLaneStates[lane.id];
    const mark =
      prev && prev !== lane.state
        ? "*"
        : lane.state === "running"
          ? ">"
          : " ";
    const elapsed =
      lane.elapsedSec == null ? "-" : `${lane.elapsedSec}s`;
    lines.push(
      `${mark}${pad(lane.id, 13)} ${pad(lane.state, 10)} ${pad(lane.harness, 8)} ${pad(elapsed, 9)} ${truncate(lane.lastActivity, 48)}`,
    );
    if (lane.sessionId) {
      lines.push(`  session ${lane.sessionId}`);
    }
    if (lane.needsInput?.prompt) {
      lines.push(`  needs-input: ${truncate(lane.needsInput.prompt, 60)}`);
    }
    if (lane.waitingFor?.length) {
      lines.push(`  waiting for: ${lane.waitingFor.join(", ")} (${lane.queueReason || "queued"})`);
    }
    if (lane.scopeViolations?.length) {
      lines.push(`  scope violations: ${lane.scopeViolations.join(", ")}`);
    }
    if (lane.readOnlyViolations?.length) {
      lines.push(`  read-only violations: ${lane.readOnlyViolations.join(", ")}`);
    }
  }

  if (status.integrate) {
    lines.push("");
    lines.push(
      `integrate: ${status.integrate.state}  branch=${status.integrate.branch || "-"}`,
    );
    if (status.integrate.error) {
      lines.push(`  error: ${status.integrate.error}`);
    }
    if (status.integrate.verification) {
      lines.push(`  verification: ${status.integrate.verification.state}`);
    }
  }
  if (status.ship) {
    lines.push("");
    lines.push(
      `ship: ${status.ship.state}  phase=${status.ship.phase || "-"}  approve=${status.ship.approve || "-"}`,
    );
    lines.push(`  branch: ${status.ship.branch || "-"}  base=${status.ship.base || "-"}`);
    if (status.ship.prUrl) lines.push(`  PR: ${status.ship.prUrl}`);
    if (status.ship.tag) lines.push(`  tag: ${status.ship.tag}`);
    if (status.ship.lastActivity) lines.push(`  last: ${truncate(status.ship.lastActivity, 64)}`);
    if (status.ship.needsInput?.prompt) {
      lines.push(`  needs-input: ${truncate(status.ship.needsInput.prompt, 64)}`);
    }
  }

  lines.push("");
  lines.push("Ctrl+C to stop · exits automatically on done/failed/cancelled");
  return lines.join("\n");
}

export function shouldMonitorExit(status) {
  return Boolean(status && DONE_EXIT_STATES.has(status.state));
}

/**
 * Live redraw loop for side-terminal watching.
 */
export async function runMonitor(runId, {
  intervalMs = 2_000,
  clear = () => {
    console.clear?.();
  },
  write = (text) => process.stdout.write(text + "\n"),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxTicks = Infinity,
} = {}) {
  const id = runId || latestRunId();
  if (!id) throw new Error(`no runs found under ${RUNS_ROOT}`);

  let previousLaneStates = {};
  let ticks = 0;

  while (ticks < maxTicks) {
    ticks += 1;
    const status = readStatus(id);
    const board = formatMonitorBoard(status, { previousLaneStates });
    clear();
    write(board);

    if (status) {
      previousLaneStates = Object.fromEntries(
        (status.lanes || []).map((lane) => [lane.id, lane.state]),
      );
    }

    if (shouldMonitorExit(status)) {
      write("");
      write(`══ monitor exit · run ${id} → ${status.state} ══`);
      return status;
    }

    // blocked is not exit — keep cooking so reply/resume is visible
    void isTerminalState;
    await sleep(intervalMs);
  }

  return readStatus(id);
}
