import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGoalMapData,
  escapeHtml,
  exportGoalMap,
  renderGoalMapHtml,
} from "../src/goal-map.mjs";
import { createGoal, linkGoalArtifact } from "../src/goals.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  return {
    goals: [
      {
        id: "goal-map-root",
        title: "Map </style><script>alert('title')</script>",
        lifecycle: "active",
        parentId: null,
        dependencies: [],
        outcome: "Safe <b>offline</b> output & evidence",
        successCriteria: ["Nothing executes: \"quoted\""],
        externalSourceRefs: [],
      },
      {
        id: "goal-map-child",
        title: "Delivered child",
        lifecycle: "delivered",
        parentId: "goal-map-root",
        dependencies: [],
        outcome: null,
        successCriteria: [],
        externalSourceRefs: [],
      },
    ],
    artifactLinks: [
      {
        id: "glink-map-blocker",
        goalId: "goal-map-root",
        artifactType: "bug",
        artifactRef: "bug:<img src=x onerror=alert(1)>",
        relationship: "blocks",
        state: "blocked",
        label: "Blocking <script>artifact</script>",
      },
      {
        id: "glink-map-release",
        goalId: "goal-map-child",
        artifactType: "release",
        artifactRef: "release:local",
        relationship: "delivers",
        state: "delivered",
        label: "Local release",
      },
    ],
    runIntents: [
      {
        runId: "run-map-active",
        title: "Active <iframe src='bad'> run",
        state: "running",
        phase: "editing",
        goalRefs: ["goal-map-root"],
      },
      {
        runId: "run-map-delivery",
        title: "Pending delivery",
        state: "pending_delivery",
        phase: "delivery",
        goalRefs: ["goal-map-child"],
      },
    ],
  };
}

test("escapes every HTML-sensitive character", () => {
  assert.equal(escapeHtml(`<&>\"'`), "&lt;&amp;&gt;&quot;&#39;");
});

test("builds a deterministic nested map with blockers, runs, artifacts, and delivered evidence", () => {
  const input = fixture();
  const data = buildGoalMapData("goal-map-root", input);
  const reversed = buildGoalMapData("goal-map-root", {
    goals: [...input.goals].reverse(),
    artifactLinks: [...input.artifactLinks].reverse(),
    runIntents: [...input.runIntents].reverse(),
  });

  assert.deepEqual(data, reversed);
  assert.equal(data.schema, "agent-manager.goal-map.v1");
  assert.equal(data.effectiveState, "blocked");
  assert.deepEqual(data.goals.map((goal) => goal.id), ["goal-map-root", "goal-map-child"]);
  assert.deepEqual(data.goals[0].children, ["goal-map-child"]);
  assert.deepEqual(data.blockers.map((item) => item.id), ["glink-map-blocker"]);
  assert.deepEqual(data.activeRuns.map((run) => run.id), ["run-map-active", "run-map-delivery"]);
  assert.ok(data.deliveredEvidence.some((item) => item.id === "glink-map-release"));
});

test("renders semantic responsive offline HTML and escapes all stored content", () => {
  const html = renderGoalMapHtml(buildGoalMapData("goal-map-root", fixture()));

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<main>/);
  assert.match(html, /aria-labelledby="blockers-heading"/);
  assert.match(html, /<ul class="goal-tree">/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /Map &lt;\/style&gt;&lt;script&gt;alert\(&#39;title&#39;\)&lt;\/script&gt;/);
  assert.match(html, /bug:&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<iframe\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /\bhttps?:\/\//i);
  assert.doesNotMatch(html, /@import/i);
});

test("exports one self-contained HTML file from a portable local brain", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-manager-goal-map-"));
  roots.push(temp);
  const root = join(temp, "brain");
  const outputPath = join(temp, "exports", "goal-map.html");
  await createGoal({
    id: "goal-export-root",
    title: "Export root",
    lifecycle: "delivered",
  }, { root });
  await linkGoalArtifact({
    id: "glink-export-release",
    goalId: "goal-export-root",
    artifactType: "release",
    artifactRef: "release:offline",
    relationship: "delivers",
    state: "delivered",
  }, { root });

  const result = await exportGoalMap("goal-export-root", { root, outputPath });
  assert.deepEqual(result, {
    schema: "agent-manager.goal-map-export.v1",
    goalId: "goal-export-root",
    effectiveState: "delivered",
    completedLeafRatio: {
      label: "completed-leaf ratio",
      numerator: 1,
      denominator: 1,
      value: 1,
    },
    outputPath,
  });
  const html = readFileSync(outputPath, "utf8");
  assert.match(html, /Export root/);
  assert.match(html, /release:offline/);
  assert.doesNotMatch(html, /<script\b/i);
});
