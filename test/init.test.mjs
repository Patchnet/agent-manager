import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initWorkflow } from "../src/init.mjs";

function initializeRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", [
    "-c", "user.email=fixture@example.invalid",
    "-c", "user.name=Fixture",
    "commit", "-m", "fixture",
  ], { cwd: repo, stdio: "ignore" });
  return repo;
}

test("init defaults to one lane and preserves explicit multi-harness generation", () => {
  const repo = initializeRepo("agent-manager-init-default-");
  try {
    const single = initWorkflow({ repo });
    assert.equal(single.workflow.lanes.length, 1);
    assert.equal(single.workflow.lanes[0].id, "implementation");
    assert.equal(single.workflow.lanes[0].harness, "claude");
    assert.equal(single.workflow.max_concurrency, 1);

    const multiple = initWorkflow({
      repo,
      output: "agent-manager-multi.yaml",
      harnesses: ["claude", "codex"],
    });
    assert.deepEqual(
      multiple.workflow.lanes.map((lane) => lane.harness),
      ["claude", "codex"],
    );
    assert.equal(multiple.workflow.max_concurrency, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("init compiles npm ci setup for package-lock Node repositories", () => {
  const repo = mkdtempSync(join(tmpdir(), "agent-manager-init-node-"));
  try {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "tsc --noEmit" } }));
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    const result = initWorkflow({ repo, harnesses: ["codex"] });
    assert.deepEqual(result.workflow.verification.setup.commands, [{ command: "npm", args: ["ci"] }]);
    assert.deepEqual(result.workflow.verification.commands, [{ command: "npm", args: ["test"] }]);
    const yaml = readFileSync(result.path, "utf8");
    assert.match(yaml, /setup:[\s\S]*command: npm[\s\S]*- ci[\s\S]*commands:[\s\S]*- test/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
