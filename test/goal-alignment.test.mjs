import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessGoalRequest, evaluateGoalEvidence, goalContractDigest } from "../src/goal-alignment.mjs";
import { createGoal, getGoal, recordGoalRequest, updateGoal } from "../src/goals.mjs";
import { recordReviewDecision, createDeliveryStatus } from "../src/delivery.mjs";
import { computeGoalProgress } from "../src/goal-progress.mjs";

const goal = { id: "goal-delivery", title: "Complete delivery", outcome: "Reviewed PR",
  successCriteria: ["Behavior works", "Recovery works"] };
const request = { request: "Add a dashboard", relationship: "optional", criteria: [],
  reason: "Visibility does not complete the delivery path", impact: "Adds a UI workstream", by: "manager" };

test("request assessment keeps new ideas proposed and requires explicit scope decisions", () => {
  const result = assessGoalRequest(goal, request);
  assert.equal(result.transition, "WAIT_OPERATOR");
  assert.equal(result.decision, "proposed");
  assert.equal(result.recommendation, "defer");
  assert.throws(() => assessGoalRequest(goal, { ...request, decision: "continue", authorityRef: "instruction:1" }), /silently continue/);
  assert.throws(() => assessGoalRequest(goal, { ...request, decision: "amend" }), /authorityRef/);
  const aligned = { ...request, relationship: "dependency", criteria: ["Recovery works"], decision: "continue", authorityRef: "instruction:delivery" };
  assert.equal(assessGoalRequest(goal, aligned).transition, "AUTO_CONTINUE");
  assert.throws(() => assessGoalRequest(goal, { ...aligned, criteria: ["invented"] }), /existing success criteria/);
  assert.throws(() => assessGoalRequest(goal, { ...aligned, goalDigest: "old" }), /goal changed/);
});

test("goal changes preserve before/after, decision authority, stale-write checks and request history", async () => {
  const root = mkdtempSync(join(tmpdir(), "am-alignment-"));
  try {
    const created = await createGoal({ ...goal, lifecycle: "delivered" }, { root });
    const assessment = { ...request, goalDigest: goalContractDigest(created), decision: "defer", authorityRef: "instruction:defer-dashboard" };
    await recordGoalRequest(created.id, assessment, { root });
    assert.equal((await recordGoalRequest(created.id, assessment, { root })).replayed, true);
    const current = await getGoal(created.id, { root });
    assert.equal(current.requests.length, 1);
    assert.equal(current.lifecycle, "delivered");
    await assert.rejects(updateGoal(created.id, { successCriteria: ["Dashboard works"] }, { root }), /change metadata/);
    const change = { expectedVersion: current.version, by: "operator", reason: "Expand goal", impact: "Delivery moves to next milestone", authorityRef: "instruction:expand" };
    const changed = await updateGoal(created.id, { successCriteria: [...goal.successCriteria, "Dashboard works"] }, { root, change });
    assert.equal(changed.changes.length, 1);
    assert.deepEqual(changed.changes[0].before.successCriteria, goal.successCriteria);
    assert.equal(changed.lifecycle, "active");
    await assert.rejects(updateGoal(created.id, { title: "Stale overwrite" }, { root, change }), /expectedVersion/);
    await assert.rejects(recordGoalRequest(created.id, assessment, { root }), /goal changed/);
    assert.equal((await getGoal(created.id, { root })).title, goal.title);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("acceptance requires frozen criterion evidence and distinguishes partial work", () => {
  const status = { goalRefs: [goal.id], goals: { alignmentRequired: true, goals: [goal] }, delivery: createDeliveryStatus({}, []) };
  const accept = { pass: 1, verdict: "accept", reviewer: "manager" };
  assert.throws(() => recordReviewDecision(status, accept), /every referenced goal/);
  assert.equal(status.delivery.review.history.length, 0);
  const evidence = [{ goalId: goal.id, goalDigest: goalContractDigest(goal), criteria: [
    { criterion: "Behavior works", state: "met", evidence: "test:behavior passed at reviewed revision" },
    { criterion: "Recovery works", state: "not-addressed", evidence: "Scheduled for next work item" },
  ] }];
  assert.throws(() => evaluateGoalEvidence(status, [{ ...evidence[0], goalDigest: "other" }]), /frozen contract/);
  recordReviewDecision(status, { ...accept, goalEvidence: evidence });
  assert.equal(status.delivery.review.history[0].goalAssessment[0].outcome, "partial");
});

test("new goal-aligned releases are evidence of work, not automatic goal fulfillment", () => {
  const result = computeGoalProgress(goal.id, { goals: [{ ...goal, lifecycle: "active", dependencies: [] }], artifactLinks: [],
    runIntents: [{ runId: "release", goalRefs: [goal.id], goalAlignmentRequired: true, state: "released", phase: "terminal" }] });
  assert.equal(result.effectiveState, "active");
  assert.equal(result.evidence.find((item) => item.kind === "run").contribution, "pending_delivery");
});
