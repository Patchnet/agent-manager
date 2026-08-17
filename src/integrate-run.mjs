import { existsSync } from "node:fs";
import { join } from "node:path";
import { integrateLanes } from "./integrate.mjs";
import { runDir } from "./paths.mjs";
import { writeReport } from "./report.mjs";
import { laneGuardrailViolations, ratificationGap } from "./ratify.mjs";
import { readStatus, writeStatus } from "./status.mjs";
import { loadWorkflow } from "./workflow.mjs";
import { markWorkersComplete } from "./delivery.mjs";
import { syncBrainStatus } from "./brain.mjs";

/**
 * `--force-lanes` selectors. `done` is the ordinary fold. `failed-with-snapshot`
 * adds failed lanes whose end-of-lane snapshot committed cleanly, so a partially
 * dead run can still deliver the work that survived. Anything else is a typo,
 * not a permission.
 */
export const FORCE_LANE_SELECTORS = ["done", "failed-with-snapshot"];

export function parseForceLanes(value) {
  const tokens = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((token) => String(token).trim().toLowerCase())
    .filter(Boolean);
  const unknown = tokens.filter((token) => !FORCE_LANE_SELECTORS.includes(token));
  if (unknown.length) {
    throw new Error(
      `unknown --force-lanes selector: ${unknown.join(", ")} (expected ${FORCE_LANE_SELECTORS.join(", ")})`,
    );
  }
  return [...new Set(tokens)];
}

/**
 * Why a snapshotted failed lane still cannot be folded, or null when it can.
 *
 * A lane that tripped a guardrail is dropped even with a snapshot: `--force-lanes`
 * exists for lanes that died, not for lanes that were stopped — the snapshot of a
 * scope violation is still a scope violation. The one exception is a recorded
 * Master ratification, and it only reaches as far as the violations it was shown:
 * a lane that strayed again after being ratified is dropped on the new evidence.
 */
function forcedLaneExclusion(lane) {
  const violations = laneGuardrailViolations(lane);
  if (violations.length) {
    if (!lane.ratification) return `guardrail violations: ${violations.join("; ")}`;
    const uncovered = ratificationGap(lane);
    if (uncovered.length) {
      return `guardrail violations recorded after ratification: ${uncovered.join("; ")}`;
    }
  }
  if (lane.snapshot?.state !== "committed") {
    return lane.snapshot?.state
      ? `lane snapshot ${lane.snapshot.state}`
      : "no lane snapshot recorded";
  }
  if (!lane.branch || !lane.worktree) return "lane kept no branch or worktree";
  return null;
}

/**
 * Which lanes a forced integration folds, which it drops, and which make it
 * refuse. Failed lanes only qualify with a committed snapshot: without one the
 * lane branch holds nothing, so folding it would claim work that does not exist.
 */
export function selectForcedLanes(lanes, selectors) {
  const acceptFailed = selectors.includes("failed-with-snapshot");
  const forced = [];
  const excluded = [];
  const refused = [];
  const ratified = [];
  for (const lane of lanes) {
    if (lane.state === "done") continue;
    if (lane.state === "failed" && acceptFailed) {
      const reason = forcedLaneExclusion(lane);
      if (reason) excluded.push({ id: lane.id, state: lane.state, reason });
      else {
        forced.push(lane.id);
        if (lane.ratification) ratified.push(lane.id);
      }
      continue;
    }
    refused.push(`${lane.id} (${lane.state})`);
  }
  return { forced, excluded, refused, ratified };
}

function alignForcedDeliveryTarget(status) {
  const target = (status.delivery?.targets || []).find((item) => item.id === "integrate");
  const merged = status.integrate?.merged;
  if (!target || !merged) return;
  const folded = new Set(merged);
  target.changedFiles = [...new Set(
    (status.lanes || [])
      .filter((lane) => folded.has(lane.id))
      .flatMap((lane) => lane.changedFiles || []),
  )];
  target.state = target.changedFiles.length ? "changes_ready" : "no_changes";
}

export async function integrateRun(runId, { forceLanes = [] } = {}) {
  const selectors = parseForceLanes(forceLanes);
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  if (["running", "shipping", "cancelled", "ship_gate_pending", "reviewed", "merged", "released"].includes(status.state)) {
    throw new Error("run must finish successfully before integration");
  }
  if (status.integrate?.state === "ready") {
    await syncBrainStatus(status);
    return writeStatus(runId, status);
  }
  const lanes = status.lanes || [];
  let forced = [];
  let excluded = [];
  let ratified = [];
  if (!selectors.length) {
    if (!lanes.length || !lanes.every((lane) => lane.state === "done")) {
      throw new Error("all lanes must be done before integration");
    }
  } else {
    if (!lanes.length) throw new Error("all lanes must be done before integration");
    const selection = selectForcedLanes(lanes, selectors);
    if (selection.refused.length) {
      throw new Error(
        `--force-lanes ${selectors.join(",")} does not cover ${selection.refused.join(", ")}`,
      );
    }
    forced = selection.forced;
    excluded = selection.excluded;
    ratified = selection.ratified;
    if (!forced.length && !lanes.some((lane) => lane.state === "done")) {
      // Say why each candidate was dropped: "nothing to fold" is not actionable
      // on its own when the operator just recorded a ratification.
      throw new Error(
        "no done lanes and no snapshotted failed lanes to integrate" +
          (excluded.length
            ? `: ${excluded.map((lane) => `${lane.id} (${lane.reason})`).join(", ")}`
            : ""),
      );
    }
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
  // A forced lane carries the files its snapshot committed, so overlap detection
  // and Delivery Review see the same work the fold is about to merge.
  for (const lane of lanes) {
    if (!forced.includes(lane.id) || (lane.changedFiles || []).length) continue;
    lane.changedFiles = [...(lane.snapshot?.files || [])];
  }
  const laneStatesForIntegration = lanes.map((lane) =>
    forced.includes(lane.id) ? { ...lane, state: "done" } : lane,
  );
  const stampForced = (integrate) =>
    selectors.length
      ? {
          ...integrate,
          forceLaneSelectors: selectors,
          forcedLanes: forced,
          excludedLanes: excluded,
          ratifiedLanes: ratified,
        }
      : integrate;
  try {
    status.integrate = stampForced(
      integrateLanes({ workflow, runId, laneStates: laneStatesForIntegration }),
    );
    status.state = status.integrate.state === "ready" ? "workers_done" : "blocked";
  } catch (error) {
    status.integrate = stampForced({ state: "failed", error: String(error?.message || error) });
    status.state = "failed";
  }
  if (status.state === "workers_done") {
    markWorkersComplete(status);
    // Delivery Review reads the target, so it must describe the fold that
    // happened: an excluded lane's files are not in the integrate branch.
    if (selectors.length) alignForcedDeliveryTarget(status);
  } else if (status.state !== "blocked") status.endedAt ||= new Date().toISOString();
  await syncBrainStatus(status);
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return saved;
}
