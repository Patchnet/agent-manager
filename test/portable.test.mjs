import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { isolatedEnv, isolatedRoot } from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("portable-");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "ignore" });
const cli = join(process.cwd(), "bin", "agent-manager.mjs");
const fleetCli = join(process.cwd(), "bin", "agent-manager-fleet.mjs");
const env = isolatedEnv({ AGENT_MANAGER_DEV_ROOT: root, AGENT_MANAGER_RUNS_ROOT: join(root, "runs") });

test.after(() => rmSync(root, { recursive: true, force: true }));

function run(args) {
  return execFileSync("node", [cli, ...args], { cwd: process.cwd(), env, encoding: "utf8", windowsHide: true });
}

test("version, init, validate, and project Cursor install work from a fresh directory", () => {
  assert.match(run(["--version"]), /^\d+\.\d+\.\d+/);
  const version = JSON.parse(run(["version", "--json"]));
  assert.match(version.runtimeVersion, /^\d+\.\d+\.\d+/);
  assert.equal(version.installedVersion, version.runtimeVersion);
  assert.equal(version.restartRequired, false);
  const initialized = JSON.parse(run(["init", "--repo", repo, "--request", "Add a portable demo", "--json"]));
  assert.ok(existsSync(initialized.path));
  assert.equal(initialized.contextPath, null);
  assert.match(initialized.workflow.planning.context, /Shared planning context/);
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
  assert.equal(validated.lanes.length, 1);
  assert.equal(validated.laneCount, 1);
  assert.equal(validated.configuredConcurrency, 1);
  assert.equal(validated.effectiveParallelism, 1);
  assert.equal(validated.fullySerialized, false);
  assert.equal(validated.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"), false);
  const installed = JSON.parse(run(["install", "cursor", "--project", repo, "--json"]));
  assert.equal(installed.host, "cursor");
  assert.ok(existsSync(join(repo, ".cursor", "skills", "agent-manager", "SKILL.md")));
  assert.ok(existsSync(join(repo, ".cursor", "skills", "pr-manager", "SKILL.md")));
  assert.ok(existsSync(join(repo, ".cursor", "rules", "agent-manager.mdc")));
});

test("config commands and the dedicated Fleet executable are portable", () => {
  const isolatedHome = join(root, "portable-home");
  const portableConfig = join(isolatedHome, ".agent-manager", "config.env");
  const configEnv = { ...env, AGENT_MANAGER_CONFIG: portableConfig };
  delete configEnv.AGENT_MANAGER_DEV_ROOT;
  delete configEnv.AGENT_MANAGER_RUNS_ROOT;
  execFileSync("node", [
    cli, "config", "init", "--dev-root", root,
    "--runs-root", join(isolatedHome, ".agent-manager", "runs"),
    "--claims-root", join(isolatedHome, ".agent-manager", "claims"),
  ], {
    cwd: repo, env: configEnv, encoding: "utf8", windowsHide: true,
  });
  const shown = JSON.parse(execFileSync("node", [cli, "config", "show", "--json"], {
    cwd: repo, env: configEnv, encoding: "utf8", windowsHide: true,
  }));
  assert.equal(shown.configPath, portableConfig);
  assert.equal(shown.values.AGENT_MANAGER_DEV_ROOT, root);
  assert.equal(shown.sources.AGENT_MANAGER_RUNS_ROOT, "user-config");

  const fleet = JSON.parse(execFileSync("node", [fleetCli, "--json"], {
    cwd: repo, env: configEnv, encoding: "utf8", windowsHide: true,
  }));
  assert.equal(fleet.telemetry.runsRoot, join(isolatedHome, ".agent-manager", "runs"));
  assert.equal(fleet.telemetry.source, "user-config");
});
