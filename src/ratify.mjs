import { assertSafeSlug } from "./paths.mjs";
import { writeReport } from "./report.mjs";
import { readStatus, writeStatus } from "./status.mjs";

/**
 * Master ratification of a guardrail-failed lane.
 *
 * A lane that trips a guardrail is stopped, and `integrate --force-lanes` will
 * not fold it: the snapshot of a scope violation is still a scope violation.
 * That is the right default, but in the field every violation that Master
 * audited turned out to be work Master wanted — and the only way to deliver it
 * was a manual fold outside the tool.
 *
 * `ratify` closes that loop without weakening the default. It is an explicit,
 * attributed, recorded decision about a specific set of violations. It never
 * relabels the lane as `done`, and it never covers violations the ratifier was
 * not shown: the violation list is snapshotted at ratify time, and a lane that
 * strays again after ratification is excluded from the fold until Master looks
 * at the new evidence and ratifies again.
 */

export function laneGuardrailViolations(lane) {
  return [
    ...(lane?.scopeViolations || []),
    ...(lane?.readOnlyViolations || []),
    ...(lane?.policyViolations || []),
  ].map((violation) => String(violation));
}

/**
 * Violations the lane carries now that its ratification did not record. Empty
 * for an unratified lane with no violations, and equal to the whole violation
 * list for a lane that was never ratified.
 */
export function ratificationGap(lane) {
  const violations = laneGuardrailViolations(lane);
  if (!lane?.ratification) return violations;
  const covered = new Set((lane.ratification.violations || []).map((value) => String(value)));
  return violations.filter((violation) => !covered.has(violation));
}

/** True only when a ratification exists and covers every violation on record. */
export function isRatified(lane) {
  return Boolean(lane?.ratification) && ratificationGap(lane).length === 0;
}

/**
 * Who a recorded decision is attributed to. An explicit id always wins; the
 * fallback is the run's own planning verifier, which is the manager agent that
 * froze this run's context. Nothing is inferred from the environment: a run
 * with neither is refused rather than attributed to nobody.
 */
export function resolveMasterIdentity(status, explicit = null, label = "this decision") {
  const provided = explicit === null || explicit === undefined ? "" : String(explicit).trim();
  if (provided) return provided;
  const verifier = String(status?.planning?.verifiedBy || "").trim();
  if (verifier) return verifier;
  throw new Error(
    `${label} requires --by <id>; the run records no planning verifier to attribute it to`,
  );
}

export function ratifyLane(runId, laneId, {
  reason,
  by = null,
  at = new Date().toISOString(),
} = {}) {
  assertSafeSlug(runId, "run id");
  assertSafeSlug(laneId, "lane id");
  const text = String(reason || "").trim();
  if (!text) throw new Error("ratification requires --reason <text>");
  const status = readStatus(runId);
  if (!status) throw new Error("no status for " + runId);
  const lane = (status.lanes || []).find((item) => item.id === laneId);
  if (!lane) throw new Error("no lane " + laneId + " in " + runId);

  const violations = laneGuardrailViolations(lane);
  if (!violations.length) {
    throw new Error(
      "lane " + laneId + " recorded no guardrail violations; there is nothing to ratify",
    );
  }
  if (lane.snapshot?.state !== "committed") {
    throw new Error(
      "lane " + laneId + " has " +
        (lane.snapshot?.state
          ? "an end-of-lane snapshot in state " + lane.snapshot.state
          : "no end-of-lane snapshot") +
        "; there is no committed work to fold",
    );
  }

  const ratifier = resolveMasterIdentity(status, by, "ratification");
  lane.ratification = { by: ratifier, reason: text, at, violations };
  const saved = writeStatus(runId, status);
  writeReport(runId, saved);
  return {
    schema: "agent-manager.lane-ratification.v1",
    runId,
    laneId,
    laneState: lane.state,
    ...lane.ratification,
  };
}
