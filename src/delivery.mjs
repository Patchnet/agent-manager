const ACCEPTED_VERDICTS = new Set(["accept", "accept-with-notes"]);
const REVIEW_VERDICTS = new Set([
  ...ACCEPTED_VERDICTS,
  "revise",
  "relaunch",
  "reject",
]);

/** Goal lifecycles that no longer need Master advancement after a run ends. */
const ADVANCED_GOAL_LIFECYCLES = new Set(["delivered", "superseded", "cancelled"]);

export function createDeliveryStatus(workflow, laneStates) {
  const targets = (workflow.delivery?.targets || []).map((target, index) => {
    const lane = laneStates.find((candidate) => candidate.id === target.lane);
    if (!lane) throw new Error(`delivery target ${target.id} references unknown lane ${target.lane}`);
    return {
      id: target.id,
      laneId: target.lane,
      order: index + 1,
      state: "pending",
      branch: target.branch || lane.branch,
      base: target.base || normalizeBase(workflow.base_ref, workflow.remote) || "main",
      pr: target.pr || null,
      worktree: null,
      changedFiles: [],
      prUrl: null,
      mergeSha: null,
      mergedAt: null,
    };
  });

  return {
    schema: "agent-manager.delivery.v1",
    mode: workflow.delivery?.mode || (targets.length > 1 ? "train" : "single"),
    state: "workers_running",
    releaseRequired: workflow.delivery?.release_required === true,
    workersCompletedAt: null,
    review: {
      state: "not_started",
      latestPass: 0,
      presentedAt: null,
      verdict: null,
      reviewer: null,
      notes: null,
      decidedAt: null,
      history: [],
    },
    targets,
    release: {
      state: "pending",
      sha: null,
      tag: null,
      verifiedMergeShas: [],
    },
  };
}

export function markWorkersComplete(status, at = new Date().toISOString()) {
  status.execution = {
    ...(status.execution || {}),
    state: "done",
    endedAt: at,
  };
  status.delivery ||= legacyDelivery(status);
  status.delivery.state = "review_pending";
  status.delivery.workersCompletedAt = at;
  const integratedChangedFiles = [...new Set(
    (status.lanes || []).flatMap((lane) => lane.changedFiles || []),
  )];
  if (status.integrate?.state === "ready"
    && status.delivery.mode !== "review-only"
    && integratedChangedFiles.length) {
    status.delivery.mode = "single";
    status.delivery.targets = [{
      id: "integrate",
      laneId: "integrate",
      order: 1,
      state: "changes_ready",
      branch: status.integrate.branch,
      base: normalizeBase(status.baseRef, status.integrate.remote || "origin") || "main",
      pr: null,
      worktree: status.integrate.worktree,
      changedFiles: integratedChangedFiles,
      prUrl: null,
      mergeSha: null,
      mergedAt: null,
    }];
  }
  for (const target of status.delivery.targets || []) {
    const lane = (status.lanes || []).find((candidate) => candidate.id === target.laneId);
    if (!lane) continue;
    target.worktree = lane.worktree || target.worktree || null;
    target.branch ||= lane.branch;
    target.changedFiles = [...(lane.changedFiles || [])];
    target.state = target.changedFiles.length ? "changes_ready" : "no_changes";
  }
  status.state = "delivery_review_pending";
  status.endedAt = null;
  return status;
}

export function recordReviewDecision(status, {
  pass,
  verdict,
  reviewer,
  notes = null,
  at = new Date().toISOString(),
}) {
  const reviewPass = Number(pass);
  if (![1, 2].includes(reviewPass)) throw new Error("review pass must be 1 or 2");
  if (!REVIEW_VERDICTS.has(verdict)) {
    throw new Error("review verdict must be accept, accept-with-notes, revise, relaunch, or reject");
  }
  if (!reviewer || !String(reviewer).trim()) throw new Error("reviewer is required");
  status.delivery ||= legacyDelivery(status);
  const review = status.delivery.review ||= {
    state: "not_started",
    latestPass: 0,
    verdict: null,
    reviewer: null,
    notes: null,
    decidedAt: null,
    history: [],
  };
  review.history ||= [];
  if (review.history.some((item) => item.pass === reviewPass)) {
    throw new Error(`delivery review pass ${reviewPass} already has a recorded decision`);
  }
  if (reviewPass === 2) {
    const passOne = review.history.find((item) => item.pass === 1);
    if (!passOne || !["revise", "relaunch"].includes(passOne.verdict)) {
      throw new Error("delivery review pass 2 requires a recorded pass 1 correction decision");
    }
    if (["revise", "relaunch"].includes(verdict)) {
      throw new Error("delivery review pass 2 must accept, accept-with-notes, or reject");
    }
  }
  const decision = {
    pass: reviewPass,
    verdict,
    reviewer: String(reviewer).trim(),
    notes: notes ? String(notes).trim() : null,
    decidedAt: at,
  };
  review.history.push(decision);
  review.state = ACCEPTED_VERDICTS.has(verdict)
    ? "accepted"
    : verdict === "reject"
      ? "rejected"
      : "correction_required";
  review.latestPass = reviewPass;
  review.verdict = verdict;
  review.reviewer = decision.reviewer;
  review.notes = decision.notes;
  review.decidedAt = at;

  if (ACCEPTED_VERDICTS.has(verdict)) {
    if (status.delivery.mode === "review-only" || status.delivery.targets.length === 0) {
      status.delivery.state = "reviewed";
      status.state = "reviewed";
      status.endedAt = at;
    } else {
      status.delivery.state = "ship_gate_pending";
      status.state = "ship_gate_pending";
      status.endedAt = null;
    }
  } else if (verdict === "reject") {
    status.delivery.state = "rejected";
    status.state = "rejected";
    status.endedAt = at;
  } else {
    status.delivery.state = "correction_pending";
    status.state = "correction_pending";
    status.endedAt = null;
  }
  return status;
}

export function recordReviewPresentation(status, {
  pass,
  at = new Date().toISOString(),
}) {
  const reviewPass = Number(pass);
  if (![1, 2].includes(reviewPass)) throw new Error("review pass must be 1 or 2");
  status.delivery ||= legacyDelivery(status);
  const review = status.delivery.review;
  review.history ||= [];
  if (review.history.some((item) => item.pass === reviewPass)) {
    throw new Error(`delivery review pass ${reviewPass} already has a recorded decision`);
  }
  if (reviewPass === 2) {
    const passOne = review.history.find((item) => item.pass === 1);
    if (!passOne || !["revise", "relaunch"].includes(passOne.verdict)) {
      throw new Error("delivery review pass 2 requires a recorded pass 1 correction decision");
    }
  }
  if (review.state === "awaiting_operator" && review.latestPass === reviewPass) return status;
  review.state = "awaiting_operator";
  review.latestPass = reviewPass;
  review.presentedAt = at;
  review.verdict = null;
  review.reviewer = null;
  review.notes = null;
  review.decidedAt = null;
  return status;
}

export function assertAcceptedReview(status) {
  const review = status.delivery?.review;
  if (review?.state !== "accepted" || !ACCEPTED_VERDICTS.has(review.verdict)) {
    throw new Error("shipping requires a persisted accepted Delivery Review");
  }
  if (!["ship_gate_pending", "release_pending", "blocked"].includes(status.state)) {
    throw new Error(`run ${status.runId} is not ready for Ship Gate shipping (state ${status.state})`);
  }
  return review;
}

/**
 * Accept-without-ship terminal. An accepted run whose outputs are kept as
 * filed evidence instead of being shipped ends in `filed`, never `cancelled`:
 * successful filing is delivery, not abandonment.
 */
export function recordFiled(status, {
  operator,
  reason = null,
  at = new Date().toISOString(),
} = {}) {
  if (!operator || !String(operator).trim()) throw new Error("filing requires an operator id");
  status.delivery ||= legacyDelivery(status);
  const review = status.delivery.review;
  if (review?.state !== "accepted" || !ACCEPTED_VERDICTS.has(review.verdict)) {
    throw new Error("filing requires a persisted accepted Delivery Review");
  }
  if (!["ship_gate_pending", "blocked"].includes(status.state)) {
    throw new Error(
      `run ${status.runId} cannot be filed from state ${status.state}; filing closes an accepted run that is not being shipped`,
    );
  }
  const merged = (status.delivery.targets || []).filter((target) => target.state === "merged");
  if (merged.length) {
    throw new Error(
      `run ${status.runId} already merged ${merged.map((target) => target.id).join(", ")}; finish the delivery instead of filing it`,
    );
  }
  status.delivery.state = "filed";
  status.delivery.filed = {
    state: "filed",
    operator: String(operator).trim(),
    reason: reason ? String(reason).trim() : null,
    filedAt: at,
    unshippedTargets: (status.delivery.targets || [])
      .filter((target) => (target.changedFiles || []).length)
      .map((target) => target.id),
  };
  status.state = "filed";
  status.endedAt = at;
  return status;
}

/**
 * Goal references this run declared that the frozen goal snapshot still shows
 * in a pre-delivery lifecycle. Advisory only — Agent Manager never advances a
 * goal on the operator's behalf.
 */
export function staleGoalHints(status) {
  const refs = status?.goalRefs || [];
  if (!refs.length) return [];
  const frozen = new Map((status?.goals?.goals || []).map((goal) => [goal.id, goal]));
  return refs
    .map((id) => {
      const goal = frozen.get(id) || null;
      return {
        id,
        title: goal?.title || null,
        lifecycle: goal?.lifecycle || "unknown",
        source: goal ? "frozen-goal-snapshot" : "declared-goal-ref",
      };
    })
    .filter((hint) => !ADVANCED_GOAL_LIFECYCLES.has(hint.lifecycle));
}

export function selectDeliveryTarget(status, targetId = null, { allowMerged = false } = {}) {
  const targets = status.delivery?.targets || [];
  if (!targets.length) return null;
  if (targets.length > 1 && !targetId) {
    throw new Error("multi-PR delivery requires --target <delivery-target-id>");
  }
  const target = targetId
    ? targets.find((candidate) => candidate.id === targetId)
    : targets[0];
  if (!target) throw new Error(`unknown delivery target: ${targetId}`);
  if (target.state === "merged" && !allowMerged) {
    throw new Error(`delivery target ${target.id} is already merged`);
  }
  return target;
}

export function recordMergedTarget(status, {
  targetId,
  prUrl,
  mergeSha,
  at = new Date().toISOString(),
}) {
  status.delivery ||= legacyDelivery(status);
  const target = (status.delivery.targets || []).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`unknown delivery target: ${targetId}`);
  if (!mergeSha) throw new Error(`delivery target ${targetId} has no merge SHA`);
  target.state = "merged";
  target.prUrl = prUrl || target.prUrl || target.pr || null;
  target.mergeSha = mergeSha;
  target.mergedAt = at;
  const allMerged = status.delivery.targets.every((candidate) => candidate.state === "merged");
  status.delivery.state = allMerged
    ? status.delivery.releaseRequired ? "release_pending" : "merged"
    : "targets_pending";
  status.state = allMerged
    ? status.delivery.releaseRequired ? "release_pending" : "merged"
    : "ship_gate_pending";
  status.endedAt = allMerged && !status.delivery.releaseRequired ? at : null;
  return { status, target, allMerged };
}

export function recordRelease(status, {
  sha,
  tag,
  verifiedMergeShas,
  at = new Date().toISOString(),
}) {
  status.delivery ||= legacyDelivery(status);
  status.delivery.release = {
    state: "released",
    sha,
    tag,
    verifiedMergeShas: [...new Set(verifiedMergeShas || [])],
    releasedAt: at,
  };
  status.delivery.state = "released";
  status.state = "released";
  status.endedAt = at;
  return status;
}

export function expectedMergeShas(status, currentShip = null) {
  const values = [];
  for (const target of status.delivery?.targets || []) {
    if (target.mergeSha) values.push(target.mergeSha);
    else if (currentShip?.targetId === target.id && currentShip.mergeSha) values.push(currentShip.mergeSha);
  }
  return [...new Set(values.filter(Boolean))];
}

export function isOverallTerminalState(state) {
  return ["reviewed", "filed", "merged", "released", "rejected", "failed", "cancelled"].includes(state);
}

export function deliveryReadiness(status, { require = "released" } = {}) {
  if (!["merged", "released"].includes(require)) {
    throw new Error("delivery readiness requires merged or released");
  }
  const targets = status.delivery?.targets || [];
  const allTargetsMerged = targets.length > 0
    && targets.every((target) => target.state === "merged" && target.mergeSha);
  const ready = require === "released"
    ? status.state === "released"
    : allTargetsMerged && ["release_pending", "merged", "released"].includes(status.state);
  return {
    schema: "agent-manager.delivery-readiness.v1",
    runId: status.runId,
    ready,
    requiredState: require,
    state: status.state,
    deliveryState: status.delivery?.state || null,
    reviewState: status.delivery?.review?.state || null,
    targets: targets.map((target) => ({
      id: target.id,
      state: target.state,
      prUrl: target.prUrl || null,
      mergeSha: target.mergeSha || null,
    })),
    release: status.delivery?.release || null,
  };
}

function legacyDelivery(status) {
  const targets = (status.lanes || []).map((lane, index) => ({
    id: lane.id,
    laneId: lane.id,
    order: index + 1,
    state: lane.changedFiles?.length ? "changes_ready" : "no_changes",
    branch: lane.branch || null,
    base: normalizeBase(status.baseRef, "origin") || "main",
    pr: null,
    worktree: lane.worktree || null,
    changedFiles: [...(lane.changedFiles || [])],
    prUrl: null,
    mergeSha: null,
    mergedAt: null,
  }));
  return {
    schema: "agent-manager.delivery.v1",
    mode: targets.length > 1 ? "train" : "single",
    state: "review_pending",
    releaseRequired: false,
    workersCompletedAt: status.executionEndedAt || status.endedAt || null,
    review: {
      state: "not_started",
      latestPass: 0,
      presentedAt: null,
      verdict: null,
      reviewer: null,
      notes: null,
      decidedAt: null,
      history: [],
    },
    targets,
    release: { state: "pending", sha: null, tag: null, verifiedMergeShas: [] },
  };
}

function normalizeBase(value, remote) {
  const text = String(value || "");
  return text.startsWith(`${remote}/`) ? text.slice(remote.length + 1) : text;
}
