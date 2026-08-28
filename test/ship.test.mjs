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
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-ship-"));
const runsRoot = join(root, "runs");
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
mkdirSync(runsRoot, { recursive: true });

const {
  diagnoseBlockedMerge,
  applyVersionStamp,
  execCommand,
  isSymbolicBaseRef,
  isWithinCheckRegistrationGrace,
  observeTagTriggeredRuns,
  resolveDefaultBaseBranch,
  resolveShipBase,
  prepareShipHandoff,
  prepareReleaseWorkspace,
  preflightShipHandoff,
  queueShip,
  resolveSpawnCommand,
  runShip,
  ShipBlockedError,
  verifyDeliveryAncestry,
} = await import("../src/ship-run.mjs?ship-test");
const { readEvents, readStatus, writeStatus } = await import("../src/status.mjs?ship-test");
const { classifyWake } = await import("../src/watch-signal.mjs?ship-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr = "failed") {
  return { ok: false, status: 1, stdout: "", stderr };
}

function tagActionsResponse(command, args, remote, tag = "v1.1.0") {
  if (command !== "gh" || args[0] !== "run" || args[1] !== "list") return null;
  const sha = args[args.indexOf("--commit") + 1];
  const published = execCommand(
    "git",
    ["ls-remote", "--tags", remote, `refs/tags/${tag}`],
    { cwd: root },
  ).stdout;
  return ok(JSON.stringify(published ? [{
    databaseId: 1,
    status: "completed",
    conclusion: "success",
    url: "https://example.invalid/actions/1",
    workflowName: "Publish",
    event: "push",
    headSha: sha,
  }] : []));
}

function providerCapabilityResponse(command, args, overrides = {}) {
  if (command === "gh" && args[0] === "repo" && args[1] === "view") {
    return ok(JSON.stringify({
      nameWithOwner: "example/fixture",
      viewerPermission: overrides.permission || "WRITE",
    }));
  }
  if (command === "gh" && args[0] === "api" && args[1] === "user") {
    return ok(overrides.identity || "ship-bot");
  }
  if (command === "gh" && args[0] === "api" && args[1] === "repos/{owner}/{repo}") {
    if (overrides.settingsFailure) return fail("settings unavailable");
    if (overrides.settingsJson) return ok(overrides.settingsJson);
    return ok(JSON.stringify({
      allow_auto_merge: overrides.autoMerge ?? true,
      allow_squash_merge: overrides.squashMerge ?? true,
    }));
  }
  if (command === "gh" && args[0] === "api" && String(args[1]).includes("/protection")) {
    return ok(JSON.stringify({
      required_status_checks: { contexts: overrides.requiredChecks ?? ["quality"] },
      required_pull_request_reviews: {
        required_approving_review_count:
          overrides.requiredApprovalsEvidence ?? overrides.requiredApprovals ?? 0,
      },
    }));
  }
  return null;
}

test("Windows npm commands run through cmd.exe without enabling shell mode", () => {
  assert.deepEqual(
    resolveSpawnCommand("npm", ["run", "check:version"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm", "run", "check:version"],
    },
  );
  assert.deepEqual(
    resolveSpawnCommand("git", ["status"], { platform: "win32" }),
    { command: "git", args: ["status"] },
  );
});

function writeRun(runId, overrides = {}) {
  const dir = join(runsRoot, runId);
  const worktree = join(dir, "integrate", "wt");
  const repoRoot = join(root, "fixture");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return writeStatus(runId, {
    runId,
    state: "ship_gate_pending",
    repo: "fixture",
    repoRoot,
    target_dev_flow: "formal",
    baseRef: "main",
    startedAt: "2026-07-30T00:00:00.000Z",
    endedAt: null,
    lanes: [],
    integrate: {
      state: "ready",
      branch: `am/${runId}/integrate`,
      worktree,
      remote: "origin",
      diffStat: "feature.txt | 1 +",
    },
    delivery: {
      schema: "agent-manager.delivery.v1",
      mode: "single",
      state: "ship_gate_pending",
      releaseRequired: false,
      review: {
        state: "accepted",
        latestPass: 1,
        verdict: "accept",
        reviewer: "test-manager",
        history: [{ pass: 1, verdict: "accept", reviewer: "test-manager" }],
      },
      targets: [],
      release: { state: "pending", sha: null, tag: null, verifiedMergeShas: [] },
    },
    ...overrides,
  });
}

function formalExec(branch, mode = "merged") {
  let views = 0;
  return (command, args) => {
    const provider = providerCapabilityResponse(command, args);
    if (provider) return provider;
    if (command === "git") {
      if (args.includes("--version")) return ok("git version test");
      if (args.includes("branch") && args.includes("--show-current")) return ok(branch);
      if (args.includes("status")) return ok("");
      return ok();
    }
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth" && args[1] === "status") return ok("authenticated");
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      views += 1;
      if (views === 1) {
        return ok(JSON.stringify({
          state: "OPEN",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
          url: "https://example.invalid/pull/7",
          number: 7,
          headRefName: branch,
          baseRefName: "main",
        }));
      }
      if (mode === "conflict") {
        return ok(JSON.stringify({
          state: "OPEN",
          mergeStateStatus: "DIRTY",
          mergeable: "CONFLICTING",
          statusCheckRollup: [],
          url: "https://example.invalid/pull/7",
          number: 7,
          headRefName: branch,
          baseRefName: "main",
        }));
      }
      return ok(JSON.stringify({
        state: "MERGED",
        mergeStateStatus: "UNKNOWN",
        mergeable: "UNKNOWN",
        statusCheckRollup: [],
        url: "https://example.invalid/pull/7",
        number: 7,
        headRefName: branch,
        baseRefName: "main",
        mergeCommit: { oid: "abc123" },
      }));
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") return ok();
    return fail(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("ship handoff requires the exact approval and release inputs", () => {
  const runId = "run-ship-contract";
  writeRun(runId);
  assert.throws(() => prepareShipHandoff(runId, {}), /--approve all\|through-pr/);
  assert.throws(
    () => prepareShipHandoff(runId, { approve: "all" }),
    /--version <semver>/,
  );
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
  });
  assert.equal(handoff.flow, "formal");
  assert.equal(handoff.branch, `am/${runId}/integrate`);
});

test("Formal preflight freezes provider capabilities and fails before mutation on permission or policy drift", () => {
  const runId = "run-provider-preflight";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
  });
  const calls = [];
  const makeExec = (overrides = {}) => (command, args) => {
    calls.push([command, ...args]);
    const provider = providerCapabilityResponse(command, args, overrides);
    if (provider) return provider;
    if (command === "git" && args.includes("--version")) return ok("git version test");
    if (command === "git" && args.includes("branch")) return ok(handoff.branch);
    if (command === "git") return ok();
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth") return ok("authenticated");
    return fail(`unexpected command: ${command} ${args.join(" ")}`);
  };

  preflightShipHandoff(handoff, makeExec());
  const repoView = calls.find((call) => call[0] === "gh" && call[1] === "repo");
  assert.deepEqual(repoView, ["gh", "repo", "view", "--json", "nameWithOwner,viewerPermission"]);
  assert.equal(
    calls.some((call) => call[0] === "gh" && call[1] === "api" && call[2] === "repos/{owner}/{repo}"),
    true,
  );
  assert.equal(handoff.providerCapabilities.base.protected, true);
  assert.deepEqual(handoff.providerCapabilities.base.requiredChecks, ["quality"]);
  assert.equal(handoff.providerCapabilities.identity, "ship-bot");
  assert.throws(
    () => preflightShipHandoff(handoff, makeExec({ identity: "different-bot" })),
    /capabilities changed after preflight/,
  );

  const denied = { ...handoff, providerCapabilities: null };
  assert.throws(
    () => preflightShipHandoff(denied, makeExec({ permission: "READ" })),
    /requires write permission/,
  );
  const reviews = { ...handoff, providerCapabilities: null };
  assert.throws(
    () => preflightShipHandoff(reviews, makeExec({ requiredApprovals: 1 })),
    /requires 1 GitHub approving review/,
  );
  const noRequiredCi = { ...handoff, providerCapabilities: null };
  assert.throws(
    () => preflightShipHandoff(noRequiredCi, makeExec({ requiredChecks: [] })),
    /no inspectable required CI checks/,
  );
  const malformedApprovals = { ...handoff, providerCapabilities: null };
  assert.throws(
    () => preflightShipHandoff(
      malformedApprovals,
      makeExec({ requiredApprovalsEvidence: "unknown" }),
    ),
    /no inspectable required-review evidence/,
  );
  const malformedSettings = { ...handoff, providerCapabilities: null };
  assert.throws(
    () => preflightShipHandoff(malformedSettings, makeExec({ settingsJson: "[]" })),
    /malformed repository merge settings evidence/,
  );
  const failedSettings = { ...handoff, providerCapabilities: null };
  assert.throws(
    () => preflightShipHandoff(failedSettings, makeExec({ settingsFailure: true })),
    /inspect repository merge settings failed/,
  );
  assert.equal(
    calls.some((call) => call[0] === "git" && ["add", "commit", "push"].includes(call[1])),
    false,
    "capability failures happen before any repository mutation",
  );
});

test("a symbolic base ref is a moving pointer or a bare commit, not a branch", () => {
  assert.equal(isSymbolicBaseRef("HEAD"), true);
  assert.equal(isSymbolicBaseRef("@"), true);
  assert.equal(isSymbolicBaseRef(""), true);
  assert.equal(isSymbolicBaseRef(null), true);
  assert.equal(isSymbolicBaseRef("c".repeat(40)), true);
  assert.equal(isSymbolicBaseRef("main"), false);
  assert.equal(isSymbolicBaseRef("release/2026-08"), false);
  assert.equal(isSymbolicBaseRef("HEADroom"), false);
});

test("ship base resolves symbolic defaults and keeps the --base override", () => {
  const calls = [];
  const remoteHead = (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "symbolic-ref") return ok("origin/trunk");
    return fail("unexpected");
  };

  assert.deepEqual(
    resolveShipBase({ explicit: "release/2026-08", recorded: "HEAD", remote: "origin", cwd: root, exec: remoteHead }),
    { base: "release/2026-08", source: "override", resolvedFrom: null },
  );
  assert.deepEqual(calls, [], "an explicit base never needs resolution");

  assert.deepEqual(
    resolveShipBase({ explicit: null, recorded: "HEAD", remote: "origin", cwd: root, exec: remoteHead }),
    { base: "trunk", source: "remote-default", resolvedFrom: "HEAD" },
  );
  assert.deepEqual(
    resolveShipBase({ explicit: null, recorded: "origin/develop", remote: "origin", cwd: root, exec: remoteHead }),
    { base: "develop", source: "recorded", resolvedFrom: null },
  );
});

test("ship base falls back to GitHub, then to main, when the remote head is unknown", () => {
  const viaGh = (command, args) => {
    if (command === "gh" && args[0] === "repo") return ok("primary\n");
    return fail("no remote head");
  };
  assert.equal(resolveDefaultBaseBranch(viaGh, root, "origin"), "primary");
  assert.deepEqual(
    resolveShipBase({ explicit: null, recorded: "HEAD", remote: "origin", cwd: root, exec: viaGh }),
    { base: "primary", source: "remote-default", resolvedFrom: "HEAD" },
  );

  const blind = () => fail("offline");
  assert.equal(resolveDefaultBaseBranch(blind, root, "origin"), null);
  assert.deepEqual(
    resolveShipBase({ explicit: null, recorded: "d".repeat(40), remote: "origin", cwd: root, exec: blind }),
    { base: "main", source: "fallback", resolvedFrom: "d".repeat(40) },
  );
});

test("ship handoff never inherits a literal HEAD from the workflow base_ref", () => {
  const runId = "run-ship-symbolic-base";
  writeRun(runId, { baseRef: "HEAD" });
  const exec = (command, args) => {
    if (command === "git" && args[0] === "symbolic-ref") return ok("origin/trunk");
    return fail("unexpected");
  };

  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    exec,
  });
  assert.equal(handoff.base, "trunk");
  assert.equal(handoff.baseSource, "remote-default");
  assert.equal(handoff.baseResolvedFrom, "HEAD");

  const overridden = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    base: "main",
    exec,
  });
  assert.equal(overridden.base, "main");
  assert.equal(overridden.baseSource, "override");

  const queued = queueShip(runId, handoff);
  assert.equal(queued.status.ship.base, "trunk");
  assert.equal(queued.status.ship.baseSource, "remote-default");
});

test("shipping refuses a delivery target with no changed files", () => {
  const runId = "run-ship-no-code";
  const status = writeRun(runId);
  status.delivery.targets = [{
    id: "empty",
    laneId: "empty",
    state: "no_changes",
    branch: status.integrate.branch,
    base: "main",
    worktree: status.integrate.worktree,
    changedFiles: [],
  }];
  writeStatus(runId, status);
  assert.throws(
    () => prepareShipHandoff(runId, { approve: "through-pr", target: "empty" }),
    /refusing a no-code shipment/,
  );
});

test("shipping refuses an integrate target whose final diff is empty", () => {
  const runId = "run-ship-empty-integrate";
  writeRun(runId, {
    integrate: {
      state: "ready",
      branch: `am/${runId}/integrate`,
      worktree: join(runsRoot, runId, "integrate", "wt"),
      remote: "origin",
      diffStat: "",
    },
    delivery: {
      schema: "agent-manager.delivery.v1",
      mode: "single",
      state: "ship_gate_pending",
      releaseRequired: false,
      review: { state: "accepted", verdict: "accept", latestPass: 1, history: [] },
      targets: [{
        id: "integrate",
        laneId: "integrate",
        state: "changes_ready",
        branch: `am/${runId}/integrate`,
        base: "main",
        worktree: join(runsRoot, runId, "integrate", "wt"),
        changedFiles: ["feature.txt"],
      }],
      release: { state: "pending", verifiedMergeShas: [] },
    },
  });
  assert.throws(() => prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: should not ship",
  }), /integrate branch has no changed files/);
});

test("release ancestry verification fails closed when any train merge is absent", () => {
  const runId = "run-ship-ancestry";
  const status = writeRun(runId);
  status.delivery.targets = [
    { id: "one", state: "merged", mergeSha: "a".repeat(40) },
    { id: "two", state: "merged", mergeSha: "b".repeat(40) },
  ];
  status.ship = { targetId: "two", mergeSha: "b".repeat(40) };
  writeStatus(runId, status);
  const handoff = { flow: "formal", repoRoot: status.repoRoot };
  assert.throws(
    () => verifyDeliveryAncestry(runId, status, handoff, "c".repeat(40), (_command, args) =>
      args.includes("b".repeat(40)) ? fail("not ancestor") : ok()
    ),
    /does not contain expected merge/,
  );
});

test("formal release preparation uses a private worktree and leaves a dirty shared checkout untouched", () => {
  const runId = "run-private-release";
  const repo = join(root, "private-release-repo");
  const remote = join(root, "private-release-remote.git");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "chore: base"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });
  writeFileSync(join(repo, "operator-notes.txt"), "keep me\n");

  const releaseRoot = prepareReleaseWorkspace(runId, {
    runId,
    worktree: repo,
    remote: "origin",
    base: "main",
    version: "1.1.0",
  });
  assert.equal(releaseRoot, join(runsRoot, runId, "ship", "release", "wt"));
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
  assert.equal(existsSync(join(repo, "operator-notes.txt")), true);
  assert.match(execFileSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" }), /operator-notes/);
  assert.equal(
    execFileSync("git", ["-C", releaseRoot, "branch", "--show-current"], { encoding: "utf8" }).trim(),
    `am/${runId}/release-1.1.0`,
  );
});

test("Formal all stamps the open delivery PR, waits for its required check, and never pushes the base", async () => {
  const runId = "run-formal-one-pr";
  const repo = join(root, "formal-one-pr-repo");
  const remote = join(root, "formal-one-pr-remote.git");
  const laneWorktree = join(runsRoot, runId, "lane", "wt");
  const branch = `am/${runId}/lane`;
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(runsRoot, runId, "lane"), { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
  writeFileSync(
    join(repo, "Version.md"),
    "---\nenabled: true\ncurrent: 1.0.0\ndev_flow: formal\n---\n\n# Version History\n\n## 1.0.0 - 2026-07-01\n\nInitial release.\n",
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "one-pr-fixture", version: "1.0.0" }, null, 2) + "\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "chore: base"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, laneWorktree, "main"], { stdio: "ignore" });
  writeFileSync(join(laneWorktree, "feature.txt"), "approved feature\n");

  writeRun(runId, {
    repoRoot: repo,
    integrate: undefined,
    delivery: {
      schema: "agent-manager.delivery.v1",
      mode: "single",
      state: "ship_gate_pending",
      releaseRequired: true,
      review: { state: "accepted", latestPass: 1, verdict: "accept", reviewer: "test-manager", history: [] },
      targets: [{
        id: "lane",
        laneId: "lane",
        state: "changes_ready",
        branch,
        base: "main",
        worktree: laneWorktree,
        changedFiles: ["feature.txt"],
        prUrl: "https://example.invalid/pull/11",
        mergeSha: null,
      }],
      release: { state: "pending", sha: null, tag: null, verifiedMergeShas: [] },
    },
  });
  const handoff = prepareShipHandoff(runId, {
    approve: "all",
    target: "lane",
    commitMessage: "feat: approved feature",
    version: "1.1.0",
    summary: "Ship the approved feature and release stamp together.",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const calls = [];
  let mergeRequested = false;
  let postMergeViews = 0;
  let releaseSha = null;
  const exec = (command, args, options) => {
    calls.push([command, ...args]);
    const provider = providerCapabilityResponse(command, args);
    if (provider) return provider;
    const tagActions = tagActionsResponse(command, args, remote);
    if (tagActions) return tagActions;
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth") return ok("authenticated");
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") {
      mergeRequested = true;
      return ok();
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      if (mergeRequested) postMergeViews += 1;
      if (mergeRequested && postMergeViews >= 2) {
        releaseSha = execFileSync(
          "git",
          ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`],
          { encoding: "utf8" },
        ).trim();
        execFileSync("git", ["--git-dir", remote, "update-ref", "refs/heads/main", releaseSha]);
        return ok(JSON.stringify({
          state: "MERGED",
          mergeStateStatus: "UNKNOWN",
          mergeable: "UNKNOWN",
          statusCheckRollup: [{ name: "quality", status: "COMPLETED", conclusion: "SUCCESS" }],
          url: "https://example.invalid/pull/11",
          number: 11,
          headRefName: branch,
          baseRefName: "main",
          mergeCommit: { oid: releaseSha },
        }));
      }
      return ok(JSON.stringify({
        state: "OPEN",
        mergeStateStatus: mergeRequested ? "BLOCKED" : "CLEAN",
        mergeable: "MERGEABLE",
        statusCheckRollup: mergeRequested
          ? [{ name: "quality", status: "IN_PROGRESS", conclusion: null }]
          : [],
        url: "https://example.invalid/pull/11",
        number: 11,
        headRefName: branch,
        baseRefName: "main",
      }));
    }
    return execCommand(command, args, options);
  };
  const result = await runShip(runId, handoff, {
    exec,
    sleep: async () => {},
    tagRegistrationGraceMs: 0,
  });
  assert.equal(result.state, "released", result.ship.error);
  assert.equal(result.ship.releaseTransaction.mode, "delivery-pr");
  assert.equal(result.ship.releasePrUrl, null);
  assert.equal(result.ship.releaseSha, releaseSha);
  assert.equal(postMergeViews, 2, "the required check is observed before the merged state");
  assert.equal(
    calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create"),
    false,
    "the existing delivery PR remains the only PR",
  );
  assert.equal(
    calls.some((call) => call[0] === "git" && call[1] === "push" && call.includes("HEAD:main")),
    false,
    "Formal Flow never pushes a stamp directly to the base",
  );
  assert.match(
    execFileSync("git", ["--git-dir", remote, "show", "main:Version.md"], { encoding: "utf8" }),
    /current: 1\.1\.0/,
  );
});

test("Formal all tags a reviewed merge that already contains the complete version stamp", async () => {
  const runId = "run-prestamped-release-fixture";
  const repo = join(root, "prestamped-repo");
  const remote = join(root, "prestamped-remote.git");
  const laneWorktree = join(runsRoot, runId, "lane", "wt");
  const branch = `am/${runId}/lane`;
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(runsRoot, runId, "lane"), { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
  writeFileSync(
    join(repo, "Version.md"),
    "---\nenabled: true\ncurrent: 1.0.0\ndev_flow: formal\n---\n\n# Version History\n\n## 1.0.0 - 2026-07-01\n\nInitial release.\n",
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "prestamped-fixture", version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({
    name: "prestamped-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "prestamped-fixture", version: "1.0.0" } },
  }, null, 2) + "\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "chore: base"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, laneWorktree, "main"], { stdio: "ignore" });
  writeFileSync(join(laneWorktree, "feature.txt"), "approved release feature\n");
  applyVersionStamp(laneWorktree, "1.1.0", "Ship the reviewed release.", Date.UTC(2026, 7, 27));
  execFileSync("git", ["-C", laneWorktree, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", laneWorktree, "commit", "-m", "feat: ship reviewed release"], { stdio: "ignore" });
  execFileSync("git", ["-C", laneWorktree, "push", "-u", "origin", branch], { stdio: "ignore" });
  const mergeSha = execFileSync("git", ["-C", laneWorktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["--git-dir", remote, "update-ref", "refs/heads/main", mergeSha]);
  assert.equal(execFileSync("git", ["-C", laneWorktree, "status", "--porcelain"], { encoding: "utf8" }), "");

  writeRun(runId, {
    repoRoot: repo,
    integrate: undefined,
    delivery: {
      schema: "agent-manager.delivery.v1",
      mode: "single",
      state: "ship_gate_pending",
      releaseRequired: true,
      review: { state: "accepted", latestPass: 1, verdict: "accept", reviewer: "test-manager", history: [] },
      targets: [{
        id: "lane",
        laneId: "lane",
        state: "changes_ready",
        branch,
        base: "main",
        worktree: laneWorktree,
        changedFiles: ["Version.md", "feature.txt", "package-lock.json", "package.json"],
        prUrl: "https://example.invalid/pull/72",
        mergeSha: null,
      }],
      release: { mode: "tag-only", state: "pending", sha: null, tag: null, verifiedMergeShas: [] },
    },
  });
  const handoff = prepareShipHandoff(runId, {
    approve: "all",
    target: "lane",
    version: "1.1.0",
    summary: "Ship the reviewed release.",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const calls = [];
  const exec = (command, args, options) => {
    calls.push([command, ...args]);
    const capability = providerCapabilityResponse(command, args);
    if (capability) return capability;
    const tagActions = tagActionsResponse(command, args, remote);
    if (tagActions) return tagActions;
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth") return ok("authenticated");
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return ok(JSON.stringify({
        state: "MERGED",
        mergeStateStatus: "UNKNOWN",
        mergeable: "UNKNOWN",
        statusCheckRollup: [{ name: "quality", status: "COMPLETED", conclusion: "SUCCESS" }],
        url: "https://example.invalid/pull/72",
        number: 72,
        headRefName: branch,
        baseRefName: "main",
        mergeCommit: { oid: mergeSha },
      }));
    }
    return execCommand(command, args, options);
  };

  const result = await runShip(runId, handoff, {
    exec,
    sleep: async () => {},
    tagRegistrationGraceMs: 0,
  });
  assert.equal(result.state, "released", result.ship.error);
  assert.equal(result.ship.releaseSha, mergeSha);
  assert.equal(result.ship.releaseTransaction.stampState, "already-satisfied");
  assert.deepEqual(
    result.ship.releaseTransaction.manifest.files.map((entry) => entry.path),
    ["Version.md", "package-lock.json", "package.json"],
  );
  assert.equal(result.ship.releaseWorktree, undefined);
  assert.equal(calls.some((call) => call[0] === "git" && call[1] === "commit"), false);
  assert.equal(calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create"), false);
  assert.equal(calls.some((call) => call[0] === "git" && call[1] === "push" && call.includes(`release-1.1.0`)), false);
  assert.equal(
    execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/tags/v1.1.0"], { encoding: "utf8" }).trim(),
    mergeSha,
  );
});

test("Formal protected release PR is reused on retry while the shared checkout stays dirty", async () => {
  const runId = "run-formal-dirty-release";
  const repo = join(root, "formal-dirty-repo");
  const remote = join(root, "formal-dirty-remote.git");
  const laneWorktree = join(runsRoot, runId, "lane", "wt");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(runsRoot, runId, "lane"), { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
  writeFileSync(
    join(repo, "Version.md"),
    "---\nenabled: true\ncurrent: 1.0.0\ndev_flow: formal\n---\n\n# Version History\n\n## 1.0.0 - 2026-07-01\n\nInitial release.\n",
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "formal-fixture", version: "1.0.0" }, null, 2) + "\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "chore: base"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });
  const mergeSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const branch = `am/${runId}/lane`;
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, laneWorktree, "main"], { stdio: "ignore" });
  writeFileSync(join(repo, "operator-notes.txt"), "keep me\n");

  writeRun(runId, {
    repoRoot: repo,
    target_dev_flow: "formal",
    integrate: undefined,
    delivery: {
      schema: "agent-manager.delivery.v1",
      mode: "single",
      state: "release_pending",
      releaseRequired: true,
      review: { state: "accepted", latestPass: 1, verdict: "accept", reviewer: "test-manager", history: [] },
      targets: [{
        id: "lane",
        laneId: "lane",
        state: "merged",
        branch,
        base: "main",
        worktree: laneWorktree,
        changedFiles: ["feature.txt"],
        prUrl: "https://example.invalid/pull/9",
        mergeSha,
      }],
      release: { state: "pending", sha: null, tag: null, verifiedMergeShas: [] },
    },
  });
  const handoff = prepareShipHandoff(runId, {
    approve: "all",
    target: "lane",
    version: "1.1.0",
    summary: "Release from an isolated workspace.",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  let releasePrCreated = false;
  let releasePrCreateCount = 0;
  let releaseMergeRequested = false;
  let allowReleaseMerge = false;
  let releasePrMerged = false;
  let releaseSha = null;
  const exec = (command, args, options) => {
    const provider = providerCapabilityResponse(command, args);
    if (provider) return provider;
    const tagActions = tagActionsResponse(command, args, remote);
    if (tagActions) return tagActions;
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth") return ok("authenticated");
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      const target = String(args[2]);
      if (target.includes("release-") && !releasePrCreated) return fail("no pull requests found");
      if (target.includes("pull/10") || target.includes("release-")) {
        return ok(JSON.stringify({
          state: releasePrMerged ? "MERGED" : "OPEN",
          mergeStateStatus: releasePrMerged ? "UNKNOWN" : releaseMergeRequested && !allowReleaseMerge ? "DIRTY" : "CLEAN",
          mergeable: releasePrMerged ? "UNKNOWN" : releaseMergeRequested && !allowReleaseMerge ? "CONFLICTING" : "MERGEABLE",
          statusCheckRollup: releasePrMerged ? [{ name: "quality", status: "COMPLETED", conclusion: "SUCCESS" }] : [],
          url: "https://example.invalid/pull/10",
          number: 10,
          headRefName: `am/${runId}/release-1.1.0`,
          baseRefName: "main",
          mergeCommit: releasePrMerged ? { oid: releaseSha } : null,
        }));
      }
      return ok(JSON.stringify({
        state: "MERGED",
        mergeStateStatus: "UNKNOWN",
        mergeable: "UNKNOWN",
        statusCheckRollup: [],
        url: "https://example.invalid/pull/9",
        number: 9,
        headRefName: branch,
        baseRefName: "main",
        mergeCommit: { oid: mergeSha },
      }));
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      releasePrCreated = true;
      releasePrCreateCount += 1;
      return ok("https://example.invalid/pull/10");
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") {
      releaseMergeRequested = true;
      if (!allowReleaseMerge) return ok();
      releaseSha = execFileSync(
        "git",
        ["--git-dir", remote, "rev-parse", `refs/heads/am/${runId}/release-1.1.0`],
        { encoding: "utf8" },
      ).trim();
      execFileSync("git", ["--git-dir", remote, "update-ref", "refs/heads/main", releaseSha]);
      releasePrMerged = true;
      return ok();
    }
    return execCommand(command, args, options);
  };
  const blocked = await runShip(runId, handoff, { exec, sleep: async () => {} });
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.ship.error, /merge conflicts/);
  assert.equal(releasePrCreateCount, 1);

  allowReleaseMerge = true;
  releaseMergeRequested = false;
  const retry = prepareShipHandoff(runId, {
    approve: "all",
    target: "lane",
    version: "1.1.0",
    summary: "Release from an isolated workspace.",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, retry);
  const result = await runShip(runId, retry, {
    exec,
    sleep: async () => {},
    tagRegistrationGraceMs: 0,
  });
  assert.equal(result.state, "released", result.ship.error);
  assert.equal(result.ship.attempt, 2);
  assert.equal(result.ship.releasePrUrl, "https://example.invalid/pull/10");
  assert.equal(releasePrCreateCount, 1, "the blocked release PR is reused instead of duplicated");
  assert.equal(result.ship.tag, "v1.1.0");
  assert.match(result.ship.releaseWorktree, /ship[\\/]release[\\/]wt$/);
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
  assert.equal(existsSync(join(repo, "operator-notes.txt")), true);
});

test("Formal through-pr shipping records PR merge telemetry and events", async () => {
  const runId = "run-ship-through-pr";
  const initial = writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const queued = readStatus(runId);
  const result = await runShip(runId, handoff, {
    exec: formalExec(handoff.branch),
    sleep: async () => {},
  });
  assert.equal(result.state, "merged");
  assert.equal(result.ship.state, "done");
  assert.equal(result.ship.prUrl, "https://example.invalid/pull/7");
  assert.equal(result.ship.mergeSha, "abc123");
  assert.equal(result.ship.tag, null);
  const events = readEvents(runId);
  assert.ok(events.some((event) => event.ship?.phase === "merge"));
  assert.equal(classifyWake(initial, queued).reason, "state_change");
});

test("Formal merge conflicts block and wake the operator", async () => {
  const runId = "run-ship-conflict";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const running = readStatus(runId);
  const result = await runShip(runId, handoff, {
    exec: formalExec(handoff.branch, "conflict"),
    sleep: async () => {},
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.ship.state, "blocked");
  assert.match(result.ship.needsInput.prompt, /merge conflicts/);
  const wake = classifyWake(running, result);
  assert.equal(wake.reason, "needs_input");
  assert.equal(wake.phase, "ship");

  const retry = prepareShipHandoff(runId, {
    approve: "through-pr",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, retry);
  const recovered = await runShip(runId, retry, {
    exec: formalExec(retry.branch),
    sleep: async () => {},
  });
  assert.equal(recovered.state, "merged");
  assert.equal(recovered.ship.attempt, 2);
});

test("Simple all shipping stamps, pushes, waits for CI, and tags", async () => {
  const runId = "run-ship-simple";
  const repo = join(root, "simple-repo");
  const remote = join(root, "simple-remote.git");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repo, "Version.md"),
    "---\nenabled: true\ncurrent: 1.0.0\ndev_flow: simple\n---\n\n# Version History\n\n## 1.0.0 - 2026-07-01\n\nInitial release.\n",
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }, null, 2) + "\n",
  );
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "chore: initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });

  const deliveryBranch = "am/run-ship-simple/lane";
  execFileSync("git", ["-C", repo, "switch", "-c", deliveryBranch], { stdio: "ignore" });
  writeFileSync(join(repo, "feature.txt"), "approved feature\n");

  writeRun(runId, {
    repo: ".",
    repoRoot: repo,
    target_dev_flow: "simple",
    integrate: undefined,
    delivery: {
      schema: "agent-manager.delivery.v1",
      mode: "single",
      state: "ship_gate_pending",
      releaseRequired: true,
      review: {
        state: "accepted",
        latestPass: 1,
        verdict: "accept",
        reviewer: "test-manager",
        history: [{ pass: 1, verdict: "accept", reviewer: "test-manager" }],
      },
      targets: [{
        id: "lane",
        laneId: "lane",
        state: "changes_ready",
        branch: deliveryBranch,
        base: "main",
        worktree: repo,
        changedFiles: ["feature.txt"],
        prUrl: null,
        mergeSha: null,
      }],
      release: { state: "pending", sha: null, tag: null, verifiedMergeShas: [] },
    },
  });
  const handoff = prepareShipHandoff(runId, {
    approve: "all",
    base: "main",
    remote: "origin",
    commitMessage: "feat: ship approved release",
    version: "1.1.0",
    summary: "Add detached shipping.",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  let actionReads = 0;
  const actionReadTagPresence = [];
  const exec = (command, args, options) => {
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth" && args[1] === "status") return ok("authenticated");
    if (command === "gh" && args[0] === "run" && args[1] === "list") {
      actionReads += 1;
      const sha = args[args.indexOf("--commit") + 1];
      actionReadTagPresence.push(
        execCommand("git", ["ls-remote", "--tags", remote, "refs/tags/v1.1.0"], { cwd: repo }).stdout,
      );
      const runs = [{
        databaseId: 1,
        status: "completed",
        conclusion: "success",
        url: "https://example.invalid/actions/1",
        workflowName: "CI",
        event: "push",
        headSha: sha,
      }];
      if (actionReads >= 3) {
        runs.push({
          databaseId: 2,
          status: "completed",
          conclusion: "success",
          url: "https://example.invalid/actions/2",
          workflowName: "Publish",
          event: "push",
          headSha: sha,
        });
      }
      return ok(JSON.stringify(runs));
    }
    return execCommand(command, args, options);
  };
  const result = await runShip(runId, handoff, {
    exec,
    sleep: async () => {},
    tagRegistrationGraceMs: 0,
  });
  assert.equal(result.state, "released");
  assert.equal(result.ship.tag, "v1.1.0");
  assert.equal(result.ship.ci.state, "green");
  assert.equal(result.ship.ci.runs[0].workflow, "Publish");
  assert.equal(result.ship.ci.runs[0].status, "completed");
  assert.deepEqual(result.ship.releaseCi.beforeRunIds, ["1"]);
  assert.deepEqual(result.ship.releaseCi.runs.map((run) => run.id), ["2"]);
  assert.equal(actionReadTagPresence[1], "", "the Actions snapshot precedes the tag push");
  assert.notEqual(actionReadTagPresence[2], "", "new Actions runs are discovered after the tag push");
  assert.equal(result.delivery.targets[0].state, "merged");
  assert.equal(result.delivery.targets[0].mergeSha, result.ship.releaseSha);
  assert.equal(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version, "1.1.0");
  assert.equal(
    execFileSync("git", ["ls-remote", "--tags", remote, "refs/tags/v1.1.0"], { encoding: "utf8" }).trim().length > 0,
    true,
  );
  assert.equal(existsSync(join(runsRoot, runId, "ship", "summary.json")), true);
});

test("tag-triggered release CI blocks with the failed workflow URL", async () => {
  const runId = "run-tag-ci-failure";
  const sha = "release-sha";
  const status = writeRun(runId);
  status.ship = {
    state: "running",
    phase: "tag",
    steps: [],
    remoteRetries: 0,
    releaseCi: {
      sha,
      state: "snapshotted",
      beforeRunIds: ["10"],
      runs: [],
    },
  };
  writeStatus(runId, status);
  const exec = (command, args) => {
    assert.equal(command, "gh");
    assert.deepEqual(args.slice(0, 2), ["run", "list"]);
    return ok(JSON.stringify([
      {
        databaseId: 10,
        status: "completed",
        conclusion: "success",
        workflowName: "Branch CI",
        url: "https://example.invalid/actions/10",
        event: "push",
        headSha: sha,
      },
      {
        databaseId: 11,
        status: "completed",
        conclusion: "failure",
        workflowName: "Publish",
        url: "https://example.invalid/actions/11",
        event: "push",
        headSha: sha,
      },
    ]));
  };
  await assert.rejects(
    observeTagTriggeredRuns(
      runId,
      status,
      { repoRoot: root, timeoutSec: 5, pollSec: 1, retryAttempts: 1 },
      sha,
      { exec, sleep: async () => {}, now: () => 0 },
    ),
    /Publish \(https:\/\/example\.invalid\/actions\/11\)/,
  );
  assert.equal(readStatus(runId).ship.releaseCi.state, "failed");
});

test("tag-triggered release CI retains later runs and waits for every run", async () => {
  const runId = "run-tag-ci-later-registration";
  const sha = "release-sha";
  const status = writeRun(runId);
  status.ship = {
    state: "running",
    phase: "tag",
    steps: [],
    remoteRetries: 0,
    releaseCi: {
      sha,
      state: "snapshotted",
      beforeRunIds: [],
      runs: [],
    },
  };
  writeStatus(runId, status);
  let clock = 0;
  let reads = 0;
  const run = (id, runStatus, conclusion) => ({
    databaseId: id,
    status: runStatus,
    conclusion,
    workflowName: `Publish ${id}`,
    url: `https://example.invalid/actions/${id}`,
    event: "push",
    headSha: sha,
  });
  const result = await observeTagTriggeredRuns(
    runId,
    status,
    { repoRoot: root, timeoutSec: 10, pollSec: 1, retryAttempts: 1 },
    sha,
    {
      exec: () => {
        reads += 1;
        if (reads === 1) return ok(JSON.stringify([run(1, "completed", "success")]));
        if (reads === 2) {
          return ok(JSON.stringify([
            run(1, "completed", "success"),
            run(2, "in_progress", null),
          ]));
        }
        return ok(JSON.stringify([
          run(1, "completed", "success"),
          run(2, "completed", "success"),
        ]));
      },
      sleep: async () => {
        clock += 1_000;
      },
      now: () => clock,
      tagRegistrationGraceMs: 2_000,
    },
  );
  assert.equal(reads, 3);
  assert.deepEqual(result.ship.releaseCi.runs.map((item) => item.id), ["1", "2"]);
  assert.equal(result.ship.releaseCi.state, "green");
});

test("tag-triggered release CI records not configured after bounded registration grace", async () => {
  const runId = "run-tag-ci-not-configured";
  const sha = "release-sha";
  const status = writeRun(runId);
  status.ship = {
    state: "running",
    phase: "tag",
    steps: [],
    remoteRetries: 0,
    releaseCi: {
      sha,
      state: "snapshotted",
      beforeRunIds: [],
      runs: [],
    },
  };
  writeStatus(runId, status);
  let clock = 0;
  const result = await observeTagTriggeredRuns(
    runId,
    status,
    { repoRoot: root, timeoutSec: 60, pollSec: 1, retryAttempts: 1 },
    sha,
    {
      exec: () => ok("[]"),
      sleep: async () => {
        clock += 30_000;
      },
      now: () => clock,
    },
  );
  assert.equal(result.ship.releaseCi.state, "not_configured");
  assert.equal(result.ship.ci.state, "not_configured");
  assert.match(result.ship.steps.find((step) => step.name === "ci").detail, /not configured/);
});

test("CLI ship detaches and completes in the background", async () => {
  const runId = "run-ship-detached";
  const repo = join(root, "detached-repo");
  const remote = join(root, "detached-remote.git");
  const fakeGh = join(root, "fake-gh.mjs");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" });
  writeFileSync(
    join(repo, "Version.md"),
    "---\nenabled: true\ncurrent: 1.0.0\ndev_flow: simple\n---\n\n# Version History\n\n## 1.0.0 - 2026-07-01\n\nInitial release.\n",
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "detached-fixture", version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify({ name: "detached-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "detached-fixture", version: "1.0.0" } } }, null, 2) + "\n",
  );
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "chore: initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "-u", "origin", "main"], { stdio: "ignore" });
  writeFileSync(
    fakeGh,
    [
      'if (process.argv[2] === "--version") {',
      '  console.log("gh version test");',
      '} else if (process.argv[2] === "auth" && process.argv[3] === "status") {',
      '  console.log("authenticated");',
      '} else if (process.argv[2] === "run" && process.argv[3] === "list") {',
      '  const { execFileSync } = await import("node:child_process");',
      '  const sha = process.argv[process.argv.indexOf("--commit") + 1];',
      '  let tagged = false;',
      '  try { execFileSync("git", ["rev-parse", "--verify", "refs/tags/v1.1.0"], { stdio: "ignore" }); tagged = true; } catch {}',
      '  console.log(JSON.stringify(tagged ? [{ databaseId: 1, status: "completed", conclusion: "success", url: "https://example.invalid/actions/1", workflowName: "Publish", event: "push", headSha: sha }] : []));',
      "} else {",
      '  console.error("unexpected fake gh command");',
      "  process.exitCode = 2;",
      "}",
    ].join("\n") + "\n",
  );
  writeRun(runId, {
    repo: ".",
    repoRoot: repo,
    target_dev_flow: "simple",
    integrate: undefined,
  });

  const cli = join(process.cwd(), "bin", "agent-manager.mjs");
  const launch = JSON.parse(execFileSync(
    process.execPath,
    [
      cli,
      "ship",
      runId,
      "--approve",
      "all",
      "--branch",
      "main",
      "--base",
      "main",
      "--commit-message",
      "feat: detached approved release",
      "--version",
      "1.1.0",
      "--summary",
      "Add detached shipping.",
      "--poll-sec",
      "1",
      "--timeout-sec",
      "2",
      "--detach",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_MANAGER_GH_BIN: fakeGh },
      encoding: "utf8",
      windowsHide: true,
    },
  ));
  assert.equal(launch.state, "detached");
  assert.equal(launch.phase, "ship");

  const deadline = Date.now() + 20_000;
  let status;
  while (Date.now() < deadline) {
    status = readStatus(runId);
    if (["released", "blocked", "failed", "cancelled"].includes(status?.state)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.equal(status?.state, "released", readFileSync(launch.supervisorLog, "utf8"));
  assert.equal(status.ship.tag, "v1.1.0");
});

test("diagnoseBlockedMerge detects required check name mismatch", () => {
  const pr = {
    state: "OPEN",
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
    reviewDecision: "",
    baseRefName: "release/next",
    statusCheckRollup: [
      {
        name: "Quality + mandatory Chromium journey",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
  };
  const exec = (command, args) => {
    assert.equal(command, "gh");
    assert.ok(args.includes("repos/{owner}/{repo}/branches/release%2Fnext/protection/required_status_checks"));
    return ok(JSON.stringify({
      contexts: ["quality"],
      checks: [{ context: "browser" }],
    }));
  };
  const error = diagnoseBlockedMerge(pr, exec, root);
  assert.ok(error instanceof ShipBlockedError);
  assert.match(error.message, /exact name: browser, quality/);
  assert.match(error.message, /Quality \+ mandatory Chromium journey/);
  assert.ok(error.options.some((option) => /display name/i.test(option)));
  assert.ok(error.options.some((option) => /human PR approval/i.test(option)));
});

test("diagnoseBlockedMerge waits while checks are still running", () => {
  const error = diagnoseBlockedMerge(
    {
      state: "OPEN",
      mergeStateStatus: "BLOCKED",
      reviewDecision: "",
      baseRefName: "main",
      statusCheckRollup: [
        { name: "quality", status: "IN_PROGRESS", conclusion: "" },
      ],
    },
    () => ok(JSON.stringify(["quality"])),
    root,
  );
  assert.equal(error, null);
});

test("blocked pull requests receive a bounded check-registration grace period", () => {
  const pr = { mergeStateStatus: "BLOCKED", statusCheckRollup: [] };
  assert.equal(isWithinCheckRegistrationGrace(pr, 89_999, 90), true);
  assert.equal(isWithinCheckRegistrationGrace(pr, 90_000, 90), false);
  assert.equal(isWithinCheckRegistrationGrace({ ...pr, statusCheckRollup: [{}] }, 1, 90), false);
});
