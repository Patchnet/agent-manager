import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-planning-"));
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "README.md"), "fixture\n");
writeFileSync(join(repo, "context.md"), "One frozen contract for every lane.\n");
execFileSync("git", ["init", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "add", "README.md", "context.md"]);
execFileSync("git", [
  "-C", repo,
  "-c", "user.name=Test",
  "-c", "user.email=test@example.invalid",
  "commit", "-m", "base",
]);
const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
process.env.AGENT_MANAGER_DEV_ROOT = root;

const { assertPlanningReady } = await import("../src/planning.mjs?planning-test");
const { lanePrompt, loadWorkflow } = await import("../src/workflow.mjs?planning-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function planning(overrides = {}) {
  return {
    source_refs: ["source-one"],
    plan_ref: "plan-one",
    context_file: "context.md",
    reviewed_base_sha: base,
    verified_by: "manager-one",
    verified_at: "2026-01-01T00:00:00Z",
    reviewed_paths: ["README.md"],
    repository_instruction_refs: ["fixture instructions"],
    attestations: {
      source_reviewed: true,
      repository_instructions_reviewed: true,
      relevant_code_reviewed: true,
      scope_verified: true,
    },
    ...overrides,
  };
}

function workflow(name, planningValue, laneOverrides = {}, workflowOverrides = {}) {
  if (arguments.length < 2) planningValue = planning();
  const path = join(root, `${name}.json`);
  const doc = {
    repo: "repo",
    planning: planningValue,
    lanes: [{ id: "one", scope: "README.md", prompt: "Do the lane work.", ...laneOverrides }],
    ...workflowOverrides,
  };
  if (planningValue === undefined) delete doc.planning;
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return loadWorkflow(path);
}

test("planning evidence validates the immutable base and prefixes every lane prompt", () => {
  const loaded = workflow("valid");
  const evidence = assertPlanningReady(loaded);
  assert.equal(evidence.state, "verified");
  assert.equal(evidence.reviewedBaseSha, base);
  assert.match(evidence.contextDigest, /^[0-9a-f]{64}$/);
  const prompt = lanePrompt(loaded.lanes[0], loaded);
  assert.match(prompt, /## Verified shared planning context/);
  assert.match(prompt, /One frozen contract for every lane/);
  assert.match(prompt, new RegExp(evidence.contextDigest));
  assert.match(prompt, /## Lane assignment/);
  assert.match(prompt, /## Host runtime \(automatic; authoritative\)/);
  assert.match(prompt, new RegExp(loaded.runtime.hostPlatform));
  loaded.awareness = { context: "## Agent Manager cross-run awareness\n- Related run: run-example" };
  assert.match(lanePrompt(loaded.lanes[0], loaded), /Related run: run-example/);
  loaded.goalContext = { context: "## Agent Manager goal context\n    {\"refs\":[\"goal-example\"]}" };
  assert.match(lanePrompt(loaded.lanes[0], loaded), /goal-example/);
});

test("workflow normalizes optional goal references and preserves legacy omission", () => {
  assert.deepEqual(workflow("legacy-goals").goal_refs, []);
  const loaded = workflow("goal-refs", planning(), {}, {
    goal_refs: ["goal-zeta", "goal-alpha"],
  });
  assert.deepEqual(loaded.goal_refs, ["goal-alpha", "goal-zeta"]);
  assert.throws(
    () => workflow("goal-refs-type", planning(), {}, { goal_refs: "goal-alpha" }),
    /goal_refs must be an array/,
  );
  assert.throws(
    () => workflow("goal-refs-duplicate", planning(), {}, { goal_refs: ["goal-alpha", "goal-alpha"] }),
    /must not contain duplicate/,
  );
  assert.throws(
    () => workflow("goal-refs-invalid", planning(), {}, { goal_refs: ["not-a-goal"] }),
    /valid local goal ID/,
  );
});

test("planning accepts inline private context without creating repository files", () => {
  const loaded = workflow("inline", planning({
    context: "Private inline packet.\n",
    context_file: undefined,
  }));
  const evidence = assertPlanningReady(loaded);
  assert.equal(evidence.contextFile, "<inline>");
  assert.match(lanePrompt(loaded.lanes[0], loaded), /Private inline packet/);
});

test("expected output preflight catches extension patterns that do not cover the file", () => {
  assert.throws(
    () => workflow("tsx-mismatch", planning(), {
      scope: ["test/projects-*.test.ts"],
      expected_outputs: ["test/projects-pane.test.tsx"],
    }),
    /not covered by its scope/,
  );
});

test("planning gate rejects missing, incomplete, stale, and escaping context", () => {
  assert.throws(
    () => assertPlanningReady(workflow("missing", undefined)),
    /planning preflight is required/,
  );
  assert.throws(
    () => assertPlanningReady(workflow("incomplete", planning({
      attestations: { ...planning().attestations, scope_verified: false },
    }))),
    /scope_verified/,
  );
  assert.throws(
    () => assertPlanningReady(workflow("stale", planning({
      reviewed_base_sha: "0".repeat(40),
    }))),
    /planning base is stale/,
  );
  assert.throws(
    () => workflow("escape", planning({ context_file: "../outside.md" })),
    /escapes its configured root/,
  );
  assert.throws(
    () => workflow("bad-date", planning({ verified_at: "2026-01-01" })),
    /ISO date-time/,
  );
});
