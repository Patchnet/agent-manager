import test from "node:test";
import assert from "node:assert/strict";

const {
  composeCoreSnapshot,
  formatCoreBoard,
  CORE_FEED_PAGE_SIZE,
} = await import("../src/core-board.mjs?core-board-unit");

const ESC = String.fromCodePoint(27);
const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const VIEWER = { runtimeVersion: "1.18.0", installedVersion: "1.18.0", restartRequired: false };

function goal(id, overrides = {}) {
  return {
    id,
    title: id.replace(/^goal-/, ""),
    lifecycle: "planned",
    parentId: null,
    dependencies: [],
    outcome: null,
    successCriteria: [],
    externalSourceRefs: [],
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function intent(runId, overrides = {}) {
  return {
    docId: runId,
    runId,
    title: runId,
    repoKey: "fixture",
    repoLabel: "agent-manager",
    state: "running",
    phase: "editing",
    scopes: [],
    planRef: null,
    goalRefs: [],
    relatedRuns: [],
    deliveryDependencies: [],
    startedAt: "2026-08-10T10:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function fixture() {
  return {
    goals: [
      goal("goal-wave", { title: "Product UX wave", lifecycle: "active" }),
      goal("goal-lane-a", { title: "Token clarity", lifecycle: "delivered", parentId: "goal-wave" }),
      goal("goal-lane-b", { title: "Fleet polish", lifecycle: "active", parentId: "goal-wave" }),
      goal("goal-idle", { title: "Nothing attached", lifecycle: "planned" }),
    ],
    artifactLinks: [],
    runIntents: [
      intent("run-20260810-151139-7ab3c9d1", { goalRefs: ["goal-lane-b", "goal-wave"] }),
      intent("run-20260804-090000-aa11bb22", {
        goalRefs: ["goal-lane-a"],
        state: "merged",
        phase: "delivery",
        startedAt: "2026-08-04T09:00:00.000Z",
      }),
      intent("run-20260801-080000-cc33dd44", { startedAt: "2026-08-01T08:00:00.000Z" }),
    ],
  };
}

function snapshot(overrides = {}) {
  return composeCoreSnapshot({ ...fixture(), now: NOW, viewer: VIEWER, rootSource: "test", ...overrides });
}

test("core snapshot separates the goal map from the run-intent feed", () => {
  const board = snapshot();
  assert.equal(board.schema, "agent-manager.core-board.v2");
  assert.equal(board.counts.goals, 4);
  assert.equal(board.counts.roots, 2);
  assert.equal(board.counts.intents, 3);
  assert.equal(board.counts.orphanIntents, 1);
  assert.equal(board.counts.isolatedGoals, 1);
  assert.equal(board.degraded, false);

  const [wave, idle] = board.roots;
  assert.equal(wave.id, "goal-wave");
  assert.equal(wave.effectiveState, "active");
  assert.equal(wave.completed, 1);
  assert.equal(wave.leaves, 2);
  assert.equal(wave.children, 2);
  assert.equal(wave.runs, 1);
  assert.equal(idle.id, "goal-idle");
  assert.equal(idle.leaves, 1);

  // Newest first, ids reduced to their suffix, goal linkage carried inline.
  assert.deepEqual(board.feed.map((item) => item.shortId), ["7ab3c9d1", "aa11bb22", "cc33dd44"]);
  assert.deepEqual(board.feed[0].goalRefs, ["goal-lane-b", "goal-wave"]);
  assert.deepEqual(board.feed[2].goalRefs, []);
  assert.equal(board.feedTotal, 3);
});

test("core board renders both regions with aligned columns", () => {
  const board = formatCoreBoard(snapshot(), { color: false, width: 130 });
  assert.match(board, /AGENT MANAGER/);
  assert.match(board, /CORE/);
  assert.match(board, /GOAL MAP/);
  assert.match(board, /Knowledge root/);
  assert.match(board, /Product UX wave/);
  assert.match(board, /1\/2/);
  assert.match(board, /gaps\s+1 runs without goal_refs · 1 goals with no links or runs/);
  assert.match(board, /RUN INTENTS/);
  assert.match(board, /page 1\/1/);
  assert.match(board, /7ab3c9d1/);
  assert.match(board, /lane-b \+1/, "extra goal refs collapse into a count");
  assert.match(board, /unlinked/);
  assert.equal(board.includes(ESC), false);
});

test("core board pages the run-intent feed", () => {
  const board = snapshot();
  const first = formatCoreBoard(board, { color: false, width: 130, page: 1, pageSize: 2 });
  assert.match(first, /page 1\/2/);
  assert.match(first, /7ab3c9d1/);
  assert.match(first, /aa11bb22/);
  assert.doesNotMatch(first, /cc33dd44/);

  const second = formatCoreBoard(board, { color: false, width: 130, page: 2, pageSize: 2 });
  assert.match(second, /page 2\/2/);
  assert.match(second, /cc33dd44/);
  assert.doesNotMatch(second, /7ab3c9d1/);

  // Out-of-range pages clamp instead of rendering an empty feed.
  const clamped = formatCoreBoard(board, { color: false, width: 130, page: 99, pageSize: 2 });
  assert.match(clamped, /page 2\/2/);
  assert.equal(CORE_FEED_PAGE_SIZE > 0, true);
});

test("core board degrades instead of throwing on a broken graph", () => {
  const broken = fixture();
  broken.goals.push(goal("goal-orphan", { parentId: "goal-missing" }));
  const board = composeCoreSnapshot({ ...broken, now: NOW, viewer: VIEWER });
  assert.equal(board.degraded, true);
  assert.match(formatCoreBoard(board, { color: false }), /integrity check/);
});

test("core board guides an empty knowledge store", () => {
  const board = formatCoreBoard(composeCoreSnapshot({ now: NOW, viewer: VIEWER }), { color: false });
  assert.match(board, /GOAL MAP/);
  assert.match(board, /use the Goals tab/);
  assert.match(board, /none recorded in the knowledge store yet/);
});
