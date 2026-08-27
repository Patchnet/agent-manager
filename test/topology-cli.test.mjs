import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolatedEnv } from "../test-support/isolated-roots.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-manager-topology-cli-"));
const repo = join(root, "repo");
const cli = join(process.cwd(), "bin", "agent-manager.mjs");
writeFileSync(join(root, ".keep"), "fixture\n");
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
writeFileSync(join(repo, "README.md"), "base\n");
execFileSync("git", ["-C", repo, "add", "README.md"]);
execFileSync("git", [
  "-C", repo,
  "-c", "user.name=Test",
  "-c", "user.email=test@example.invalid",
  "commit", "-m", "base",
], { stdio: "ignore" });
const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const env = isolatedEnv({
  AGENT_MANAGER_DEV_ROOT: root,
  AGENT_MANAGER_RUNS_ROOT: join(root, "runs"),
});

test.after(() => rmSync(root, { recursive: true, force: true }));

function workflow(name, lanes, maxConcurrency = lanes.length) {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify({
    repo,
    integrate: true,
    max_concurrency: maxConcurrency,
    planning: {
      source_refs: ["test-source"],
      plan_ref: "test-plan",
      context: "Reviewed fixture context.",
      reviewed_base_sha: base,
      verified_by: "test-manager",
      verified_at: "2026-01-01T00:00:00Z",
      reviewed_paths: ["README.md"],
      repository_instruction_refs: ["test fixture"],
      attestations: {
        source_reviewed: true,
        repository_instructions_reviewed: true,
        relevant_code_reviewed: true,
        scope_verified: true,
      },
    },
    lanes,
  }, null, 2));
  return path;
}

function validate(path, json = true) {
  return execFileSync(process.execPath, [cli, "validate", path, ...(json ? ["--json"] : [])], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("validate reports serialized topology and a stable warning code", () => {
  const path = workflow("serialized", [
    { id: "first", scope: "shared.txt", prompt: "first" },
    { id: "second", scope: "shared.txt", depends_on: ["first"], prompt: "second" },
  ], 2);
  const result = JSON.parse(validate(path));
  assert.equal(result.laneCount, 2);
  assert.equal(result.configuredConcurrency, 2);
  assert.equal(result.effectiveParallelism, 1);
  assert.equal(result.fullySerialized, true);
  assert.equal(result.topology.recommendation.includes("one queued agent"), true);
  assert.equal(
    result.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"),
    true,
  );

  const human = validate(path, false);
  assert.match(human, /lanes: 2/);
  assert.match(human, /configured concurrency: 2/);
  assert.match(human, /effective parallelism: 1/);
  assert.match(human, /fully serialized: yes/);
  assert.match(human, /one queued agent/);
});

test("independent and single-lane workflows do not get the serialized warning", () => {
  const independent = JSON.parse(validate(workflow("independent", [
    { id: "first", scope: "first.txt", prompt: "first" },
    { id: "second", scope: "second.txt", prompt: "second" },
  ], 2)));
  assert.equal(independent.effectiveParallelism, 2);
  assert.equal(independent.fullySerialized, false);
  assert.equal(independent.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"), false);

  const single = JSON.parse(validate(workflow("single", [
    { id: "only", scope: "only.txt", prompt: "only" },
  ], 1)));
  assert.equal(single.effectiveParallelism, 1);
  assert.equal(single.fullySerialized, false);
  assert.equal(single.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"), false);
});
