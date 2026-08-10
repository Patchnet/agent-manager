import test from "node:test";
import assert from "node:assert/strict";

const {
  composeGoalsSnapshot,
  formatGoalsBoard,
  humanizeAge,
  progressBar,
  shortRunId,
  visibleGoalRows,
  STALE_AFTER_MS,
} = await import("../src/goals-board.mjs?goals-board-unit");

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
      goal("goal-wave", { title: "Product UX wave", lifecycle: "active", updatedAt: "2026-08-05T12:00:00.000Z" }),
      goal("goal-lane-a", { title: "Token clarity", lifecycle: "delivered", parentId: "goal-wave" }),
      goal("goal-lane-b", { title: "Fleet polish", lifecycle: "active", parentId: "goal-wave" }),
      goal("goal-lane-c", { title: "Dashboard MVP", lifecycle: "planned", parentId: "goal-wave" }),
      goal("goal-drifting", {
        title: "Long forgotten cleanup",
        lifecycle: "active",
        createdAt: "2026-06-01T12:00:00.000Z",
        updatedAt: "2026-07-01T12:00:00.000Z",
      }),
      goal("goal-shipped", { title: "Already shipped", lifecycle: "delivered" }),
    ],
    artifactLinks: [],
    runIntents: [
      intent("run-20260810-151139-7ab3c9d1", { goalRefs: ["goal-lane-b"] }),
      intent("run-20260804-090000-aa11bb22", {
        goalRefs: ["goal-lane-a"],
        state: "merged",
        phase: "delivery",
        startedAt: "2026-08-04T09:00:00.000Z",
      }),
    ],
  };
}

function snapshot(overrides = {}) {
  return composeGoalsSnapshot({ ...fixture(), now: NOW, viewer: VIEWER, rootSource: "test", ...overrides });
}

test("relative ages stay compact across every bucket", () => {
  assert.equal(humanizeAge(0), "now");
  assert.equal(humanizeAge(45 * 60_000), "45m");
  assert.equal(humanizeAge(3 * 3_600_000), "3h");
  assert.equal(humanizeAge(6 * 86_400_000), "6d");
  assert.equal(humanizeAge(40 * 86_400_000), "5w");
  assert.equal(humanizeAge(300 * 86_400_000), "10mo");
  assert.equal(humanizeAge(800 * 86_400_000), "2y");
  assert.equal(humanizeAge(null), "-");
});

test("run ids are truncated to their suffix", () => {
  assert.equal(shortRunId("run-20260810-151139-7ab3c9d1"), "7ab3c9d1");
  assert.equal(shortRunId("legacy-run"), "gacy-run");
  assert.equal(shortRunId(null), "-");
});

test("progress bars stay inside their width", () => {
  assert.equal(progressBar(0, 0, 4), "····");
  assert.equal(progressBar(0, 3, 4), "────");
  assert.equal(progressBar(3, 3, 4), "━━━━");
  assert.equal(progressBar(1, 3, 6).length, 6);
});

test("goal roots carry progress, repo grouping, and temporal context", () => {
  const board = snapshot();
  assert.equal(board.schema, "agent-manager.goals-board.v2");
  assert.equal(board.counts.roots, 3);
  assert.equal(board.counts.total, 6);
  assert.equal(board.counts.open, 2);
  assert.equal(board.counts.stale, 1);
  assert.equal(board.degraded, false);

  // Repos come from the run intents attached to a root's subtree; roots with no
  // runs fall into "unassigned", which always sorts last.
  assert.deepEqual(board.groups.map((group) => group.repo), ["agent-manager", "unassigned"]);

  const wave = board.groups[0].roots[0];
  assert.equal(wave.goal.id, "goal-wave");
  assert.equal(wave.effectiveState, "active");
  assert.equal(wave.progress.numerator, 1);
  assert.equal(wave.progress.denominator, 3);
  assert.equal(wave.plannedChildren, 1);
  assert.equal(wave.stale, false);
  // Touched by the newest run intent, not by the older goal edit.
  assert.equal(wave.touchedBy.kind, "run");
  assert.equal(wave.touchedBy.label, "run 7ab3c9d1");
  assert.equal(humanizeAge(wave.touchedMs), "2h");
  assert.equal(humanizeAge(wave.ageMs), "7d");
  assert.equal(wave.runCount, 2);
  assert.deepEqual(wave.runs.map((run) => run.shortId), ["7ab3c9d1", "aa11bb22"]);

  const [drifting, shipped] = board.groups[1].roots;
  assert.equal(drifting.goal.id, "goal-drifting");
  assert.equal(drifting.stale, true);
  assert.equal(drifting.touchedBy.kind, "goal");
  assert.ok(NOW - Date.parse(drifting.touchedAt) >= STALE_AFTER_MS);
  assert.equal(shipped.open, false);
  assert.equal(shipped.stale, false);
});

test("open roots sort by most recently touched", () => {
  const board = snapshot();
  const open = board.groups.flatMap((group) => group.roots).filter((entry) => entry.open);
  assert.deepEqual(open.map((entry) => entry.goal.id), ["goal-wave", "goal-drifting"]);
});

test("rows show roots only until a root is selected", () => {
  const board = snapshot();
  assert.deepEqual(board.rows.map((row) => row.goal.id), ["goal-wave", "goal-drifting"]);

  const expanded = visibleGoalRows(board, { selectedGoalId: "goal-wave" });
  assert.deepEqual(
    expanded.map((row) => row.goal.id),
    ["goal-wave", "goal-lane-a", "goal-lane-b", "goal-drifting"],
    "planned children stay collapsed behind the +N count",
  );

  const withPlanned = visibleGoalRows(board, { selectedGoalId: "goal-wave", expandPlanned: true });
  assert.ok(withPlanned.some((row) => row.goal.id === "goal-lane-c"));

  const allRoots = visibleGoalRows(board, { openOnly: false });
  assert.deepEqual(allRoots.map((row) => row.goal.id), ["goal-wave", "goal-drifting", "goal-shipped"]);
});

test("goals board renders grouping, progress, temporal columns, and the stale chip", () => {
  const board = formatGoalsBoard(snapshot(), { color: false, width: 130, selectedGoalId: "goal-wave" });
  assert.match(board, /AGENT MANAGER/);
  assert.match(board, /2 open/);
  assert.match(board, /1 stale/);
  assert.match(board, /AGE\s+TOUCHED/);
  assert.match(board, /agent-manager/);
  assert.match(board, /unassigned/);
  assert.match(board, /Product UX wave/);
  assert.match(board, /1\/3/);
  assert.match(board, /stale/);
  assert.match(board, /\+1 planned/);
  assert.match(board, /OPEN ONLY/);
  assert.doesNotMatch(board, /Already shipped/, "delivered roots stay hidden under the open-only filter");
  assert.equal(board.includes(ESC), false, "color: false emits no escape sequences");

  const detail = board.slice(board.indexOf("SELECTED"));
  assert.match(detail, /goal-wave/);
  assert.match(detail, /created 2026-08-03 \(7d ago\)/);
  assert.match(detail, /last touched 2h ago by run 7ab3c9d1/);
  assert.match(detail, /7ab3c9d1/);
  assert.match(detail, /aa11bb22/);
});

test("goals board can show settled roots and dims them", () => {
  const board = formatGoalsBoard(snapshot(), { color: true, width: 130, openOnly: false });
  assert.match(board, /Already shipped/);
  assert.ok(board.includes(`${ESC}[2m`), "settled roots render dim rather than in a competing colour");
  assert.match(board, /all roots/);
});

test("goals board degrades instead of throwing on a broken graph", () => {
  const broken = fixture();
  broken.goals.push(goal("goal-orphan", { parentId: "goal-missing" }));
  const board = composeGoalsSnapshot({ ...broken, now: NOW, viewer: VIEWER });
  assert.equal(board.degraded, true);
  assert.match(formatGoalsBoard(board, { color: false }), /integrity check/);
});

test("goals board keeps its first-run guidance when the store is empty", () => {
  const board = formatGoalsBoard(composeGoalsSnapshot({ now: NOW, viewer: VIEWER }), { color: false });
  assert.match(board, /No goals yet/);
  assert.match(board, /Use agent-manager for/);
});
