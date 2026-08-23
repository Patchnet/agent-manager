import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(process.cwd(), "bin", "agent-manager.mjs");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-director-cli-"));
  mkdirSync(join(root, "repo"));
  const policyPath = join(root, "policy.yaml");
  const itemsPath = join(root, "items.json");
  const stateRoot = join(root, "state");
  writeFileSync(policyPath, [
    "schema: agent-manager.director-policy.v1",
    "repository:",
    "  path: ./repo",
    "  base_ref: main",
    "director:",
    "  harness: codex",
    "  model: planning-model",
    "  reasoning: high",
    "autopilot:",
    "  enabled: true",
    "  mode: pr-only",
    "  source_filter: automation-ready",
    "  allowed_actions: [plan, run, review, commit, push, open-pr]",
    "  allowed_paths: [src/**]",
    "  forbidden_risks: [security]",
    "  max_items_per_cycle: 1",
    "  max_concurrency: 1",
    "  correction_limit: 1",
    "  on_blocker: quarantine-and-continue",
    "",
  ].join("\n"));
  writeFileSync(itemsPath, JSON.stringify({
    schema: "agent-manager.director-source-list.v1",
    items: [{
      schema: "agent-manager.director-source-item.v1",
      source: { provider: "fixture", item_id: "cli-one", ref: "fixture:cli-one" },
      repository: { path: "./repo", base_ref: "main", reviewed_base_sha: "b".repeat(40) },
      objective: "Exercise the CLI",
      acceptance_criteria: ["The dry cycle closes"],
      priority: 50,
      dependencies: [],
      automation_eligible: true,
      labels: ["automation-ready"],
      risks: [],
      scope: ["src/cli.mjs"],
      planning: {
        plan_ref: "plan:cli-one",
        verified_by: "cli-fixture",
        verified_at: "2026-08-08T12:00:00.000Z",
        repository_instruction_refs: ["AGENTS.md"],
        reviewed_paths: ["src/cli.mjs"],
      },
    }],
  }, null, 2));
  return { root, policyPath, itemsPath, stateRoot };
}

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

test("Director CLI validates policy and runs a fixture-backed dry cycle", () => {
  const fx = setup();
  try {
    const validation = JSON.parse(run([
      "director", "validate", "--policy", fx.policyPath, "--json",
    ]));
    assert.equal(validation.schema, "agent-manager.director-policy-validation.v1");
    assert.equal(validation.ok, true);
    assert.equal(validation.mode, "pr-only");
    assert.equal(validation.director.model, "planning-model");

    const cycle = JSON.parse(run([
      "director", "cycle", "--policy", fx.policyPath, "--items", fx.itemsPath,
      "--state-dir", fx.stateRoot, "--dry-run", "--json",
    ]));
    assert.equal(cycle.schema, "agent-manager.director-cycle.v1");
    assert.equal(cycle.status, "dry-run-complete");
    assert.equal(cycle.selected[0].sourceKey, "fixture:cli-one");
    assert.equal(cycle.director.harness, "codex");
    assert.equal(cycle.drafts.length, 1);
    assert.match(cycle.drafts[0].kickoff, /--detach/);

    const human = run([
      "director", "cycle", "--policy", fx.policyPath, "--items", fx.itemsPath,
      "--state-dir", fx.stateRoot, "--dry-run",
    ]);
    assert.match(human, /kickoff: agent-manager run/);
    assert.match(human, /proposal\/dry-run/);

    const replay = JSON.parse(run([
      "director", "dry-cycle", "--policy", fx.policyPath, "--items", fx.itemsPath,
      "--state-dir", fx.stateRoot, "--json",
    ]));
    assert.equal(replay.cycleId, cycle.cycleId);
    assert.equal(replay.replayed, true);
    assert.equal(replay.drafts.length, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Director CLI is discoverable and fails closed without policy or dry-run", () => {
  const help = run(["--help"]);
  assert.match(help, /agent-manager director validate/);
  assert.match(help, /agent-manager director cycle/);
  assert.match(help, /agent-manager director go/);

  const missingPolicy = spawnSync(process.execPath, [cli, "director", "validate", "--json"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true,
  });
  assert.notEqual(missingPolicy.status, 0);
  assert.match(missingPolicy.stderr, /Director policy is required/);

  const fx = setup();
  try {
    const liveCycle = spawnSync(process.execPath, [
      cli, "director", "cycle", "--policy", fx.policyPath, "--items", fx.itemsPath,
      "--state-dir", fx.stateRoot, "--json",
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
    assert.notEqual(liveCycle.status, 0);
    assert.match(liveCycle.stderr, /require --dry-run/);

    const goWithoutDetach = spawnSync(process.execPath, [
      cli, "director", "go", "--policy", fx.policyPath, "--items", fx.itemsPath,
      "--state-dir", fx.stateRoot, "--json",
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
    assert.notEqual(goWithoutDetach.status, 0);
    assert.match(goWithoutDetach.stderr, /director go requires --detach/);

    const goWithoutPolicy = spawnSync(process.execPath, [
      cli, "director", "go", "--policy", fx.policyPath, "--items", fx.itemsPath,
      "--state-dir", fx.stateRoot, "--detach", "--json",
    ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
    assert.notEqual(goWithoutPolicy.status, 0);
    assert.match(goWithoutPolicy.stderr, /requires an explicitly enabled automation_policy/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
