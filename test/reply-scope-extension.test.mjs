import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertResolvedRootsIsolated,
  isolatedRoot,
  useIsolatedRoots,
} from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("scope-extension-");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const { AGENT_MANAGER_RUNS_ROOT: runsRoot } = useIsolatedRoots(root);

execFileSync("git", ["init", "-b", "main", repo]);
writeFileSync(join(repo, "README.md"), "base\n");
execFileSync("git", ["-C", repo, "add", "README.md"]);
execFileSync("git", [
  "-C", repo,
  "-c", "user.name=Test",
  "-c", "user.email=test@example.invalid",
  "commit", "-m", "base",
]);

test.after(() => rmSync(root, { recursive: true, force: true }));

const { currentHead, laneScopePatterns, validateLaneGuardrails } =
  await import("../src/guardrails.mjs?scope-extension");
const { normalizeScopeExtension, prepareReply } = await import("../src/reply.mjs?scope-extension");
const { readStatus, writeStatus } = await import("../src/status.mjs?scope-extension");

let counter = 0;

function blockedRunFixture(laneOverrides = {}) {
  counter += 1;
  const runId = `run-extend-${counter}`;
  const worktree = join(runsRoot, runId, "lane", "wt");
  mkdirSync(worktree, { recursive: true });
  writeStatus(runId, {
    runId,
    state: "blocked",
    repo: "repo",
    repoRoot: repo,
    claimMode: "off",
    planning: { state: "verified", verifiedBy: "test-manager" },
    supervisor: { pid: null, startedAt: new Date().toISOString(), kind: "run" },
    lanes: [{
      id: "lane",
      harness: "fake",
      state: "blocked",
      attempt: 1,
      sessionId: "fake-session",
      branch: `am/${runId}/lane`,
      scope: "src/**",
      worktree,
      needsInput: { type: "question", prompt: "may I touch docs?", blocking: true },
      lastActivity: "may I touch docs?",
      ...laneOverrides,
    }],
  });
  return { runId, worktree };
}

test("this test file resolves disposable runs, claims, and brain roots", async () => {
  await assertResolvedRootsIsolated();
});

test("a granted extension is unioned into the lane's writable patterns", () => {
  assert.deepEqual(laneScopePatterns("src/**"), ["src/**"]);
  assert.deepEqual(
    laneScopePatterns("src/**, test/**", [
      { patterns: ["docs/OPERATOR.md"], by: "master-dev", at: "-" },
      { patterns: ["src/**", "schemas/**"], by: "master-dev", at: "-" },
    ]),
    ["src/**", "test/**", "docs/OPERATOR.md", "schemas/**"],
    "grants append and duplicates collapse",
  );
});

test("reply --extend-scope records an attributed, appended grant", () => {
  const { runId } = blockedRunFixture();
  const first = prepareReply(runId, "lane", "yes, the operator guide too", {
    extendScope: "docs/OPERATOR.md",
  });
  assert.equal(first.scopeExtensions.length, 1);
  assert.deepEqual(first.scopeExtensions[0].patterns, ["docs/OPERATOR.md"]);
  assert.equal(first.scopeExtensions[0].by, "test-manager", "falls back to the planning verifier");
  assert.equal(typeof first.scopeExtensions[0].at, "string");

  // The lane blocks again; a second grant appends rather than replacing.
  const status = readStatus(runId);
  status.lanes[0].state = "blocked";
  status.lanes[0].needsInput = { type: "question", prompt: "and the schema?", blocking: true };
  writeStatus(runId, status);

  const second = prepareReply(runId, "lane", "schemas too", {
    extendScope: " schemas/run-goals.json , ./schemas/lane.json ",
    by: "master-dev",
  });
  assert.deepEqual(second.scopeExtensions.map((grant) => grant.patterns), [
    ["docs/OPERATOR.md"],
    ["schemas/run-goals.json", "schemas/lane.json"],
  ]);
  assert.equal(second.scopeExtensions[1].by, "master-dev", "an explicit id wins");
  assert.deepEqual(
    readStatus(runId).lanes[0].scopeExtensions.map((grant) => grant.by),
    ["test-manager", "master-dev"],
  );
});

test("an ordinary reply leaves the lane's scope exactly as it was", () => {
  const { runId } = blockedRunFixture();
  const prepared = prepareReply(runId, "lane", "carry on");
  assert.deepEqual(prepared.scopeExtensions, []);
  assert.equal(readStatus(runId).lanes[0].scopeExtensions, undefined);
});

test("a grant that escapes the repository is refused before anything is recorded", () => {
  const { runId } = blockedRunFixture();
  for (const bad of ["../outside/**", "src/../../etc", "/etc/passwd"]) {
    assert.throws(
      () => prepareReply(runId, "lane", "go", { extendScope: bad }),
      /--extend-scope must stay inside the repository/,
      bad,
    );
  }
  assert.throws(
    () => prepareReply(runId, "lane", "go", { extendScope: "docs/\nOPERATOR.md" }),
    /--extend-scope contains invalid characters/,
  );
  const lane = readStatus(runId).lanes[0];
  assert.equal(lane.state, "blocked", "a refused grant does not resume the lane");
  assert.equal(lane.scopeExtensions, undefined);
  assert.deepEqual(normalizeScopeExtension(""), []);
});

test("an unattributable grant is refused rather than recorded anonymously", () => {
  const { runId } = blockedRunFixture();
  const status = readStatus(runId);
  status.planning = { state: "verified" };
  writeStatus(runId, status);
  assert.throws(
    () => prepareReply(runId, "lane", "go", { extendScope: "docs/**" }),
    /a scope extension requires --by <id>/,
  );
  assert.equal(readStatus(runId).lanes[0].state, "blocked");
});

test("guardrails clear a violation the extension covers, and only that one", () => {
  const worktree = join(root, "guardrail-wt");
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", "am/extend/lane", worktree, "main"], {
    stdio: "ignore",
  });
  const baseCommit = currentHead(worktree);
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(join(worktree, "docs"), { recursive: true });
  writeFileSync(join(worktree, "src", "run.mjs"), "in scope\n");
  writeFileSync(join(worktree, "docs", "OPERATOR.md"), "granted\n");
  writeFileSync(join(worktree, "stray.txt"), "never granted\n");

  const unextended = validateLaneGuardrails({ worktree, scope: "src/**", baseCommit });
  assert.equal(unextended.ok, false);
  assert.deepEqual(unextended.scopeViolations, ["docs/OPERATOR.md", "stray.txt"]);

  const extended = validateLaneGuardrails({
    worktree,
    scope: "src/**",
    scopeExtensions: [{ patterns: ["docs/OPERATOR.md"], by: "master-dev", at: "-" }],
    baseCommit,
  });
  assert.equal(extended.ok, false, "the ungranted file still fails the lane");
  assert.deepEqual(
    extended.scopeViolations,
    ["stray.txt"],
    "a Master-granted extension cannot fail the lane at exit",
  );

  const covered = validateLaneGuardrails({
    worktree,
    scope: "src/**",
    scopeExtensions: [{ patterns: ["docs/**", "stray.txt"], by: "master-dev", at: "-" }],
    baseCommit,
  });
  assert.equal(covered.ok, true);
  assert.deepEqual(covered.scopeViolations, []);

  // An extension widens what the lane owns; it never reopens someone else's path.
  const readOnly = validateLaneGuardrails({
    worktree,
    scope: "src/**",
    scopeExtensions: [{ patterns: ["docs/**"], by: "master-dev", at: "-" }],
    readOnlyScope: "docs/**",
    baseCommit,
  });
  assert.equal(readOnly.ok, false);
  assert.deepEqual(readOnly.readOnlyViolations, ["docs/OPERATOR.md"]);
});
