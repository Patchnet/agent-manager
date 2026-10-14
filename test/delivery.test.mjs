import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAccepted,
  closeRun,
  markWorkersComplete,
  recordReview,
  settleTargets,
} from "../src/delivery.mjs";

function finished({ integrate = true, changed = ["src/a.ts"] } = {}) {
  const status = {
    runId: "run-d",
    state: "workers_done",
    baseRef: "origin/main",
    lanes: [{ id: "api", worktree: "/wt/api", branch: "am/run-d/api", changedFiles: changed }],
    integrate: integrate ? { state: "ready", branch: "am/run-d/integrate", worktree: "/wt/int", remote: "origin" } : undefined,
    delivery: { mode: "single", review: { verdict: null, history: [] }, targets: [] },
  };
  return markWorkersComplete(status, "2026-10-13T00:00:00.000Z");
}

test("finished workers wait for review with one integrate target", () => {
  const status = finished();
  assert.equal(status.state, "review_pending");
  assert.equal(status.delivery.targets.length, 1);
  const [target] = status.delivery.targets;
  assert.equal(target.branch, "am/run-d/integrate");
  assert.equal(target.base, "main");
  assert.equal(target.state, "changes_ready");
});

test("one recorded verdict moves the run: accept, revise, reject", () => {
  const accepted = recordReview(finished(), { verdict: "accept", reviewer: "rev-1", notes: "ok" });
  assert.equal(accepted.state, "ship_pending");
  assert.doesNotThrow(() => assertAccepted(accepted));
  assert.equal(recordReview(finished(), { verdict: "revise", reviewer: "rev-1" }).state, "correction_pending");
  assert.equal(recordReview(finished(), { verdict: "reject", reviewer: "rev-1" }).state, "rejected");
  assert.equal(recordReview(finished({ changed: [] }), { verdict: "accept", reviewer: "rev-1" }).state, "reviewed",
    "nothing to ship ends the run at review");
});

test("verdicts need a known value, a reviewer, and a finished run", () => {
  assert.throws(() => recordReview(finished(), { verdict: "accept-with-notes", reviewer: "x" }), /accept, revise, or reject/);
  assert.throws(() => recordReview(finished(), { verdict: "accept", reviewer: " " }), /--reviewer/);
  assert.throws(() => recordReview({ ...finished(), state: "running" }, { verdict: "accept", reviewer: "x" }), /after workers finish/);
  assert.throws(() => assertAccepted(finished()), /no accepted review/);
});

test("targets settle into shipping, waiting_operator, and merged", () => {
  const status = recordReview(finished(), { verdict: "accept", reviewer: "rev-1" });
  const [target] = status.delivery.targets;
  target.prUrl = "u";
  target.waitingOperator = "tier 2";
  assert.equal(settleTargets(status).state, "waiting_operator");
  target.waitingOperator = null;
  target.autoMerge = true;
  assert.equal(settleTargets(status).state, "shipping");
  target.mergeSha = "abc";
  assert.equal(settleTargets(status).state, "merged");
  assert.ok(status.endedAt);
});

test("close ends a run without shipping", () => {
  const closed = closeRun(finished(), { reason: "kept for reference" });
  assert.equal(closed.state, "closed");
  assert.equal(closed.closedReason, "kept for reference");
});
