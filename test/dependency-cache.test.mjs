import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSetupCacheKey,
  runSetupWithCache,
} from "../src/dependency-cache.mjs";

const roots = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || "").trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-setup-cache-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "tracked.txt"), "before\n");
  writeFileSync(join(repo, "removed.txt"), "remove me\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  const revision = git(repo, ["rev-parse", "HEAD"]);
  let sequence = 0;
  const makeWorktree = (ref = revision) => {
    const worktree = join(root, `lane-${sequence += 1}`);
    git(repo, ["worktree", "add", "--detach", worktree, ref]);
    return worktree;
  };
  return { root, repo, revision, cacheRoot: join(root, "cache"), makeWorktree };
}

const plan = {
  timeout_sec: 30,
  commands: [{ command: "npm", args: ["ci"] }],
};

function successfulSetup(worktree, counter) {
  return () => {
    counter.count += 1;
    mkdirSync(join(worktree, "node_modules", "example"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "example", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(worktree, "tracked.txt"), "after\n");
    rmSync(join(worktree, "removed.txt"));
    return {
      state: "passed",
      commands: [{ command: ["npm", "ci"], exitCode: 0, passed: true }],
      passed: true,
      startedAt: new Date().toISOString(),
      elapsedMs: 1,
      timeoutSec: 30,
    };
  };
}

test("equivalent worktrees run setup once and restore private copies", () => {
  const { revision, cacheRoot, makeWorktree } = fixture();
  const counter = { count: 0 };
  const first = makeWorktree();
  const second = makeWorktree();
  const third = makeWorktree();
  const options = { cacheRoot, plan, revision, environment: { CI: "1" } };

  const miss = runSetupWithCache({
    ...options,
    worktree: first,
    runSetup: successfulSetup(first, counter),
  });
  const hit = runSetupWithCache({
    ...options,
    worktree: second,
    runSetup: successfulSetup(second, counter),
  });

  assert.equal(counter.count, 1);
  assert.equal(miss.cache.outcome, "miss");
  assert.equal(miss.cache.stored, true);
  assert.equal(hit.cache.outcome, "hit");
  assert.equal(hit.cache.restored, true);
  assert.equal(hit.commands[0].cached, true);
  assert.equal(readFileSync(join(second, "tracked.txt"), "utf8"), "after\n");
  assert.throws(() => readFileSync(join(second, "removed.txt"), "utf8"));

  writeFileSync(join(second, "node_modules", "example", "index.js"), "lane mutation\n");
  assert.equal(
    readFileSync(join(first, "node_modules", "example", "index.js"), "utf8"),
    "module.exports = 1;\n",
  );
  const laterHit = runSetupWithCache({
    ...options,
    worktree: third,
    runSetup: successfulSetup(third, counter),
  });
  assert.equal(laterHit.cache.outcome, "hit");
  assert.equal(counter.count, 1);
  assert.equal(
    readFileSync(join(third, "node_modules", "example", "index.js"), "utf8"),
    "module.exports = 1;\n",
  );
});

test("setup-plan, revision, and environment drift produce different keys", () => {
  const first = createSetupCacheKey({ plan, revision: "a", environment: { CI: "1" } });
  assert.notEqual(first, createSetupCacheKey({
    plan: { ...plan, commands: [{ command: "npm", args: ["install"] }] },
    revision: "a",
    environment: { CI: "1" },
  }));
  assert.notEqual(first, createSetupCacheKey({ plan, revision: "b", environment: { CI: "1" } }));
  assert.notEqual(first, createSetupCacheKey({ plan, revision: "a", environment: { CI: "0" } }));
});

test("plan and revision drift execute setup instead of restoring a snapshot", () => {
  const { repo, revision, cacheRoot, makeWorktree } = fixture();
  const counter = { count: 0 };
  const source = makeWorktree();
  runSetupWithCache({
    worktree: source,
    cacheRoot,
    plan,
    revision,
    runSetup: successfulSetup(source, counter),
  });

  const changedPlan = {
    ...plan,
    commands: [{ command: "npm", args: ["install"] }],
  };
  const planLane = makeWorktree();
  const planMiss = runSetupWithCache({
    worktree: planLane,
    cacheRoot,
    plan: changedPlan,
    revision,
    runSetup: successfulSetup(planLane, counter),
  });
  assert.equal(planMiss.cache.outcome, "miss");

  writeFileSync(join(repo, "revision.txt"), "new revision\n");
  git(repo, ["add", "revision.txt"]);
  git(repo, ["commit", "-m", "new revision"]);
  const nextRevision = git(repo, ["rev-parse", "HEAD"]);
  const revisionLane = makeWorktree(nextRevision);
  const revisionMiss = runSetupWithCache({
    worktree: revisionLane,
    cacheRoot,
    plan,
    revision: nextRevision,
    runSetup: successfulSetup(revisionLane, counter),
  });
  assert.equal(revisionMiss.cache.outcome, "miss");
  assert.equal(counter.count, 3);
});

test("baseline drift and corrupt overlays run the real setup", () => {
  const { revision, cacheRoot, makeWorktree } = fixture();
  const counter = { count: 0 };
  const first = makeWorktree();
  const drifted = makeWorktree();
  const corrupt = makeWorktree();
  const options = { cacheRoot, plan, revision, environment: {} };
  runSetupWithCache({
    ...options,
    worktree: first,
    runSetup: successfulSetup(first, counter),
  });

  writeFileSync(join(drifted, "local-only.txt"), "different baseline\n");
  const fallback = runSetupWithCache({
    ...options,
    worktree: drifted,
    runSetup: successfulSetup(drifted, counter),
  });
  assert.equal(fallback.cache.outcome, "fallback");
  assert.equal(fallback.cache.reason, "baseline-drift");
  assert.equal(counter.count, 2);

  const key = createSetupCacheKey({ plan, revision, environment: {} });
  writeFileSync(join(cacheRoot, key, "overlay", "tracked.txt"), "corrupt\n");
  const recovered = runSetupWithCache({
    ...options,
    worktree: corrupt,
    runSetup: successfulSetup(corrupt, counter),
  });
  assert.equal(recovered.passed, true);
  assert.equal(recovered.cache.outcome, "fallback");
  assert.match(recovered.cache.reason, /^cache-invalid:/);
  assert.equal(counter.count, 3);
  assert.equal(readFileSync(join(corrupt, "tracked.txt"), "utf8"), "after\n");
});
