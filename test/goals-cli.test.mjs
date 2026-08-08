import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-goals-cli-"));
const cli = join(process.cwd(), "bin", "agent-manager.mjs");
const env = {
  ...process.env,
  AGENT_MANAGER_BRAIN_ROOT: join(root, "brain"),
};

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
});

test("goal CLI is discoverable and rejects missing local goals", () => {
  const help = run(["--help"]);
  assert.match(help, /agent-manager goals/);
  assert.match(help, /agent-manager goal create/);
  assert.match(help, /agent-manager goal link/);
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
