import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-scaling-"));
const repo = join(root, "repo");
const claims = join(root, "claims");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "README.md"), "base\n");
execFileSync("git", ["init", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "add", "README.md"]);
execFileSync("git", [
  "-C", repo,
  "-c", "user.name=Test",
  "-c", "user.email=test@example.invalid",
  "commit", "-m", "base",
]);

process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_CLAIMS_ROOT = claims;
const { loadWorkflow } = await import("../src/workflow.mjs?scaling-test");
const { validateLaneGuardrails } = await import("../src/guardrails.mjs?scaling-test");
const { currentHead } = await import("../src/guardrails.mjs?scaling-test-head");
const { findChangedFileOverlaps } = await import("../src/scope.mjs?scaling-test");
const { runVerification } = await import("../src/verification.mjs?scaling-test");
const { claimLanes } = await import("../src/claim.mjs?scaling-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function workflow(name, value) {
  const path = join(root, name + ".json");
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

function lane(index) {
  return {
    id: `lane-${index}`,
    scope: `area-${index}/**`,
    prompt: `work ${index}`,
  };
}

test("workflow accepts five lanes, defaults concurrency to three, and rejects six", () => {
  const five = loadWorkflow(workflow("five", {
    repo: "repo",
    integrate: true,
    lanes: [1, 2, 3, 4, 5].map(lane),
  }));
  assert.equal(five.lanes.length, 5);
  assert.equal(five.max_concurrency, 3);
  assert.throws(
    () => loadWorkflow(workflow("six", {
      repo: "repo",
      lanes: [1, 2, 3, 4, 5, 6].map(lane),
    })),
    /at most 5 lanes/,
  );
  assert.throws(
    () => loadWorkflow(workflow("bad-concurrency", {
      repo: "repo",
      max_concurrency: 6,
      lanes: [lane(1)],
    })),
    /max_concurrency must be an integer from 1 to 5/,
  );
});

test("overlapping write scopes fail closed unless one lane is explicitly read-only", () => {
  const overlapping = {
    repo: "repo",
    integrate: true,
    lanes: [
      { id: "platform", scope: "src/**", prompt: "platform" },
      { id: "ui", scope: "src/ui/**", prompt: "ui" },
    ],
  };
  assert.throws(
    () => loadWorkflow(workflow("overlap", overlapping)),
    /overlapping write scopes.*platform.*ui/,
  );

  const allowed = loadWorkflow(workflow("override", {
    ...overlapping,
    scope_overrides: [{
      path: "src/ui/**",
      lanes: ["platform", "ui"],
      owner: "ui",
      reason: "The platform lane may inspect the UI contract but only the UI lane writes it.",
    }],
  }));
  assert.deepEqual(allowed.lanes.find((item) => item.id === "platform").read_only, ["src/ui/**"]);
  assert.deepEqual(allowed.lanes.find((item) => item.id === "ui").read_only, []);
});

test("dependency validation rejects unknown lanes and cycles", () => {
  assert.throws(
    () => loadWorkflow(workflow("unknown-dependency", {
      repo: "repo",
      lanes: [{ ...lane(1), depends_on: ["missing"] }],
    })),
    /unknown lane/,
  );
  assert.throws(
    () => loadWorkflow(workflow("cycle", {
      repo: "repo",
      lanes: [
        { ...lane(1), depends_on: ["lane-2"] },
        { ...lane(2), depends_on: ["lane-1"] },
      ],
    })),
    /dependency cycle/,
  );
});

test("dependencies permit sequential ownership of the same path", () => {
  const loaded = loadWorkflow(workflow("sequential-overlap", {
    repo: "repo",
    integrate: true,
    lanes: [
      { id: "generator", scope: "src/generated/**", prompt: "generate" },
      {
        id: "formatter",
        depends_on: ["generator"],
        scope: "src/generated/**",
        prompt: "format generated files",
      },
    ],
  }));
  assert.equal(loaded.sequential_overlaps.length, 1);
  assert.deepEqual(loaded.sequential_overlaps[0].lanes, ["generator", "formatter"]);
});

test("read-only paths fail lane guardrails", () => {
  const baseCommit = currentHead(repo);
  mkdirSync(join(repo, "src", "ui"), { recursive: true });
  writeFileSync(join(repo, "src", "ui", "shared.ts"), "changed\n");
  const result = validateLaneGuardrails({
    worktree: repo,
    scope: "src/**",
    readOnlyScope: "src/ui/**",
    baseCommit,
    policy: { allow_commit: false },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.readOnlyViolations, ["src/ui/shared.ts"]);
});

test("changed-file overlap and verification produce deterministic evidence", () => {
  assert.deepEqual(findChangedFileOverlaps([
    { id: "one", changedFiles: ["a.txt", "shared.txt"] },
    { id: "two", changedFiles: ["b.txt", "shared.txt"] },
  ]), [{ file: "shared.txt", lanes: ["one", "two"] }]);

  const passed = runVerification(repo, {
    timeout_sec: 10,
    commands: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
  });
  assert.equal(passed.state, "passed");
  const failed = runVerification(repo, {
    timeout_sec: 10,
    commands: [{ command: process.execPath, args: ["-e", "process.exit(7)"] }],
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.commands[0].exitCode, 7);
});

test("claim groups permit one wave's approved overlap, block another wave, and renew leases", () => {
  const claimTool = join(process.cwd(), "tools", "claim.mjs");
  const claimEnv = { ...process.env, AGENT_MANAGER_CLAIMS_ROOT: claims };
  const run = (...args) =>
    execFileSync(process.execPath, [claimTool, ...args], {
      env: claimEnv,
      encoding: "utf8",
      windowsHide: true,
    });

  run("claim", "--repo", "repo", "--branch", "a", "--lane", "a", "--scope", "src/**", "--group", "wave-1", "--agent", "test-agent");
  run("claim", "--repo", "repo", "--branch", "b", "--lane", "b", "--scope", "src/ui/**", "--group", "wave-1", "--agent", "test-agent");
  assert.throws(
    () => run("claim", "--repo", "repo", "--branch", "c", "--lane", "c", "--scope", "src/ui/**", "--group", "wave-2", "--agent", "test-agent"),
    (error) => error.status === 2,
  );

  const claimPath = join(claims, "repo", "a.json");
  const before = JSON.parse(readFileSync(claimPath, "utf8"));
  run("renew", "--repo", "repo", "--branch", "a");
  const after = JSON.parse(readFileSync(claimPath, "utf8"));
  assert.ok(Date.parse(after.renewed_at) >= Date.parse(before.renewed_at));
  run("release", "--repo", "repo", "--branch", "a");
  run("release", "--repo", "repo", "--branch", "b");
});

test("stale claims recover only after the owning supervisor is inactive", () => {
  const claimTool = join(process.cwd(), "tools", "claim.mjs");
  const claimEnv = { ...process.env, AGENT_MANAGER_CLAIMS_ROOT: claims };
  const claimDir = join(claims, "stale-repo");
  const heldPath = join(claimDir, "held.json");
  mkdirSync(claimDir, { recursive: true });
  const stale = {
    repo: "stale-repo",
    branch: "held",
    lane: "held",
    agent: "test",
    group: "old-wave",
    scope: ["src/**"],
    claimed_at: "2000-01-01T00:00:00.000Z",
    renewed_at: "2000-01-01T00:00:00.000Z",
    ttl_hours: 1,
    owner_pid: process.pid,
    owner_host: hostname(),
  };
  writeFileSync(heldPath, JSON.stringify(stale));
  const claim = () => execFileSync(process.execPath, [
    claimTool,
    "claim",
    "--repo", "stale-repo",
    "--branch", "new",
    "--lane", "new",
    "--scope", "src/**",
    "--group", "new-wave",
  ], { env: claimEnv, encoding: "utf8", windowsHide: true });

  assert.throws(claim, (error) => error.status === 2);
  writeFileSync(heldPath, JSON.stringify({ ...stale, owner_pid: 2_147_483_647 }));
  assert.doesNotThrow(claim);
  assert.equal(existsSync(heldPath), false);
});

test("required claim admission rolls back the partial wave before work starts", () => {
  const claimTool = join(process.cwd(), "tools", "claim.mjs");
  execFileSync(process.execPath, [
    claimTool,
    "claim",
    "--repo", "atomic-repo",
    "--branch", "existing",
    "--lane", "existing",
    "--scope", "area-2/**",
    "--group", "other-wave",
  ], {
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });

  assert.throws(
    () => claimLanes({
      repo: "atomic-repo",
      group: "new-wave",
      mode: "required",
      lanes: [
        {
          branch: "new-one",
          lane: "one",
          scope: ["area-1/**"],
          agent: "test",
        },
        {
          branch: "new-two",
          lane: "two",
          scope: ["area-2/**"],
          agent: "test",
        },
      ],
    }),
    /required claim admission failed/,
  );
  assert.equal(existsSync(join(claims, "atomic-repo", "new-one.json")), false);
  assert.equal(existsSync(join(claims, "atomic-repo", "new-two.json")), false);
});
