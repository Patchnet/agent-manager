import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-authorization-"));
const runsRoot = join(root, "runs");
const repo = join(root, "repo");
mkdirSync(runsRoot, { recursive: true });
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "README.md"), "base\n");
execFileSync("git", ["init", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "add", "README.md"]);
execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
process.env.AGENT_MANAGER_TEST_ROOT = root;
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;

const {
  assertAuthorizationReceipt,
  authorizedShipOptions,
  canonicalJson,
  consumeAuthorization,
  createAuthorizationGrant,
  inspectAuthorization,
  resolveReviewerIdentity,
  revokeAuthorization,
} = await import("../src/authorization.mjs?authorization-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

const NOW = new Date("2026-08-20T12:00:00.000Z");

function status(runId) {
  const value = {
    runId,
    state: "delivery_review_pending",
    repo: "repo",
    repoRoot: repo,
    target_dev_flow: "formal",
    baseRef: "main",
    agentManager: { version: "1.21.0" },
    identity: {
      manager: {
        harness: "codex",
        model: "gpt-test",
        threadTitle: "independent-manager-thread",
      },
    },
    planning: {
      reviewedBaseSha: head,
      actualBaseSha: head,
      contextDigest: "a".repeat(64),
    },
    lanes: [{
      id: "author",
      harness: "codex",
      modelObserved: "gpt-test",
      sessionId: "worker-session",
      state: "done",
      changedFiles: ["README.md"],
    }],
    delivery: {
      state: "review_pending",
      mode: "single",
      review: { state: "not_started", latestPass: 0, verdict: null, history: [] },
      targets: [{
        id: "change",
        branch: "feature/change",
        base: "main",
        worktree: repo,
        changedFiles: ["README.md"],
      }],
      release: { state: "pending" },
    },
  };
  mkdirSync(join(runsRoot, runId), { recursive: true });
  return value;
}

function grantOptions(overrides = {}) {
  return {
    level: "through-pr",
    operator: "test-operator",
    expiresAt: "2026-08-21T12:00:00.000Z",
    risk: "moderate",
    riskCeiling: "moderate",
    providerMode: "github",
    commitMessage: "feat: approved change",
    now: () => NOW,
    ...overrides,
  };
}

function create(statusValue, overrides = {}) {
  const options = grantOptions(overrides);
  return createAuthorizationGrant(statusValue, options, { now: options.now });
}

function accept(statusValue, reviewer = "independent-reviewer") {
  const reviewerIdentity = resolveReviewerIdentity(statusValue, "manager");
  statusValue.state = "ship_gate_pending";
  statusValue.delivery.state = "ship_gate_pending";
  statusValue.delivery.review = {
    state: "accepted",
    latestPass: 1,
    verdict: "accept",
    reviewer,
    history: [{ pass: 1, verdict: "accept", reviewer, reviewerIdentity }],
  };
}

function handoffFrom(statusValue) {
  const options = authorizedShipOptions(statusValue);
  return {
    runId: statusValue.runId,
    approve: options.level,
    flow: options.flow,
    repoRoot: options.repo,
    worktree: options.worktree,
    branch: options.branch,
    base: options.base,
    remote: options.remote,
    pr: options.pr,
    targetId: options.target,
    commitMessage: options.commitMessage,
    version: options.version,
    summary: options.summary,
    pollSec: options.pollSec,
    timeoutSec: options.timeoutSec,
    checkGraceSec: options.checkGraceSec,
    retryAttempts: options.retryAttempts,
    retryBaseMs: options.retryBaseMs,
    providerMode: options.providerMode,
    risk: options.risk,
    permittedMutations: options.permittedMutations,
  };
}

test("canonical hashing input is stable across object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test("authorization CLI creates, inspects, and revokes without exposing private provenance", () => {
  const current = status("run-auth-cli");
  writeFileSync(join(runsRoot, current.runId, "status.json"), JSON.stringify(current, null, 2));
  const env = {
    ...process.env,
    AGENT_MANAGER_TEST_ROOT: root,
    AGENT_MANAGER_TEST_MODE: "1",
    AGENT_MANAGER_DEV_ROOT: root,
    AGENT_MANAGER_RUNS_ROOT: runsRoot,
  };
  const cli = join(process.cwd(), "bin", "agent-manager.mjs");
  const createdText = execFileSync("node", [
    cli, "authorization", "create", current.runId,
    "--level", "through-pr",
    "--operator", "private-operator",
    "--expires-at", "2026-08-21T12:00:00.000Z",
    "--risk", "moderate",
    "--risk-ceiling", "moderate",
    "--provider-mode", "github",
    "--commit-message", "feat: approved change",
    "--json",
  ], { encoding: "utf8", env });
  const created = JSON.parse(createdText);
  assert.equal(created.action, "create");
  assert.equal(created.authorization.level, "through-pr");
  assert.doesNotMatch(createdText, /private-operator|operatorProvenance|manifest\"/);

  const inspected = JSON.parse(execFileSync("node", [
    cli, "authorization", "inspect", current.runId, "--json",
  ], { encoding: "utf8", env }));
  assert.equal(inspected.authorization.failureCode, "review-inconclusive");

  const revoked = JSON.parse(execFileSync("node", [
    cli, "authorization", "revoke", current.runId,
    "--operator", "private-operator", "--reason", "test", "--json",
  ], { encoding: "utf8", env }));
  assert.equal(revoked.authorization.state, "revoked");
  assert.doesNotMatch(JSON.stringify(revoked), /private-operator/);
});

test("a reviewer label alone cannot activate conditional authority", () => {
  const current = status("run-auth-unattributed");
  create(current);
  current.state = "ship_gate_pending";
  current.delivery.review = {
    state: "accepted", latestPass: 1, verdict: "accept", reviewer: "somebody",
    history: [{ pass: 1, verdict: "accept", reviewer: "somebody" }],
  };
  const result = inspectAuthorization(current, { now: () => NOW });
  assert.equal(result.valid, false);
  assert.equal(result.code, "reviewer-unattributed");
  assert.match(result.action, /--reviewer-role manager/);
});

test("permitted mutations are the smallest set for the recorded flow and level", () => {
  const current = status("run-auth-simple-bounds");
  current.target_dev_flow = "simple";
  current.delivery.targets[0].branch = "main";
  const { grant } = create(current, {
    level: "all",
    version: "1.22.0",
    summary: "Ship the reviewed change.",
  });
  assert.deepEqual(grant.permittedMutations, ["commit", "push", "version", "tag"]);
  assert.equal(grant.permittedMutations.includes("pull-request"), false);
  assert.equal(grant.permittedMutations.includes("merge"), false);
});

test("an unchanged independent acceptance consumes once and binds an immutable receipt", () => {
  const current = status("run-auth-receipt");
  create(current);
  accept(current);
  assert.equal(inspectAuthorization(current, { now: () => NOW }).state, "ready");

  const handoff = handoffFrom(current);
  const consumed = consumeAuthorization(current, handoff, { now: () => NOW });
  handoff.authorization = {
    grantDigest: consumed.receipt.grantDigest,
    receiptDigest: consumed.receipt.receiptDigest,
    executionDigest: consumed.receipt.executionDigest,
  };
  assert.equal(consumed.receipt.grantDigest.length, 64);
  assert.equal(assertAuthorizationReceipt(current, handoff, { now: () => NOW }), true);
  assert.equal(existsSync(join(runsRoot, current.runId, "authorization", "receipt.json")), true);
  assert.throws(
    () => consumeAuthorization(current, handoff, { now: () => NOW }),
    /already has an execution receipt|already been consumed/,
  );
});

test("revocation and expiry fail closed with an exact operator action", () => {
  const revoked = status("run-auth-revoked");
  create(revoked);
  accept(revoked);
  revokeAuthorization(revoked, { operator: "test-operator", reason: "inputs changed" }, { now: () => NOW });
  const revokedResult = inspectAuthorization(revoked, { now: () => NOW });
  assert.equal(revokedResult.code, "revoked");
  assert.match(revokedResult.action, /manual Ship Gate|new reviewed run/);

  const expired = status("run-auth-expired");
  create(expired, { expiresAt: "2026-08-20T12:00:01.000Z" });
  accept(expired);
  const expiredResult = inspectAuthorization(expired, {
    now: () => new Date("2026-08-20T12:00:02.000Z"),
  });
  assert.equal(expiredResult.code, "expired");
  assert.match(expiredResult.action, /manual Ship Gate|fresh bounded expiry/);
});

test("evidence, provider mode, risk, runtime version, and reviewer collision drift fail closed", () => {
  const content = status("run-auth-content-drift");
  writeFileSync(join(repo, "README.md"), "reviewed dirty content\n");
  create(content);
  accept(content);
  writeFileSync(join(repo, "README.md"), "different dirty content\n");
  assert.equal(inspectAuthorization(content, { now: () => NOW }).code, "evidence-drift");
  writeFileSync(join(repo, "README.md"), "base\n");

  const evidence = status("run-auth-evidence-drift");
  create(evidence);
  accept(evidence);
  writeFileSync(join(repo, "drift.txt"), "unreviewed\n");
  assert.equal(inspectAuthorization(evidence, { now: () => NOW }).code, "evidence-drift");
  rmSync(join(repo, "drift.txt"));

  const manifest = status("run-auth-manifest-drift");
  create(manifest);
  accept(manifest);
  const provider = handoffFrom(manifest);
  provider.providerMode = "other-provider";
  assert.throws(() => consumeAuthorization(manifest, provider, { now: () => NOW }), /requested execution differs/);
  const risk = handoffFrom(manifest);
  risk.risk = "high";
  assert.throws(() => consumeAuthorization(manifest, risk, { now: () => NOW }), /requested execution differs/);

  const version = status("run-auth-runtime-drift");
  create(version);
  accept(version);
  version.agentManager.version = "1.22.0";
  assert.equal(inspectAuthorization(version, { now: () => NOW }).code, "version-drift");

  const collision = status("run-auth-reviewer-collision");
  create(collision);
  accept(collision, "worker-session");
  assert.equal(inspectAuthorization(collision, { now: () => NOW }).code, "reviewer-collision");
});
