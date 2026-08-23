import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createGitHubProvider,
  formatReconciliation,
  parseReconcileArgs,
  reconcileExternalDelivery,
  ReconciliationError,
} from "../src/reconcile.mjs";

const MERGE_SHA = "a".repeat(40);
const RELEASE_SHA = "b".repeat(40);
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-manager.mjs");

function blockedStatus(overrides = {}) {
  return {
    runId: "run-reconcile-fixture",
    state: "blocked",
    endedAt: null,
    lanes: [],
    delivery: {
      schema: "agent-manager.delivery.v1",
      mode: "single",
      state: "blocked",
      releaseRequired: true,
      review: { state: "accepted", verdict: "accept", history: [] },
      targets: [{
        id: "integrate",
        laneId: "integrate",
        order: 1,
        state: "blocked",
        branch: "am/run-reconcile-fixture/integrate",
        base: "main",
        pr: "42",
        prUrl: "https://example.invalid/pull/42",
        mergeSha: null,
      }],
      release: { state: "pending", sha: null, tag: null, verifiedMergeShas: [] },
    },
    ship: {
      schema: "agent-manager.ship.v1",
      state: "blocked",
      phase: "release-push",
      approve: "all",
      branch: "am/run-reconcile-fixture/integrate",
      base: "main",
      remote: "origin",
      prUrl: "https://example.invalid/pull/42",
      targetId: "integrate",
      version: "1.23.0",
      plannedTag: "v1.23.0",
      releaseSha: RELEASE_SHA,
      needsInput: { type: "blocked", prompt: "protected branch rejected release push" },
    },
    ...overrides,
  };
}

function provider(overrides = {}) {
  return {
    name: "github",
    inspectPullRequest: async () => ({
      state: "MERGED",
      url: "https://example.invalid/pull/42",
      mergeSha: MERGE_SHA,
      head: "am/run-reconcile-fixture/integrate",
      base: "main",
      requiredChecksSatisfied: true,
      checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
    inspectTag: async () => ({ tag: "v1.23.0", sha: RELEASE_SHA }),
    inspectRelease: async () => ({
      tag: "v1.23.0",
      sha: RELEASE_SHA,
      published: true,
      publishedAt: "2026-08-23T18:00:00.000Z",
      url: "https://example.invalid/releases/v1.23.0",
    }),
    isAncestor: async () => true,
    ...overrides,
  };
}

test("verified external delivery reconciles a blocked release and records ancestry evidence", async () => {
  const result = await reconcileExternalDelivery(blockedStatus(), {
    provider: provider(),
    now: () => new Date("2026-08-23T18:05:00.000Z"),
  });
  assert.equal(result.state, "released");
  assert.equal(result.delivery.targets[0].state, "merged");
  assert.equal(result.delivery.targets[0].mergeSha, MERGE_SHA);
  assert.equal(result.delivery.release.sha, RELEASE_SHA);
  assert.deepEqual(result.delivery.release.verifiedMergeShas, [MERGE_SHA]);
  assert.equal(result.ship.state, "done");
  assert.equal(result.ship.needsInput, null);
  assert.equal(result.reconciliation.state, "verified");
  assert.deepEqual(result.reconciliation.release.verifiedMergeShas, [MERGE_SHA]);
});

test("mismatched or unverifiable evidence fails closed without mutating the blocked ledger", async () => {
  const original = blockedStatus();
  await assert.rejects(
    reconcileExternalDelivery(original, { provider: provider({ isAncestor: async () => false }) }),
    (error) => error instanceof ReconciliationError && error.code === "ancestry-mismatch",
  );
  assert.equal(original.state, "blocked");
  assert.equal(original.delivery.targets[0].state, "blocked");

  await assert.rejects(
    reconcileExternalDelivery(blockedStatus(), {
      provider: provider({
        inspectPullRequest: async () => ({
          state: "MERGED",
          mergeSha: MERGE_SHA,
          head: "am/run-reconcile-fixture/integrate",
          base: "main",
          requiredChecksSatisfied: false,
          checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
        }),
      }),
    }),
    (error) => error instanceof ReconciliationError && error.code === "checks-unverified",
  );

  await assert.rejects(
    reconcileExternalDelivery(blockedStatus(), {
      provider: provider({
        inspectPullRequest: async () => ({
          state: "MERGED",
          mergeSha: MERGE_SHA,
          head: "am/run-reconcile-fixture/integrate",
          base: "main",
          requiredChecksSatisfied: true,
          checks: [],
        }),
      }),
    }),
    (error) => error instanceof ReconciliationError && error.code === "checks-unavailable",
  );
});

test("reconcile CLI arguments and output are explicit and fail closed", () => {
  assert.deepEqual(parseReconcileArgs(["run-123", "--provider", "github", "--json"]), {
    runId: "run-123",
    provider: "github",
    json: true,
  });
  assert.throws(() => parseReconcileArgs([]), /reconcile requires <runId>/);
  assert.throws(() => parseReconcileArgs(["run-123", "--provider", "gitlab"]), /current adapter: github/);
  assert.match(formatReconciliation({
    runId: "run-123",
    state: "merged",
    reconciliation: {
      provider: "github",
      targets: [{ id: "integrate", pr: "https://example.invalid/pull/42", mergeSha: MERGE_SHA }],
      release: null,
    },
  }), /reconciled: run-123[\s\S]*provider: github[\s\S]*target integrate:/);

  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /agent-manager reconcile <runId> \[--provider github\] \[--json\]/);
  const rejected = spawnSync(process.execPath, [cli, "reconcile", "run-123", "--provider", "gitlab"], {
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unsupported reconcile provider: gitlab; current adapter: github/);
});

test("the GitHub adapter reads PR checks, remote tags, releases, and compare ancestry", async () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    const joined = [command, ...args].join(" ");
    if (joined.includes("pr view")) return { ok: true, stdout: JSON.stringify({
      state: "MERGED",
      mergeCommit: { oid: MERGE_SHA },
      url: "https://example.invalid/pull/42",
      headRefName: "feature",
      baseRefName: "main",
      statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    }) };
    if (joined.includes("ls-remote")) return { ok: true, stdout: `${RELEASE_SHA}\trefs/tags/v1.23.0` };
    if (joined.includes("release view")) return { ok: true, stdout: JSON.stringify({
      tagName: "v1.23.0",
      isDraft: false,
      publishedAt: "2026-08-23T18:00:00.000Z",
      url: "https://example.invalid/releases/v1.23.0",
    }) };
    if (joined.includes("repo view")) return { ok: true, stdout: '{"nameWithOwner":"public/example"}' };
    if (joined.includes("gh api")) return { ok: true, stdout: '{"status":"ahead"}' };
    return { ok: false, stderr: `unexpected command: ${joined}` };
  };
  const github = createGitHubProvider({ cwd: "C:\\fixture", exec });
  assert.equal((await github.inspectPullRequest("42")).requiredChecksSatisfied, true);
  assert.equal((await github.inspectTag("v1.23.0")).sha, RELEASE_SHA);
  assert.equal((await github.inspectRelease("v1.23.0")).published, true);
  assert.equal(await github.isAncestor(MERGE_SHA, RELEASE_SHA), true);
  assert.ok(calls.some((args) => args.includes(`repos/public/example/compare/${MERGE_SHA}...${RELEASE_SHA}`)));
});

test("the GitHub adapter does not treat an empty check rollup as successful CI", async () => {
  const github = createGitHubProvider({
    cwd: "C:\\fixture",
    exec: () => ({
      ok: true,
      stdout: JSON.stringify({
        state: "MERGED",
        mergeCommit: { oid: MERGE_SHA },
        statusCheckRollup: [],
      }),
    }),
  });
  const result = await github.inspectPullRequest("42");
  assert.equal(result.requiredChecksSatisfied, false);
  assert.deepEqual(result.checks, []);
});
