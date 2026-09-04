import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, isolatedRoot } from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("goals-cli-");
const cli = join(process.cwd(), "bin", "agent-manager.mjs");
// isolatedEnv drops ambient roots outright, so the CLI child cannot fall back
// to the operator's brain for anything this file does not name.
const env = isolatedEnv({ AGENT_MANAGER_BRAIN_ROOT: join(root, "brain") });

test.after(() => rmSync(root, { recursive: true, force: true }));

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function json(args) {
  return JSON.parse(run([...args, "--json"]));
}

test("goal CLI creates, updates, lists, shows, inspects, and links goals", () => {
  const parent = json([
    "goal", "create", "--id", "goal-cli-parent", "--title", "CLI parent",
    "--outcome", "Operators manage goals locally.", "--success-criterion", "Commands are deterministic.",
  ]);
  assert.equal(parent.schema, "agent-manager.goal-write.v1");
  assert.equal(parent.operation, "create");
  assert.equal(parent.goal.id, "goal-cli-parent");

  json(["goal", "create", "--id", "goal-cli-dependency", "--title", "Dependency"]);
  const child = json([
    "goal", "create", "--id", "goal-cli-child", "--title", "CLI child",
    "--parent", "goal-cli-parent", "--depends-on", "goal-cli-dependency",
    "--source-ref", "plan:public-example",
  ]);
  assert.equal(child.goal.parentId, "goal-cli-parent");
  assert.deepEqual(child.goal.dependencies, ["goal-cli-dependency"]);

  const updated = json([
    "goal", "update", "goal-cli-child", "--lifecycle", "active",
    "--outcome", "The CLI slice is active.", "--clear-source-refs",
  ]);
  assert.equal(updated.operation, "update");
  assert.equal(updated.goal.lifecycle, "active");
  assert.deepEqual(updated.goal.externalSourceRefs, []);

  const linked = json([
    "goal", "link", "goal-cli-child", "--link-id", "glink-cli-plan",
    "--type", "plan", "--ref", "plan:public-example", "--relationship", "supports",
    "--state", "active", "--label", "Public example plan",
  ]);
  assert.equal(linked.schema, "agent-manager.goal-link.v1");
  assert.equal(linked.link.goalId, "goal-cli-child");
  assert.equal(linked.link.artifactType, "plan");

  const all = json(["goals"]);
  assert.equal(all.schema, "agent-manager.goals-list.v1");
  assert.deepEqual(all.goals.map((goal) => goal.id), [
    "goal-cli-child",
    "goal-cli-dependency",
    "goal-cli-parent",
  ]);
  const roots = json(["goals", "--roots"]);
  assert.deepEqual(roots.goals.map((goal) => goal.id), ["goal-cli-dependency", "goal-cli-parent"]);
  const children = json(["goals", "--parent", "goal-cli-parent"]);
  assert.deepEqual(children.goals.map((goal) => goal.id), ["goal-cli-child"]);

  const shown = json(["goal", "show", "goal-cli-child"]);
  assert.equal(shown.schema, "agent-manager.goal-detail.v1");
  assert.equal(shown.goal.lifecycle, "active");
  assert.deepEqual(shown.artifactLinks.map((link) => link.id), ["glink-cli-plan"]);
  const inspected = json(["goal", "inspect", "goal-cli-parent"]);
  assert.deepEqual(inspected.children.map((goal) => goal.id), ["goal-cli-child"]);

  const status = json(["goal", "status", "goal-cli-parent"]);
  assert.equal(status.schema, "agent-manager.goal-progress.v1");
  assert.equal(status.goalId, "goal-cli-parent");
  assert.equal(status.effectiveState, "active");
  assert.deepEqual(status.completedLeafRatio, {
    label: "completed-leaf ratio",
    numerator: 0,
    denominator: 1,
    value: 0,
  });
  const statusText = run(["goal", "status", "goal-cli-parent"]);
  assert.match(statusText, /completed-leaf ratio: 0\/1/);
  assert.match(statusText, /decisive evidence:/);

  const outputPath = join(root, "exports", "cli-goal-map.html");
  const exported = json(["goal", "map", "goal-cli-parent", "--output", outputPath]);
  assert.equal(exported.schema, "agent-manager.goal-map-export.v1");
  assert.equal(exported.goalId, "goal-cli-parent");
  assert.equal(exported.outputPath, outputPath);
  assert.equal(existsSync(outputPath), true);
  assert.match(run(["goal", "map", "goal-cli-parent", "--output", outputPath]), /goal map: .*cli-goal-map\.html/);
  const html = readFileSync(outputPath, "utf8");
  assert.match(html, /CLI parent/);
  assert.match(html, /CLI child/);
  assert.match(html, /Public example plan/);
  assert.doesNotMatch(html, /<script\b/i);
});

test("goal CLI is discoverable and rejects missing local goals", () => {
  const help = run(["--help"]);
  assert.match(help, /agent-manager goals/);
  assert.match(help, /agent-manager goal create/);
  assert.match(help, /agent-manager goal link/);
  assert.match(help, /agent-manager goal status/);
  assert.match(help, /agent-manager goal map/);
  const missing = spawnSync(process.execPath, [
    cli, "goal", "show", "goal-does-not-exist", "--json",
  ], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /GOAL_NOT_FOUND|goal not found/);
});

test("reconcile CLI repairs terminal goal history and replays without mutation", () => {
  json(["goal", "create", "--id", "goal-cli-repair", "--title", "CLI repair", "--lifecycle", "active"]);
  const runId = "run-cli-goal-repair";
  const runRoot = join(env.AGENT_MANAGER_RUNS_ROOT, runId);
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, "status.json"), JSON.stringify({
    runId,
    repo: "fixture",
    state: "failed",
    startedAt: "2026-09-01T10:00:00.000Z",
    endedAt: "2026-09-01T11:00:00.000Z",
    updatedAt: "2026-09-01T11:00:00.000Z",
    goalRefs: ["goal-cli-repair"],
    goals: { goals: [{ id: "goal-cli-repair", title: "CLI repair", lifecycle: "active" }] },
    lanes: [],
  }, null, 2) + "\n");

  const command = [
    "reconcile", runId,
    "--goal-disposition", "goal-cli-repair=delivered",
    "--operator", "master-dev",
    "--reason", "accepted recovery",
  ];
  const repaired = json(command);
  assert.equal(repaired.goalReconciliation.state, "settled");
  assert.equal(repaired.goalReconciliation.dispositions[0].lifecycle, "delivered");
  const afterFirst = readFileSync(join(runRoot, "status.json"), "utf8");
  const goalAfterFirst = json(["goal", "show", "goal-cli-repair"]).goal;

  const replayed = json(command);
  assert.deepEqual(replayed, repaired);
  assert.equal(readFileSync(join(runRoot, "status.json"), "utf8"), afterFirst);
  assert.equal(json(["goal", "show", "goal-cli-repair"]).goal.version, goalAfterFirst.version);
});
