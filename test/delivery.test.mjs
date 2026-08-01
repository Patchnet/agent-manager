import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-delivery-"));
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "README.md"), "fixture\n");
process.env.AGENT_MANAGER_DEV_ROOT = root;

const {
  createDeliveryStatus,
  deliveryReadiness,
  markWorkersComplete,
  recordMergedTarget,
  recordRelease,
  recordReviewDecision,
} = await import("../src/delivery.mjs?delivery-test");
const { loadWorkflow } = await import("../src/workflow.mjs?delivery-test");

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
  assert.equal(status.state, "ship_gate_pending");
});
