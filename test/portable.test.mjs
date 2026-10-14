import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, isolatedRoot } from "../test-support/isolated-roots.mjs";

const root = isolatedRoot("portable-");
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "ignore" });
const cli = join(process.cwd(), "bin", "agent-manager.mjs");
const env = isolatedEnv({ AGENT_MANAGER_DEV_ROOT: root, AGENT_MANAGER_RUNS_ROOT: join(root, "runs") });

test.after(() => rmSync(root, { recursive: true, force: true }));

function run(args) {
  return execFileSync("node", [cli, ...args], { cwd: process.cwd(), env, encoding: "utf8", windowsHide: true });
}

test("version, init, and validate work from a fresh directory", () => {
  assert.match(run(["--version"]), /^\d+\.\d+\.\d+/);
  const version = JSON.parse(run(["version", "--json"]));
  assert.match(version.runtimeVersion, /^\d+\.\d+\.\d+/);
  assert.equal(version.installedVersion, version.runtimeVersion);
  assert.equal(version.restartRequired, false);
  const initialized = JSON.parse(run(["init", "--repo", repo, "--request", "Add a portable demo", "--json"]));
  assert.ok(existsSync(initialized.path));
  assert.equal(initialized.workflow.goal, "Add a portable demo");
  assert.equal(initialized.workflow.planning, undefined);
  const validated = JSON.parse(run(["validate", initialized.path, "--json"]));
  assert.equal(validated.ok, true);
  assert.equal(validated.lanes.length, 1);
  assert.equal(validated.laneCount, 1);
  assert.equal(validated.effectiveParallelism, 1);
  assert.equal(validated.warnings.some((warning) => warning.code === "fully-serialized-multi-lane"), false);
});

test("config commands are portable", () => {
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

  assert.equal(shown.values.AGENT_MANAGER_RUNS_ROOT, join(isolatedHome, ".agent-manager", "runs"));
});
