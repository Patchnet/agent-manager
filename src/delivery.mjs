// Run delivery state: one review verdict, then one target per PR.
//
// running → review_pending → ship_pending → shipping → merged
//                          ↘ correction_pending (revise) ↘ rejected
//                          ↘ reviewed (accepted, nothing to ship) / closed

export const VERDICTS = new Set(["accept", "revise", "reject"]);

export function createDeliveryStatus(workflow, laneStates) {
  const base = normalizeBase(workflow.base_ref, workflow.remote);
  const targets = (workflow.delivery?.targets || []).map((target) => {
    const lane = laneStates.find((candidate) => candidate.id === target.lane);
    if (!lane) throw new Error(`delivery target ${target.id} references unknown lane ${target.lane}`);
    return newTarget({ id: target.id, laneId: target.lane, branch: target.branch || lane.branch, base: target.base || base, pr: target.pr });
  });
  return {
    mode: workflow.delivery?.mode || (targets.length > 1 ? "train" : "single"),
    review: { verdict: null, reviewer: null, notes: null, decidedAt: null, history: [] },
    targets,
  };
}

function newTarget({ id, laneId, branch, base, pr = null }) {
  return {
    id, laneId, branch, base: base || null, worktree: null, changedFiles: [], state: "pending",
    pr: pr ? String(pr) : null, prUrl: null, tier: null, autoMerge: false, waitingOperator: null,
    mergeSha: null, mergedAt: null,
  };
}

export function markWorkersComplete(status, at = new Date().toISOString()) {
  status.execution = { ...(status.execution || {}), state: "done", endedAt: at };
  status.delivery ||= { mode: "single", review: { verdict: null, history: [] }, targets: [] };
  const changed = [...new Set((status.lanes || []).flatMap((lane) => lane.changedFiles || []))];
  if (status.integrate?.state === "ready" && status.delivery.mode !== "review-only" && changed.length) {
    status.delivery.mode = "single";
    status.delivery.targets = [{
      ...newTarget({
        id: "integrate",
        laneId: "integrate",
        branch: status.integrate.branch,
        base: normalizeBase(status.baseRef, status.integrate.remote || "origin"),
      }),
      worktree: status.integrate.worktree,
      changedFiles: changed,
      state: "changes_ready",
    }];
  }
  for (const target of status.delivery.targets) {
    const lane = (status.lanes || []).find((candidate) => candidate.id === target.laneId);
    if (!lane) continue;
    target.worktree = lane.worktree || target.worktree;
    target.branch ||= lane.branch;
    target.changedFiles = [...(lane.changedFiles || [])];
    target.state = target.changedFiles.length ? "changes_ready" : "no_changes";
  }
  status.state = "review_pending";
  status.endedAt = null;
  return status;
}

export function recordReview(status, { verdict, reviewer, notes = null, at = new Date().toISOString() }) {
  if (!VERDICTS.has(verdict)) throw new Error("verdict must be accept, revise, or reject");
  if (!reviewer || !String(reviewer).trim()) throw new Error("review requires --reviewer");
  if (!["review_pending", "correction_pending", "ship_pending"].includes(status.state)) {
    throw new Error(`run ${status.runId} is ${status.state}; review applies after workers finish`);
  }
  const review = status.delivery.review;
  review.history = [...(review.history || []), { verdict, reviewer, notes, at }];
  Object.assign(review, { verdict, reviewer: String(reviewer).trim(), notes, decidedAt: at });
  if (verdict === "reject") {
    status.state = "rejected";
    status.endedAt = at;
  } else if (verdict === "revise") {
    status.state = "correction_pending";
  } else {
    const shippable = status.delivery.targets.some((target) => target.state === "changes_ready");
    status.state = shippable ? "ship_pending" : "reviewed";
    if (!shippable) status.endedAt = at;
  }
  return status;
}

export function assertAccepted(status) {
  if (status.delivery?.review?.verdict !== "accept") {
    throw new Error(`run ${status.runId} has no accepted review; record one with: agent-manager review ${status.runId} --verdict accept --reviewer <id>`);
  }
}

/** Recompute the run state after a target changed. */
export function settleTargets(status, at = new Date().toISOString()) {
  const shippable = status.delivery.targets.filter((target) => target.state !== "no_changes");
  if (shippable.length && shippable.every((target) => target.mergeSha)) {
    status.state = "merged";
    status.endedAt = at;
  } else if (shippable.some((target) => target.waitingOperator && !target.autoMerge)) {
    status.state = "waiting_operator";
  } else if (shippable.some((target) => target.prUrl)) {
    status.state = "shipping";
  }
  return status;
}

export function closeRun(status, { reason = "closed without shipping", at = new Date().toISOString() } = {}) {
  status.state = "closed";
  status.closedReason = reason;
  status.endedAt = at;
  return status;
}

function normalizeBase(value, remote = "origin") {
  const text = String(value || "");
  if (!text || text === "HEAD" || /^[0-9a-f]{40}$/i.test(text)) return null;
  return text.startsWith(`${remote}/`) ? text.slice(remote.length + 1) : text;
}
