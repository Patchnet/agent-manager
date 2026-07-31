import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const root = mkdtempSync(join(tmpdir(), "agent-manager-portable-"));
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "ignore" });
const cli = join(process.cwd(), "bin", "agent-manager.mjs");
const env = { ...process.env, AGENT_MANAGER_DEV_ROOT: root, AGENT_MANAGER_RUNS_ROOT: join(root, "runs") };

test.after(() => rmSync(root, { recursive: true, force: true }));

function run(args) {
  return execFileSync("node", [cli, ...args], { cwd: process.cwd(), env, encoding: "utf8", windowsHide: true });
}

test("version, init, validate, and project Cursor install work from a fresh directory", () => {
  assert.match(run(["--version"]), /^\d+\.\d+\.\d+/);
  const initialized = JSON.parse(run(["init", "--repo", repo, "--request", "Add a portable demo", "--json"]));
  assert.ok(existsSync(initialized.path));
  assert.ok(existsSync(initialized.contextPath));
  assert.equal(initialized.planningReady, false);
  const workflow = YAML.parse(readFileSync(initialized.path, "utf8"));
  workflow.planning.source_refs = ["portable-test-source"];
  workflow.planning.plan_ref = "portable-test-plan";
  workflow.planning.verified_by = "portable-test-manager";
  workflow.planning.reviewed_paths = ["."];
  workflow.planning.repository_instruction_refs = ["test fixture"];
  workflow.planning.attestations = {
    source_reviewed: true,
    repository_instructions_reviewed: true,
    relevant_code_reviewed: true,
    scope_verified: true,
  };
  writeFileSync(initialized.path, YAML.stringify(workflow));
  const validated = JSON.parse(run(["validate", initialized.path, "--json"]));
  assert.equal(validated.ok, true);
  assert.equal(validated.planning.state, "verified");
  assert.equal(validated.lanes.length, 2);
  const installed = JSON.parse(run(["install", "cursor", "--project", repo, "--json"]));
  assert.equal(installed.host, "cursor");
  assert.ok(existsSync(join(repo, ".cursor", "skills", "agent-manager", "SKILL.md")));
  assert.ok(existsSync(join(repo, ".cursor", "skills", "pr-manager", "SKILL.md")));
  assert.ok(existsSync(join(repo, ".cursor", "rules", "agent-manager.mdc")));
});
