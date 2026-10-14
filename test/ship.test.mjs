import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedRoot, useIsolatedRoots } from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("ship-");
useIsolatedRoots(root);
test.after(() => rmSync(root, { recursive: true, force: true }));

const { shipRun, tierForChange } = await import("../src/ship.mjs?ship");
const { readStatus, writeStatus } = await import("../src/status.mjs?ship");
const { readEvents } = await import("../src/events.mjs?ship");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const remote = join(root, "remote.git");
const seed = join(root, "seed");
git(root, "init", "--bare", "-b", "main", remote);
git(root, "init", "-b", "main", seed);
for (const cwd of [seed]) {
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.invalid");
}
mkdirSync(join(seed, ".github"), { recursive: true });
writeFileSync(join(seed, ".github", "ship-tiers.yml"), "default: 1\ntier2:\n  - \"secrets/**\"\ntier0:\n  - \"docs/**\"\n");
writeFileSync(join(seed, "README.md"), "base\n");
git(seed, "add", "-A");
git(seed, "commit", "-m", "base");
git(seed, "remote", "add", "origin", remote);
git(seed, "push", "origin", "main");

let counter = 0;
function seedRun(files, { flow = "simple", verdict = "accept" } = {}) {
  counter += 1;
  const runId = `run-ship-${counter}`;
  const worktree = join(root, `wt-${counter}`);
  git(root, "clone", "-q", remote, worktree);
  git(worktree, "config", "user.name", "Test");
  git(worktree, "config", "user.email", "test@example.invalid");
  git(worktree, "checkout", "-q", "-b", `am/${runId}/integrate`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(worktree, path, ".."), { recursive: true });
    writeFileSync(join(worktree, path), body);
  }
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "wip(lane): snapshot");
  writeStatus(runId, {
    runId, repo: "app", state: "ship_pending", target_dev_flow: flow,
    identity: { subject: "Ship test" }, lanes: [],
    delivery: {
      mode: "single",
      review: { verdict, reviewer: "rev-1", notes: null, decidedAt: "t", history: [] },
      targets: [{
        id: "integrate", laneId: "integrate", branch: `am/${runId}/integrate`, base: "main",
        worktree, changedFiles: Object.keys(files), state: "changes_ready", pr: null, prUrl: null,
        tier: null, autoMerge: false, waitingOperator: null, mergeSha: null, mergedAt: null,
      }],
    },
  });
  return { runId, worktree };
}

test("tier policy is read from the base branch, not from the change", () => {
  const { worktree } = seedRun({ ".github/ship-tiers.yml": "default: 0\n", "src/a.ts": "x\n" });
  const tier = tierForChange(worktree, "origin/main");
  assert.equal(tier.tier, 2, "editing the tiers file is tier 2 under the base policy");
  assert.equal(tier.tiersFile, ".github/ship-tiers.yml");
});

test("Simple Flow ships a tier 1 change as one commit on main and closes the run", () => {
  const { runId } = seedRun({ "src/feature.ts": "export const x = 1;\n" });
  const result = shipRun(runId, { message: "feat: add feature" });
  const head = git(remote, "rev-parse", "main");
  const target = result.status.delivery.targets[0];
  assert.equal(result.status.state, "merged");
  assert.equal(target.tier, 1);
  assert.equal(target.mergeSha, head);
  assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "feat: add feature", "lane snapshots are squashed");
  assert.match(result.lines[0], /tier 1 · merged/);
  assert.deepEqual(readEvents({ runId }).map((event) => event.kind), ["review_verdict", "merged", "run_closed"]);
});

test("a tier 2 change waits for the operator, then ships on approval", () => {
  const { runId } = seedRun({ "secrets/key-rotation.md": "rotate\n" });
  const before = git(remote, "rev-parse", "main");
  const waiting = shipRun(runId, { message: "chore: rotate keys" });
  assert.equal(waiting.status.state, "waiting_operator");
  assert.equal(git(remote, "rev-parse", "main"), before, "nothing reaches main before approval");
  assert.match(waiting.lines[0], /Ship Gate · .* tier 2 · waiting: .*secrets\/key-rotation\.md/);
  const [question] = readEvents({ runId }).filter((event) => event.kind === "waiting_operator");
  assert.equal(question.tier, 2);

  const shipped = shipRun(runId, { message: "chore: rotate keys", approvedBy: "operator" });
  assert.equal(shipped.status.state, "merged");
  assert.equal(shipped.status.delivery.targets[0].approvedBy, "operator");
});

test("Simple Flow rebases onto a moved main", () => {
  const { runId } = seedRun({ "docs/guide.md": "guide\n" });
  writeFileSync(join(seed, "OTHER.md"), "landed meanwhile\n");
  git(seed, "pull", "-q", "origin", "main");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "other");
  git(seed, "push", "-q", "origin", "main");
  const result = shipRun(runId, { message: "docs: guide" });
  assert.equal(result.status.delivery.targets[0].tier, 0);
  assert.equal(git(remote, "log", "-2", "--format=%s", "main"), "docs: guide\nother");
});

test("ship refuses without an accepted review or a Simple Flow message", () => {
  const unreviewed = seedRun({ "src/b.ts": "b\n" }, { verdict: null });
  assert.throws(() => shipRun(unreviewed.runId, { message: "feat: b" }), /no accepted review/);
  const { runId } = seedRun({ "src/c.ts": "c\n" });
  assert.throws(() => shipRun(runId, {}), /pass --message/);
  assert.equal(readStatus(runId).state, "ship_pending");
});
