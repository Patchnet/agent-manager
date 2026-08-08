import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrainConflictError,
  admitRun,
  canonicalRepoIdentity,
  ensureBrain,
  listBrainIntents,
  syncBrainStatus,
} from "../src/brain.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-manager-brain-"));
const brainRoot = join(root, "brain");
const repoOne = join(root, "repo-one");
const repoTwo = join(root, "repo-two");

function initRepo(path, remote) {
  execFileSync("git", ["init", path], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
}

test.before(() => {
  initRepo(repoOne, "git@github.com:Example/Shared.git");
  initRepo(repoTwo, "https://credential@github.com/Example/Shared.git");
});

test.after(() => rmSync(root, { recursive: true, force: true }));

test("brain initializes explicitly in Git-free feed mode", async () => {
  const result = await ensureBrain({ root: brainRoot });
  assert.equal(result.historyMode, "feed");
  assert.equal(existsSync(join(brainRoot, ".git")), false);
  assert.equal(existsSync(join(brainRoot, "_registry", "object_types.yaml")), true);
  assert.equal(existsSync(join(brainRoot, "_schema", "run_intent.v1.yaml")), true);
});

test("canonical repository identity follows the remote across local paths", () => {
  const first = canonicalRepoIdentity(repoOne);
  const second = canonicalRepoIdentity(repoTwo);
  assert.equal(first.source, "remote");
  assert.equal(first.key, second.key);
});

test("admission blocks overlapping edits and retains pending delivery as a dependency", async () => {
  const first = await admitRun({
    runId: "run-20260807-220000-11111111",
    repoRoot: repoOne,
    title: "First edit",
    lanes: [{ scope: ["src/workspace/**"] }],
    planRef: "plan-first",
    root: brainRoot,
  });
  assert.equal(first.state, "admitted");
  assert.equal(first.historyMode, "feed");

  const parallel = await admitRun({
    runId: "run-20260807-220001-22222222",
    repoRoot: repoTwo,
    title: "Non-overlapping edit",
    lanes: [{ scope: ["docs/**"] }],
    root: brainRoot,
  });
  assert.equal(parallel.activeRelated.length, 1);
  assert.equal(parallel.activeRelated.some((item) => item.runId === "run-20260807-220000-11111111"), true);

  await assert.rejects(
    admitRun({
      runId: "run-20260807-220002-33333333",
      repoRoot: repoOne,
      title: "Conflicting edit",
      lanes: [{ scope: ["src/workspace/session.mjs"] }],
      root: brainRoot,
    }),
    (error) => error instanceof BrainConflictError && error.code === "RUN_INTENT_CONFLICT",
  );

  await syncBrainStatus({
    runId: "run-20260807-220000-11111111",
    state: "delivery_review_pending",
    awareness: { intentId: first.intentId },
  }, { root: brainRoot });

  const staleHeartbeat = await syncBrainStatus({
    runId: "run-20260807-220000-11111111",
    state: "running",
    awareness: { intentId: first.intentId },
  }, { root: brainRoot });
  assert.deepEqual(staleHeartbeat, {
    skipped: true,
    reason: "phase-regression",
    currentPhase: "delivery",
  });

  const dependent = await admitRun({
    runId: "run-20260807-220003-44444444",
    repoRoot: repoOne,
    title: "Dependent edit",
    lanes: [{ scope: ["src/workspace/session.mjs"] }],
    root: brainRoot,
  });
  assert.equal(
    dependent.deliveryDependencies.some((item) => item.runId === "run-20260807-220000-11111111"),
    true,
  );

  const intents = await listBrainIntents({ repoRoot: repoOne, root: brainRoot });
  assert.equal(intents.length, 3);
  assert.equal(intents.some((item) => item.phase === "delivery"), true);

  for (const awareness of [parallel, dependent]) {
    await syncBrainStatus({
      runId: awareness.runId,
      state: "cancelled",
      endedAt: new Date().toISOString(),
      awareness: { intentId: awareness.intentId },
    }, { root: brainRoot });
  }
});
