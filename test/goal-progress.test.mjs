import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { assertResolvedRootsIsolated, isolatedRoot } from "../test-support/isolated-roots.mjs";
import { GoalModelError, createGoal, linkGoalArtifact } from "../src/goals.mjs";
import { computeGoalProgress, getGoalProgress } from "../src/goal-progress.mjs";

const roots = [];

function brainRoot() {
  const root = isolatedRoot("goal-progress-");
  roots.push(root);
  return join(root, "brain");
}

function goal(id, lifecycle = "planned", parentId = null, updatedAt = null) {
  return {
    id,
    title: id,
    lifecycle,
    parentId,
    dependencies: [],
    updatedAt,
  };
}

function artifact(id, goalId, state, relationship = "supports") {
  return {
    id,
    goalId,
    artifactType: "other",
    artifactRef: `test:${id}`,
    relationship,
    state,
    label: null,
  };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("this test file resolves a disposable brain root", async () => {
  await assertResolvedRootsIsolated();
});

test("reports empty goals from stored lifecycle with an exact leaf ratio", () => {
  const planned = computeGoalProgress("goal-empty", {
    goals: [goal("goal-empty")],
  });
  assert.equal(planned.effectiveState, "planned");
  assert.deepEqual(planned.completedLeafRatio, {
    label: "completed-leaf ratio",
    numerator: 0,
    denominator: 1,
    value: 0,
  });
  assert.equal(planned.counts.goals.leaves, 1);
  assert.equal(planned.counts.artifacts.total, 0);
  assert.equal(planned.counts.runs.total, 0);

  const delivered = computeGoalProgress("goal-empty", {
    goals: [goal("goal-empty", "delivered")],
  });
  assert.equal(delivered.effectiveState, "delivered");
  assert.deepEqual(delivered.completedLeafRatio, {
    label: "completed-leaf ratio",
    numerator: 1,
    denominator: 1,
    value: 1,
  });

  const cancelled = computeGoalProgress("goal-empty", {
    goals: [goal("goal-empty", "cancelled")],
  });
  assert.equal(cancelled.effectiveState, "cancelled");
  assert.equal(cancelled.completedLeafRatio.numerator, 0);
});

test("rolls up mixed child states and counts delivered leaves", () => {
  const result = computeGoalProgress("goal-root", {
    goals: [
      goal("goal-root", "active"),
      goal("goal-done", "delivered", "goal-root"),
      goal("goal-next", "planned", "goal-root"),
    ],
  });

  assert.equal(result.effectiveState, "active");
  assert.deepEqual(result.completedLeafRatio, {
    label: "completed-leaf ratio",
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  assert.equal(result.counts.goals.byStoredLifecycle.delivered, 1);
  assert.equal(result.counts.goals.byEffectiveState.planned, 1);
  assert.deepEqual(result.basis.decisiveEvidence.map((item) => [item.kind, item.id]), [
    ["goal", "goal-root"],
  ]);
});

test("blocked run evidence takes precedence over active work", () => {
  const result = computeGoalProgress("goal-run", {
    goals: [goal("goal-run", "active")],
    artifactLinks: [artifact("glink-active", "goal-run", "active")],
    runIntents: [
      {
        runId: "run-active",
        state: "running",
        phase: "editing",
        goalRefs: ["goal-run"],
      },
      {
        runId: "run-blocked",
        state: "needs_input",
        phase: "editing",
        goalRefs: ["goal-run"],
      },
    ],
  });

  assert.equal(result.effectiveState, "blocked");
  assert.equal(result.counts.runs.total, 2);
  assert.equal(result.counts.runs.byContribution.active, 1);
  assert.equal(result.counts.runs.byContribution.blocked, 1);
  assert.deepEqual(result.basis.decisiveEvidence.map((item) => item.id), ["run-blocked"]);
  assert.equal(
    result.evidence.some((item) => item.id === "run-active" && item.contribution === "active"),
    true,
  );
});

test("explicit terminal lifecycle retires older failed, abandoned, and filed attempts", () => {
  for (const [state, phase] of [
    ["failed", "terminal"],
    ["abandoned", "terminal"],
    ["filed", "terminal"],
    ["cancelled", "terminal"],
  ]) {
    const result = computeGoalProgress(`goal-${state}`, {
      goals: [goal(`goal-${state}`, "delivered", null, "2026-09-04T12:00:00.000Z")],
      runIntents: [{
        runId: `run-${state}`,
        state,
        phase,
        goalRefs: [`goal-${state}`],
        startedAt: "2026-09-03T10:00:00.000Z",
        endedAt: "2026-09-03T11:00:00.000Z",
      }],
    });

    assert.equal(result.effectiveState, "delivered", state);
    const evidence = result.evidence.find((item) => item.id === `run-${state}`);
    assert.equal(evidence.historical, true, state);
    assert.equal(evidence.excluded, false, state);
  }
});

test("an untimed terminal attempt cannot override an explicit terminal lifecycle", () => {
  const result = computeGoalProgress("goal-untimed-terminal", {
    goals: [goal("goal-untimed-terminal", "delivered")],
    runIntents: [{
      runId: "run-untimed-failure",
      state: "failed",
      phase: "terminal",
      goalRefs: ["goal-untimed-terminal"],
    }],
  });
  assert.equal(result.effectiveState, "delivered");
  assert.equal(result.evidence.find((item) => item.id === "run-untimed-failure").historical, true);
});

test("a later filed correction stays historical until it receives a disposition", () => {
  const result = computeGoalProgress("goal-filed-correction", {
    goals: [goal("goal-filed-correction", "delivered", null, "2026-09-03T10:00:00.000Z")],
    runIntents: [{
      runId: "run-filed-correction",
      state: "filed",
      phase: "terminal",
      goalRefs: ["goal-filed-correction"],
      startedAt: "2026-09-04T10:00:00.000Z",
      endedAt: "2026-09-04T11:00:00.000Z",
    }],
  });
  assert.equal(result.effectiveState, "delivered");
  assert.equal(result.evidence.find((item) => item.id === "run-filed-correction").historical, true);
});

test("later accepted delivery retires earlier failure without rewriting its evidence", () => {
  const result = computeGoalProgress("goal-recovered", {
    goals: [goal("goal-recovered", "active", null, "2026-09-01T09:00:00.000Z")],
    runIntents: [
      {
        runId: "run-failed-attempt",
        state: "failed",
        phase: "terminal",
        goalRefs: ["goal-recovered"],
        endedAt: "2026-09-02T10:00:00.000Z",
      },
      {
        runId: "run-released-recovery",
        state: "released",
        phase: "terminal",
        goalRefs: ["goal-recovered"],
        endedAt: "2026-09-03T10:00:00.000Z",
      },
    ],
  });

  assert.equal(result.effectiveState, "delivered");
  assert.equal(result.evidence.find((item) => item.id === "run-failed-attempt").historical, true);
  assert.equal(result.evidence.find((item) => item.id === "run-released-recovery").historical, false);
});

test("new explicitly current blocked work reopens a terminal goal", () => {
  const result = computeGoalProgress("goal-reopened", {
    goals: [goal("goal-reopened", "delivered", null, "2026-09-03T10:00:00.000Z")],
    runIntents: [{
      runId: "run-current-blocker",
      state: "needs_input",
      phase: "editing",
      goalRefs: ["goal-reopened"],
      startedAt: "2026-09-04T10:00:00.000Z",
      heartbeatAt: "2026-09-04T11:00:00.000Z",
    }],
  });

  assert.equal(result.effectiveState, "blocked");
  assert.equal(result.evidence.find((item) => item.id === "run-current-blocker").historical, false);
});

test("a failed attempt started after terminal closeout remains a current blocker", () => {
  const result = computeGoalProgress("goal-failed-reopen", {
    goals: [goal("goal-failed-reopen", "delivered", null, "2026-09-03T10:00:00.000Z")],
    runIntents: [{
      runId: "run-failed-reopen",
      state: "failed",
      phase: "terminal",
      goalRefs: ["goal-failed-reopen"],
      startedAt: "2026-09-04T10:00:00.000Z",
      endedAt: "2026-09-04T11:00:00.000Z",
    }],
  });
  assert.equal(result.effectiveState, "blocked");
  assert.equal(result.evidence.find((item) => item.id === "run-failed-reopen").historical, false);
});

test("terminal child reconciliation rolls up without stale parent blocking", () => {
  const result = computeGoalProgress("goal-parent", {
    goals: [
      goal("goal-parent", "delivered", null, "2026-09-04T12:00:00.000Z"),
      goal("goal-child", "delivered", "goal-parent", "2026-09-04T11:00:00.000Z"),
    ],
    runIntents: [{
      runId: "run-child-failed",
      state: "failed",
      phase: "terminal",
      goalRefs: ["goal-child", "goal-parent"],
      endedAt: "2026-09-03T10:00:00.000Z",
    }],
  });

  assert.equal(result.effectiveState, "delivered");
  assert.deepEqual(result.completedLeafRatio, {
    label: "completed-leaf ratio",
    numerator: 1,
    denominator: 1,
    value: 1,
  });
  assert.equal(result.goals.find((item) => item.goalId === "goal-child").effectiveState, "delivered");
});

test("a terminal parent retires an older unresolved child epoch", () => {
  const result = computeGoalProgress("goal-settled-parent", {
    goals: [
      goal("goal-settled-parent", "delivered", null, "2026-09-04T12:00:00.000Z"),
      goal("goal-old-child", "active", "goal-settled-parent", "2026-09-02T09:00:00.000Z"),
    ],
    runIntents: [{
      runId: "run-old-child-failure",
      state: "failed",
      phase: "terminal",
      goalRefs: ["goal-old-child"],
      endedAt: "2026-09-03T10:00:00.000Z",
    }],
  });
  assert.equal(result.goals.find((item) => item.goalId === "goal-old-child").effectiveState, "blocked");
  assert.equal(result.effectiveState, "delivered");
});

test("pending-delivery evidence remains distinct and explainable", () => {
  const result = computeGoalProgress("goal-delivery", {
    goals: [goal("goal-delivery", "delivered")],
    artifactLinks: [artifact("glink-release", "goal-delivery", "delivered", "delivers")],
    runIntents: [{
      runId: "run-delivery",
      title: "Awaiting Ship Gate",
      state: "pending_delivery",
      phase: "delivery",
      goalRefs: ["goal-delivery"],
    }],
  });

  assert.equal(result.effectiveState, "pending_delivery");
  assert.equal(result.counts.runs.byState.pending_delivery, 1);
  assert.equal(result.completedLeafRatio.numerator, 0);
  assert.deepEqual(result.basis.decisiveEvidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    state: item.state,
  })), [{ id: "run-delivery", kind: "run", state: "pending_delivery" }]);
});

test("excludes superseded branches and their blocked evidence from completion", () => {
  const result = computeGoalProgress("goal-root", {
    goals: [
      goal("goal-root", "delivered"),
      goal("goal-current", "delivered", "goal-root"),
      goal("goal-old", "superseded", "goal-root"),
      goal("goal-old-child", "blocked", "goal-old"),
    ],
    artifactLinks: [artifact("glink-old-blocker", "goal-old-child", "blocked", "blocks")],
    runIntents: [{
      runId: "run-old-blocked",
      state: "needs_input",
      goalRefs: ["goal-old-child"],
    }],
  });

  assert.equal(result.effectiveState, "delivered");
  assert.deepEqual(result.completedLeafRatio, {
    label: "completed-leaf ratio",
    numerator: 1,
    denominator: 1,
    value: 1,
  });
  assert.equal(result.counts.goals.total, 4);
  assert.equal(result.counts.goals.included, 2);
  assert.equal(result.counts.goals.excludedSuperseded, 2);
  assert.equal(result.counts.artifacts.included, 0);
  assert.equal(result.counts.runs.total, 1);
  assert.equal(result.counts.runs.included, 0);
  assert.equal(result.counts.runs.excludedSuperseded, 1);
  assert.equal(
    result.evidence.find((item) => item.id === "run-old-blocked").excluded,
    true,
  );
});

test("rolls delivered nested goals up deterministically regardless of input order", () => {
  const input = {
    goals: [
      goal("goal-leaf", "delivered", "goal-middle"),
      goal("goal-root", "delivered"),
      goal("goal-middle", "delivered", "goal-root"),
    ],
    artifactLinks: [artifact("glink-leaf", "goal-leaf", "delivered", "delivers")],
    runIntents: [{
      runId: "run-released",
      state: "released",
      goalRefs: ["goal-leaf", "goal-root"],
    }],
  };
  const result = computeGoalProgress("goal-root", input);
  const reversed = computeGoalProgress("goal-root", {
    goals: [...input.goals].reverse(),
    artifactLinks: [...input.artifactLinks].reverse(),
    runIntents: [...input.runIntents].reverse(),
  });

  assert.equal(result.effectiveState, "delivered");
  assert.equal(result.completedLeafRatio.numerator, 1);
  assert.equal(result.completedLeafRatio.denominator, 1);
  assert.equal(result.counts.runs.total, 1);
  assert.deepEqual(result, reversed);
  assert.deepEqual(result.goals.map((item) => item.goalId), [
    "goal-root",
    "goal-middle",
    "goal-leaf",
  ]);

  const blocked = computeGoalProgress("goal-root", {
    ...input,
    artifactLinks: [
      ...input.artifactLinks,
      artifact("glink-leaf-blocker", "goal-leaf", "blocked", "blocks"),
    ],
  });
  assert.equal(blocked.effectiveState, "blocked");
  assert.equal(
    blocked.evidence.some((item) => item.id === "glink-leaf-blocker" && item.contribution === "blocked"),
    true,
  );
});

test("reads goals and artifact links through the phase-2 brain API", async () => {
  const root = brainRoot();
  await createGoal({ id: "goal-api-root", title: "API root", lifecycle: "delivered" }, { root });
  await createGoal({
    id: "goal-api-leaf",
    title: "API leaf",
    lifecycle: "delivered",
    parentId: "goal-api-root",
  }, { root });
  await linkGoalArtifact({
    id: "glink-api-release",
    goalId: "goal-api-leaf",
    artifactType: "release",
    artifactRef: "release:local",
    relationship: "delivers",
    state: "delivered",
  }, { root });

  const result = await getGoalProgress("goal-api-root", { root });
  assert.equal(result.effectiveState, "delivered");
  assert.equal(result.counts.goals.total, 2);
  assert.equal(result.counts.artifacts.total, 1);
  assert.equal(result.completedLeafRatio.numerator, 1);
  assert.equal(result.completedLeafRatio.denominator, 1);
});

test("rejects a missing selected goal and invalid graph input", () => {
  assert.throws(
    () => computeGoalProgress("goal-missing", { goals: [goal("goal-present")] }),
    (error) => error instanceof GoalModelError && error.code === "GOAL_NOT_FOUND",
  );
  assert.throws(
    () => computeGoalProgress("goal-orphan", {
      goals: [goal("goal-orphan", "planned", "goal-missing")],
    }),
    (error) => error instanceof GoalModelError && error.code === "MISSING_PARENT",
  );
});
