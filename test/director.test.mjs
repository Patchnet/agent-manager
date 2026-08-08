import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRepositoryLease,
  loadDirectorPolicy,
  runDirectorCycle,
} from "../src/director/index.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-director-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const policyPath = join(root, "policy.json");
  const itemsPath = join(root, "items.json");
  const stateRoot = join(root, "state");
  const policy = {
    schema: "agent-manager.director-policy.v1",
    repository: { path: "./repo", base_ref: "main" },
    director: { harness: "codex", model: "planning-model", reasoning: "high" },
    autopilot: {
      enabled: true,
      mode: "pr-only",
      source_filter: "automation-ready",
      allowed_actions: ["plan", "run", "review", "commit", "push", "open-pr"],
      allowed_paths: ["src/**", "test/**", "docs/**"],
      forbidden_risks: ["security", "authentication", "billing"],
      max_items_per_cycle: 1,
      max_concurrency: 2,
      correction_limit: 1,
      on_blocker: "quarantine-and-continue",
    },
  };
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  return { root, repo, policy, policyPath, itemsPath, stateRoot };
}

function item(id, overrides = {}) {
  const base = {
    schema: "agent-manager.director-source-item.v1",
    source: { provider: "fixture", item_id: id, ref: `fixture:${id}` },
    repository: { path: "./repo", base_ref: "main", reviewed_base_sha: "a".repeat(40) },
    objective: `Implement ${id}`,
    acceptance_criteria: [`${id} is verified`],
    priority: 50,
    dependencies: [],
    automation_eligible: true,
    labels: ["automation-ready"],
    risks: [],
    scope: ["src/feature.mjs"],
    planning: {
      plan_ref: `plan:${id}`,
      verified_by: "fixture-manager",
      verified_at: "2026-08-08T12:00:00.000Z",
      repository_instruction_refs: ["AGENTS.md"],
      reviewed_paths: ["src/feature.mjs"],
    },
  };
  return {
    ...base,
    ...overrides,
    source: { ...base.source, ...(overrides.source || {}) },
    repository: { ...base.repository, ...(overrides.repository || {}) },
    planning: { ...base.planning, ...(overrides.planning || {}) },
  };
}

function writeItems(path, items) {
  writeFileSync(path, JSON.stringify({
    schema: "agent-manager.director-source-list.v1",
    items,
  }, null, 2));
}

test("Director policy fails closed outside the pr-only boundary", () => {
  const fx = fixture();
  try {
    const loaded = loadDirectorPolicy(fx.policyPath);
    assert.equal(loaded.director.harness, "codex");
    assert.equal(loaded.director.model, "planning-model");
    assert.equal(loaded.autopilot.mode, "pr-only");
    assert.match(loaded.digest, /^[0-9a-f]{64}$/);

    fx.policy.autopilot.allowed_actions.push("merge");
    writeFileSync(fx.policyPath, JSON.stringify(fx.policy, null, 2));
    assert.throws(() => loadDirectorPolicy(fx.policyPath), /pr-only policy forbids action: merge/);

    fx.policy.autopilot.allowed_actions.pop();
    fx.policy.autopilot.allowed_paths = ["src/../infra/**"];
    writeFileSync(fx.policyPath, JSON.stringify(fx.policy, null, 2));
    assert.throws(() => loadDirectorPolicy(fx.policyPath), /repository-relative path or glob/);

    delete fx.policy.autopilot;
    writeFileSync(fx.policyPath, JSON.stringify(fx.policy, null, 2));
    assert.throws(() => loadDirectorPolicy(fx.policyPath), /autopilot must be a mapping/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("dry cycle triages deterministically, persists transitions, and replays idempotently", async () => {
  const fx = fixture();
  try {
    writeItems(fx.itemsPath, [
      item("lower-priority", { priority: 20, scope: ["docs/guide.md"] }),
      item("selected", { priority: 90, scope: ["src/feature/**"] }),
      item("unsafe", { priority: 100, risks: ["security"] }),
      item("not-ready", { priority: 80, labels: ["manual-review"] }),
    ]);
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 7, 8, 12, 0, tick++));
    const result = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
      now,
    });
    assert.equal(result.status, "dry-run-complete");
    assert.equal(result.replayed, false);
    assert.deepEqual(result.selected.map((entry) => entry.sourceKey), ["fixture:selected"]);
    assert.deepEqual(result.quarantined.map((entry) => entry.sourceKey), ["fixture:unsafe"]);
    assert.deepEqual(result.skipped.map((entry) => entry.sourceKey), [
      "fixture:not-ready",
      "fixture:lower-priority",
    ]);
    assert.deepEqual(result.transitions.map((entry) => entry.to), [
      "DISCOVER", "TRIAGE", "PLAN", "VALIDATE", "CLOSE",
    ]);
    assert.equal(existsSync(result.statePath), true);
    const state = JSON.parse(readFileSync(result.statePath, "utf8"));
    assert.equal(state.schema, "agent-manager.director-state.v1");
    assert.equal(state.phase, "CLOSE");
    assert.equal(state.status, "dry-run-complete");
    assert.equal(state.director.model, "planning-model");
    assert.match(state.items.selected[0].idempotencyKeys[1], /^run-create:/);

    const replay = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
      now: () => new Date("2027-01-01T00:00:00.000Z"),
    });
    assert.equal(replay.cycleId, result.cycleId);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.transitions, result.transitions);

    rmSync(join(fx.stateRoot, "cycles", result.cycleId, "cycle.json"));
    const resumedFromState = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
    });
    assert.equal(resumedFromState.replayed, true);
    assert.deepEqual(resumedFromState.transitions, result.transitions);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("dry cycle quarantines repository, base, risk, and scope policy violations", async () => {
  const fx = fixture();
  try {
    const otherRepo = join(fx.root, "other");
    mkdirSync(otherRepo);
    writeItems(fx.itemsPath, [
      item("repo", { repository: { path: "./other" } }),
      item("base", { repository: { base_ref: "release" } }),
      item("risk", { risks: ["billing"] }),
      item("scope", { scope: ["infra/deploy.yml"] }),
    ]);
    const result = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
    });
    assert.equal(result.selected.length, 0);
    assert.deepEqual(result.quarantined.map((entry) => entry.reason).sort(), [
      "base-ref-outside-policy",
      "forbidden-risk:billing",
      "repository-outside-policy",
      "scope-outside-policy:infra/deploy.yml",
    ]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Director cycle refuses execution and repository leases are exclusive", async () => {
  const fx = fixture();
  try {
    writeItems(fx.itemsPath, [item("one")]);
    await assert.rejects(
      runDirectorCycle({ policyPath: fx.policyPath, itemsPath: fx.itemsPath, stateRoot: fx.stateRoot }),
      /require --dry-run/,
    );
    const first = acquireRepositoryLease({
      stateRoot: fx.stateRoot,
      repoRoot: fx.repo,
      cycleId: "cycle-one",
    });
    assert.throws(
      () => acquireRepositoryLease({ stateRoot: fx.stateRoot, repoRoot: fx.repo, cycleId: "cycle-two" }),
      (error) => error.code === "DIRECTOR_REPOSITORY_LEASE_HELD",
    );
    assert.equal(first.release(), true);
    const second = acquireRepositoryLease({
      stateRoot: fx.stateRoot,
      repoRoot: fx.repo,
      cycleId: "cycle-two",
    });
    assert.equal(second.release(), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
