import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agent-manager-ship-retry-"));
const runsRoot = join(root, "runs");
process.env.AGENT_MANAGER_DEV_ROOT = root;
process.env.AGENT_MANAGER_RUNS_ROOT = runsRoot;
mkdirSync(runsRoot, { recursive: true });

const {
  classifyPrBlock,
  evaluateVersionPlan,
  execCommand,
  isTransientRemoteFailure,
  prepareShipHandoff,
  queueShip,
  remoteBackoffMs,
  runShip,
  ShipBlockedError,
} = await import("../src/ship-run.mjs?ship-retry-test");
const { readStatus, writeStatus } = await import("../src/status.mjs?ship-retry-test");

test.after(() => rmSync(root, { recursive: true, force: true }));

function ok(stdout = "") {
  return { ok: true, status: 0, stdout, stderr: "" };
}

function fail(stderr = "failed") {
  return { ok: false, status: 1, stdout: "", stderr };
}

function tagActionsResponse(command, args, remote, tag) {
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

function providerCapabilityResponse(command, args) {
  if (command === "gh" && args[0] === "repo" && args[1] === "view") {
    return ok(JSON.stringify({
      nameWithOwner: "example/fixture",
      viewerPermission: "WRITE",
    }));
  }
  if (command === "gh" && args[0] === "api" && args[1] === "user") return ok("ship-bot");
  if (command === "gh" && args[0] === "api" && args[1] === "repos/{owner}/{repo}") {
    return ok(JSON.stringify({
      allow_auto_merge: true,
      allow_squash_merge: true,
    }));
  }
  if (command === "gh" && args[0] === "api" && String(args[1]).includes("/protection")) {
    return ok(JSON.stringify({
      required_status_checks: { contexts: ["quality"] },
      required_pull_request_reviews: { required_approving_review_count: 0 },
    }));
  }
  return null;
}

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
    startedAt: "2026-08-15T00:00:00.000Z",
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

/**
 * Formal through-pr exec double. `prViews` is consumed one entry per `gh pr view`; each
 * entry is either an exec result (an injected transport failure) or a PR payload.
 */
function prExec(branch, prViews) {
  const calls = { prView: 0, prCreate: 0, updateBranch: 0 };
  const queue = [...prViews];
  const exec = (command, args) => {
    const provider = providerCapabilityResponse(command, args);
    if (provider) return provider;
    if (command === "git") {
      if (args.includes("--version")) return ok("git version test");
      if (args.includes("branch") && args.includes("--show-current")) return ok(branch);
      if (args.includes("status")) return ok("");
      return ok();
    }
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth") return ok("authenticated");
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      calls.prView += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next && next.ok === false) return next;
      return ok(JSON.stringify({
        state: "OPEN",
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
        statusCheckRollup: [],
        url: "https://example.invalid/pull/12",
        number: 12,
        headRefName: branch,
        baseRefName: "main",
        ...next,
      }));
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") return ok();
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      calls.prCreate += 1;
      return ok("https://example.invalid/pull/12");
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "update-branch") {
      calls.updateBranch += 1;
      return ok();
    }
    return fail(`unexpected command: ${command} ${args.join(" ")}`);
  };
  exec.calls = calls;
  return exec;
}

const MERGED = {
  state: "MERGED",
  mergeStateStatus: "UNKNOWN",
  mergeable: "UNKNOWN",
  mergeCommit: { oid: "f".repeat(40) },
};

test("transient transport failures are told apart from answers GitHub actually gave", () => {
  const transient = [
    "read tcp 10.0.0.1:443: connection reset by peer",
    "Post \"https://api.github.com/graphql\": net/http: TLS handshake timeout",
    "dial tcp: lookup api.github.com: no such host EAI_AGAIN",
    "error connecting to api.github.com: ECONNRESET",
    "spawnSync gh ETIMEDOUT",
    "HTTP 502 (https://api.github.com/graphql)",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503",
    "error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly",
    "fatal: could not resolve host: github.com",
    "502 Bad Gateway",
  ];
  for (const stderr of transient) {
    assert.equal(isTransientRemoteFailure(fail(stderr)), true, stderr);
  }

  const hard = [
    "no pull requests found for branch \"am/run/integrate\"",
    "gh: Not Found (HTTP 404)",
    "You must be authenticated. Run: gh auth login",
    "GraphQL: Resource not accessible by integration",
    "fatal: not a git repository",
  ];
  for (const stderr of hard) {
    assert.equal(isTransientRemoteFailure(fail(stderr)), false, stderr);
  }

  assert.equal(isTransientRemoteFailure(ok("connection reset by peer")), false, "a success is never transient");
  assert.equal(isTransientRemoteFailure(null), false);
});

test("remote retries back off exponentially and stay capped", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((attempt) => remoteBackoffMs(attempt, 1_000)),
    [1_000, 2_000, 4_000, 8_000],
  );
  assert.equal(remoteBackoffMs(10, 1_000), 30_000, "backoff is capped");
  assert.equal(remoteBackoffMs(1, 250), 250);
});

test("a transient GitHub error is retried with backoff and never blocks the ship", async () => {
  const runId = "run-retry-recovers";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    pollSec: 1,
    timeoutSec: 60,
  });
  queueShip(runId, handoff);

  // Discovery view succeeds; the merge poll fails twice on the wire, then answers MERGED.
  const exec = prExec(handoff.branch, [
    {},
    fail("net/http: TLS handshake timeout"),
    fail("read tcp 10.0.0.1:443: connection reset by peer"),
    MERGED,
  ]);
  const delays = [];
  const result = await runShip(runId, handoff, {
    exec,
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(result.state, "merged");
  assert.equal(result.ship.state, "done");
  assert.equal(result.ship.mergeSha, "f".repeat(40));
  assert.equal(result.ship.needsInput, null);
  assert.equal(result.ship.remoteRetries, 2, "both transport failures were retried");
  assert.deepEqual(delays.slice(0, 2), [1_000, 2_000], "backoff grew between attempts");
  assert.equal(exec.calls.prView, 4);
});

test("a behind delivery branch is updated in place without opening a new pull request", async () => {
  const runId = "run-ship-behind-update";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const exec = prExec(handoff.branch, [
    { state: "OPEN", mergeStateStatus: "CLEAN" },
    { state: "OPEN", mergeStateStatus: "BEHIND" },
    MERGED,
  ]);
  const result = await runShip(runId, handoff, {
    exec,
    sleep: async () => {},
  });
  assert.equal(result.state, "merged");
  assert.equal(exec.calls.updateBranch, 1);
  assert.equal(exec.calls.prCreate, 0, "the existing pull request is retained");
});

test("consecutive transient failures block only after the retry budget is spent", async () => {
  const runId = "run-retry-exhausted";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    pollSec: 1,
    timeoutSec: 60,
    retryAttempts: 4,
  });
  queueShip(runId, handoff);

  const exec = prExec(handoff.branch, [{}, fail("net/http: TLS handshake timeout")]);
  const delays = [];
  const result = await runShip(runId, handoff, {
    exec,
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.ship.state, "blocked");
  assert.match(result.ship.needsInput.prompt, /Unable to read pull request after 4 attempts/);
  assert.match(result.ship.needsInput.prompt, /TLS handshake timeout/);
  assert.equal(exec.calls.prView, 5, "one discovery read plus four bounded poll attempts");
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
});

test("a hard GitHub answer blocks on the first attempt without burning retries", async () => {
  const runId = "run-retry-hard-failure";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    pollSec: 1,
    timeoutSec: 60,
  });
  queueShip(runId, handoff);

  const exec = prExec(handoff.branch, [{}, fail("gh: Not Found (HTTP 404)")]);
  const delays = [];
  const result = await runShip(runId, handoff, {
    exec,
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(result.state, "blocked");
  assert.match(result.ship.needsInput.prompt, /Unable to read pull request: gh: Not Found/);
  assert.doesNotMatch(result.ship.needsInput.prompt, /attempts/);
  assert.equal(exec.calls.prView, 2, "no retry for an answer GitHub actually gave");
  assert.deepEqual(delays, []);
});

test("a stale BLOCKED read is re-polled once and does not end the ship", async () => {
  const runId = "run-stale-blocked-read";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    pollSec: 1,
    timeoutSec: 60,
    checkGraceSec: 0,
  });
  queueShip(runId, handoff);

  // Poll 1 reads BLOCKED with a green check (a pre-CI stale answer), the confirming
  // re-poll reads the truth: CLEAN, then MERGED.
  const exec = prExec(handoff.branch, [
    {},
    {
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ name: "quality", status: "COMPLETED", conclusion: "SUCCESS" }],
    },
    { mergeStateStatus: "CLEAN" },
    MERGED,
  ]);
  const result = await runShip(runId, handoff, { exec, sleep: async () => {} });

  assert.equal(result.state, "merged");
  assert.equal(result.ship.state, "done");
  assert.equal(result.ship.staleBlockedReads, 1);
  assert.equal(result.ship.needsInput, null);
});

test("a blocked pull request still blocks once the re-poll confirms it", async () => {
  const runId = "run-confirmed-blocked";
  writeRun(runId);
  const handoff = prepareShipHandoff(runId, {
    approve: "through-pr",
    commitMessage: "feat: approved branch",
    pollSec: 1,
    timeoutSec: 60,
    checkGraceSec: 0,
  });
  queueShip(runId, handoff);

  const exec = prExec(handoff.branch, [
    {},
    {
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ name: "quality", status: "COMPLETED", conclusion: "FAILURE" }],
    },
  ]);
  const result = await runShip(runId, handoff, { exec, sleep: async () => {} });

  assert.equal(result.state, "blocked");
  assert.match(result.ship.needsInput.prompt, /checks failed: quality/);
  assert.equal(result.ship.staleBlockedReads, undefined);
  assert.equal(exec.calls.prView, 3, "the block was confirmed by a second read");
});

test("classifyPrBlock holds its verdict inside the check-registration grace window", () => {
  const pr = {
    state: "OPEN",
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
    reviewDecision: "",
    baseRefName: "main",
    statusCheckRollup: [],
  };
  const exec = () => ok(JSON.stringify(["quality"]));
  assert.equal(classifyPrBlock(pr, { exec, cwd: root, insideCheckGrace: true }), null);

  const conflicted = { ...pr, mergeable: "CONFLICTING" };
  const verdict = classifyPrBlock(conflicted, { exec, cwd: root, insideCheckGrace: true });
  assert.ok(verdict instanceof ShipBlockedError, "conflicts do not wait out the grace window");
  assert.match(verdict.message, /merge conflicts/);
});

test("a version plan is judged against the base branch it was stamped on", () => {
  const plan = {
    version: "1.20.0",
    baseVersion: "1.19.0",
    baseSha: "a".repeat(40),
    releaseSha: null,
  };

  assert.equal(
    evaluateVersionPlan(plan, { available: true, baseSha: "a".repeat(40), current: "1.19.0" }).state,
    "current",
    "an unmoved base keeps the approved plan",
  );
  assert.equal(
    evaluateVersionPlan({ ...plan, baseSha: null }, { available: true, baseSha: "b".repeat(40), current: "1.19.0" }).state,
    "current",
    "a first attempt has no earlier plan to invalidate",
  );
  assert.equal(
    evaluateVersionPlan(plan, { available: false, baseSha: null, current: null }).state,
    "unverified",
    "an unreadable base fails soft rather than blocking a good ship",
  );
  assert.equal(
    evaluateVersionPlan(
      { ...plan, releaseSha: "b".repeat(40) },
      { available: true, baseSha: "b".repeat(40), current: "1.20.0" },
    ).state,
    "applied",
    "the base moved because this ship pushed its own stamp",
  );
  assert.equal(
    evaluateVersionPlan(plan, { available: true, baseSha: "c".repeat(40), current: "1.19.1" }).state,
    "rebased",
    "the base moved but the approved version is still ahead",
  );

  const stale = evaluateVersionPlan(plan, { available: true, baseSha: "c".repeat(40), current: "1.20.0" });
  assert.equal(stale.state, "stale");
  assert.equal(stale.bump, "minor");
  assert.equal(stale.recommended, "1.21.0", "the approved bump is recomputed on the new base");

  const major = evaluateVersionPlan(
    { version: "2.0.0", baseVersion: "1.19.0", baseSha: "a".repeat(40) },
    { available: true, baseSha: "c".repeat(40), current: "2.0.0" },
  );
  assert.equal(major.recommended, "3.0.0");

  const unknownBase = evaluateVersionPlan(
    { version: "1.20.0", baseSha: "a".repeat(40) },
    { available: true, baseSha: "c".repeat(40), current: "1.21.0" },
  );
  assert.equal(unknownBase.state, "stale");
  assert.equal(unknownBase.recommended, null, "no recorded plan base means no invented recommendation");
});

test("a resumed ship refuses to stamp a version the base branch has passed", async () => {
  const runId = "run-stale-version-plan";
  const repo = join(root, "stale-plan-repo");
  const remote = join(root, "stale-plan-remote.git");
  const clone = join(root, "stale-plan-clone");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "remote", "add", "origin", remote);
  const versionDoc = (current, history) =>
    `---\nenabled: true\ncurrent: ${current}\ndev_flow: simple\n---\n\n# Version History\n\n${history}`;
  writeFileSync(join(repo, "Version.md"), versionDoc("1.19.0", "## 1.19.0 - 2026-08-01\n\nPrevious release.\n"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "stale-fixture", version: "1.19.0" }, null, 2) + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "chore: base");
  git(repo, "push", "-u", "origin", "main");
  const planBaseSha = git(repo, "rev-parse", "HEAD");

  const deliveryBranch = `am/${runId}/lane`;
  git(repo, "switch", "-c", deliveryBranch);
  writeFileSync(join(repo, "feature.txt"), "approved feature\n");

  // Someone else releases 1.20.0 on main while this ship sits blocked.
  execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
  git(clone, "config", "user.name", "Other");
  git(clone, "config", "user.email", "other@example.invalid");
  writeFileSync(
    join(clone, "Version.md"),
    versionDoc("1.20.0", "## 1.20.0 - 2026-08-14\n\nSomeone else shipped first.\n\n## 1.19.0 - 2026-08-01\n\nPrevious release.\n"),
  );
  git(clone, "add", "-A");
  git(clone, "commit", "-m", "chore: release 1.20.0");
  git(clone, "push", "origin", "main");

  const status = writeRun(runId, {
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
  // An earlier attempt stamped this plan against main @ 1.19.0.
  status.ship = {
    state: "blocked",
    attempt: 1,
    versionPlan: {
      version: "1.20.0",
      baseVersion: "1.19.0",
      baseSha: planBaseSha,
      releaseSha: null,
    },
  };
  writeStatus(runId, status);

  const handoff = prepareShipHandoff(runId, {
    approve: "all",
    base: "main",
    remote: "origin",
    commitMessage: "feat: ship approved release",
    version: "1.20.0",
    summary: "Add ship resilience.",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const exec = (command, args, options) => {
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth") return ok("authenticated");
    const tagActions = tagActionsResponse(command, args, remote, "v1.20.0");
    if (tagActions) return tagActions;
    return execCommand(command, args, options);
  };
  const result = await runShip(runId, handoff, { exec, sleep: async () => {} });

  assert.equal(result.state, "blocked");
  assert.match(result.ship.needsInput.prompt, /version plan 1\.20\.0 is stale/);
  assert.match(result.ship.needsInput.prompt, /now carries 1\.20\.0/);
  assert.ok(
    result.ship.needsInput.options.some((option) => option.includes("--version 1.21.0")),
    "the operator is handed the recomputed version",
  );
  assert.equal(result.ship.tag, null);
  assert.equal(
    JSON.parse(execFileSync("git", ["-C", repo, "show", "HEAD:package.json"], { encoding: "utf8" })).version,
    "1.19.0",
    "the stale plan was never stamped",
  );
  assert.equal(
    execFileSync("git", ["ls-remote", "--tags", remote, "refs/tags/v1.20.0"], { encoding: "utf8" }).trim(),
    "",
    "no tag was published against the stale plan",
  );
});

test("a ship whose base advanced under it keeps a version that is still ahead", async () => {
  const runId = "run-rebased-version-plan";
  const repo = join(root, "rebased-plan-repo");
  const remote = join(root, "rebased-plan-remote.git");
  const clone = join(root, "rebased-plan-clone");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "remote", "add", "origin", remote);
  writeFileSync(
    join(repo, "Version.md"),
    "---\nenabled: true\ncurrent: 1.19.0\ndev_flow: simple\n---\n\n# Version History\n\n## 1.19.0 - 2026-08-01\n\nPrevious release.\n",
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "rebased-fixture", version: "1.19.0" }, null, 2) + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "chore: base");
  git(repo, "push", "-u", "origin", "main");
  const planBaseSha = git(repo, "rev-parse", "HEAD");

  // main advances with a docs commit — no release, so the approved version still holds.
  execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
  git(clone, "config", "user.name", "Other");
  git(clone, "config", "user.email", "other@example.invalid");
  writeFileSync(join(clone, "README.md"), "docs\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-m", "docs: notes");
  git(clone, "push", "origin", "main");

  git(repo, "fetch", "origin", "main");
  git(repo, "merge", "--ff-only", "origin/main");
  writeFileSync(join(repo, "feature.txt"), "approved feature\n");

  const status = writeRun(runId, {
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
        branch: "main",
        base: "main",
        worktree: repo,
        changedFiles: ["feature.txt"],
        prUrl: null,
        mergeSha: null,
      }],
      release: { state: "pending", sha: null, tag: null, verifiedMergeShas: [] },
    },
  });
  status.ship = {
    state: "blocked",
    attempt: 1,
    versionPlan: { version: "1.20.0", baseVersion: "1.19.0", baseSha: planBaseSha, releaseSha: null },
  };
  writeStatus(runId, status);

  const handoff = prepareShipHandoff(runId, {
    approve: "all",
    branch: "main",
    base: "main",
    remote: "origin",
    commitMessage: "feat: ship approved release",
    version: "1.20.0",
    summary: "Add ship resilience.",
    pollSec: 1,
    timeoutSec: 5,
  });
  queueShip(runId, handoff);
  const exec = (command, args, options) => {
    if (command === "gh" && args[0] === "--version") return ok("gh version test");
    if (command === "gh" && args[0] === "auth") return ok("authenticated");
    const tagActions = tagActionsResponse(command, args, remote, "v1.20.0");
    if (tagActions) return tagActions;
    return execCommand(command, args, options);
  };
  const result = await runShip(runId, handoff, {
    exec,
    sleep: async () => {},
    tagRegistrationGraceMs: 0,
  });

  assert.equal(result.state, "released");
  assert.equal(result.ship.tag, "v1.20.0");
  assert.equal(result.ship.versionPlan.state, "rebased");
  assert.equal(result.ship.versionPlan.baseSha, planBaseSha, "the plan keeps the base it was approved on");
  assert.equal(readStatus(runId).ship.versionPlan.observedVersion, "1.19.0");
});
