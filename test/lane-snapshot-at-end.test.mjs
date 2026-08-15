import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWritableLane,
  restoreLaneSnapshot,
  snapshotLaneAtEnd,
} from "../src/lane-snapshot.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-manager-lane-snapshot-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

/** A lane worktree that already has a base commit, optionally left dirty. */
function laneWorktree({ dirty = true } = {}) {
  counter += 1;
  const worktree = join(root, "lane-" + counter);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "base.txt"), "base\n");
  execFileSync("git", ["init", "-b", "main", worktree], { windowsHide: true });
  git(worktree, ["add", "base.txt"]);
  git(worktree, [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "base",
  ]);
  if (dirty) {
    writeFileSync(join(worktree, "worker.txt"), "half-finished work\n");
    writeFileSync(join(worktree, "base.txt"), "base edited\n");
  }
  return worktree;
}

function lane(overrides = {}) {
  const worktree = overrides.worktree === undefined
    ? laneWorktree({ dirty: overrides.dirty !== false })
    : overrides.worktree;
  return {
    id: "recover",
    kind: "implementation",
    permissionMode: "acceptEdits",
    state: "failed",
    ...overrides,
    worktree,
  };
}

test("a failed lane's work is committed so the lane branch points at it", () => {
  const failed = lane({ state: "failed" });
  const snapshot = snapshotLaneAtEnd(failed);

  assert.equal(snapshot.state, "committed");
  assert.equal(snapshot.committed, true);
  assert.equal(failed.snapshot, snapshot);
  assert.match(git(failed.worktree, ["log", "-1", "--pretty=%s"]), /^wip\(recover\): lane integrate snapshot$/);
  assert.deepEqual(snapshot.files.sort(), ["base.txt", "worker.txt"]);
  assert.equal(git(failed.worktree, ["status", "--porcelain"]), "");
  assert.equal(snapshot.commit, git(failed.worktree, ["rev-parse", "HEAD"]));
  assert.equal(snapshot.parent, git(failed.worktree, ["rev-parse", "HEAD~1"]));
});

test("a done lane is snapshotted on the same contract", () => {
  const done = lane({ state: "done" });
  const snapshot = snapshotLaneAtEnd(done);

  assert.equal(snapshot.state, "committed");
  assert.equal(git(done.worktree, ["status", "--porcelain"]), "");
});

test("only lane ends are snapshotted, and never a read-only lane", () => {
  for (const state of ["blocked", "running", "cancelled", "queued"]) {
    const midFlight = lane({ state });
    const snapshot = snapshotLaneAtEnd(midFlight);
    assert.equal(snapshot.state, "skipped", `${state} must not be committed`);
    assert.match(snapshot.reason, /not a lane end/);
    assert.notEqual(git(midFlight.worktree, ["status", "--porcelain"]), "");
  }

  const review = lane({ kind: "review", state: "failed" });
  assert.equal(snapshotLaneAtEnd(review).state, "skipped");
  assert.match(review.snapshot.reason, /read-only lane/);
  assert.notEqual(git(review.worktree, ["status", "--porcelain"]), "");

  const readOnlyMode = lane({ permissionMode: "read-only", state: "done" });
  assert.equal(snapshotLaneAtEnd(readOnlyMode).state, "skipped");
  assert.equal(isWritableLane(readOnlyMode), false);
  assert.notEqual(git(readOnlyMode.worktree, ["status", "--porcelain"]), "");
});

test("a clean worktree records no snapshot commit, and a missing one is not an error", () => {
  const clean = lane({ state: "failed", dirty: false });
  const before = git(clean.worktree, ["rev-parse", "HEAD"]);
  const snapshot = snapshotLaneAtEnd(clean);

  assert.equal(snapshot.state, "clean");
  assert.equal(snapshot.committed, false);
  assert.equal(git(clean.worktree, ["rev-parse", "HEAD"]), before);

  const gone = lane({ state: "failed", worktree: join(root, "never-created") });
  assert.equal(snapshotLaneAtEnd(gone).state, "skipped");
  assert.match(gone.snapshot.reason, /no worktree/);

  const notARepo = lane({ state: "failed", worktree: mkdtempSync(join(root, "plain-")) });
  writeFileSync(join(notARepo.worktree, "loose.txt"), "loose\n");
  assert.equal(snapshotLaneAtEnd(notARepo).state, "failed");
  assert.equal(notARepo.snapshot.ok, false);
  assert.ok(notARepo.snapshot.error);
});

test("resuming a lane rewinds its snapshot so the worker sees the tree it left", () => {
  const failed = lane({ state: "failed" });
  const snapshot = snapshotLaneAtEnd(failed);
  const restored = restoreLaneSnapshot(failed.worktree, snapshot);

  assert.equal(restored.restored, true);
  assert.equal(git(failed.worktree, ["rev-parse", "HEAD"]), snapshot.parent);
  assert.equal(git(failed.worktree, ["rev-list", "--count", "HEAD"]), "1");
  assert.notEqual(git(failed.worktree, ["status", "--porcelain"]), "", "the work is back in the worktree");

  // A second lane end re-commits the same work, so the branch never stays behind.
  const again = snapshotLaneAtEnd(failed);
  assert.equal(again.state, "committed");
  assert.deepEqual(again.files.sort(), ["base.txt", "worker.txt"]);
});

test("restore refuses anything that is not the snapshot commit it made", () => {
  const failed = lane({ state: "failed" });
  const snapshot = snapshotLaneAtEnd(failed);
  writeFileSync(join(failed.worktree, "later.txt"), "later\n");
  git(failed.worktree, ["add", "-A"]);
  git(failed.worktree, [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "later work",
  ]);

  const moved = restoreLaneSnapshot(failed.worktree, snapshot);
  assert.equal(moved.ok, true);
  assert.equal(moved.restored, false);
  assert.match(moved.reason, /no longer the snapshot commit/);

  const clean = lane({ state: "failed", dirty: false });
  const cleanSnapshot = snapshotLaneAtEnd(clean);
  assert.equal(restoreLaneSnapshot(clean.worktree, cleanSnapshot).restored, false);
  assert.equal(restoreLaneSnapshot(clean.worktree, null).restored, false);
});
