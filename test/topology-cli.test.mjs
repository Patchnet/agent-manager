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
  assert.equal(result.effectiveParallelism, 1);
  const warning = result.warnings.find((entry) => entry.code === "fully-serialized-multi-lane");
  assert.ok(warning, "serialized topology carries a stable warning code");
  assert.equal(warning.configuredConcurrency, 2);
  assert.equal(warning.effectiveParallelism, 1);
  assert.equal(warning.fullySerialized, true);
  assert.match(warning.message, /one queued agent/);

  const human = validate(path, false);
  assert.match(human, /lanes: 2 \(parallelism 1\)/);
  assert.match(human, /warning: .*one queued agent/);
});

test("independent and single-lane workflows do not get the serialized warning", () => {
  const independent = JSON.parse(validate(workflow("independent", [
    { id: "first", scope: "first.txt", prompt: "first" },
    { id: "second", scope: "second.txt", prompt: "second" },
  ], 2)));
  assert.equal(independent.effectiveParallelism, 2);
  assert.equal(independent.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"), false);

  const single = JSON.parse(validate(workflow("single", [
    { id: "only", scope: "only.txt", prompt: "only" },
  ], 1)));
  assert.equal(single.effectiveParallelism, 1);
  assert.equal(single.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"), false);
});
