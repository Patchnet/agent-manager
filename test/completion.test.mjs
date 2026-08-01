import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLaneCompletion } from "../src/completion.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-manager-completion-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

test("implementation completion rejects a successful zero-change process", () => {
  const lane = { state: "done", worktree: root, changedFiles: [], lastActivity: "finished" };
  assert.equal(validateLaneCompletion(lane, {
    kind: "implementation",
    expected_outputs: [],
    allow_no_changes: false,
  }), false);
  assert.equal(lane.state, "failed");
  assert.match(lane.lastActivity, /zero changed files/);
});

test("review lanes can complete with no changes and implementation outputs must exist", () => {
  const review = { state: "done", worktree: root, changedFiles: [] };
  assert.equal(validateLaneCompletion(review, {
    kind: "review",
    expected_outputs: [],
  }), true);

  const implementation = { state: "done", worktree: root, changedFiles: ["src/feature.mjs"] };
  assert.equal(validateLaneCompletion(implementation, {
    kind: "implementation",
    expected_outputs: ["src/feature.mjs"],
  }), false);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "feature.mjs"), "export {};\n");
  assert.equal(validateLaneCompletion(implementation, {
    kind: "implementation",
    expected_outputs: ["src/feature.mjs"],
  }), true);
});
