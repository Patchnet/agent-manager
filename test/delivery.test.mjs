import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-delivery-"));
const repo = join(root, "repo");
const runsRoot = join(root, "runs");
const brainRoot = join(root, "brain");
mkdirSync(repo, { recursive: true });
mkdirSync(runsRoot, { recursive: true });
writeFileSync(join(repo, "README.md"), "fixture\n");
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
process.env.AGENT_MANAGER_BRAIN_ROOT = brainRoot;

const {
  createDeliveryStatus,
  deliveryReadiness,
  markWorkersComplete,
  recordFiled,
  recordMergedTarget,
  recordRelease,
  recordReviewDecision,
  staleGoalHints,
} = await import("../src/delivery.mjs?delivery-test");
const { loadWorkflow } = await import("../src/workflow.mjs?delivery-test");
const {
  closeoutRun,
  fileRunArtifacts,
  runArtifactBundleRoot,
} = await import("../src/review.mjs?delivery-test");
const { readStatus, writeStatus } = await import("../src/status.mjs?delivery-test");
const { createGoal, listGoalArtifactLinks } = await import("../src/goals.mjs?delivery-test");
const { deriveOperatorCadence } = await import("../src/cadence.mjs?delivery-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function workflowFile(name, value) {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

test("multi-lane writable workflows require an explicit delivery train when integration is off", () => {
  const lanes = [
    { id: "api", scope: "src/api/**", prompt: "api" },
    { id: "ui", scope: "src/ui/**", prompt: "ui" },
  ];
  assert.throws(
    () => loadWorkflow(workflowFile("missing-train", { repo: "repo", integrate: false, lanes })),
    /require workflow\.delivery\.targets/,
  );
  const loaded = loadWorkflow(workflowFile("train", {
    repo: "repo",
    target_dev_flow: "formal",
    integrate: false,
    delivery: {
      mode: "train",
      release_required: true,
      targets: [
        { id: "api-pr", lane: "api", branch: "feature/api", base: "main", pr: 10 },
        { id: "ui-pr", lane: "ui", branch: "feature/ui", base: "main", pr: 11 },
      ],
    },
    lanes,
  }));
  assert.equal(loaded.delivery.mode, "train");
  assert.deepEqual(loaded.delivery.targets.map((target) => target.lane), ["api", "ui"]);
  assert.equal(loaded.delivery.release_required, true);
});

test("review and approved no-change lanes are excluded from the delivery manifest", () => {
  const loaded = loadWorkflow(workflowFile("mixed-delivery", {
    repo: "repo",
    target_dev_flow: "formal",
    integrate: false,
    lanes: [
      { id: "review", kind: "review", scope: "README.md", prompt: "review" },
      { id: "advisory", kind: "implementation", allow_no_changes: true, scope: "notes/**", prompt: "inspect" },
      { id: "code", kind: "implementation", scope: "src/**", prompt: "implement" },
    ],
  }));
  assert.equal(loaded.delivery.mode, "single");
  assert.deepEqual(loaded.delivery.targets.map((target) => target.lane), ["code"]);
});

test("worker completion cannot become delivery completion without a persisted review and merge evidence", () => {
  const laneStates = [
    { id: "api", branch: "am/run/api", worktree: "api-wt", changedFiles: ["src/api/a.ts"] },
    { id: "ui", branch: "am/run/ui", worktree: "ui-wt", changedFiles: ["src/ui/a.tsx"] },
  ];
  const workflow = {
    base_ref: "origin/main",
    remote: "origin",
    delivery: {
      mode: "train",
      release_required: true,
      targets: [
        { id: "api-pr", lane: "api", branch: "feature/api", base: "main", pr: "10" },
        { id: "ui-pr", lane: "ui", branch: "feature/ui", base: "main", pr: "11" },
      ],
    },
  };
  const status = {
    runId: "run-delivery",
    state: "running",
    lanes: laneStates,
    delivery: createDeliveryStatus(workflow, laneStates),
    endedAt: null,
  };

  markWorkersComplete(status, "2026-08-01T00:00:00.000Z");
  assert.equal(status.state, "delivery_review_pending");
  assert.equal(status.endedAt, null);
  assert.equal(status.delivery.targets[0].state, "changes_ready");
  assert.equal(deliveryReadiness(status).ready, false);

  recordReviewDecision(status, {
    pass: 1,
    verdict: "accept-with-notes",
    reviewer: "master-dev",
    notes: "CI must run on each PR",
    at: "2026-08-01T00:01:00.000Z",
  });
  assert.equal(status.state, "ship_gate_pending");
  assert.equal(status.delivery.state, "ship_gate_pending");
  assert.equal(status.delivery.review.state, "accepted");

  recordMergedTarget(status, {
    targetId: "api-pr",
    prUrl: "https://example.invalid/pull/10",
    mergeSha: "a".repeat(40),
    at: "2026-08-01T00:02:00.000Z",
  });
  assert.equal(status.state, "ship_gate_pending");
  recordMergedTarget(status, {
    targetId: "ui-pr",
    prUrl: "https://example.invalid/pull/11",
    mergeSha: "b".repeat(40),
    at: "2026-08-01T00:03:00.000Z",
  });
  assert.equal(status.state, "release_pending");
  assert.equal(deliveryReadiness(status, { require: "merged" }).ready, true);
  assert.equal(deliveryReadiness(status, { require: "released" }).ready, false);

  recordRelease(status, {
    sha: "c".repeat(40),
    tag: "v1.2.3",
    verifiedMergeShas: ["a".repeat(40), "b".repeat(40)],
    at: "2026-08-01T00:04:00.000Z",
  });
  assert.equal(status.state, "released");
  assert.equal(deliveryReadiness(status).ready, true);
  assert.equal(status.delivery.release.verifiedMergeShas.length, 2);
});

test("Delivery Review permits one correction decision and one final pass", () => {
  const status = {
    runId: "run-review-loop",
    state: "delivery_review_pending",
    lanes: [],
    delivery: createDeliveryStatus({ delivery: { mode: "review-only", targets: [] } }, []),
  };
  markWorkersComplete(status);
  assert.throws(() => recordReviewDecision(status, {
    pass: 2,
    verdict: "accept",
    reviewer: "master-dev",
  }), /requires a recorded pass 1 correction/);
  recordReviewDecision(status, {
    pass: 1,
    verdict: "revise",
    reviewer: "master-dev",
  });
  assert.equal(status.state, "correction_pending");
  assert.throws(() => recordReviewDecision(status, {
    pass: 2,
    verdict: "revise",
    reviewer: "master-dev",
  }), /must accept, accept-with-notes, or reject/);
  recordReviewDecision(status, {
    pass: 2,
    verdict: "accept",
    reviewer: "master-dev",
  });
  assert.equal(status.state, "reviewed");
  assert.equal(status.delivery.state, "reviewed");
});

function acceptedShipGateStatus(runId) {
  const laneStates = [{
    id: "research",
    branch: `am/${runId}/research`,
    worktree: join(root, `${runId}-wt`),
    changedFiles: ["docs/research.md"],
  }];
  const status = {
    runId,
    state: "running",
    repo,
    lanes: laneStates,
    delivery: createDeliveryStatus({
      base_ref: "origin/main",
      remote: "origin",
      delivery: {
        mode: "single",
        targets: [{ id: "research-pr", lane: "research", branch: "feature/research", base: "main" }],
      },
    }, laneStates),
    endedAt: null,
  };
  markWorkersComplete(status, "2026-08-08T00:00:00.000Z");
  recordReviewDecision(status, {
    pass: 1,
    verdict: "accept",
    reviewer: "master-dev",
    at: "2026-08-08T00:01:00.000Z",
  });
  assert.equal(status.state, "ship_gate_pending");
  return status;
}

test("accepted work that will not be shipped ends in filed, not cancelled", () => {
  const status = acceptedShipGateStatus("run-filed-terminal");

  recordFiled(status, {
    operator: "master-dev",
    reason: "research accepted; nothing to ship",
    at: "2026-08-08T00:02:00.000Z",
  });
  assert.equal(status.state, "filed");
  assert.equal(status.delivery.state, "filed");
  assert.equal(status.endedAt, "2026-08-08T00:02:00.000Z");
  assert.deepEqual(status.delivery.filed.unshippedTargets, ["research-pr"]);
  assert.equal(deriveOperatorCadence(status).transition, "TERMINAL");
  // Filing is a terminal outcome, not a merged or released delivery.
  assert.equal(deliveryReadiness(status, { require: "merged" }).ready, false);
  assert.equal(deliveryReadiness(status).ready, false);
});

test("filing refuses an unaccepted run, a wrong state, and merged work", () => {
  const unreviewed = acceptedShipGateStatus("run-filed-guards");
  unreviewed.delivery.review.state = "awaiting_operator";
  assert.throws(
    () => recordFiled(unreviewed, { operator: "master-dev" }),
    /requires a persisted accepted Delivery Review/,
  );

  const accepted = acceptedShipGateStatus("run-filed-guards-2");
  assert.throws(() => recordFiled(accepted, { operator: "" }), /requires an operator id/);

  // A half-shipped train must be finished, not filed: the first merge is real.
  const laneStates = [
    { id: "api", branch: "am/train/api", worktree: "api-wt", changedFiles: ["src/api/a.ts"] },
    { id: "ui", branch: "am/train/ui", worktree: "ui-wt", changedFiles: ["src/ui/a.tsx"] },
  ];
  const train = {
    runId: "run-filed-guards-train",
    state: "running",
    repo,
    lanes: laneStates,
    delivery: createDeliveryStatus({
      base_ref: "origin/main",
      remote: "origin",
      delivery: {
        mode: "train",
        targets: [
          { id: "api-pr", lane: "api", branch: "feature/api", base: "main" },
          { id: "ui-pr", lane: "ui", branch: "feature/ui", base: "main" },
        ],
      },
    }, laneStates),
    endedAt: null,
  };
  markWorkersComplete(train, "2026-08-08T00:00:00.000Z");
  recordReviewDecision(train, {
    pass: 1,
    verdict: "accept",
    reviewer: "master-dev",
    at: "2026-08-08T00:01:00.000Z",
  });
  recordMergedTarget(train, {
    targetId: "api-pr",
    prUrl: "https://example.invalid/pull/1",
    mergeSha: "d".repeat(40),
    at: "2026-08-08T00:03:00.000Z",
  });
  assert.equal(train.state, "ship_gate_pending");
  assert.throws(
    () => recordFiled(train, { operator: "master-dev" }),
    /already merged api-pr/,
  );
});

test("stale goal references are hinted at terminal delivery and never advanced", () => {
  const status = acceptedShipGateStatus("run-filed-hints");
  status.goalRefs = ["goal-open", "goal-done", "goal-unknown"];
  status.goals = {
    goals: [
      { id: "goal-open", title: "Still open", lifecycle: "active" },
      { id: "goal-done", title: "Already delivered", lifecycle: "delivered" },
    ],
  };
  recordFiled(status, { operator: "master-dev", at: "2026-08-08T00:02:00.000Z" });

  assert.deepEqual(staleGoalHints(status).map((hint) => [hint.id, hint.lifecycle]), [
    ["goal-open", "active"],
    ["goal-unknown", "unknown"],
  ]);
  const cadence = deriveOperatorCadence(status);
  assert.deepEqual(cadence.goalHints.map((hint) => hint.id), ["goal-open", "goal-unknown"]);
  assert.match(cadence.nextAction, /goal-open \(active\)/);
  // Lifecycles are reported, never rewritten.
  assert.equal(status.goals.goals[0].lifecycle, "active");
});

test("closeout files run outputs into the brain and links them to every declared goal", async () => {
  const runId = "run-filed-closeout";
  const status = acceptedShipGateStatus(runId);
  await createGoal({ id: "goal-closeout", title: "Closeout goal", lifecycle: "active" });
  status.goalRefs = ["goal-closeout"];
  status.goals = { goals: [{ id: "goal-closeout", title: "Closeout goal", lifecycle: "active" }] };
  status.lanes[0].expectedOutputs = ["docs/research.md", "docs/missing.md"];
  mkdirSync(join(status.lanes[0].worktree, "docs"), { recursive: true });
  writeFileSync(join(status.lanes[0].worktree, "docs", "research.md"), "# findings\n");
  writeStatus(runId, status);

  const filed = await closeoutRun(runId, {
    operator: "master-dev",
    reason: "accepted research; nothing to ship",
  });
  assert.equal(filed.state, "filed");
  assert.equal(filed.closeout.state, "filed");
  assert.deepEqual(filed.goalHints.map((hint) => hint.id), ["goal-closeout"]);

  const bundleRoot = runArtifactBundleRoot(runId);
  assert.equal(filed.closeout.bundleRoot, bundleRoot);
  assert.equal(existsSync(join(bundleRoot, "report.md")), true);
  assert.equal(existsSync(join(bundleRoot, "lanes", "research", "docs", "research.md")), true);
  const manifest = JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.runState, "filed");
  assert.equal(manifest.artifactRef, `run-artifact:${runId}`);
  assert.equal(
    manifest.artifacts.some((artifact) => artifact.path === "lanes/research/docs/research.md"),
    true,
  );
  assert.equal(manifest.artifacts.every((artifact) => /^[0-9a-f]{64}$/.test(artifact.sha256)), true);
  assert.equal(manifest.warnings.some((warning) => warning.includes("docs/missing.md")), true);

  const links = await listGoalArtifactLinks({ goalId: "goal-closeout" });
  assert.equal(links.length, 1);
  assert.equal(links[0].artifactRef, `run-artifact:${runId}`);
  assert.equal(links[0].state, "delivered");
  assert.deepEqual(filed.closeout.links.map((link) => link.action), ["created"]);

  // Re-filing refreshes the existing link instead of duplicating it.
  const refiled = await fileRunArtifacts(runId);
  assert.deepEqual(refiled.links.map((link) => link.action), ["updated"]);
  assert.equal((await listGoalArtifactLinks({ goalId: "goal-closeout" })).length, 1);

  const persisted = readStatus(runId);
  assert.equal(persisted.state, "filed");
  assert.equal(persisted.closeout.artifactRef, `run-artifact:${runId}`);
  assert.match(
    readFileSync(join(runsRoot, runId, "report.md"), "utf8"),
    /goals awaiting advancement:.*goal-closeout \(active\)/,
  );
});
