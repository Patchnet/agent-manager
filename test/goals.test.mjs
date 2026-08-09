import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { assertResolvedRootsIsolated, isolatedRoot } from "../test-support/isolated-roots.mjs";
import {
  GoalModelError,
  assertGoalsExist,
  createGoal,
  getGoal,
  inspectGoalGraph,
  linkGoalArtifact,
  listGoalArtifactLinks,
  listGoals,
  updateArtifactLink,
  updateGoal,
  validateGoalGraph,
} from "../src/goals.mjs";

const roots = [];

function brainRoot() {
  const root = isolatedRoot("goals-");
  roots.push(root);
  return join(root, "brain");
}

function rejectsWith(code) {
  return (error) => error instanceof GoalModelError && error.code === code;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The default brain root is an operator's real brain. A goal test that forgets
// to pass `root` must not be able to write into it.
test("this test file resolves a disposable brain root", async () => {
  await assertResolvedRootsIsolated();
});

test("creates, reads, lists, and updates hierarchical goals with stable IDs", async () => {
  const root = brainRoot();
  const now = new Date("2026-08-08T01:02:03.000Z");
  const parent = await createGoal({
    id: "goal-release",
    title: "Release the goal graph",
    lifecycle: "active",
    outcome: "Operators can coordinate work through durable goals.",
    successCriteria: ["Goals survive process restarts", "Links remain portable"],
    externalSourceRefs: ["decision:public-roadmap", "plan:goal-build"],
  }, { root, now });
  assert.equal(parent.id, "goal-release");
  assert.equal(parent.lifecycle, "active");
  assert.equal(parent.createdAt, now.toISOString());

  const child = await createGoal({
    id: "goal-model",
    title: "Implement the model",
    parentId: parent.id,
    dependencies: [parent.id],
    successCriteria: ["Integrity checks pass"],
  }, { root, now: new Date("2026-08-08T01:03:00.000Z") });
  assert.equal(child.parentId, parent.id);
  assert.deepEqual(child.dependencies, [parent.id]);

  assert.deepEqual((await listGoals({ root })).map((goal) => goal.id), ["goal-model", "goal-release"]);
  assert.deepEqual((await listGoals({ root, parentId: parent.id })).map((goal) => goal.id), ["goal-model"]);
  assert.deepEqual((await listGoals({ root, parentId: null })).map((goal) => goal.id), ["goal-release"]);
  assert.equal((await getGoal(child.id, { root })).title, "Implement the model");
  assert.deepEqual((await assertGoalsExist([child.id, parent.id], { root })).map((goal) => goal.id), [
    "goal-model",
    "goal-release",
  ]);

  const updated = await updateGoal(child.id, {
    title: "Implement and validate the model",
    lifecycle: "delivered",
    parentId: null,
    dependencies: [],
    outcome: null,
    successCriteria: ["Integrity checks pass", "Migration is tested"],
    externalSourceRefs: [],
  }, { root, now: new Date("2026-08-08T02:00:00.000Z") });
  assert.equal(updated.parentId, null);
  assert.equal(updated.outcome, null);
  assert.deepEqual(updated.dependencies, []);
  assert.deepEqual(updated.externalSourceRefs, []);
  assert.equal(updated.updatedAt, "2026-08-08T02:00:00.000Z");
  assert.equal((await validateGoalGraph({ root })).valid, true);
});

test("generates collision-safe local IDs and validates caller-supplied IDs", async () => {
  const root = brainRoot();
  const first = await createGoal({ title: "Shared title" }, { root });
  const second = await createGoal({ title: "Shared title" }, { root });
  assert.equal(first.id, "goal-shared-title");
  assert.equal(second.id, "goal-shared-title-2");
  await assert.rejects(
    createGoal({ id: "outside-prefix", title: "Bad ID" }, { root }),
    rejectsWith("INVALID_GOAL_ID"),
  );
  await assert.rejects(getGoal("goal-missing", { root }), rejectsWith("GOAL_NOT_FOUND"));
  await assert.rejects(
    assertGoalsExist([first.id, "goal-missing"], { root }),
    rejectsWith("GOAL_NOT_FOUND"),
  );
});

test("rejects missing parents, self-parenting, and hierarchy cycles without mutating records", async () => {
  const root = brainRoot();
  await assert.rejects(
    createGoal({ id: "goal-orphan", title: "Orphan", parentId: "goal-missing" }, { root }),
    rejectsWith("MISSING_PARENT"),
  );
  await assert.rejects(
    createGoal({ id: "goal-self", title: "Self", parentId: "goal-self" }, { root }),
    rejectsWith("SELF_PARENT"),
  );
  await createGoal({ id: "goal-parent", title: "Parent" }, { root });
  await createGoal({ id: "goal-child", title: "Child", parentId: "goal-parent" }, { root });
  await assert.rejects(
    updateGoal("goal-parent", { parentId: "goal-child" }, { root }),
    rejectsWith("HIERARCHY_CYCLE"),
  );
  assert.equal((await getGoal("goal-parent", { root })).parentId, null);
});

test("rejects missing, self, duplicate, and cyclic dependencies", async () => {
  const root = brainRoot();
  await createGoal({ id: "goal-one", title: "One" }, { root });
  await createGoal({ id: "goal-two", title: "Two", dependencies: ["goal-one"] }, { root });
  await assert.rejects(
    updateGoal("goal-one", { dependencies: ["goal-missing"] }, { root }),
    rejectsWith("MISSING_DEPENDENCY"),
  );
  await assert.rejects(
    updateGoal("goal-one", { dependencies: ["goal-one"] }, { root }),
    rejectsWith("SELF_DEPENDENCY"),
  );
  await assert.rejects(
    updateGoal("goal-one", { dependencies: ["goal-two", "goal-two"] }, { root }),
    rejectsWith("DUPLICATE_DEPENDENCY"),
  );
  await assert.rejects(
    updateGoal("goal-one", { dependencies: ["goal-two"] }, { root }),
    rejectsWith("DEPENDENCY_CYCLE"),
  );
  assert.deepEqual((await getGoal("goal-one", { root })).dependencies, []);
});

test("links every portable artifact type and tracks normalized artifact state", async () => {
  const root = brainRoot();
  await createGoal({ id: "goal-linked", title: "Linked goal" }, { root });
  const artifactTypes = ["fup", "decision", "plan", "bug", "pr", "release", "other"];
  for (const artifactType of artifactTypes) {
    await linkGoalArtifact({
      goalId: "goal-linked",
      artifactType,
      artifactRef: `${artifactType}:opaque-client-reference`,
      relationship: artifactType === "bug" ? "blocks" : "supports",
      state: artifactType === "release" ? "delivered" : "active",
    }, { root });
  }
  const links = await listGoalArtifactLinks({ root, goalId: "goal-linked" });
  assert.deepEqual(new Set(links.map((link) => link.artifactType)), new Set(artifactTypes));
  assert.equal(links.every((link) => link.goalId === "goal-linked"), true);

  const bug = links.find((link) => link.artifactType === "bug");
  const updated = await updateArtifactLink(bug.id, {
    state: "delivered",
    relationship: "delivers",
    label: "Resolved blocker",
  }, { root });
  assert.equal(updated.state, "delivered");
  assert.equal(updated.relationship, "delivers");
  assert.equal(updated.label, "Resolved blocker");

  await assert.rejects(
    linkGoalArtifact({
      goalId: "goal-missing",
      artifactType: "other",
      artifactRef: "client:anything",
    }, { root }),
    rejectsWith("GOAL_NOT_FOUND"),
  );
  await assert.rejects(
    linkGoalArtifact({
      goalId: "goal-linked",
      artifactType: "service-specific-type",
      artifactRef: "client:anything",
    }, { root }),
    rejectsWith("INVALID_GOAL_INPUT"),
  );
});

test("rejects duplicate artifact relationships and exposes pure graph diagnostics", async () => {
  const root = brainRoot();
  await createGoal({ id: "goal-artifacts", title: "Artifacts" }, { root });
  await linkGoalArtifact({
    id: "glink-plan",
    goalId: "goal-artifacts",
    artifactType: "plan",
    artifactRef: "plan:alpha",
    relationship: "tracks",
  }, { root });
  await assert.rejects(
    linkGoalArtifact({
      goalId: "goal-artifacts",
      artifactType: "plan",
      artifactRef: "plan:alpha",
      relationship: "tracks",
    }, { root }),
    rejectsWith("DUPLICATE_ARTIFACT_LINK"),
  );
  const second = await linkGoalArtifact({
    id: "glink-plan-beta",
    goalId: "goal-artifacts",
    artifactType: "plan",
    artifactRef: "plan:beta",
    relationship: "tracks",
  }, { root });
  await assert.rejects(
    updateArtifactLink(second.id, { artifactRef: "plan:alpha" }, { root }),
    rejectsWith("DUPLICATE_ARTIFACT_LINK"),
  );
  assert.equal(
    (await listGoalArtifactLinks({ root })).find((link) => link.id === second.id).artifactRef,
    "plan:beta",
  );

  const validation = inspectGoalGraph({
    goals: [
      { id: "goal-a", parentId: "goal-b", dependencies: [] },
      { id: "goal-b", parentId: "goal-a", dependencies: ["goal-missing"] },
    ],
    artifactLinks: [{ id: "glink-missing", goalId: "goal-missing" }],
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.issues.some((issue) => issue.code === "HIERARCHY_CYCLE"), true);
  assert.equal(validation.issues.some((issue) => issue.code === "MISSING_DEPENDENCY"), true);
  assert.equal(validation.issues.some((issue) => issue.code === "MISSING_LINKED_GOAL"), true);
});
