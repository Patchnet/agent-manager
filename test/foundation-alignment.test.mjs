import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import YAML from "yaml";
import { createDemo } from "../src/demo.mjs";
import { loadWorkflow } from "../src/workflow.mjs";
import { installHost } from "../src/install.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { inheritCorrectionBudget, canCorrect, assertReviewPass } from "../src/review-budget.mjs";
import { reconcileCorrectionParent } from "../src/reconcile.mjs";
import { isolatedRoot, isolatedEnv } from "../test-support/isolated-roots.mjs";
import { diagnoseHarnessFailure } from "../src/preflight.mjs";

test("startup permission errors have actionable diagnostics without weakening the sandbox", () => {
  const result = diagnoseHarnessFailure("codex", "Error: failed to initialize in-process app-server client: Access is denied. (os error 5)");
  assert.equal(result.code, "harness-startup-permission");
  assert.equal(result.retryUnchanged, false);
  assert.equal(diagnoseHarnessFailure("codex", "unit test failed"), null);
});

test("goal policy distinguishes legacy warnings, required goals and explicit small-task exemptions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "am-goal-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const demo = createDemo({ dir: join(root, "repo") });
  const doc = YAML.parse(readFileSync(demo.workflowPath, "utf8"));
  const load = () => { writeFileSync(demo.workflowPath, YAML.stringify(doc)); return loadWorkflow(demo.workflowPath); };
  assert.ok(load().lint_warnings.some((w) => w.code === "goal-alignment-inactive"));
  doc.goal_policy = "required";
  assert.throws(load, /needs goal_refs/);
  doc.goal_refs = ["goal-example"];
  assert.equal(load().goal_policy, "required");
  doc.goal_refs = []; doc.goal_policy = "exempt";
  assert.throws(load, /requires a reason/);
  doc.goal_exemption = "Isolated typo correction";
  assert.ok(!load().lint_warnings.some((w) => w.code === "goal-alignment-inactive"));
});

test("doctor detects edited skills even when the install version matches", (t) => {
  const home = mkdtempSync(join(tmpdir(), "am-alignment-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  installHost("codex", { home });
  let result = runDoctor({ home });
  assert.equal(result.activation.required, false);
  const path = join(home, ".codex", "skills", "pr-manager", "SKILL.md");
  writeFileSync(path, readFileSync(path, "utf8") + "\nLocal instruction\n");
  result = runDoctor({ home });
  assert.equal(result.versions.drift, true);
  assert.equal(result.aligned, false);
  assert.deepEqual(result.activation.commands, ["agent-manager install codex"]);
  assert.throws(() => installHost("codex", { home }), /review local changes/);
});

test("correction retries inherit consumed count, elapsed window and goal binding", () => {
  const parent = { runId: "run-parent", goalRefs: ["goal-example"], delivery: { review: { budget: { max_corrections: 1, max_elapsed_sec: 3600 }, history: [{ pass: 1, verdict: "revise", decidedAt: new Date().toISOString() }] } } };
  const child = { goalRefs: ["goal-example"], delivery: { review: {} } };
  inheritCorrectionBudget(child, parent);
  assert.equal(child.delivery.review.family.consumedCorrections, 1);
  assert.equal(canCorrect(child, 1), false);
  assert.doesNotThrow(() => assertReviewPass(child, 1));
  assert.throws(() => assertReviewPass(child, 2), /review pass/);
  assert.throws(() => inheritCorrectionBudget({ goalRefs: [], delivery: { review: {} } }, parent), /preserve parent goal/);
  parent.delivery.review.history[0].decidedAt = "2000-01-01T00:00:00Z";
  assert.throws(() => inheritCorrectionBudget(child, parent), /elapsed-time/);
});

test("correction closeout retires only the original snapshot and preserves review evidence", () => {
  const parent = { runId: "run-parent", state: "correction_pending", goalRefs: [], delivery: { review: { history: [{ pass: 1, verdict: "revise" }] } } };
  const child = { runId: "run-child", state: "ship_gate_pending", goalRefs: [], lineage: { parentRunId: parent.runId }, delivery: { review: { state: "accepted", family: { parentRunId: parent.runId, parentPass: 1 } } } };
  const options = { operator: "reviewer", authorityRef: "existing correction instruction" };
  const result = reconcileCorrectionParent(parent, child, options);
  assert.equal(result.state, "cancelled");
  assert.equal(result.delivery.state, "cancelled");
  assert.equal(parent.state, "correction_pending");
  assert.deepEqual(result.delivery.review, parent.delivery.review);
  assert.equal(result.correctionResolution.childRunId, child.runId);
  assert.equal(reconcileCorrectionParent(result, child, options), result);
  child.delivery.review.state = "pending";
  assert.throws(() => reconcileCorrectionParent(parent, child, options), /accepted child/);
});

test("claim preflight preserves unknown ownership and never writes the registry", (t) => {
  const root = isolatedRoot("claim-preflight-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claims = join(root, "claims"); mkdirSync(join(claims, "fixture"), { recursive: true });
  const file = join(claims, "fixture", "owner.json");
  const claim = { repo: "fixture", branch: "owner", scope: ["src/**"], claimed_at: "2000-01-01T00:00:00Z", owner_host: hostname(), owner_pid: 0 };
  const body = JSON.stringify(claim); writeFileSync(file, body);
  const result = spawnSync(process.execPath, ["tools/claim.mjs", "check", "--repo", "fixture", "--scope", "src/file.mjs"], { encoding: "utf8", windowsHide: true, env: isolatedEnv({ AGENT_MANAGER_CLAIMS_ROOT: claims }) });
  assert.equal(result.status, 2, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.claims[0].ownerActive, null);
  assert.equal(info.claims[0].recoverable, false);
  assert.equal(readFileSync(file, "utf8"), body);
});
