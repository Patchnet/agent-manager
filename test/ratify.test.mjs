import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertResolvedRootsIsolated,
  isolatedRoot,
  useIsolatedRoots,
} from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("ratify-");
useIsolatedRoots(root);

test.after(() => rmSync(root, { recursive: true, force: true }));

const { readStatus, writeStatus } = await import("../src/status.mjs?ratify");
const {
  isRatified,
  laneGuardrailViolations,
  ratificationGap,
  ratifyLane,
  resolveMasterIdentity,
} = await import("../src/ratify.mjs?ratify");

let runCounter = 0;

function seedRun(lane, { verifiedBy = "test-manager" } = {}) {
  runCounter += 1;
  const runId = `run-ratify-${runCounter}`;
  writeStatus(runId, {
    runId,
    state: "failed",
    repo: "fixture-repo",
    planning: { state: "verified", verifiedBy },
    lanes: [{
      id: "stray",
      state: "failed",
      branch: `am/${runId}/stray`,
      worktree: join(root, "runs", runId, "stray", "wt"),
      scopeViolations: [],
      readOnlyViolations: [],
      policyViolations: [],
      snapshot: { state: "committed", files: ["stray.txt"] },
      ...lane,
    }],
  });
  return runId;
}

test("this test file resolves disposable runs, claims, and brain roots", async () => {
  await assertResolvedRootsIsolated();
});

test("ratify records who accepted which violations, and why", () => {
  const runId = seedRun({ scopeViolations: ["docs/OPERATOR.md", "src/review.mjs"] });
  const result = ratifyLane(runId, "stray", {
    reason: "cross-lane doc edit sanctioned during the audit",
    at: "2026-08-17T12:00:00.000Z",
  });

  assert.equal(result.by, "test-manager", "attribution falls back to the run's planning verifier");
  assert.equal(result.laneState, "failed", "ratification never relabels the lane");
  assert.deepEqual(result.violations, ["docs/OPERATOR.md", "src/review.mjs"]);

  const lane = readStatus(runId).lanes[0];
  assert.deepEqual(lane.ratification, {
    by: "test-manager",
    reason: "cross-lane doc edit sanctioned during the audit",
    at: "2026-08-17T12:00:00.000Z",
    violations: ["docs/OPERATOR.md", "src/review.mjs"],
  });
  assert.equal(lane.state, "failed");
  assert.deepEqual(lane.scopeViolations, ["docs/OPERATOR.md", "src/review.mjs"]);
});

test("an explicit --by wins over the recorded planning verifier", () => {
  const runId = seedRun({ policyViolations: ["worker created 1 commit(s) while allow_commit=false"] });
  const result = ratifyLane(runId, "stray", { reason: "snapshot commit reviewed", by: "master-dev" });
  assert.equal(result.by, "master-dev");
});

test("ratification refuses a lane with nothing to ratify and a lane with nothing to fold", () => {
  const clean = seedRun({});
  assert.throws(
    () => ratifyLane(clean, "stray", { reason: "please fold it anyway" }),
    /recorded no guardrail violations; there is nothing to ratify/,
  );

  const uncommitted = seedRun({
    scopeViolations: ["stray.txt"],
    snapshot: { state: "clean" },
  });
  assert.throws(
    () => ratifyLane(uncommitted, "stray", { reason: "fold the nothing" }),
    /an end-of-lane snapshot in state clean; there is no committed work to fold/,
  );

  const unsnapshotted = seedRun({ scopeViolations: ["stray.txt"], snapshot: undefined });
  assert.throws(
    () => ratifyLane(unsnapshotted, "stray", { reason: "fold the nothing" }),
    /no end-of-lane snapshot; there is no committed work to fold/,
  );

  const missing = seedRun({ scopeViolations: ["stray.txt"] });
  assert.throws(() => ratifyLane(missing, "ghost", { reason: "who?" }), /no lane ghost in/);
  assert.throws(() => ratifyLane(missing, "stray", { reason: "  " }), /requires --reason/);
});

test("a run with no attributable identity is refused rather than attributed to nobody", () => {
  const runId = seedRun({ scopeViolations: ["stray.txt"] }, { verifiedBy: "" });
  assert.throws(
    () => ratifyLane(runId, "stray", { reason: "fold it" }),
    /requires --by <id>; the run records no planning verifier/,
  );
  assert.equal(
    resolveMasterIdentity({ planning: { verifiedBy: "" } }, "master-dev"),
    "master-dev",
  );
});

test("a ratification covers only the violations it was shown", () => {
  const lane = {
    scopeViolations: ["stray.txt"],
    readOnlyViolations: [],
    policyViolations: [],
    ratification: { by: "master-dev", reason: "audited", at: "-", violations: ["stray.txt"] },
  };
  assert.deepEqual(ratificationGap(lane), []);
  assert.equal(isRatified(lane), true);

  const strayedAgain = { ...lane, scopeViolations: ["stray.txt", "src/ship-run.mjs"] };
  assert.deepEqual(ratificationGap(strayedAgain), ["src/ship-run.mjs"]);
  assert.equal(isRatified(strayedAgain), false);

  const unratified = { scopeViolations: ["stray.txt"] };
  assert.deepEqual(ratificationGap(unratified), ["stray.txt"]);
  assert.equal(isRatified(unratified), false);
  assert.deepEqual(laneGuardrailViolations(unratified), ["stray.txt"]);
});

test("re-ratifying after new evidence covers the new violation list", () => {
  const runId = seedRun({ scopeViolations: ["stray.txt"] });
  ratifyLane(runId, "stray", { reason: "first look" });

  const status = readStatus(runId);
  status.lanes[0].scopeViolations = ["stray.txt", "src/ship-run.mjs"];
  writeStatus(runId, status);
  assert.deepEqual(ratificationGap(readStatus(runId).lanes[0]), ["src/ship-run.mjs"]);

  ratifyLane(runId, "stray", { reason: "second look, both accepted" });
  const relooked = readStatus(runId).lanes[0];
  assert.deepEqual(relooked.ratification.violations, ["stray.txt", "src/ship-run.mjs"]);
  assert.deepEqual(ratificationGap(relooked), []);
});
