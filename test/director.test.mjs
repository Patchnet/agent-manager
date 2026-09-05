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

function enableShippingPolicy(fx) {
  fx.policy.autopilot.mode = "auto-merge";
  fx.policy.autopilot.allowed_actions.push("ship", "merge");
  fx.policy.automation_policy = {
    schema: "agent-manager.automation-policy.v1",
    enabled: true,
    repository: { path: "./repo", base_ref: "main" },
    approval: {
      level: "through-pr",
      operator: "director-operator",
      approved_at: "2026-08-23T12:00:00.000Z",
      expires_at: "2026-08-24T12:00:00.000Z",
    },
    risk: { observed: "moderate", ceiling: "moderate", classes: [], exceptions: [] },
    provider: { mode: "fixture-provider" },
    shipment: { commit_message: "feat: director approved change" },
    revocation: null,
  };
  writeFileSync(fx.policyPath, JSON.stringify(fx.policy, null, 2));
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

test("Director shipping cannot smuggle merge authority through pr-only mode", () => {
  const fx = fixture();
  try {
    enableShippingPolicy(fx);
    assert.equal(loadDirectorPolicy(fx.policyPath).autopilot.mode, "auto-merge");
    fx.policy.autopilot.mode = "pr-only";
    fx.policy.autopilot.allowed_actions = fx.policy.autopilot.allowed_actions.filter((action) => action !== "merge");
    writeFileSync(fx.policyPath, JSON.stringify(fx.policy));
    assert.throws(() => loadDirectorPolicy(fx.policyPath), /pr-only cannot grant merge/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("Director compiles worker effort/profile and zero correction budget", async () => {
  const fx = fixture();
  try {
    fx.policy.workers = { harness_default: "codex", model_default: "gpt-6-astra", harness_options: { effort: "high", profile: "coding" } };
    fx.policy.autopilot.correction_limit = 0;
    writeFileSync(fx.policyPath, JSON.stringify(fx.policy));
    writeItems(fx.itemsPath, [item("settings")]);
    const result = await runDirectorCycle({ policyPath: fx.policyPath, itemsPath: fx.itemsPath, stateRoot: fx.stateRoot, dryRun: true });
    const workflow = readFileSync(result.drafts[0].path, "utf8");
    assert.match(workflow, /max_corrections: 0/);
    assert.match(workflow, /effort: high/);
    assert.match(workflow, /profile: coding/);
    assert.equal(result.drafts[0].validateOk, true);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
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

test("dry cycle writes validated workflow drafts and kickoff commands", async () => {
  const fx = fixture();
  try {
    writeItems(fx.itemsPath, [
      item("selected", {
        priority: 90,
        scope: ["src/feature/**"],
        goal_refs: ["goal-am-feature"],
      }),
    ]);
    const result = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
    });
    assert.equal(result.drafts.length, 1);
    assert.equal(result.drafts[0].validateOk, true);
    assert.deepEqual(result.drafts[0].sourceKeys, ["fixture:selected"]);
    assert.match(result.drafts[0].kickoff, /agent-manager run .+ --detach/);
    assert.equal(existsSync(result.drafts[0].path), true);
    const workflow = readFileSync(result.drafts[0].path, "utf8");
    assert.match(workflow, /goal-am-feature/);
    assert.match(workflow, /harness_default:\s*claude/);
    assert.match(workflow, /classification:\s*operational/);
    assert.match(result.transitions.find((entry) => entry.to === "PLAN").decision, /wrote 1 validated workflow draft/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Director Node drafts compile deterministic lockfile setup before verification", async () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.repo, "package.json"), JSON.stringify({ scripts: { test: "tsc --noEmit" } }));
    writeFileSync(join(fx.repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    writeItems(fx.itemsPath, [item("node-workflow")]);
    const result = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
    });
    assert.equal(result.drafts[0].validateOk, true);
    const workflow = readFileSync(result.drafts[0].path, "utf8");
    assert.match(workflow, /setup:[\s\S]*command: npm[\s\S]*- ci[\s\S]*commands:[\s\S]*- test/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Director drafts carry a bounded review-to-ship policy without launching", async () => {
  const fx = fixture();
  try {
    enableShippingPolicy(fx);
    writeItems(fx.itemsPath, [item("authorized-draft")]);
    const result = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
    });
    const draft = result.drafts[0];
    assert.equal(result.status, "dry-run-complete");
    assert.equal(draft.validateOk, true);
    assert.equal(existsSync(draft.automationPolicy.path), true);
    assert.match(draft.automationPolicy.digest, /^[0-9a-f]{64}$/);
    assert.match(draft.review, /--reviewer-role manager --automation-policy/);
    const workflow = readFileSync(draft.path, "utf8");
    assert.match(workflow, /automation-policy:/);
    assert.match(workflow, /An independent accepting Delivery Review may materialize this policy/);
    assert.doesNotMatch(result.transitions.at(-1).decision, /launched|detached worker/i);

    const replay = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.drafts[0].automationPolicy.digest, draft.automationPolicy.digest);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Director go explicitly detaches one deterministic run into the shared review and ship path", async () => {
  const fx = fixture();
  try {
    enableShippingPolicy(fx);
    writeItems(fx.itemsPath, [item("go-run", { goal_refs: ["goal-director-go"] })]);
    const launches = [];
    const result = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      go: true,
      launchDraft: async (request) => {
        launches.push(request);
        return { state: "detached", telemetry: join(fx.stateRoot, `${request.runId}.status.json`) };
      },
    });
    assert.equal(result.status, "launched");
    assert.equal(result.go, true);
    assert.equal(result.dryRun, false);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].runId, result.launches[0].runId);
    assert.match(result.launches[0].runId, /^director-[0-9a-f]{24}$/);
    assert.deepEqual(result.transitions.map((entry) => entry.to), [
      "DISCOVER", "TRIAGE", "PLAN", "VALIDATE", "DETACH", "CLOSE",
    ]);
    assert.match(result.transitions.at(-1).decision, /independent Delivery Review.*shared shipment state machine/i);

    const replay = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      go: true,
      launchDraft: async () => {
        throw new Error("replay must not launch again");
      },
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.launches[0].runId, result.launches[0].runId);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("risk_exceptions admit scoped CodeQL-class security work", async () => {
  const fx = fixture();
  try {
    fx.policy.autopilot.allowed_paths = ["src/**", "test/**", "src/lib/security/**", "test/security/**"];
    fx.policy.autopilot.risk_exceptions = [{
      risk: "security",
      require_labels: ["codeql", "automation-ready"],
      allowed_paths: ["src/lib/security/**", "test/security/**"],
    }];
    writeFileSync(fx.policyPath, JSON.stringify(fx.policy, null, 2));
    writeItems(fx.itemsPath, [
      item("codeql", {
        priority: 95,
        risks: ["security"],
        labels: ["automation-ready", "codeql"],
        scope: ["src/lib/security/**", "test/security/**"],
        planning: {
          plan_ref: "plan:codeql",
          verified_by: "fixture-manager",
          verified_at: "2026-08-08T12:00:00.000Z",
          repository_instruction_refs: ["AGENTS.md"],
          reviewed_paths: ["src/lib/security/**"],
        },
      }),
      item("security-open", {
        priority: 90,
        risks: ["security"],
        labels: ["automation-ready"],
        scope: ["src/lib/security/**"],
      }),
    ]);
    const result = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
    });
    assert.deepEqual(result.selected.map((entry) => entry.sourceKey), ["fixture:codeql"]);
    assert.deepEqual(result.quarantined.map((entry) => entry.reason), ["forbidden-risk:security"]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("unknown source providers quarantine as connector-not-implemented", async () => {
  const fx = fixture();
  try {
    writeItems(fx.itemsPath, [
      item("from-jared", {
        source: { provider: "jared", item_id: "from-jared", ref: "jared:from-jared" },
      }),
    ]);
    const result = await runDirectorCycle({
      policyPath: fx.policyPath,
      itemsPath: fx.itemsPath,
      stateRoot: fx.stateRoot,
      dryRun: true,
    });
    assert.equal(result.selected.length, 0);
    assert.deepEqual(result.quarantined.map((entry) => entry.reason), [
      "connector-not-implemented:jared",
    ]);
    assert.equal(result.drafts.length, 0);
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
