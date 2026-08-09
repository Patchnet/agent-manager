import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-workflow-"));
const runsRoot = join(root, "runs");
const claimsRoot = join(root, "claims");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
process.env.AGENT_MANAGER_CLAIMS_ROOT = claimsRoot;

test.after(() => rmSync(root, { recursive: true, force: true }));

const { assertShellPolicyCoherence, loadWorkflow } = await import("../src/workflow.mjs?workflow-test");

let counter = 0;
function workflow(value) {
  counter += 1;
  const path = join(root, `workflow-${counter}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function withLane(lane = {}, overrides = {}) {
  return workflow({
    repo: "repo",
    lanes: [{ id: "lane", scope: "src/**", prompt: "work", ...lane }],
    ...overrides,
  });
}

test("allow_commit with a prompting Claude permission mode is rejected at load", () => {
  for (const permission_mode of ["acceptEdits", "workspace-write"]) {
    assert.throws(
      () => loadWorkflow(withLane({ permission_mode }, { policy: { allow_commit: true } })),
      /prompts before git and gh commands/,
    );
  }
  assert.throws(
    () => loadWorkflow(withLane({}, { policy: { allow_commit: true } })),
    /permission_mode acceptEdits/,
    "the acceptEdits policy default is checked even when the lane declares no mode",
  );
});

test("allow_pr is checked with the same rule and names the pull-request claim", () => {
  let message = "";
  try {
    loadWorkflow(withLane({ permission_mode: "acceptEdits" }, { policy: { allow_pr: true } }));
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /workflow\.policy\.allow_pr=true/);
  assert.doesNotMatch(message, /allow_commit/);
});

test("unattended Claude modes satisfy a commit policy", () => {
  const auto = loadWorkflow(
    withLane({ permission_mode: "auto" }, { policy: { allow_commit: true, allow_pr: true } }),
  );
  assert.equal(auto.policy.allow_commit, true);

  const scoped = loadWorkflow(withLane(
    {
      permission_mode: "dontAsk",
      allowed_tools: ["Bash(git commit:*)", "Bash(gh pr create:*)"],
    },
    { policy: { allow_commit: true, allow_pr: true } },
  ));
  assert.equal(scoped.lanes[0].permission_mode, "dontAsk");
});

test("dontAsk without a matching allowlist rule is rejected per claim", () => {
  assert.throws(
    () => loadWorkflow(withLane(
      { permission_mode: "dontAsk", allowed_tools: ["Bash(node --test *)"] },
      { policy: { allow_commit: true } },
    )),
    /without an allowed_tools rule for git/,
  );
  assert.throws(
    () => loadWorkflow(withLane(
      { permission_mode: "dontAsk", allowed_tools: ["Bash(git commit:*)"] },
      { policy: { allow_commit: true, allow_pr: true } },
    )),
    /without an allowed_tools rule for gh/,
  );
  assert.throws(
    () => loadWorkflow(withLane(
      { permission_mode: "dontAsk", allowed_tools: ["Bash(gitleaks:*)"] },
      { policy: { allow_commit: true } },
    )),
    /without an allowed_tools rule for git/,
    "a longer binary name must not satisfy the git rule",
  );
});

test("a read-only implementation lane cannot claim commit permission", () => {
  assert.throws(
    () => loadWorkflow(withLane(
      { permission_mode: "readOnly", kind: "implementation" },
      { policy: { allow_commit: true } },
    )),
    /runs read-only/,
  );
});

test("review lanes, Codex lanes, and an approved bypass stay loadable", () => {
  const review = loadWorkflow(withLane(
    { permission_mode: "readOnly" },
    { policy: { allow_commit: true } },
  ));
  assert.equal(review.lanes[0].kind, "review");

  const codex = loadWorkflow(withLane(
    { harness: "codex", permission_mode: "acceptEdits" },
    { policy: { allow_commit: true } },
  ));
  assert.equal(codex.lanes[0].harness, "codex");

  const bypass = loadWorkflow(withLane({ permission_mode: "acceptEdits" }, {
    policy: { allow_commit: true, dangerously_skip_permissions: true },
  }));
  assert.equal(bypass.policy.dangerously_skip_permissions, true);
});

test("workflows that claim no shell permission keep the acceptEdits default", () => {
  const workflowValue = loadWorkflow(withLane());
  assert.equal(workflowValue.policy.allow_commit, false);
  assert.equal(workflowValue.lanes[0].permission_mode, "acceptEdits");
});

test("the coherence check reads lane state directly and is order independent", () => {
  const lanes = [
    { id: "review", kind: "review", harness: "claude", permission_mode: "readOnly", allowed_tools: [] },
    { id: "build", kind: "implementation", harness: "claude", permission_mode: "auto", allowed_tools: [] },
  ];
  assert.equal(assertShellPolicyCoherence(lanes, { allow_commit: true }), lanes);
  assert.throws(
    () => assertShellPolicyCoherence(
      [...lanes, { id: "late", kind: "implementation", harness: "claude", permission_mode: "acceptEdits", allowed_tools: [] }],
      { allow_commit: true },
    ),
    /Claude lane late/,
  );
});
